import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationJob } from "@prisma/client";
const mocks = vi.hoisted(() => ({ find: vi.fn(), create: vi.fn(), update: vi.fn(), template: vi.fn(), transaction: vi.fn(), lock: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { generationJob: { findMany: mocks.find }, $transaction: mocks.transaction } }));
import { contentGenerationJobs, designGenerationJobs, projectGenerationJob } from "./job-storage";
const now = new Date("2026-09-01T00:00:00Z");
function row(): GenerationJob { return { id: "job", targetId: "template", targetType: "CLASSROOM_TEMPLATE", jobType: "COURSE_CONTENT", status: "QUEUED", step: "queued", progress: 0, request: {}, result: null, trace: null, qualityReport: null, error: null, attempt: 0, startedAt: null, completedAt: null, heartbeatAt: null, retryAt: null, createdAt: now, updatedAt: now }; }
beforeEach(() => {
  vi.resetAllMocks(); mocks.find.mockResolvedValue([row()]); mocks.template.mockResolvedValue({ id: "template" });
  mocks.update.mockImplementation(async ({ data }) => ({ ...row(), ...data, updatedAt: now }));
  mocks.create.mockResolvedValue(row());
  mocks.transaction.mockImplementation((fn) => fn({ $executeRaw: mocks.lock, generationJob: { findMany: mocks.find, create: mocks.create, update: mocks.update }, classroomTemplate: { findUnique: mocks.template } }));
});
describe("V2 generation job persistence", () => {
  it("scopes content and design workers to distinct job types", async () => {
    await contentGenerationJobs.findUnique({ where: { courseId: "template" } });
    await designGenerationJobs.findUnique({ where: { courseId: "template" } });
    expect(mocks.find.mock.calls.map(([input]) => input.where)).toEqual([
      { targetType: "CLASSROOM_TEMPLATE", jobType: "COURSE_CONTENT", targetId: "template" },
      { targetType: "CLASSROOM_TEMPLATE", jobType: "COURSE_DESIGN", targetId: "template" },
    ]);
  });
  it("atomically claims queued work and preserves review state with its heartbeat", async () => {
    const result = await designGenerationJobs.updateMany({ where: { id: "job", status: "queued" }, data: { status: "running", reviewStatus: "available", reviewAvailableUntil: now, message: "Review", lastHeartbeatAt: now, version: { increment: 1 }, attempt: { increment: 1 } } });
    expect(result.count).toBe(1); expect(mocks.lock).toHaveBeenCalledOnce();
    const data = mocks.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "RUNNING", heartbeatAt: now, attempt: 1, trace: { state: { version: 2, reviewStatus: "available" } } });
    const decoded = projectGenerationJob({ ...row(), ...data });
    expect(decoded.reviewAvailableUntil).toEqual(now); expect(decoded.message).toBe("Review");
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
});
