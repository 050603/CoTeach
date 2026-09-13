import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import { emptyResourcePackageDraft } from "@/lib/resource-package/types";
import type { Course } from "@/lib/session/types";
import type { PersistedClassroomData } from "@/lib/openmaic/server/classroom-storage";
import type { CourseQualityIssue, CourseQualityReport } from "./types";
import { computeCourseQualitySignature } from "./signature";

const mocks = vi.hoisted(() => ({ course: null as unknown, classroom: null as unknown, job: null as unknown, claimable: false, source: "教师资料", review: vi.fn(), upsert: vi.fn(), updates: [] as unknown[] }));
vi.mock("@/lib/session/server-store", () => ({ getCourse: async () => mocks.course, updateCourse: async (_id: string, update: (course: unknown) => unknown) => { mocks.course = update(mocks.course); return mocks.course; } }));
vi.mock("@/lib/openmaic/server/classroom-storage", () => ({ readClassroom: async () => mocks.classroom }));
vi.mock("@/lib/llm/client", () => ({ callLLM: vi.fn() }));
vi.mock("./semantic-review", async (original) => ({ ...await original<typeof import("./semantic-review")>(), reviewCourseSection: mocks.review }));
vi.mock("@/lib/course-generation/job-storage", () => ({ contentGenerationJobs: { findUnique: async () => ({ request: { teachingSourceContext: mocks.source } }) }, qualityReviewJobs: {
  findUnique: async () => mocks.job, findFirst: async () => null,
  upsert: async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
    mocks.upsert(args);
    const previous = mocks.job as Record<string, unknown> | null;
    mocks.job = { id: "job", ...args.create, ...previous, ...args.update, version: Number(previous?.version ?? 0) + 1 };
    return mocks.job;
  },
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const job = mocks.job as Record<string, unknown> | null;
    if (!job || (where.status === "queued" && !mocks.claimable) || Object.entries(where).some(([key, value]) => job[key] !== value)) return { count: 0 };
    mocks.updates.push(data);
    mocks.job = { ...job, ...data };
    return { count: 1 };
  },
} }));
import { enqueueCourseQualityReview, initializeReviewSections, mergeReviewIssues, runCourseQualityReviewJob } from "./job-runner";

function fixture() {
  const course = createPblTemplateCourse("course");
  course.aiLearningClassroomId = "classroom";
  course.content.resourcePackage = { schemaVersion: 2, id: "package", revision: 1, source: { id: "zip", fileName: "course.zip", url: "/api/uploads/zip" }, documents: {}, draft: emptyResourcePackageDraft() };
  const scenes = ["a", "b"].map((id) => ({ id, outlineId: id, stageId: "stage", order: id === "a" ? 0 : 1, type: "slide", title: id, actions: [], content: { type: "slide", canvas: { elements: [{ id: `text-${id}`, type: "text", left: 80, top: 180, width: 800, height: 100, content: `<p>${id}的解释</p>` }] } } }));
  const classroom = { id: "classroom", revision: 3, createdAt: "2026-09-12T00:00:00Z", stage: { id: "stage", name: "课程" }, scenes } as unknown as PersistedClassroomData;
  course.content.knowledgeLectureSections = ["a", "b"].map((id, order) => ({ id, title: id, order, sceneOutlineIds: [id], quizOutlineId: `quiz-${id}`, knowledgePointIds: [], estimatedMinutes: 1 }));
  return { course, classroom };
}
beforeEach(() => {
  vi.clearAllMocks();
  const { course, classroom } = fixture();
  mocks.course = course; mocks.classroom = classroom; mocks.job = null; mocks.claimable = false; mocks.source = "教师资料"; mocks.updates = [];
});

describe("durable background quality review", () => {
  it("enqueues schema 2 package drafts that predate the explicit review flag", async () => {
    const report = await enqueueCourseQualityReview("course");
    expect(report).toMatchObject({ status: "pending", classroomRevision: 3 });
    expect((mocks.course as Course).content.qualityReviewRequired).toBe(true);
    expect(mocks.upsert).toHaveBeenCalledOnce();
  });

  it("restores a completed matching report to the course without rechecking", async () => {
    const course = mocks.course as Course;
    const classroom = mocks.classroom as PersistedClassroomData;
    const signature = computeCourseQualitySignature(course, classroom);
    const report: CourseQualityReport = { schemaVersion: 1, courseId: course.id, classroomId: classroom.id, classroomRevision: 3, signature, status: "completed", issues: [] };
    mocks.job = { id: "job", status: "completed", request: { signature }, result: report };
    expect(await enqueueCourseQualityReview("course")).toEqual(report);
    expect((mocks.course as Course).content.qualityReview).toEqual(report);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it("also reviews versioned public stage plans when the private source is unavailable", async () => {
    const course = mocks.course as Course;
    course.content.resourcePackage = undefined;
    course.content.stagePlan = { schemaVersion: 2, source: "resource-package", totalMinutes: 135, lessonCount: 3, minutesPerLesson: 45, stages: [], evaluationCriteria: "", reflectionQuestions: [] };
    expect(await enqueueCourseQualityReview("course")).toMatchObject({ status: "pending" });
  });

  it("resumes only unfinished sections and replaces their issues instead of appending duplicates", async () => {
    const report = (await enqueueCourseQualityReview("course"))!;
    const issue: CourseQualityIssue = { id: "semantic-a-1", origin: "semantic", severity: "suggestion", title: "条件", evidence: "具体条件", suggestion: "核对条件" };
    report.sections![0] = { ...report.sections![0], status: "completed", issues: [issue] };
    report.sections![1] = { ...report.sections![1], status: "failed", issues: [], error: "中断" };
    report.issues = [issue]; report.status = "failed";
    (mocks.job as { result: CourseQualityReport; status: string }).result = report;
    (mocks.job as { status: string }).status = "queued";
    (mocks.course as Course).content.qualityReview = report;
    mocks.claimable = true;
    mocks.review.mockResolvedValue([{ ...issue, id: "semantic-b-1" }]);
    await runCourseQualityReviewJob("job");
    const result = (mocks.job as { result: CourseQualityReport }).result;
    expect(mocks.review).toHaveBeenCalledOnce();
    expect(mocks.review.mock.calls[0][0].scenes.map((scene: { id: string }) => scene.id)).toEqual(["b"]);
    expect(result.status).toBe("completed");
    expect(result.issues.filter((entry) => entry.id === issue.id)).toHaveLength(1);
    expect(result.sections!.every((section) => section.status === "completed")).toBe(true);
    expect(mocks.updates).toEqual(expect.arrayContaining([expect.objectContaining({ progress: 50 }), expect.objectContaining({ progress: 100 })]));
  });

  it("discloses bounded source review and invalidates all section checkpoints when teaching changes", async () => {
    mocks.source = "长正文".repeat(25000);
    const before = (await enqueueCourseQualityReview("course"))!;
    expect(before.sourceCoverage).toMatchObject({ partial: true, totalChars: 75000 });
    expect(before.issues.some((issue) => issue.id === "source-partial-coverage")).toBe(true);
    before.sections![0].status = "completed";
    (mocks.course as Course).grade = "新的教学对象";
    const after = (await enqueueCourseQualityReview("course"))!;
    expect(after.signature).not.toBe(before.signature);
    expect(after.sections!.every((section) => section.status === "pending")).toBe(true);
  });

  it("keeps successful section checkpoints and progress when the teacher retries failed checks", async () => {
    const before = (await enqueueCourseQualityReview("course"))!;
    before.status = "failed";
    before.sections![0] = { ...before.sections![0], status: "completed", issues: [] };
    before.sections![1] = { ...before.sections![1], status: "failed", issues: [], error: "暂不可用" };
    (mocks.job as { result: CourseQualityReport; status: string }).result = before;
    (mocks.job as { status: string }).status = "failed";
    const retry = await enqueueCourseQualityReview("course", { force: true });
    expect(retry!.sections!.map((section) => section.status)).toEqual(["completed", "pending"]);
    expect(mocks.upsert.mock.lastCall![0].update.progress).toBe(50);
  });

  it("deduplicates reconstructed reports and matches checkpoints by scene identity", () => {
    const issue: CourseQualityIssue = { id: "same", origin: "semantic", severity: "suggestion", title: "条件", evidence: "证据", suggestion: "核对" };
    const sections = initializeReviewSections([[{ id: "a" }]]);
    sections[0] = { ...sections[0], status: "completed", issues: [issue] };
    expect(mergeReviewIssues([issue], sections)).toEqual([issue]);
    const previous = { sections } as CourseQualityReport;
    expect(initializeReviewSections([[{ id: "a" }], [{ id: "c" }]], previous).map((section) => section.status)).toEqual(["completed", "pending"]);
  });
});
