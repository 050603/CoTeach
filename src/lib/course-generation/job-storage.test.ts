import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationJob } from "@prisma/client";
const mocks = vi.hoisted(() => ({ find: vi.fn(), create: vi.fn(), update: vi.fn(), template: vi.fn(), transaction: vi.fn(), lock: vi.fn(), deleteCheckpoints: vi.fn(), checkpoint: vi.fn(), saveCheckpoint: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { generationJob: { findMany: mocks.find }, $transaction: mocks.transaction } }));
import { contentGenerationJobs, designGenerationJobs, resourcePackageJobs, projectGenerationJob } from "./job-storage";
const now = new Date("2026-09-01T00:00:00Z");
function row(): GenerationJob { return { id: "job", targetId: "template", targetType: "CLASSROOM_TEMPLATE", jobType: "COURSE_CONTENT", status: "QUEUED", step: "queued", progress: 0, request: {}, result: null, trace: null, qualityReport: null, error: null, attempt: 0, startedAt: null, completedAt: null, heartbeatAt: null, retryAt: null, createdAt: now, updatedAt: now }; }
beforeEach(() => {
  vi.resetAllMocks(); mocks.find.mockResolvedValue([row()]); mocks.template.mockResolvedValue({ id: "template" });
  mocks.update.mockImplementation(async ({ data }) => ({ ...row(), ...data, updatedAt: now }));
  mocks.create.mockResolvedValue(row());
  mocks.transaction.mockImplementation((fn) => fn({ $executeRaw: mocks.lock, generationJob: { findMany: mocks.find, create: mocks.create, update: mocks.update }, generationCheckpoint: { deleteMany: mocks.deleteCheckpoints, findUnique: mocks.checkpoint, upsert: mocks.saveCheckpoint }, classroomTemplate: { findUnique: mocks.template } }));
});
describe("V2 generation job persistence", () => {
  it.each(['prepared-outlines', 'all'] as const)('archives trusted old classroom origins before %s replacement clears output', async (checkpointPolicy) => {
    mocks.find.mockResolvedValue([{ ...row(), status: 'COMPLETED', result: { id: 'old-test' }, request: { id: 'foreign-injected' } }]);
    mocks.checkpoint.mockResolvedValue({ state: { split: { studentClassroomId: 'old-test', teacherClassroomId: 'old-test-teacher' } } });
    await contentGenerationJobs.replace({
      where: { id: 'job', status: 'completed', version: 1 }, checkpointPolicy,
      data: { status: 'queued', result: null },
    });
    expect(mocks.saveCheckpoint.mock.calls.map(([args]) => args.create)).toEqual([
      { jobId: 'job', step: 'classroom-media-origin:old-test', state: { classroomId: 'old-test' } },
      { jobId: 'job', step: 'classroom-media-origin:old-test-teacher', state: { classroomId: 'old-test-teacher' } },
    ]);
    expect(mocks.saveCheckpoint.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.deleteCheckpoints.mock.invocationCallOrder[0]);
    expect(mocks.deleteCheckpoints).toHaveBeenCalledWith({ where: checkpointPolicy === 'all'
      ? { jobId: 'job', NOT: { step: { startsWith: 'classroom-media-origin:' } } }
      : { jobId: 'job', step: 'prepared-outlines' } });
    expect(mocks.deleteCheckpoints.mock.invocationCallOrder[0]).toBeLessThan(mocks.update.mock.invocationCallOrder[0]);
  });

  it('does not turn user-controlled request IDs into trusted media origins', async () => {
    mocks.find.mockResolvedValue([{ ...row(), request: { id: 'foreign', studentClassroomId: 'foreign' } }]);
    mocks.checkpoint.mockResolvedValue(null);
    await contentGenerationJobs.replace({ where: { id: 'job' }, checkpointPolicy: 'all', data: { result: null } });
    expect(mocks.saveCheckpoint).not.toHaveBeenCalled();
  });

  it("scopes content and design workers to distinct job types", async () => {
    await contentGenerationJobs.findUnique({ where: { courseId: "template" } });
    await designGenerationJobs.findUnique({ where: { courseId: "template" } });
    expect(mocks.find.mock.calls.map(([input]) => input.where)).toEqual([
      { targetType: "CLASSROOM_TEMPLATE", jobType: "COURSE_CONTENT", targetId: "template" },
      { targetType: "CLASSROOM_TEMPLATE", jobType: "COURSE_DESIGN", targetId: "template" },
    ]);
  });
  it("atomically claims queued work and preserves review state with its heartbeat", async () => {
    const currentCall = { stage: "knowledgePoints", status: "reasoning", attempt: 1 };
    const result = await designGenerationJobs.updateMany({ where: { id: "job", status: "queued" }, data: { status: "running", reviewStatus: "available", reviewAvailableUntil: now, message: "Review", currentCall, lastHeartbeatAt: now, version: { increment: 1 }, attempt: { increment: 1 } } });
    expect(result.count).toBe(1); expect(mocks.lock).toHaveBeenCalledOnce();
    const data = mocks.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "RUNNING", heartbeatAt: now, attempt: 1, trace: { state: { version: 2, reviewStatus: "available" } } });
    const decoded = projectGenerationJob({ ...row(), ...data });
    expect(decoded.reviewAvailableUntil).toEqual(now); expect(decoded.message).toBe("Review");
    expect(decoded.currentCall).toEqual(currentCall);
  });
  it("increments the persisted token estimate without a schema column", async () => {
    await contentGenerationJobs.update({
      where: { id: "job" },
      data: { tokenUsage: { increment: 1_240 }, tokenUsageCalls: { increment: 1 } },
    });
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.trace.state).toMatchObject({ tokenUsage: 1_240, tokenUsageCalls: 1 });
    const decoded = projectGenerationJob({ ...row(), ...data });
    expect(decoded.tokenUsage).toBe(1_240);
    expect(decoded.tokenUsageCalls).toBe(1);
  });
  it("does not claim a job whose status changed before the lock was acquired", async () => {
    mocks.find.mockResolvedValue([{ ...row(), status: "RUNNING" }]);
    expect(await contentGenerationJobs.updateMany({ where: { id: "job", status: "queued" }, data: { status: "running" } })).toEqual({ count: 0 });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("creates work only for a persisted template and reuses its existing job", async () => {
    const existing = await contentGenerationJobs.create({ data: { courseId: "template", request: {} } });
    expect(existing.id).toBe("job"); expect(mocks.create).not.toHaveBeenCalled();
    mocks.template.mockResolvedValue(null);
    await expect(contentGenerationJobs.create({ data: { courseId: "missing", request: {} } })).rejects.toThrow("GENERATION_TEMPLATE_NOT_FOUND");
  });
  it("does not resume a scheduled retry before its deadline", async () => {
    mocks.find.mockResolvedValue([{ ...row(), retryAt: new Date(now.getTime() + 10000) }]);
    expect(await designGenerationJobs.findFirst({ where: { status: "queued", OR: [{ retryAt: null }, { retryAt: { lte: now } }] } })).toBeNull();
  });
  it("does not replace a resource package that another request queued before the lock", async () => {
    await expect(resourcePackageJobs.upsert({ where: { courseId: "template" }, create: { courseId: "template" }, update: { request: { uploadId: "replacement" } }, rejectStatuses: ["queued", "running"] })).rejects.toThrow("GENERATION_JOB_BUSY");
    expect(mocks.lock).toHaveBeenCalledOnce();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("rejects a stale resource package confirmation after a new input version is saved", async () => {
    mocks.find.mockResolvedValue([{ ...row(), status: "READY", trace: { state: { version: 3 } } }]);
    await expect(resourcePackageJobs.update({ where: { id: "job", status: "ready", version: 2 }, data: { result: { package: "stale" } } })).rejects.toThrow("GENERATION_JOB_NOT_FOUND");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("stores execution ownership and lease metadata inside the durable JSON state", async () => {
    const leaseExpiresAt = new Date(now.getTime() + 30_000);
    await contentGenerationJobs.update({
      where: { id: "job" },
      data: { executionId: "execution-1", executionOwner: "worker-1", leaseExpiresAt },
    });
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.trace.state).toMatchObject({ executionId: "execution-1", executionOwner: "worker-1" });
    expect(projectGenerationJob({ ...row(), ...data })).toMatchObject({
      executionId: "execution-1",
      executionOwner: "worker-1",
      leaseExpiresAt,
    });
  });
  it("replaces a job and its selected checkpoints under the same CAS transaction", async () => {
    await contentGenerationJobs.replace({
      where: { id: "job", status: "queued", version: 1 },
      checkpointPolicy: { prefixes: ["stage-attempt:"] },
      data: { status: "running" },
    });
    expect(mocks.deleteCheckpoints).toHaveBeenCalledWith({
      where: { jobId: "job", OR: [{ step: { startsWith: "stage-attempt:" } }] },
    });
    expect(mocks.deleteCheckpoints.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.update.mock.invocationCallOrder[0]!);
  });
  it("can clear completed-but-unvalidated model responses without deleting validated stages", async () => {
    await contentGenerationJobs.replace({
      where: { id: "job", status: "queued", version: 1 },
      checkpointPolicy: { prefixes: ["course-design-attempt:"], unvalidatedResponses: true },
      data: { status: "running" },
    });
    expect(mocks.deleteCheckpoints).toHaveBeenCalledWith({
      where: {
        jobId: "job",
        OR: [
          { step: { startsWith: "course-design-attempt:" } },
          { state: { path: ["status"], equals: "response-complete" } },
        ],
      },
    });
  });
});
