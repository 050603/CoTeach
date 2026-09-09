import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
const mocks = vi.hoisted(() => ({ user: vi.fn(), participation: vi.fn(), workspace: vi.fn(), write: vi.fn(), transaction: vi.fn(), lock: vi.fn() }));
vi.mock("./access", () => ({ getPlatformUser: mocks.user, requireTeacherUser: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { classroomParticipation: { findUnique: mocks.participation }, studentProjectWorkspace: { findUnique: mocks.workspace }, $transaction: mocks.transaction } }));
import { readClassroom, saveWorkspace } from "./classroom";
const claims = { role: "student", sub: "student" } as AuthClaims;
function participation(status = "FINISHED") {
  return { id: "p", instanceId: "i", firstEnteredAt: null, lastEnteredAt: null, completedAt: new Date(), stageProgress: {},
    enrollment: { userId: "student", offeringId: "o", status: "COMPLETED", user: { displayName: "小林" } },
    instance: { id: "i", status, activityId: "a", runNo: 1, runtimeConfig: {}, templateVersion: { version: 1, snapshot: { kind: "pbl-course" } }, activity: { title: "历史课堂", chapter: { offeringId: "o", offering: { status: "FINISHED", name: "课程" } } } },
  };
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.user.mockResolvedValue({ id: "student", role: "student" }); mocks.participation.mockResolvedValue(participation());
  mocks.workspace.mockResolvedValue({ version: 3, projectState: { document: "已保存的历史文档" }, updatedAt: null });
  mocks.transaction.mockImplementation((fn) => fn({ $queryRaw: mocks.lock, classroomParticipation: { findUnique: mocks.participation }, studentProjectWorkspace: { findUnique: mocks.workspace, upsert: mocks.write } }));
});
describe("student historical classroom access", () => {
  it("reads the student's finished PBL participation after course completion without writing", async () => {
    const record = await readClassroom(claims, "p");
    expect(record.canWrite).toBe(false);
    expect(record.instance.snapshot).toEqual({ kind: "pbl-course" });
    expect(record.workspace.projectState).toEqual({ document: "已保存的历史文档" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(["FINISHED", "SCHEDULED"])("rejects workspace mutations in %s without altering saved content", async (status) => {
    mocks.participation.mockResolvedValue(participation(status));
    await expect(saveWorkspace(claims, "p", { version: 3, idempotencyKey: "attempt", document: "overwrite" })).rejects.toMatchObject({ code: "CLASSROOM_READ_ONLY" });
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("does not expose another student's historical record", async () => {
    mocks.user.mockResolvedValue({ id: "other-student", role: "student" });
    await expect(readClassroom(claims, "p")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.workspace).not.toHaveBeenCalled();
  });
});
