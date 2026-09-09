import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(), scope: vi.fn(), archive: vi.fn(), write: vi.fn(), unlink: vi.fn(),
  db: { $queryRaw: vi.fn(), domainEvent: { findUnique: vi.fn(), create: vi.fn() }, classroomSubmission: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() }, classroomInstance: { findUniqueOrThrow: vi.fn(), update: vi.fn() }, enrollment: { findUniqueOrThrow: vi.fn() }, artifact: { upsert: vi.fn() }, artifactVersion: { findFirst: vi.fn(), create: vi.fn() }, fileAsset: { create: vi.fn(), findUnique: vi.fn() }, aiInteractionEvent: { create: vi.fn() } },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const overridden = { ...actual, mkdir: vi.fn(), writeFile: mocks.write, unlink: mocks.unlink };
  return { ...overridden, default: overridden };
});
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: () => null }));
vi.mock("@/lib/ai-collaboration/legacy-scope", () => ({ authorizeLegacyAiScope: mocks.scope, legacyAiError: (error: { code: string; status: number }) => Response.json({ error: error.code }, { status: error.status ?? 503 }) }));
vi.mock("@/lib/db/client", () => ({ prisma: mocks.db }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: (operation: (db: unknown) => unknown) => operation(mocks.db) }));
vi.mock("@/lib/project-practice/document-archive", () => ({ buildProjectDocumentDocx: mocks.archive, ProjectDocumentArchiveError: class extends Error {} }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: vi.fn() }));
import { POST } from "./route";
const draft = () => ({ id: "db-submission", payload: { view: { id: "ui-submission", stageKey: "make", type: "document", content: "<p>内容</p>", title: "成果", version: 2 } } });
const request = () => new Request("http://localhost/api/project-practice/submissions/finalize", { method: "POST", body: JSON.stringify({ courseId: "instance", submissionId: "ui-submission", stageKey: "make", expectedVersion: 2, requestId: "request" }) });
beforeEach(() => {
  vi.resetAllMocks(); mocks.auth.mockResolvedValue({ claims: { sub: "student", role: "student" } });
  mocks.scope.mockResolvedValue({ user: { id: "student" }, offering: { id: "offering" }, participation: { id: "participation", enrollmentId: "enrollment" } });
  mocks.db.classroomSubmission.findFirst.mockResolvedValue(draft()); mocks.db.classroomSubmission.findUniqueOrThrow.mockResolvedValue(draft());
  mocks.db.classroomInstance.findUniqueOrThrow.mockResolvedValue({ status: "TEACHING", runtimeConfig: { version: 5 }, activity: { chapter: { offering: { status: "OPEN" } } } });
  mocks.db.enrollment.findUniqueOrThrow.mockResolvedValue({ status: "ACTIVE", researchKey: "research" });
  mocks.db.artifactVersion.create.mockResolvedValue({ id: "version", sequence: 1 });
  mocks.archive.mockResolvedValue({ bytes: Buffer.from("docx"), sourceHtml: "<p>内容</p>", sha256: "hash", uploadIds: [], imageCount: 0 });
  mocks.unlink.mockResolvedValue(undefined);
});
describe("V2 document finalize", () => {
  it("atomically binds a real file, immutable version and research receipts", async () => {
    const result = await POST(request());
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ ok: true, versionId: "version", sequence: 1 });
    expect(mocks.db.artifactVersion.create).toHaveBeenCalledWith({ data: expect.objectContaining({ artifactId: "document:db-submission", sourceHtml: "<p>内容</p>", status: "SUBMITTED", fileAssetId: expect.any(String) }) });
    expect(mocks.db.domainEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ researchKey: "research", participationId: "participation", payload: expect.objectContaining({ submissionId: "ui-submission", sourceVersion: 2, versionId: "version" }) }) });
    expect(mocks.db.aiInteractionEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ researchKey: "research", eventType: "submit" }) });
    expect(mocks.unlink).not.toHaveBeenCalled();
  });
  it("rejects stale editor versions before generating an archive", async () => {
    const row = draft(); row.payload.view.version = 3; mocks.db.classroomSubmission.findFirst.mockResolvedValue(row);
    const result = await POST(request()); expect(result.status).toBe(409); expect(mocks.archive).not.toHaveBeenCalled();
  });
  it("cleans the temporary file if the draft changes during Word generation", async () => {
    const row = draft(); row.payload.view.content = "new text"; mocks.db.classroomSubmission.findUniqueOrThrow.mockResolvedValue(row);
    const result = await POST(request()); expect(result.status).toBe(409);
    expect(mocks.unlink).toHaveBeenCalledOnce(); expect(mocks.db.fileAsset.create).not.toHaveBeenCalled(); expect(mocks.db.artifactVersion.create).not.toHaveBeenCalled();
  });
  it("does not delete an archive when a commit acknowledgement is uncertain", async () => {
    const row = draft(); row.payload.view.content = "changed"; mocks.db.classroomSubmission.findUniqueOrThrow.mockResolvedValue(row);
    mocks.db.fileAsset.findUnique.mockRejectedValue(new Error("database temporarily unreachable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try { await POST(request()); expect(mocks.unlink).not.toHaveBeenCalled(); }
    finally { log.mockRestore(); }
  });
  it("reuses the durable receipt on a retried request", async () => {
    await POST(request());
    const receipt = mocks.db.domainEvent.create.mock.calls[0][0].data;
    mocks.db.domainEvent.findUnique.mockResolvedValue(receipt); mocks.archive.mockClear(); mocks.write.mockClear();
    const result = await POST(request()); expect(result.status).toBe(200); expect(mocks.archive).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  });
  it("requires authentication before resolving student work", async () => {
    mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    expect((await POST(request())).status).toBe(401); expect(mocks.scope).not.toHaveBeenCalled();
  });
});
