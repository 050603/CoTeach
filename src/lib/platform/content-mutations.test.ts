import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => {
  const model = () => ({ findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), aggregate: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() });
  const tx = { $queryRaw: vi.fn(), courseTeacher: model(), courseOffering: model(), chapter: model(), activity: model(), resource: model(), classroomTemplate: model(), classroomTemplateVersion: model(), classroomInstance: model(), activityProgress: model(), courseInvitation: model(), generationJob: model() };
  return { tx, transaction: vi.fn(), teacher: vi.fn(), student: vi.fn(), activity: vi.fn(), enrollment: vi.fn(), offerings: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ prisma: { activity: { findUnique: mocks.activity }, enrollment: { findUnique: mocks.enrollment }, courseOffering: { findMany: mocks.offerings }, classroomTemplate: mocks.tx.classroomTemplate, generationJob: mocks.tx.generationJob } }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: mocks.transaction }));
vi.mock("./learning-events", () => ({ appendValidatedLearningEvents: vi.fn().mockResolvedValue([]) }));
vi.mock("./access", () => ({ requireTeacherUser: mocks.teacher, requireStudentUser: mocks.student, normalizeUsername: (value: string) => value }));

import { createActivity, createChapter, createClassroomInstance, createTemplateVersion, deleteArchivedPrivateTemplate, getStudentActivity, listPrivateTemplates, listTeacherOfferings, resetOfferingInvitation, restorePrivateTemplate, updateActivity, updateChapter, updateOffering } from "./repository";
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
    mocks.tx.classroomTemplateVersion.findFirst.mockResolvedValue({ id: "version" });
    mocks.tx.activity.create.mockResolvedValue({ id: "activity" });
    await createActivity(teacherClaims, "offering", "chapter", { type: "Classroom", title: "Class", templateVersionId: "version" });
    expectLockedBefore(mocks.tx.activity.aggregate, "Chapter");
    expect(mocks.tx.classroomTemplateVersion.findFirst).toHaveBeenCalledWith({ where: { id: "version", status: { in: ["PUBLISHED", "published"] }, template: { ownerId: "teacher", status: { in: ["ACTIVE", "active"] } } } });
    expect(mocks.tx.classroomInstance.create).toHaveBeenCalledWith({ data: { activityId: "activity", templateVersionId: "version", runNo: 1, status: "SCHEDULED" } });
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it("rejects a classroom activity without an exact course version", async () => {
    mocks.tx.chapter.findFirst.mockResolvedValue({ id: "chapter" });

    await expect(createActivity(teacherClaims, "offering", "chapter", { type: "Classroom", title: "Class" })).rejects.toMatchObject({ code: "TEMPLATE_REQUIRED" });

    expect(mocks.tx.activity.create).not.toHaveBeenCalled();
    expect(mocks.tx.classroomInstance.create).not.toHaveBeenCalled();
  });

  it("binds an uploaded PDF to the reference activity", async () => {
    mocks.tx.chapter.findFirst.mockResolvedValue({ id: "chapter" });
    mocks.tx.activity.aggregate.mockResolvedValue({ _max: { position: null } });
    mocks.tx.activity.create.mockResolvedValue({ id: "activity" });
    mocks.tx.resource.findFirst.mockResolvedValue({ id: "file", fileAsset: { deletedAt: null, mimeType: "application/pdf" } });
    await createActivity(teacherClaims, "offering", "chapter", { type: "Resource", title: "Reference", config: { schemaVersion: 1, resourceKind: "file", fileId: "file", url: "/api/uploads/file" } });
    expect(mocks.tx.resource.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "file", offeringId: "offering", createdById: "teacher" }) }));
    expect(mocks.tx.resource.update).toHaveBeenCalledWith({ where: { id: "file" }, data: { activityId: "activity" } });
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
    mocks.tx.activity.findUnique.mockResolvedValue({ chapterId: "chapter", version: 2, chapter: { offeringId: "offering" } });
    await expect(updateActivity(teacherClaims, "activity", { version: 1, templateVersionId: "version" })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(mocks.tx.$queryRaw.mock.calls[0][0].join("")).toContain('FROM "Chapter"');
    expect(mocks.tx.$queryRaw.mock.calls[1][0].join("")).toContain('FROM "Activity"');
    expect(mocks.tx.activity.update).not.toHaveBeenCalled();
    expect(mocks.tx.classroomInstance.create).not.toHaveBeenCalled();
  });

  it("locks every active activity when its chapter is locked", async () => {
    mocks.tx.chapter.findUnique.mockResolvedValue({ id: "chapter", offeringId: "offering", version: 2 });
    mocks.tx.chapter.update.mockResolvedValue({ id: "chapter", isOpen: false, version: 3 });

    await updateChapter(teacherClaims, "chapter", { isOpen: false, version: 2 });

    expect(mocks.tx.activity.updateMany).toHaveBeenCalledWith({
      where: { chapterId: "chapter", archivedAt: null, isOpen: true },
      data: { isOpen: false, version: { increment: 1 } },
    });
    expect(mocks.tx.chapter.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "chapter" },
      data: expect.objectContaining({ isOpen: false }),
    }));
  });

  it("unlocks the parent chapter when an activity is unlocked", async () => {
    mocks.tx.activity.findUnique.mockResolvedValue({
      id: "activity",
      chapterId: "chapter",
      type: "RESOURCE",
      version: 4,
      chapter: { id: "chapter", offeringId: "offering", isOpen: false },
    });
    mocks.tx.activity.update.mockResolvedValue({ id: "activity", isOpen: true, version: 5 });

    await updateActivity(teacherClaims, "activity", { isOpen: true, version: 4 });

    expect(mocks.tx.chapter.update).toHaveBeenCalledWith({
      where: { id: "chapter" },
      data: { isOpen: true, version: { increment: 1 } },
    });
    expect(mocks.tx.activity.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "activity" },
      data: expect.objectContaining({ isOpen: true }),
    }));
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

  it("never reuses an active run from a different selected course version", async () => {
    mocks.tx.activity.findUnique.mockResolvedValue({ id: "activity", chapter: { offeringId: "offering" } });
    mocks.tx.classroomTemplateVersion.findUnique.mockResolvedValue({ status: "PUBLISHED", snapshot: {}, template: { ownerId: "teacher", status: "ACTIVE" } });
    mocks.tx.classroomInstance.findFirst.mockResolvedValue(null);
    mocks.tx.classroomInstance.aggregate.mockResolvedValue({ _max: { runNo: 3 } });
    mocks.tx.classroomInstance.create.mockResolvedValue({ id: "new-run", templateVersionId: "selected-version" });

    await createClassroomInstance(teacherClaims, "activity", "selected-version");

    expect(mocks.tx.classroomInstance.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ activityId: "activity", templateVersionId: "selected-version" }),
    }));
    expect(mocks.tx.classroomInstance.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ templateVersionId: "selected-version", runNo: 4 }),
    }));
  });

  it("rejects versions whose course has already been deleted", async () => {
    mocks.tx.activity.findUnique.mockResolvedValue({ id: "activity", chapter: { offeringId: "offering" } });
    mocks.tx.classroomTemplateVersion.findUnique.mockResolvedValue({ status: "PUBLISHED", template: { ownerId: "teacher", status: "DELETED" } });

    await expect(createClassroomInstance(teacherClaims, "activity", "deleted-version")).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.tx.classroomInstance.findFirst).not.toHaveBeenCalled();
    expect(mocks.tx.classroomInstance.create).not.toHaveBeenCalled();
  });

  it("serializes invitation replacement before deactivating previous invitations", async () => {
    await resetOfferingInvitation(teacherClaims, "offering", {});
    expectLockedBefore(mocks.tx.courseInvitation.updateMany, "CourseOffering");
    expect(mocks.tx.courseInvitation.create).toHaveBeenCalledWith({ data: expect.objectContaining({ offeringId: "offering", status: "ACTIVE" }) });
  });
});

describe("course library lifecycle", () => {
  it("excludes deleted templates from the teacher library", async () => {
    mocks.tx.classroomTemplate.findMany.mockResolvedValue([]);
    await listPrivateTemplates(teacherClaims);
    expect(mocks.tx.classroomTemplate.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerId: "teacher", status: { notIn: ["DELETED", "deleted"] } } }));
  });

  it("includes the latest active generation status for each course", async () => {
    mocks.tx.classroomTemplate.findMany.mockResolvedValue([{ id: "template", versions: [] }]);
    mocks.tx.generationJob.findMany.mockResolvedValue([
      { targetId: "template", status: "RUNNING" },
      { targetId: "template", status: "QUEUED" },
    ]);

    await expect(listPrivateTemplates(teacherClaims)).resolves.toEqual([
      expect.objectContaining({ id: "template", generationStatus: "running" }),
    ]);
    expect(mocks.tx.generationJob.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ targetId: { in: ["template"] } }),
      orderBy: { updatedAt: "desc" },
    }));
  });

  it("restores archived templates and logically deletes only archived templates", async () => {
    mocks.tx.classroomTemplate.findFirst.mockResolvedValueOnce({ id: "template", status: "ARCHIVED" });
    await restorePrivateTemplate(teacherClaims, "template");
    expect(mocks.tx.classroomTemplate.update).toHaveBeenLastCalledWith({ where: { id: "template" }, data: { status: "ACTIVE" } });

    mocks.tx.classroomTemplate.findFirst.mockResolvedValueOnce({ id: "template", status: "ARCHIVED" });
    await deleteArchivedPrivateTemplate(teacherClaims, "template");
    expect(mocks.tx.classroomTemplate.update).toHaveBeenLastCalledWith({ where: { id: "template" }, data: { status: "DELETED" } });

    mocks.tx.classroomTemplate.findFirst.mockResolvedValueOnce({ id: "active", status: "ACTIVE" });
    await expect(deleteArchivedPrivateTemplate(teacherClaims, "active")).rejects.toMatchObject({ code: "TEMPLATE_NOT_ARCHIVED" });
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

  it("projects the preparation cover onto student classroom instances", async () => {
    const snapshot = { schemaVersion: 2, kind: "pbl-course", design: { coverImageUrl: "/classroom-cover.webp" } };
    mocks.activity.mockResolvedValue({
      id: "activity",
      type: "CLASSROOM",
      ...release,
      chapterId: "chapter",
      chapter: { id: "chapter", title: "第一章", position: 0, ...release, offering: { id: "offering", name: "课程", status: "FINISHED" } },
      classroomInstances: [{ id: "instance", status: "FINISHED", startedAt: new Date(), endedAt: new Date(), templateVersion: { id: "version", version: 1, snapshot, mediaRefs: null } }],
    });
    mocks.enrollment.mockResolvedValue({ id: "enrollment", status: "COMPLETED", activityProgress: [] });
    const result = await getStudentActivity(studentClaims, "activity");
    expect(result.instances[0]).toMatchObject({ id: "instance", coverImageUrl: "/classroom-cover.webp" });
    expect(result.instance).toMatchObject({ id: "instance", coverImageUrl: "/classroom-cover.webp" });
  });
});

describe("teacher offering classroom covers", () => {
  it("projects each latest template snapshot cover onto the chapter activity instance", async () => {
    const snapshot = { schemaVersion: 2, kind: "pbl-course", design: { coverImageUrl: "https://cdn.example.test/classroom.webp" } };
    mocks.offerings.mockResolvedValue([{
      id: "offering",
      name: "课程",
      status: "OPEN",
      settings: { referenceLinks: [{ id: "reading", title: "延伸阅读", url: "https://example.test/reading" }] },
      invitations: [],
      resources: [{ title: "观察手册", fileAsset: { id: "8f31b270-b23d-4ec1-bd2b-8543210bcf88", originalName: "观察手册.pdf", size: BigInt(2048), mimeType: "application/pdf", deletedAt: null } }],
      _count: { enrollments: 2 },
      chapters: [{
        id: "chapter",
        activities: [{
          id: "activity",
          type: "CLASSROOM",
          classroomInstances: [{ id: "instance", status: "SCHEDULED", templateVersion: { id: "version", templateId: "template", version: 1, status: "PUBLISHED", snapshot } }],
        }],
      }],
    }]);
    const result = await listTeacherOfferings(teacherClaims);
    expect(result[0].chapters[0].activities[0]).toMatchObject({
      templateId: "template",
      templateVersionId: "version",
    });
    expect(result[0].chapters[0].activities[0].instances[0]).toMatchObject({
      id: "instance",
      templateVersionId: "version",
      coverImageUrl: "https://cdn.example.test/classroom.webp",
    });
    expect(result[0].courseReferences).toEqual([
      { id: "reading", kind: "link", title: "延伸阅读", url: "https://example.test/reading" },
      expect.objectContaining({ id: "8f31b270-b23d-4ec1-bd2b-8543210bcf88", kind: "file", title: "观察手册", fileName: "观察手册.pdf", url: "/api/uploads/8f31b270-b23d-4ec1-bd2b-8543210bcf88" }),
    ]);
    expect(mocks.offerings).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        chapters: expect.objectContaining({
          include: expect.objectContaining({
            activities: expect.objectContaining({
              include: expect.objectContaining({
                classroomInstances: expect.objectContaining({
                  include: { templateVersion: { select: expect.objectContaining({ snapshot: true }) } },
                }),
              }),
            }),
          }),
        }),
      }),
    }));
  });
});
