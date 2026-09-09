import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => {
  const model = () => ({ findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findFirst: vi.fn(), aggregate: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() });
  const tx = { $queryRaw: vi.fn(), courseTeacher: model(), courseOffering: model(), chapter: model(), activity: model(), classroomTemplate: model(), classroomTemplateVersion: model(), classroomInstance: model(), activityProgress: model(), courseInvitation: model() };
  return { tx, transaction: vi.fn(), teacher: vi.fn(), student: vi.fn(), activity: vi.fn(), enrollment: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ prisma: { activity: { findUnique: mocks.activity }, enrollment: { findUnique: mocks.enrollment } } }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: mocks.transaction }));
vi.mock("./learning-events", () => ({ appendValidatedLearningEvents: vi.fn().mockResolvedValue([]) }));
vi.mock("./access", () => ({ requireTeacherUser: mocks.teacher, requireStudentUser: mocks.student, normalizeUsername: (value: string) => value }));

import { createActivity, createChapter, createClassroomInstance, createTemplateVersion, getStudentActivity, resetOfferingInvitation, updateActivity, updateChapter, updateOffering } from "./repository";
const teacherClaims = { sub: "teacher", role: "teacher" } as AuthClaims;
const studentClaims = { sub: "student", role: "student" } as AuthClaims;
const release = { isOpen: true, opensAt: null, archivedAt: null };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation((operation) => operation(mocks.tx));
  mocks.teacher.mockResolvedValue({ id: "teacher" });
  mocks.student.mockResolvedValue({ id: "student" });
  mocks.tx.courseTeacher.findFirst.mockResolvedValue({ userId: "teacher" });
});

function expectLockedBefore(read: ReturnType<typeof vi.fn>, table: string) {
  expect(mocks.tx.$queryRaw.mock.calls[0][0].join("")).toContain(`FROM "${table}"`);
  expect(mocks.tx.$queryRaw.mock.calls[0][0].join("")).toContain("FOR UPDATE");
  expect(mocks.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]);
}

describe("serialized content changes", () => {
  it("allocates chapter position after locking its offering", async () => {
    mocks.tx.chapter.aggregate.mockResolvedValue({ _max: { position: 7 } });
    await createChapter(teacherClaims, "offering", { title: "Chapter" });
    expectLockedBefore(mocks.tx.chapter.aggregate, "CourseOffering");
    expect(mocks.tx.chapter.create).toHaveBeenCalledWith({ data: expect.objectContaining({ position: 8 }) });
  });

  it("creates classroom activity and its first run in the same transaction", async () => {
    mocks.tx.chapter.findFirst.mockResolvedValue({ id: "chapter" });
    mocks.tx.activity.aggregate.mockResolvedValue({ _max: { position: null } });
    mocks.tx.classroomTemplate.findFirst.mockResolvedValue({ versions: [{ id: "version" }] });
    mocks.tx.activity.create.mockResolvedValue({ id: "activity" });
    await createActivity(teacherClaims, "offering", "chapter", { type: "Classroom", title: "Class", templateId: "template" });
    expectLockedBefore(mocks.tx.activity.aggregate, "Chapter");
    expect(mocks.tx.classroomInstance.create).toHaveBeenCalledWith({ data: { activityId: "activity", templateVersionId: "version", runNo: 1, status: "SCHEDULED" } });
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it("rejects stale offering and chapter versions inside the locked transaction", async () => {
    mocks.tx.courseOffering.findUnique.mockResolvedValue({ version: 2 });
    await expect(updateOffering(teacherClaims, "offering", { name: "Changed", version: 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expectLockedBefore(mocks.tx.courseOffering.findUnique, "CourseOffering");
    expect(mocks.tx.courseOffering.update).not.toHaveBeenCalled();
    mocks.tx.$queryRaw.mockClear();
    mocks.tx.chapter.findUnique.mockResolvedValue({ version: 2, offeringId: "offering" });
    await expect(updateChapter(teacherClaims, "chapter", { title: "Changed", version: 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expectLockedBefore(mocks.tx.chapter.findUnique, "Chapter");
    expect(mocks.tx.chapter.update).not.toHaveBeenCalled();
  });

  it("rejects stale activity versions without creating replacement runs", async () => {
    mocks.tx.activity.findUnique.mockResolvedValue({ version: 2, chapter: { offeringId: "offering" } });
    await expect(updateActivity(teacherClaims, "activity", { version: 1, templateId: "template" })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expectLockedBefore(mocks.tx.activity.findUnique, "Activity");
    expect(mocks.tx.activity.update).not.toHaveBeenCalled();
    expect(mocks.tx.classroomInstance.create).not.toHaveBeenCalled();
  });

  it("allocates template revisions and classroom run numbers under their parent locks", async () => {
    mocks.tx.classroomTemplate.findFirst.mockResolvedValue({ versions: [{ version: 5 }] });
    await createTemplateVersion(teacherClaims, "template", { snapshot: {} });
    expectLockedBefore(mocks.tx.classroomTemplate.findFirst, "ClassroomTemplate");
    expect(mocks.tx.classroomTemplateVersion.create).toHaveBeenCalledWith({ data: expect.objectContaining({ version: 6 }) });
    mocks.tx.$queryRaw.mockClear();
    mocks.tx.activity.findUnique.mockResolvedValue({ id: "activity", chapter: { offeringId: "offering" } });
    mocks.tx.classroomTemplateVersion.findUnique.mockResolvedValue({ status: "PUBLISHED", template: { ownerId: "teacher", status: "ACTIVE" } });
    mocks.tx.classroomInstance.aggregate.mockResolvedValue({ _max: { runNo: 4 } });
    await createClassroomInstance(teacherClaims, "activity", "version");
    expectLockedBefore(mocks.tx.classroomInstance.aggregate, "Activity");
    expect(mocks.tx.classroomInstance.create).toHaveBeenCalledWith({ data: expect.objectContaining({ runNo: 5 }), include: { templateVersion: true } });
  });

  it.each(["SCHEDULED", "TEACHING"])("reuses an existing %s run on repeated entry", async (status) => {
    mocks.tx.activity.findUnique.mockResolvedValue({ id: "activity", chapter: { offeringId: "offering" } });
    mocks.tx.classroomTemplateVersion.findUnique.mockResolvedValue({ status: "PUBLISHED", template: { ownerId: "teacher", status: "ACTIVE" } });
    const active = { id: "existing", status, runNo: 2 };
    mocks.tx.classroomInstance.findFirst.mockResolvedValue(active);
    await expect(createClassroomInstance(teacherClaims, "activity", "version")).resolves.toEqual(active);
    expectLockedBefore(mocks.tx.classroomInstance.findFirst, "Activity");
    expect(mocks.tx.classroomInstance.create).not.toHaveBeenCalled();
  });

  it("serializes invitation replacement before deactivating previous invitations", async () => {
    await resetOfferingInvitation(teacherClaims, "offering", {});
    expectLockedBefore(mocks.tx.courseInvitation.updateMany, "CourseOffering");
    expect(mocks.tx.courseInvitation.create).toHaveBeenCalledWith({ data: expect.objectContaining({ offeringId: "offering", status: "ACTIVE" }) });
  });
});

describe("activity access concurrent with completion", () => {
  it("preserves the committed completion even when the initial enrollment snapshot was not started", async () => {
    mocks.activity.mockResolvedValue({ id: "activity", type: "ASSIGNMENT", ...release, chapterId: "chapter", chapter: { id: "chapter", ...release, offering: { id: "offering", status: "OPEN" } }, classroomInstances: [] });
    mocks.enrollment.mockResolvedValue({ id: "enrollment", status: "ACTIVE", activityProgress: [{ status: "NOT_STARTED", startedAt: null }] });
    mocks.tx.activityProgress.findUniqueOrThrow.mockResolvedValue({ status: "COMPLETED", progressData: { answer: "saved" } });
    const result = await getStudentActivity(studentClaims, "activity");
    expect(mocks.tx.activityProgress.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { lastAccessedAt: expect.any(Date) } }));
    expect(mocks.tx.activityProgress.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { enrollmentId: "enrollment", activityId: "activity", status: { in: ["NOT_STARTED", "not_started"] } } }));
    expect(result.progress.status).toBe("completed");
    expect(result.progress.progressData).toEqual({ answer: "saved" });
  });
});
