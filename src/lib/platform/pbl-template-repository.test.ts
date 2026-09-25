import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ template: vi.fn(), findVersion: vi.fn(), createTemplate: vi.fn(), updateTemplate: vi.fn(), createVersion: vi.fn(), updateVersion: vi.fn(), files: vi.fn(), transaction: vi.fn(), lock: vi.fn(), readClassroom: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/lib/openmaic/server/classroom-storage", () => ({ readClassroom: mocks.readClassroom, isValidClassroomId: (value: string) => Boolean(value) }));
import { createPblTemplateCourse, encodePblTemplate } from "./pbl-template";
import { getPblTemplatePublicationState, getPblTemplateVersionHistory, restorePblTemplateVersion, savePblTemplateCourse } from "./pbl-template-repository";
const now = new Date("2026-09-01T00:00:00Z");
const course = createPblTemplateCourse("template", { name: "Original" });
function template(status = "DRAFT") { return { id: "template", ownerId: "teacher", status: "ACTIVE", createdAt: now, updatedAt: now, versions: [{ id: "v1", version: 1, status, snapshot: encodePblTemplate(course) }] }; }
beforeEach(() => {
  vi.resetAllMocks(); mocks.template.mockResolvedValue(template()); mocks.files.mockResolvedValue([]); mocks.readClassroom.mockResolvedValue({ id: "classroom" });
  mocks.transaction.mockImplementation((fn) => fn({
    $executeRaw: mocks.lock, classroomTemplate: { findUnique: mocks.template, create: mocks.createTemplate, update: mocks.updateTemplate },
    classroomTemplateVersion: { findUnique: mocks.findVersion, create: mocks.createVersion, update: mocks.updateVersion }, fileAsset: { findMany: mocks.files },
  }));
});
describe("V2 PBL template persistence", () => {
  it("reports the immutable published version separately from the editable draft", async () => {
    const state = await getPblTemplatePublicationState("template", {
      classroomTemplate: {
        findUnique: vi.fn().mockResolvedValue({
          versions: [
            { version: 3, status: "DRAFT" },
            { version: 2, status: "PUBLISHED" },
          ],
        }),
      },
    } as never);
    expect(state).toEqual({ latestVersion: 3, publishedVersion: 2, draftVersion: 3 });
  });

  it("uses the immutable published snapshot as the source of a new editable draft", async () => {
    mocks.template.mockResolvedValue(template("PUBLISHED"));
    await savePblTemplateCourse({ ...course, name: "Revised", version: now.getTime(), status: "ready" }, "teacher");
    expect(mocks.updateVersion).not.toHaveBeenCalled();
    expect(mocks.createVersion).toHaveBeenCalledWith({ data: expect.objectContaining({ templateId: "template", version: 2, status: "DRAFT", snapshot: expect.objectContaining({ design: expect.objectContaining({ name: "Revised" }) }) }) });
  });
  it("publishes a draft without mutating any previous version", async () => {
    await savePblTemplateCourse({ ...course, version: now.getTime(), status: "ready" }, "teacher");
    expect(mocks.updateVersion).toHaveBeenCalledWith({ where: { id: "v1" }, data: expect.objectContaining({ status: "PUBLISHED" }) });
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });
  it("rejects stale authoring writes before touching the template", async () => {
    await expect(savePblTemplateCourse({ ...course, version: now.getTime() - 1 }, "teacher")).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(mocks.updateTemplate).not.toHaveBeenCalled();
  });
  it("requires ownership of the template and referenced upload assets", async () => {
    await expect(savePblTemplateCourse(course, "other")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(savePblTemplateCourse({ ...course, resources: [{ id: "foreign", title: "Private file", type: "PDF", size: "1 MB", downloadedBy: [] }] }, "teacher")).rejects.toMatchObject({ code: "INVALID_TEMPLATE_RESOURCE" });
    expect(mocks.files).toHaveBeenCalledWith({ where: { id: { in: ["foreign"] }, uploadedById: "teacher", deletedAt: null }, select: { id: true } });
  });
  it("preserves published version identity on a content-identical save", async () => {
    const snapshot = JSON.parse(JSON.stringify(encodePblTemplate(course)));
    mocks.template.mockResolvedValue({ ...template("PUBLISHED"), versions: [{ ...template("PUBLISHED").versions[0], snapshot }] });
    await savePblTemplateCourse(course, "teacher");
    expect(mocks.updateVersion).not.toHaveBeenCalled(); expect(mocks.createVersion).not.toHaveBeenCalled();
  });

  it("lists immutable versions with their own pages and measured audio", async () => {
    const historical = createPblTemplateCourse("template", {
      name: "旧版课程",
      aiLearningClassroomId: "classroom",
      content: {
        ...course.content,
        teachingTimingAudit: { schemaVersion: 1, totalBudgetSec: 1200, plannedSubstantiveTeachingSec: 900, plannedAssessmentSec: 100, plannedLearnerActivitySec: 200,
          substantiveTeachingDurationSec: 430, assessmentAudioDurationSec: 70, narrationDurationSource: "actual-audio", measuredSegmentCount: 2,
          narrationSegmentCount: 2, complete: true, substantiveTeachingRatio: 0.5, teachingRatioValid: true, generatedAt: now.toISOString() },
      },
    });
    const current = createPblTemplateCourse("template", { name: "当前草稿" });
    const database = { classroomTemplate: { findUnique: vi.fn().mockResolvedValue({ updatedAt: now, versions: [
      { version: 2, status: "DRAFT", createdAt: now, snapshot: encodePblTemplate(current) },
      { version: 1, status: "PUBLISHED", createdAt: now, snapshot: encodePblTemplate(historical) },
    ] }) } } as never;
    const result = await getPblTemplateVersionHistory("template", 1, database);
    expect(result.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(result.selected).toMatchObject({ name: "旧版课程", classroomId: "classroom", measuredSpeechSeconds: 500, classroomAvailable: true });
    expect(mocks.readClassroom).toHaveBeenCalledWith("classroom");
  });

  it("restores a published snapshot as a new draft and keeps the current draft immutable", async () => {
    const current = createPblTemplateCourse("template", { name: "当前草稿" });
    const old = createPblTemplateCourse("template", { name: "旧版课程", aiLearningClassroomId: "classroom",
      content: { ...course.content, teacherReview: { signature: "old-signature" } as never } });
    mocks.template.mockResolvedValue({ ...template(), versions: [{ id: "v2", version: 2, status: "DRAFT", snapshot: encodePblTemplate(current) }] });
    mocks.findVersion.mockResolvedValue({ id: "v1", version: 1, status: "PUBLISHED", snapshot: encodePblTemplate(old), mediaRefs: null });
    const result = await restorePblTemplateVersion("template", "teacher", 1, now.getTime());
    expect(mocks.updateVersion).toHaveBeenCalledWith({ where: { id: "v2" }, data: { status: "SUPERSEDED" } });
    expect(mocks.createVersion).toHaveBeenCalledWith({ data: expect.objectContaining({ templateId: "template", version: 3, status: "DRAFT", snapshot: expect.objectContaining({ design: expect.objectContaining({ name: "旧版课程", content: expect.not.objectContaining({ teacherReview: expect.anything() }) }) }) }) });
    expect(mocks.updateTemplate).toHaveBeenCalledWith({ where: { id: "template" }, data: expect.objectContaining({ title: "旧版课程" }) });
    expect(result.version).toBe(3);
  });

  it("rejects a stale restore before changing any version", async () => {
    await expect(restorePblTemplateVersion("template", "teacher", 1, now.getTime() - 1)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(mocks.updateVersion).not.toHaveBeenCalled();
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });

  it("refuses to restore when the historical classroom file is missing", async () => {
    const old = createPblTemplateCourse("template", { name: "旧版", aiLearningClassroomId: "classroom" });
    mocks.template.mockResolvedValue({ ...template("PUBLISHED"), versions: [{ id: "v2", version: 2, status: "PUBLISHED" }] });
    mocks.findVersion.mockResolvedValue({ id: "v1", version: 1, status: "PUBLISHED", snapshot: encodePblTemplate(old) });
    mocks.readClassroom.mockResolvedValue(null);
    await expect(restorePblTemplateVersion("template", "teacher", 1, now.getTime())).rejects.toMatchObject({ code: "MISSING_VERSION_CLASSROOM" });
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });
});
