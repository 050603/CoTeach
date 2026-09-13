import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { emptyResourcePackageDraft, type CourseResourcePackage } from "./types";

const mocks = vi.hoisted(() => ({ template: vi.fn(), file: vi.fn(), design: vi.fn(), content: vi.fn(), find: vi.fn(), update: vi.fn(), upsert: vi.fn(), load: vi.fn(), save: vi.fn(), stat: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { classroomTemplate: { findUnique: mocks.template }, fileAsset: { findFirst: mocks.file } } }));
vi.mock("@/lib/course-generation/job-storage", () => ({ designGenerationJobs: { findUnique: mocks.design }, contentGenerationJobs: { findUnique: mocks.content }, resourcePackageJobs: { findUnique: mocks.find, update: mocks.update, upsert: mocks.upsert } }));
vi.mock("@/lib/platform/pbl-template-repository", () => ({ loadPblTemplateCourse: mocks.load }));
vi.mock("@/lib/session/server-store", () => ({ updateCourse: mocks.save }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: mocks.stat, readFile: mocks.read, default: { ...actual, stat: mocks.stat, readFile: mocks.read } };
});
import { assertResourcePackageEditable, authorizeResourcePackageAdaptation, confirmResourcePackage, resolveConfirmedResourcePackage, retryResourcePackage, submitResourcePackage } from "./server";
import { inspectPackageCompatibility } from "./compatibility";
import { normalizePackageStructure } from "./parser";

function resourcePackage(): CourseResourcePackage {
  const draft = emptyResourcePackageDraft();
  Object.assign(draft, { courseName: "课程", grade: "本科一年级", drivingQuestion: "如何设计AI教学活动？", expectedOutcome: "10页PPT", learningObjectives: ["辨析理论"], totalMinutes: 135, lessonCount: 3, minutesPerLesson: 45,
    knowledgePoints: [{ name: "学习理论", description: "条件与适用性", subPoints: ["建构主义"] }] });
  draft.stages.forEach((stage, index) => { stage.durationMin = [15, 30, 60, 20, 10][index]; });
  return { schemaVersion: 1, id: "source", revision: 2, source: { id: "source", fileName: "资料.zip", url: "/api/uploads/source" }, draft,
    documents: { knowledge: { id: "knowledge", fileName: "知识点.docx", url: "/api/uploads/knowledge" }, lessonPlan: { id: "lesson", fileName: "教案.docx", url: "/api/uploads/lesson" } }, launchResourceId: "launch" };
}
let course: Course;
beforeEach(() => {
  vi.resetAllMocks();
  const pkg = resourcePackage();
  course = { id: "course", name: "旧课", hours: 1, content: { resourcePackage: pkg }, aiLearningClassroomId: "old-classroom" } as Course;
  mocks.template.mockResolvedValue({ ownerId: "teacher", status: "ACTIVE" });
  mocks.design.mockResolvedValue(null); mocks.content.mockResolvedValue(null);
  mocks.load.mockImplementation(async () => course);
  mocks.save.mockImplementation(async (_id: string, updater: (course: Course) => Course) => { course = updater(course); return { courses: [course] }; });
  mocks.find.mockResolvedValue({ id: "job", requestedBy: "teacher", status: "ready", request: { uploadId: "source", revision: 2, selections: {} }, result: { package: pkg } });
  mocks.update.mockImplementation(async ({ data }) => ({ ...(await mocks.find()), ...data }));
  mocks.upsert.mockImplementation(async ({ update }) => ({ id: "job", ...update }));
  mocks.stat.mockResolvedValue({ isFile: () => true, size: 3 }); mocks.read.mockResolvedValue(Buffer.from("zip"));
  mocks.file.mockResolvedValue({ id: "source", originalName: "资料.zip", storageKey: "source.zip", size: BigInt(3), mimeType: "application/zip", regenerationRecipe: { operation: "course-resource-package-upload", courseId: "course" } });
});
describe("resource package persistence and authorization", () => {
  it("requires ownership even when the caller knows another package identifier", async () => {
    mocks.template.mockResolvedValue({ ownerId: "another-teacher", status: "ACTIVE" });
    await expect(resolveConfirmedResourcePackage("course", "source", 2, "teacher")).rejects.toMatchObject({ status: 404 });
    expect(mocks.file).not.toHaveBeenCalled();
  });
  it("rejects unconfirmed and outdated generation input", async () => {
    await expect(resolveConfirmedResourcePackage("course", "source", 2, "teacher")).rejects.toMatchObject({ code: "RESOURCE_PACKAGE_CONFIRMATION_REQUIRED" });
    course.content.resourcePackage!.confirmedAt = new Date().toISOString();
    await expect(resolveConfirmedResourcePackage("course", "source", 1, "teacher")).rejects.toMatchObject({ code: "RESOURCE_PACKAGE_REVISION_CONFLICT" });
  });
  it("persists fractional hours, independent stage plan and incremented confirmation version", async () => {
    const job = await confirmResourcePackage("course", "teacher", 2, resourcePackage().draft);
    expect(course.hours).toBe(2.25);
    expect(course.content.stagePlan?.totalMinutes).toBe(135);
    expect(course.content.stagePlan?.stages[1].durationMin).toBe(30);
    expect(course.content.resourcePackage?.revision).toBe(3);
    expect(course.content.resourcePackage?.confirmedAt).toBeTruthy();
    expect(course.aiLearningClassroomId).toBeUndefined();
    expect(course.status).toBe("draft");
    expect(job.message).toContain("已确认");
  });
  it("does not save inconsistent stage budgets", async () => {
    const draft = resourcePackage().draft; draft.stages[1].durationMin = 31;
    await expect(confirmResourcePackage("course", "teacher", 2, draft)).rejects.toMatchObject({ code: "RESOURCE_PACKAGE_INVALID_DRAFT", status: 422 });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("detects stale edits against the durable course revision", async () => {
    course.content.resourcePackage = { ...resourcePackage(), revision: 3 };
    await expect(confirmResourcePackage("course", "teacher", 2, resourcePackage().draft)).rejects.toMatchObject({ code: "RESOURCE_PACKAGE_REVISION_CONFLICT" });
  });
  it("blocks edits while a design or content job is active, including paused review", async () => {
    mocks.design.mockResolvedValue({ status: "paused" });
    await expect(assertResourcePackageEditable("course")).rejects.toMatchObject({ status: 409 });
    expect(mocks.design.mock.calls[0][0].where.status.in).toContain("cancelling");
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("preserves extracted documents on PDF conversion retry", async () => {
    mocks.find.mockResolvedValue({ id: "job", requestedBy: "teacher", status: "failed", request: { uploadId: "source", selections: {} }, result: { package: resourcePackage() } });
    const job = await retryResourcePackage("course", "teacher");
    expect(job.progress).toBe(65);
    expect(mocks.update.mock.calls[0][0].data.result).toBeUndefined();
    expect(mocks.update.mock.calls[0][0].data.request.uploadId).toBe("source");
  });
  it("re-extracts when the teacher changes a selected document", async () => {
    mocks.find.mockResolvedValue({ id: "job", requestedBy: "teacher", status: "needs_selection", request: { uploadId: "source", selections: {} }, result: {} });
    const job = await retryResourcePackage("course", "teacher", { lessonPlan: "另一个教案.docx" });
    expect(job.progress).toBe(0);
    expect(mocks.update.mock.calls[0][0].data.request.selections.lessonPlan).toBe("另一个教案.docx");
  });
  it("rejects a ZIP uploaded for a different course", async () => {
    mocks.file.mockResolvedValue({ id: "source", storageKey: "source.zip", size: BigInt(3), mimeType: "application/zip", regenerationRecipe: { operation: "course-resource-package-upload", courseId: "different-course" } });
    await expect(submitResourcePackage("course", "teacher", "source")).rejects.toMatchObject({ status: 404 });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("changing the source invalidates old classroom readiness and confirmation", async () => {
    course.content.resourcePackage!.confirmedAt = new Date().toISOString();
    const job = await submitResourcePackage("course", "teacher", "source");
    expect(job.status).toBe("queued");
    expect(course.content.resourcePackage?.confirmedAt).toBeUndefined();
    expect(course.aiLearningClassroomId).toBeUndefined();
  });
  it("requires explicit version-bound adaptation before confirming a conflicting package", async () => {
    const pkg = modernPackage();
    course.content.resourcePackage = pkg;
    let job = { id: "job", version: 1, requestedBy: "teacher", status: "blocked", request: { uploadId: "source", revision: 2, selections: {} }, result: { package: pkg } };
    mocks.find.mockImplementation(async () => job);
    mocks.update.mockImplementation(async ({ data }) => { job = { ...job, ...data }; return job; });
    await confirmResourcePackage("course", "teacher", 2, pkg.draft);
    expect(job.status).toBe("blocked");
    expect(course.content.resourcePackage?.confirmedAt).toBeUndefined();
    await expect(authorizeResourcePackageAdaptation("course", "teacher", 2, "old-conflicts", pkg.draft)).rejects.toMatchObject({ code: "RESOURCE_PACKAGE_REVISION_CONFLICT" });
    const adapted = await authorizeResourcePackageAdaptation("course", "teacher", 2, pkg.conflictVersion!, pkg.draft);
    expect(adapted.status).toBe("queued");
    expect(job.result.package.draft.stages.map((stage) => stage.durationMin)).toEqual([15, 30, 60, 20, 10]);
    expect(job.result.package.draft.totalMinutes).toBe(135);
    expect(job.result.package.adaptation?.authorizedBy).toBe("teacher");
    expect(job.result.package.launchResourceId).toBeUndefined();
    expect(job.result.package.draft.stages[3].teacherActions).not.toMatch(/4\.66|1\.33/);
    expect(job.result.package.draft.evaluationRubric?.dimensions.map((item) => item.weight)).toEqual([30, 40, 20, 10]);
    expect(job.result.package.draft.evaluationRubric?.sourceWeights).toEqual({ teacher: 60, ai: 40 });
    // Conversion success is a separate durable checkpoint; confirmation remains unavailable until it completes.
    await expect(confirmResourcePackage("course", "teacher", 3, job.result.package.draft)).rejects.toMatchObject({ code: "RESOURCE_PACKAGE_NOT_READY" });
    job.status = "ready"; job.result.package.launchResourceId = "adapted-launch";
    await confirmResourcePackage("course", "teacher", 3, job.result.package.draft);
    expect(course.content.resourcePackage?.confirmedAt).toBeTruthy();
    expect(course.content.stagePlan?.schemaVersion).toBe(2);
    expect(course.content.stagePlan?.stages[1].durationMin).toBe(30);
    expect(course.hours).toBe(2.25);
    const modified = structuredClone(course.content.resourcePackage!.draft);
    modified.drivingQuestion = "怎样设计更有依据的AI教学活动？";
    await confirmResourcePackage("course", "teacher", 4, modified);
    expect(job.status).toBe("blocked");
    expect(course.content.resourcePackage?.adaptation).toBeUndefined();
    expect(course.content.resourcePackage?.launchResourceId).toBeUndefined();
  });
  it("cannot bypass missing activities or conflicting minutes by authorizing adaptation or downgrading the parser version", async () => {
    const pkg = modernPackage(); course.content.resourcePackage = pkg;
    mocks.find.mockResolvedValue({ id: "job", version: 1, requestedBy: "teacher", status: "blocked", result: { package: pkg } });
    const draft = structuredClone(pkg.draft); delete draft.parsingVersion; draft.stages[2].requirements = "";
    await expect(authorizeResourcePackageAdaptation("course", "teacher", 2, pkg.conflictVersion!, draft)).rejects.toMatchObject({ code: "RESOURCE_PACKAGE_INVALID_DRAFT" });
    draft.stages[2].requirements = "完成个人作品"; draft.stages[1].durationMin = 31;
    await expect(authorizeResourcePackageAdaptation("course", "teacher", 2, pkg.conflictVersion!, draft)).rejects.toMatchObject({ code: "RESOURCE_PACKAGE_INVALID_DRAFT" });
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

function modernPackage(): CourseResourcePackage {
  const pkg = resourcePackage(); pkg.schemaVersion = 2; delete pkg.launchResourceId;
  pkg.draft.parsingVersion = 2;
  pkg.draft.stages.forEach((stage) => { stage.requirements = "学生与AI伙伴讨论并形成个人决策"; stage.outputs = "个人学习记录"; stage.teacherActions = "提供反馈"; stage.aiActions = "提供启发"; });
  pkg.draft.stages[0].requirements = "组建小组，每组5人，记录组员姓名";
  pkg.draft.stages[3].teacherActions = "控制每组4.66分钟汇报及1.33分钟讨论时间";
  pkg.draft.finalDeliverables = [{ id: "artifact", name: "个人作品", format: "pptx", requirements: "10页PPT终稿", required: true }];
  pkg.draft.evaluationRubric = { id: "rubric", version: 1, dimensions: [30, 40, 20, 10].map((weight, index) => ({ id: `dimension-${index}`, name: ["理论适切性", "活动可行性", "呈现质量", "协作贡献"][index], description: "依照作品证据评分", weight })), sourceWeights: { teacher: 60, ai: 40 } };
  pkg.draft.reflectionQuestions = ["AI输出的哪次修改体现了你的判断？"];
  pkg.draft.reflectionQuestionSet = { id: "reflection", version: 1, questions: [{ id: "q1", prompt: pkg.draft.reflectionQuestions[0], required: true }] };
  pkg.draft = normalizePackageStructure(pkg.draft);
  return { ...pkg, ...inspectPackageCompatibility("组建小组，每组5人。\n教师评分70%，同伴互评20%，小组自评10%。", []) };
}
