import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import { emptyResourcePackageDraft } from "@/lib/resource-package/types";
import type { Course } from "@/lib/session/types";
import type { PersistedClassroomData } from "@/lib/openmaic/server/classroom-storage";
import { COURSE_QUALITY_REVIEW_POLICY_VERSION, type CourseQualityIssue, type CourseQualityReport } from "./types";
import { computeCourseQualitySignature } from "./signature";

const mocks = vi.hoisted(() => ({
  course: null as unknown,
  classroom: null as unknown,
  job: null as unknown,
  claimable: false,
  source: "教师资料",
  generationModelString: undefined as string | undefined,
  reviewModelString: undefined as string | undefined,
  review: vi.fn(),
  resolveModel: vi.fn(),
  createAiCall: vi.fn(),
  upsert: vi.fn(),
  updates: [] as unknown[],
}));
vi.mock("@/lib/session/server-store", () => ({ getCourse: async () => mocks.course, updateCourse: async (_id: string, update: (course: unknown) => unknown) => { mocks.course = update(mocks.course); return mocks.course; } }));
vi.mock("@/lib/openmaic/server/classroom-storage", () => ({ readClassroom: async () => mocks.classroom }));
vi.mock("@/lib/llm/client", () => ({ callLLM: vi.fn() }));
vi.mock("./settings", () => ({ getCourseQualityReviewSettings: async () => ({ modelString: mocks.reviewModelString }) }));
vi.mock("@/lib/openmaic/server/resolve-model", () => ({ resolveModel: mocks.resolveModel }));
vi.mock("@/lib/openmaic/server/course-generation-ai-call", () => ({ createCourseGenerationAiCall: mocks.createAiCall }));
vi.mock("@/lib/openmaic/server/provider-config", () => ({ findServerDefaultModelString: () => undefined }));
vi.mock("./semantic-review", async (original) => ({ ...await original<typeof import("./semantic-review")>(), reviewCourseSection: mocks.review }));
vi.mock("@/lib/course-generation/job-storage", () => ({ contentGenerationJobs: { findUnique: async () => ({ request: { teachingSourceContext: mocks.source, generationModelString: mocks.generationModelString } }) }, qualityReviewJobs: {
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
  mocks.course = course; mocks.classroom = classroom; mocks.job = null; mocks.claimable = false; mocks.source = "教师资料"; mocks.generationModelString = undefined; mocks.reviewModelString = undefined; mocks.updates = [];
  mocks.resolveModel.mockResolvedValue({ model: {}, modelInfo: { capabilities: { vision: true }, outputWindow: 12_000 }, thinkingConfig: undefined });
  mocks.createAiCall.mockReturnValue(vi.fn().mockResolvedValue('{"issues":[]}'));
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
    const report: CourseQualityReport = { schemaVersion: 1, reviewPolicyVersion: COURSE_QUALITY_REVIEW_POLICY_VERSION, reviewScope: { kind: 'full-course', checkedOutlineIds: [], uncheckedOutlineCount: 0 }, courseId: course.id, classroomId: classroom.id, classroomRevision: 3, signature, status: "completed", issues: [] };
    report.runId = 'existing-run';
    mocks.job = { id: "job", status: "completed", request: { signature, sourceContext: mocks.source, reviewPolicyVersion: COURSE_QUALITY_REVIEW_POLICY_VERSION, reviewScopeKind: 'full-course', runId: report.runId }, result: report };
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

  it("stores an explicitly selected reviewer separately and invalidates old review checkpoints when it changes", async () => {
    mocks.reviewModelString = "deepseek:deepseek-v4-flash-vision-exp";
    const first = (await enqueueCourseQualityReview("course"))!;
    expect(first.reviewModelString).toBe("deepseek:deepseek-v4-flash-vision-exp");
    expect((mocks.job as { request: { reviewModelString?: string } }).request.reviewModelString)
      .toBe("deepseek:deepseek-v4-flash-vision-exp");

    first.status = "completed";
    first.sections![0].status = "completed";
    (mocks.job as { result: CourseQualityReport; status: string }).result = first;
    (mocks.job as { status: string }).status = "completed";
    (mocks.course as Course).content.qualityReview = first;
    mocks.reviewModelString = "openai:gpt-5.6";

    const second = (await enqueueCourseQualityReview("course"))!;
    expect(second).toMatchObject({ status: "pending", reviewModelString: "openai:gpt-5.6" });
    expect(second.sections!.every((section) => section.status === "pending")).toBe(true);
  });

  it("follows the model locked by course generation when no independent reviewer is selected", async () => {
    mocks.generationModelString = "deepseek:deepseek-v4-flash";
    const report = (await enqueueCourseQualityReview("course"))!;
    expect(report.reviewModelString).toBe("deepseek:deepseek-v4-flash");
    expect((mocks.job as { request: { reviewModelString?: string } }).request.reviewModelString)
      .toBe("deepseek:deepseek-v4-flash");
  });

  it("resolves an explicitly selected vision reviewer without changing the generation request", async () => {
    mocks.generationModelString = "deepseek:deepseek-v4-flash";
    mocks.reviewModelString = "deepseek:deepseek-v4-flash-vision-exp";
    mocks.review.mockResolvedValue([]);
    await enqueueCourseQualityReview("course");
    mocks.claimable = true;

    await runCourseQualityReviewJob("job");

    expect(mocks.resolveModel).toHaveBeenCalledWith({ modelString: "deepseek:deepseek-v4-flash-vision-exp" });
    expect(mocks.createAiCall).toHaveBeenCalledWith(expect.objectContaining({
      vision: true,
      source: "course-quality-review",
    }));
    expect((mocks.job as { request: { reviewModelString?: string } }).request.reviewModelString)
      .toBe("deepseek:deepseek-v4-flash-vision-exp");
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
    expect(mocks.review.mock.calls[0][0].includeKnowledgeGraph).toBe(true);
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
    const retry = await enqueueCourseQualityReview("course", { mode: "retry" });
    expect(retry!.sections!.map((section) => section.status)).toEqual(["completed", "pending"]);
    expect(retry!.runId).not.toBe(before.runId);
    expect(mocks.upsert.mock.lastCall![0].update.progress).toBe(50);
  });

  it("reruns every section for a full check even when the content signature is unchanged", async () => {
    const before = (await enqueueCourseQualityReview("course"))!;
    before.status = "completed";
    before.sections!.forEach((section) => { section.status = "completed"; });
    (mocks.job as { result: CourseQualityReport; status: string }).result = before;
    (mocks.job as { status: string }).status = "completed";
    const after = (await enqueueCourseQualityReview("course", { mode: "check" }))!;
    expect(after.runId).not.toBe(before.runId);
    expect(after.sections!.map((section) => section.status)).toEqual(["pending", "pending"]);
    expect(mocks.upsert.mock.lastCall![0].update.progress).toBe(0);
  });

  it("never reuses successful sections from an obsolete review policy", async () => {
    const before = (await enqueueCourseQualityReview("course"))!;
    before.reviewPolicyVersion = "obsolete";
    before.sections![0].status = "completed";
    (mocks.job as { result: CourseQualityReport; status: string }).result = before;
    (mocks.job as { status: string }).status = "failed";
    const after = (await enqueueCourseQualityReview("course", { mode: "retry" }))!;
    expect(after.sections!.every((section) => section.status === "pending")).toBe(true);
  });

  it("does not reuse a test-lesson checkpoint after its checked outlines change", async () => {
    const course = mocks.course as Course;
    course.content.classroomGenerationRun = {
      scope: "test-lesson", status: "completed", generatedOutlineIds: ["a"], fullOutlineCount: 2,
      testLesson: { sectionId: "section", sectionTitle: "测试小节", sceneOutlineIds: ["a"], durationSeconds: 60 },
      generatedAt: new Date(0).toISOString(),
    };
    const before = (await enqueueCourseQualityReview("course"))!;
    before.status = "failed";
    before.sections![0].status = "completed";
    (mocks.job as { result: CourseQualityReport; status: string }).result = before;
    (mocks.job as { status: string }).status = "failed";
    course.content.classroomGenerationRun.testLesson!.sceneOutlineIds = ["b"];
    const after = (await enqueueCourseQualityReview("course", { mode: "retry" }))!;
    expect(after.signature).toBe(before.signature);
    expect(after.reviewScope?.checkedOutlineIds).toEqual(["b"]);
    expect(after.sections!.every((section) => section.status === "pending")).toBe(true);
  });

  it("cancels a queued legacy job rather than running it under the new policy", async () => {
    const current = (await enqueueCourseQualityReview("course"))!;
    (mocks.job as { request: Record<string, unknown> }).request = { courseId: 'course', classroomId: 'classroom', signature: current.signature, sourceContext: mocks.source };
    mocks.claimable = true;
    await runCourseQualityReviewJob("job");
    expect((mocks.job as { status: string }).status).toBe('cancelled');
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it("does not let a late result from an earlier run replace the current report", async () => {
    await enqueueCourseQualityReview("course");
    mocks.claimable = true;
    const resolvers: Array<(issues: CourseQualityIssue[]) => void> = [];
    mocks.review.mockImplementation(() => new Promise<CourseQualityIssue[]>((resolve) => { resolvers.push(resolve); }));
    const oldRun = runCourseQualityReviewJob("job");
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    mocks.claimable = false;
    const current = (await enqueueCourseQualityReview("course", { mode: "check" }))!;
    resolvers.forEach((resolve) => resolve([]));
    await oldRun;
    expect((mocks.job as { result: CourseQualityReport }).result.runId).toBe(current.runId);
    expect((mocks.course as Course).content.qualityReview?.runId).toBe(current.runId);
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
