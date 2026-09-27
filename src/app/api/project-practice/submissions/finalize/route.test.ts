import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  admission: vi.fn(), transaction: vi.fn(), auth: vi.fn(), scope: vi.fn(), archive: vi.fn(), write: vi.fn(), unlink: vi.fn(),
  db: { $queryRaw: vi.fn(), domainEvent: { findUnique: vi.fn(), create: vi.fn() }, classroomSubmission: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() }, classroomInstance: { findUniqueOrThrow: vi.fn(), update: vi.fn() }, enrollment: { findUniqueOrThrow: vi.fn() }, artifact: { upsert: vi.fn() }, artifactVersion: { findFirst: vi.fn(), create: vi.fn() }, fileAsset: { create: vi.fn(), findUnique: vi.fn() }, aiInteractionEvent: { create: vi.fn() } },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const overridden = { ...actual, mkdir: vi.fn(), writeFile: mocks.write, unlink: mocks.unlink };
  return { ...overridden, default: overridden };
});
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: () => null }));
vi.mock("@/lib/ai-collaboration/legacy-scope", () => ({ legacyAiError: (error: { code: string; status: number }) => Response.json({ error: error.code }, { status: error.status ?? 503 }) }));
vi.mock("@/lib/project-practice/document-finalize", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/project-practice/document-finalize")>(), authorizeDocumentArchiveScope: mocks.scope }));
vi.mock("@/lib/db/client", () => ({ prisma: mocks.db }));
vi.mock("@/lib/db/transaction-retry", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/db/transaction-retry")>(), runMutationTransaction: mocks.transaction, hasCourseMutationAdmission: mocks.admission }));
vi.mock("@/lib/project-practice/document-archive", () => ({ buildProjectDocumentDocx: mocks.archive, ProjectDocumentArchiveError: class extends Error {} }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: vi.fn() }));
import { POST } from "./route";
import { DocumentConversionBusyError } from "@/lib/project-practice/document-conversion-queue";
const draft = () => ({ id: "db-submission", payload: { view: { id: "ui-submission", stageKey: "make", type: "document", content: "<p>内容</p>", title: "成果", version: 2 } } });
const request = () => new Request("http://localhost/api/project-practice/submissions/finalize", { method: "POST", body: JSON.stringify({ courseId: "instance", submissionId: "ui-submission", stageKey: "make", expectedVersion: 2, requestId: "request" }) });
beforeEach(() => {
  vi.resetAllMocks(); mocks.transaction.mockImplementation((operation: (db: unknown) => unknown, options: { lowPriorityCourseId: string }) => { expect(options.lowPriorityCourseId).toBe("instance"); return operation(mocks.db); }); mocks.auth.mockResolvedValue({ claims: { sub: "student", role: "student", sv: 1 } });
  mocks.scope.mockResolvedValue({ user: { id: "student" }, offering: { id: "offering" }, participation: { id: "participation", enrollmentId: "enrollment" } });
  mocks.db.classroomSubmission.findFirst.mockResolvedValue(draft()); mocks.db.classroomSubmission.findUniqueOrThrow.mockResolvedValue(draft());
  mocks.db.classroomInstance.findUniqueOrThrow.mockResolvedValue({ status: "TEACHING", runtimeConfig: { version: 5 }, activity: { chapter: { offering: { status: "OPEN" } } } });
  mocks.db.enrollment.findUniqueOrThrow.mockResolvedValue({ status: "ACTIVE", researchKey: "research" });
  mocks.db.$queryRaw.mockImplementation((sql: TemplateStringsArray, ...values: unknown[]) => {
    if (sql.join("?").includes('openpbl_document_archive_commit_v1')) return [{ payload: { ...JSON.parse(String(values.at(-1))), sequence: 1 }, reused: false, error_code: null }];
    return sql.join("?").includes('FOR UPDATE OF p') ? [{ userStatus: "ACTIVE", userRole: "STUDENT", sessionVersion: 1, researchKey: "research", instanceStatus: "TEACHING", offeringStatus: "OPEN", enrollmentStatus: "ACTIVE", archivedAt: null, unchanged: true, receipt: null, sequence: 1 }] : [];
  });
  mocks.archive.mockResolvedValue({ bytes: Buffer.from("docx"), sourceHtml: "<p>内容</p>", sha256: "hash", uploadIds: [], imageCount: 0 });
  mocks.unlink.mockResolvedValue(undefined);
});
describe("V2 document finalize", () => {
  it("uses one atomic archive function only after course admission, with combined timing", async () => {
    mocks.admission.mockReturnValue(true);
    const result = await POST(request());
    expect(result.status).toBe(200);
    expect(mocks.admission).toHaveBeenCalledWith(mocks.db, "instance");
    expect(mocks.db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.db.$queryRaw.mock.calls[0][0].join("?")).toContain("public.openpbl_document_archive_commit_v1");
    const timing = result.headers.get("server-timing")!;
    expect(timing).toMatch(/archive_lock_scope_write;dur=[0-9.]+/);
    expect(timing).not.toContain("archive_write;dur=");
    expect(timing).not.toContain("archive_lock_scope;dur=");
    expect(timing).not.toContain("archive_lock;dur=");
    expect(timing).not.toContain("archive_scope;dur=");
  });
  it("atomically binds a real file, immutable version and research receipts", async () => {
    const result = await POST(request());
    expect(result.headers.get("server-timing")).toMatch(/docx;dur=[0-9.]+, file;dur=[0-9.]+, commit;dur=[0-9.]+/);
    expect(result.status).toBe(200); const receipt = await result.json();
    expect(receipt).toMatchObject({ ok: true, versionId: expect.any(String), sequence: 1, submissionVersion: 3, sha256: "hash" });
    expect(mocks.db.$queryRaw).toHaveBeenCalledTimes(4);
    const statements = mocks.db.$queryRaw.mock.calls.map(call => call[0].join("?"));
    expect(statements[0]).toContain("pg_advisory_xact_lock");
    expect(statements[1]).toContain('"ClassroomInstance"');
    expect(statements[2]).toContain('FOR UPDATE OF p');
    expect(statements[3]).toContain('INSERT INTO "ArtifactVersion"');
    expect(statements[3]).toContain('INSERT INTO "DomainEvent"');
    expect(statements[3]).toContain('INSERT INTO "AiInteractionEvent"');
    const values = mocks.db.$queryRaw.mock.calls[3].slice(1);
    expect(values).toContain("research");
    expect(values).toContain("participation");
    const payloads = values.filter((value): value is string => typeof value === "string" && value.startsWith("{")) .map(value => JSON.parse(value));
    expect(payloads).toContainEqual({ view: expect.objectContaining({ version: 3, status: "submitted" }) });
    expect(payloads).toContainEqual(expect.objectContaining({ submissionId: "ui-submission", sourceVersion: 2, versionId: receipt.versionId }));
    expect(mocks.db.classroomInstance.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(mocks.unlink).not.toHaveBeenCalled();
  });
  it.each(["DOCUMENT_CONVERSION_BUSY", "DOCUMENT_CONVERSION_UNAVAILABLE"])("returns retryable 503 for %s without writing a file or receipt", async code => {
    mocks.archive.mockRejectedValue(code === "DOCUMENT_CONVERSION_BUSY" ? new DocumentConversionBusyError() : Object.assign(new Error("Worker unavailable"), { code }));
    const result = await POST(request());
    expect(result.status).toBe(503); expect(result.headers.get("retry-after")).toBe("1");
    expect(await result.json()).toMatchObject({ code });
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.db.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.db.domainEvent.create).not.toHaveBeenCalled(); expect(mocks.unlink).not.toHaveBeenCalled();
  });
  it("rejects stale editor versions before generating an archive", async () => {
    const row = draft(); row.payload.view.version = 3; mocks.db.classroomSubmission.findFirst.mockResolvedValue(row);
    const result = await POST(request()); expect(result.status).toBe(409); expect(mocks.archive).not.toHaveBeenCalled();
  });
  it("cleans the temporary file if the draft changes during Word generation", async () => {
    const implementation = mocks.db.$queryRaw.getMockImplementation()!;
    mocks.db.$queryRaw.mockImplementation(async (...args) => (await implementation(...args)).map((row: object) => ({ ...row, unchanged: false })));
    const result = await POST(request()); expect(result.status).toBe(409);
    expect(mocks.unlink).toHaveBeenCalledOnce(); expect(mocks.db.fileAsset.create).not.toHaveBeenCalled(); expect(mocks.db.artifactVersion.create).not.toHaveBeenCalled();
  });
  it("does not delete an archive when a commit acknowledgement is uncertain", async () => {
    const implementation = mocks.db.$queryRaw.getMockImplementation()!;
    mocks.db.$queryRaw.mockImplementation(async (...args) => (await implementation(...args)).map((row: object) => ({ ...row, unchanged: false })));
    mocks.db.fileAsset.findUnique.mockRejectedValue(new Error("database temporarily unreachable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try { await POST(request()); expect(mocks.unlink).not.toHaveBeenCalled(); }
    finally { log.mockRestore(); }
  });
  it("reuses the durable receipt on a retried request", async () => {
    await POST(request());
    const payload = mocks.db.$queryRaw.mock.calls[3].slice(1).find(value => typeof value === "string" && value.startsWith('{"fingerprint"'));
    const receipt = { payload: JSON.parse(payload) };
    mocks.db.domainEvent.findUnique.mockResolvedValue(receipt); mocks.archive.mockClear(); mocks.write.mockClear();
    const result = await POST(request()); expect(result.status).toBe(200); expect(mocks.archive).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  });
  it("returns the complete committed receipt when another same-ID request wins during rendering", async () => {
    const first = await POST(request()); const saved = await first.json();
    const payload = mocks.db.$queryRaw.mock.calls[3].slice(1).find(value => typeof value === "string" && value.startsWith('{"fingerprint"'));
    const implementation = mocks.db.$queryRaw.getMockImplementation()!;
    mocks.db.$queryRaw.mockClear(); mocks.unlink.mockClear();
    mocks.db.$queryRaw.mockImplementation(async (...args) => (await implementation(...args)).map((row: object) => ({ ...row, unchanged: false, instanceStatus: "FINISHED", receipt: JSON.parse(payload) })));
    const result = await POST(request());
    expect(result.status).toBe(200); expect(await result.json()).toEqual(saved);
    expect(mocks.db.$queryRaw).toHaveBeenCalledTimes(3); expect(mocks.unlink).toHaveBeenCalledOnce();
  });
  it.each([
    { userStatus: "DISABLED", status: 401 }, { userRole: "TEACHER", status: 401 },
    { sessionVersion: 2, status: 401 }, { enrollmentStatus: "WITHDRAWN", status: 403 },
  ])("rejects fresh revocation before both writes and raced receipt replays: %j", async ({ status, ...change }) => {
    await POST(request());
    const payload = mocks.db.$queryRaw.mock.calls[3].slice(1).find(value => typeof value === "string" && value.startsWith('{"fingerprint"'));
    const implementation = mocks.db.$queryRaw.getMockImplementation()!;
    for (const admitted of [false, true]) for (const receipt of [null, JSON.parse(payload)]) {
      mocks.admission.mockReturnValue(admitted);
      mocks.db.$queryRaw.mockClear(); mocks.unlink.mockClear();
      mocks.db.$queryRaw.mockImplementation(async (...args) => admitted
        ? [{ payload: null, reused: false, error_code: status === 401 ? "UNAUTHENTICATED" : "STUDENT_SCOPE_MISMATCH" }]
        : (await implementation(...args)).map((row: object) => ({ ...row, ...change, receipt })));
      expect((await POST(request())).status).toBe(status);
      expect(mocks.db.$queryRaw).toHaveBeenCalledTimes(admitted ? 1 : 3);
      expect(mocks.db.$queryRaw.mock.calls.some(call => call[0].join("?").includes('INSERT INTO "ArtifactVersion"'))).toBe(false);
      expect(mocks.unlink).toHaveBeenCalledOnce();
    }
  });
  it("separates callback lock/scope/write time from transaction envelope time", async () => {
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const implementation = mocks.db.$queryRaw.getMockImplementation()!;
    mocks.db.$queryRaw.mockImplementation(async (...args) => { clock += 2; return implementation(...args); });
    mocks.transaction.mockImplementation(async (operation: (db: unknown) => Promise<unknown>) => {
      clock += 7; // Admission/BEGIN before the supplied callback.
      const result = await operation(mocks.db);
      clock += 11; // Completion after callback return, including COMMIT.
      return result;
    });
    try {
      const result = await POST(request());
      expect(result.status).toBe(200);
      const timing = result.headers.get("server-timing")!;
      for (const entry of ["commit;dur=26.00", "archive_lock;dur=4.00", "archive_scope;dur=2.00", "archive_write;dur=2.00", "archive_callback;dur=8.00", "archive_before_callback;dur=7.00", "archive_after_callback;dur=11.00", "archive_remaining;dur=18.00"]) expect(timing).toContain(entry);
    } finally { now.mockRestore(); }
  });
  it.each([
    { instanceStatus: "FINISHED" }, { offeringStatus: "CLOSED" },
    { enrollmentStatus: "COMPLETED" }, { archivedAt: new Date() },
  ])("checks current classroom/enrollment state after acquiring locks: %j", async change => {
    const implementation = mocks.db.$queryRaw.getMockImplementation()!;
    mocks.db.$queryRaw.mockImplementation(async (...args) => (await implementation(...args)).map((row: object) => ({ ...row, ...change })));
    const result = await POST(request()); expect(result.status).toBe(409);
    expect(mocks.db.$queryRaw).toHaveBeenCalledTimes(3); expect(mocks.unlink).toHaveBeenCalledOnce();
  });
  it("keeps the physical archive if the database proves the uncertain commit succeeded", async () => {
    const implementation = mocks.db.$queryRaw.getMockImplementation()!;
    mocks.db.$queryRaw.mockImplementation(async (...args) => {
      if (args[0].join("?").includes('INSERT INTO "ArtifactVersion"')) throw new Error("lost database commit acknowledgement");
      return implementation(...args);
    });
    mocks.db.fileAsset.findUnique.mockResolvedValue({ id: "durable" });
    expect((await POST(request())).status).toBe(503); expect(mocks.unlink).not.toHaveBeenCalled();
  });
  it("requires authentication before resolving student work", async () => {
    mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    expect((await POST(request())).status).toBe(401); expect(mocks.scope).not.toHaveBeenCalled();
  });
});
