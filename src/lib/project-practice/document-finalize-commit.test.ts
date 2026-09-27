// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
const mocks = vi.hoisted(() => ({ admitted: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/db/transaction-retry", () => ({ hasCourseMutationAdmission: mocks.admitted }));
vi.mock("@/lib/db/session-repository", () => ({ lockProjectedCourse: vi.fn() }));
import { commitDocumentArchive, type DocumentArchiveCommit } from "./document-finalize";
const tx = { $queryRaw: mocks.query } as unknown as Prisma.TransactionClient;
const input = (originalPayload: unknown = { view: { content: "<p>文稿</p>", version: 3 }, extra: { retained: true } }): DocumentArchiveCommit => ({
  courseId: "course", studentId: "student", participationId: "person", offeringId: "offering", sessionVersion: 7,
  submissionId: "submission", submissionViewId: "view-id", originalPayload, expectedVersion: 3,
  receiptKey: "receipt", fingerprint: "fingerprint", requestId: "request", title: "a/b:文稿", uploadId: "upload",
  storageKey: "file.docx", size: 123, sha256: "hash", sourceHtml: "<p>文稿</p>",
});
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-27T10:11:12.345Z"));
  mocks.admitted.mockReturnValue(true);
  mocks.query.mockImplementation(async (_sql, ...values) => [{ payload: { ...JSON.parse(values.at(-1)), sequence: 17 }, reused: false, error_code: null }]);
});
afterEach(() => vi.useRealTimers());
describe("admitted archive single-call commit", () => {
  it("passes original CAS, JS-prepared draft and identical receipt fields in one DB call", async () => {
    const mark = vi.fn(); const original = input(); const result = await commitDocumentArchive(tx, original, mark);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [sql, contextJson, originalJson, draftJson, receiptJson] = mocks.query.mock.calls[0];
    expect(sql.join("?")).toContain("openpbl_document_archive_commit_v1");
    expect(JSON.parse(originalJson)).toEqual(original.originalPayload);
    expect(JSON.parse(draftJson)).toEqual({ view: { content: "<p>文稿</p>", version: 4, status: "submitted", submittedAt: "2026-09-27T10:11:12.345Z" }, extra: { retained: true } });
    expect(JSON.parse(contextJson)).toMatchObject({ sessionVersion: 7, filename: "a_b_文稿.docx", sourceHtml: "<p>文稿</p>", submittedAt: "2026-09-27T10:11:12.345Z" });
    expect(result.payload).toEqual({ ...JSON.parse(receiptJson), sequence: 17 });
    expect(result.payload).toMatchObject({ sourceVersion: 3, submissionVersion: 4, stageKey: "make", submissionId: "view-id", size: 123 });
    expect(mark.mock.calls).toEqual([["lock_scope_write"]]);
  });
  it.each([null, [], "scalar", { view: null, retained: true }, { view: false, retained: true }, { view: 0, retained: true }, { view: "", retained: true }, { view: [], retained: true }, { content: "legacy-flat", version: 3 }])("keeps existing JS object/view semantics for %j", async original => {
    await commitDocumentArchive(tx, input(original));
    const plain = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const base = plain(original);
    const draft = { ...plain(base.view ?? base), version: 4, status: "submitted", submittedAt: "2026-09-27T10:11:12.345Z" };
    expect(JSON.parse(mocks.query.mock.calls[0][3])).toEqual(base.view ? { ...base, view: draft } : draft);
  });
  it.each([["UNAUTHENTICATED", 401], ["STUDENT_SCOPE_MISMATCH", 403], ["IDEMPOTENCY_CONFLICT", 409], ["DRAFT_VERSION_CONFLICT", 409], ["COURSE_LOCKED", 409]])("maps explicit %s result without additional SQL", async (code, status) => {
    mocks.query.mockResolvedValue([{ payload: null, reused: false, error_code: code }]);
    await expect(commitDocumentArchive(tx, input())).rejects.toMatchObject({ code, status });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
  it("returns a replay receipt unchanged, without regenerating its metadata", async () => {
    const receipt = { versionId: "original-version", sequence: 8, submittedAt: "old", fingerprint: "original" };
    mocks.query.mockResolvedValue([{ payload: receipt, reused: true, error_code: null }]);
    expect(await commitDocumentArchive(tx, input())).toEqual({ payload: receipt, reused: true });
  });
  it("propagates database rejection verbatim instead of hiding rollback/timeout failures", async () => {
    const error = new Error("injected audit failure"); mocks.query.mockRejectedValue(error);
    await expect(commitDocumentArchive(tx, input())).rejects.toBe(error);
  });
  it.each([[], [{ payload: {}, reused: false, error_code: "UNKNOWN" }], [{ payload: null, reused: false, error_code: null }]].map(result => ({ result })))("rejects invalid function result %j", async ({ result }) => {
    mocks.query.mockResolvedValue(result); await expect(commitDocumentArchive(tx, input())).rejects.toThrow(/Document archive commit/);
  });
});
