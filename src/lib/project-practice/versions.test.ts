// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
import { listProjectDocumentVersions } from "./versions";

describe("document history and summary reads", () => {
  it("omits archive HTML only when explicitly requested, preserving receipt metadata and filters", async () => {
    const date = new Date("2026-09-27T00:00:00Z");
    const findMany = vi.fn(async (query) => [{ id: "v1", sequence: 2, sourceHtml: query.select.sourceHtml ? "<p>original</p>" : undefined, fileAssetId: "download", sha256: "hash", size: BigInt(123), status: "SUBMITTED", submittedAt: date, createdAt: date, artifact: { id: "document:submission", title: "fallback", participation: { enrollment: { userId: "student" } } } }]);
    const receipts = vi.fn(async () => [{ payload: { versionId: "v1", title: "receipt title", submissionId: "submission", sourceVersion: 9, stageKey: "make", requestId: "stable" } }]);
    const db = { artifactVersion: { findMany }, domainEvent: { findMany: receipts } } as unknown as Prisma.TransactionClient;
    const full = await listProjectDocumentVersions({ courseId: "course", studentId: "student" }, db);
    const summary = await listProjectDocumentVersions({ courseId: "course", studentId: "student", includeSourceHtml: false }, db);
    expect(full[0].sourceHtml).toBe("<p>original</p>");
    expect(summary).toEqual(full.map(row => ({ ...row, sourceHtml: "" })));
    expect(summary[0]).toMatchObject({ title: "receipt title", sourceVersion: 9, requestId: "stable", docxSize: 123 });
    expect(findMany.mock.calls[1][0]).toMatchObject({ where: { artifact: { participation: { instanceId: "course", enrollment: { userId: "student" } } } }, select: { sourceHtml: false } });
    expect(receipts).toHaveBeenCalledWith(expect.objectContaining({ select: { payload: true } }));
    expect(await listProjectDocumentVersions({ courseId: "course", stageKey: "other", includeSourceHtml: false }, db)).toEqual([]);
    expect(await listProjectDocumentVersions({ courseId: "course", submissionId: "other", includeSourceHtml: false }, db)).toEqual([]);
  });
});
