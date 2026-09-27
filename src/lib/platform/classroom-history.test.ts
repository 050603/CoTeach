import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
const mocks = vi.hoisted(() => ({ user: vi.fn(), participation: vi.fn(), workspace: vi.fn(), write: vi.fn(), transaction: vi.fn(), lock: vi.fn() }));
vi.mock("./access", () => ({ getPlatformUser: mocks.user, requireTeacherUser: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { classroomParticipation: { findUnique: mocks.participation }, studentProjectWorkspace: { findUnique: mocks.workspace }, $transaction: mocks.transaction } }));
import { readClassroom, saveWorkspace } from "./classroom";
const claims = { role: "student", sub: "student" } as AuthClaims;
function participation(status = "FINISHED") {
  const snapshot = { schemaVersion: 2, kind: "pbl-course", design: { coverImageUrl: "/history-cover.webp" } };
  return { id: "p", instanceId: "i", firstEnteredAt: null, lastEnteredAt: null, completedAt: new Date(), stageProgress: {},
    enrollment: { userId: "student", offeringId: "o", status: "COMPLETED", user: { displayName: "小林" } },
    instance: { id: "i", status, activityId: "a", runNo: 1, runtimeConfig: {}, templateVersion: { version: 1, snapshot }, activity: { title: "历史课堂", chapter: { offeringId: "o", offering: { status: "FINISHED", name: "课程" } } } },
  };
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.lock.mockResolvedValue([{ id: "i" }]); mocks.user.mockResolvedValue({ id: "student", role: "student" }); mocks.participation.mockResolvedValue(participation());
  mocks.workspace.mockResolvedValue({ version: 3, projectState: { document: "已保存的历史文档" }, updatedAt: null });
  mocks.transaction.mockImplementation((fn) => fn({ $queryRaw: mocks.lock, classroomParticipation: { findUnique: mocks.participation }, studentProjectWorkspace: { findUnique: mocks.workspace, upsert: mocks.write } }));
});
describe("student historical classroom access", () => {
  it("reads the student's finished PBL participation after course completion without writing", async () => {
    const record = await readClassroom(claims, "p");
    expect(record.canWrite).toBe(false);
    expect(record.instance.snapshot).toMatchObject({ kind: "pbl-course" });
    expect(record.instance.coverImageUrl).toBe("/history-cover.webp");
    expect(record.workspace.projectState).toEqual({ document: "已保存的历史文档" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(["FINISHED", "SCHEDULED"])("rejects workspace mutations in %s without altering saved content", async (status) => {
    mocks.participation.mockResolvedValue(participation(status));
    await expect(saveWorkspace(claims, "p", { version: 3, idempotencyKey: "attempt", document: "overwrite" })).rejects.toMatchObject({ code: "CLASSROOM_READ_ONLY" });
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("locks classroom before participation and rechecks closure after both waits", async () => {
    mocks.lock.mockImplementation(async (query: TemplateStringsArray) => {
      if (query.join("").includes("FOR UPDATE OF ci")) return [{ id: "i" }];
      mocks.participation.mockResolvedValue(participation("FINISHED"));
      return [{ id: "p" }];
    });
    await expect(saveWorkspace(claims, "p", { version: 3, idempotencyKey: "close-race", document: "pending" })).rejects.toMatchObject({ code: "CLASSROOM_READ_ONLY" });
    expect(mocks.lock.mock.calls[0][0].join("")).toContain("FOR UPDATE OF ci");
    expect(mocks.lock.mock.calls[1][0].join("")).toContain('FROM "ClassroomParticipation"');
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("rejects revoked membership observed after the lock wait", async () => {
    const row = participation("TEACHING"); row.enrollment.status = "WITHDRAWN";
    mocks.participation.mockResolvedValue(row);
    await expect(saveWorkspace(claims, "p", { version: 3, idempotencyKey: "revoked", document: "pending" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("rejects participation reassignment instead of writing under another classroom lock", async () => {
    mocks.lock.mockResolvedValue([{ id: "different-instance" }]);
    await expect(saveWorkspace(claims, "p", { version: 3, idempotencyKey: "moved", document: "pending" })).rejects.toMatchObject({ code: "SCOPE_MISMATCH" });
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("does not expose another student's historical record", async () => {
    mocks.user.mockResolvedValue({ id: "other-student", role: "student" });
    await expect(readClassroom(claims, "p")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.workspace).not.toHaveBeenCalled();
  });
});
