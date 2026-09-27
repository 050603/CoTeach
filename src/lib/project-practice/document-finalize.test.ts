import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ $queryRaw: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
import { authorizeDocumentArchiveScope } from "./document-finalize";
beforeEach(() => { vi.resetAllMocks(); db.$queryRaw.mockResolvedValue([{ participationId: "owned-participation", offeringId: "offering", userStatus: "ACTIVE", userRole: "STUDENT", sessionVersion: 1 }]); });
describe("narrow document archive authorization", () => {
  it("returns only the caller's owned participation without loading course configuration", async () => {
    expect(await authorizeDocumentArchiveScope({ sub: "student", role: "student", studentName: "学生", sv: 1 }, "course", "student")).toEqual({ user: { id: "student" }, participation: { id: "owned-participation" }, offering: { id: "offering" } });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = db.$queryRaw.mock.calls[0][0].join("?");
    expect(sql).toContain('e."userId" = u.id'); expect(sql).toContain('e."offeringId" = o.id');
    expect(sql).not.toContain('"runtimeConfig"'); expect(sql).not.toContain('"snapshot"');
  });
  it("rejects cross-student IDs before reading work", async () => {
    await expect(authorizeDocumentArchiveScope({ sub: "student", role: "student", studentName: "学生", sv: 1 }, "course", "other")).rejects.toMatchObject({ code: "STUDENT_SCOPE_MISMATCH", status: 403 });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it("does not grant access without an eligible enrollment and participation", async () => {
    db.$queryRaw.mockResolvedValue([{ participationId: null, offeringId: "offering", userStatus: "ACTIVE", userRole: "STUDENT", sessionVersion: 1 }]);
    await expect(authorizeDocumentArchiveScope({ sub: "student", role: "student", studentName: "学生", sv: 1 }, "course")).rejects.toMatchObject({ code: "STUDENT_SCOPE_MISMATCH" });
  });
  it("rechecks a deactivated account before accessing a saved receipt", async () => {
    db.$queryRaw.mockResolvedValue([{ participationId: "owned", offeringId: "offering", userStatus: "DISABLED", userRole: "STUDENT", sessionVersion: 1 }]);
    await expect(authorizeDocumentArchiveScope({ sub: "student", role: "student", studentName: "学生", sv: 1 }, "course")).rejects.toMatchObject({ status: 401 });
  });
  it.each([{ userRole: "TEACHER" }, { sessionVersion: 2 }])("rechecks current role/session before the fast receipt lookup: %j", async change => {
    db.$queryRaw.mockResolvedValue([{ participationId: "owned", offeringId: "offering", userStatus: "ACTIVE", userRole: "STUDENT", sessionVersion: 1, ...change }]);
    await expect(authorizeDocumentArchiveScope({ sub: "student", role: "student", studentName: "学生", sv: 1 }, "course")).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
  });
});
