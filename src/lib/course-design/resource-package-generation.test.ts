import { describe, expect, it, vi } from "vitest";
import { emptyResourcePackageDraft, stagePlanFromResourcePackage, type CourseResourcePackage } from "@/lib/resource-package/types";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import { knowledgeLectureBudgetBounds } from "@/lib/classroom/knowledge-lecture-budget";
import { buildNewSystemAiDurationMessages, normalizeNewSystemAiDurationRecommendation } from "@/lib/classroom/new-system-ai-duration";
import { buildNewSystemTimingPlan, isNewSystemAiTimingPlan } from "@/lib/classroom/new-system-course";
import { createClassroomTimingState, deriveClassroomTimingSnapshot, pauseClassroomTiming, reconcileClassroomTimingState, resolveCourseTimingMinutes } from "@/lib/classroom/timing";
import { canResumeCourseDesignWithPackageState, isSameCourseDesignRequest } from "./resume-policy";

const { modelCall } = vi.hoisted(() => ({ modelCall: vi.fn() }));
vi.mock("@/lib/llm/client", () => ({ callLLM: modelCall, parseLLMJson: JSON.parse }));
vi.mock("@/lib/teaching-ai/support-engine", () => ({ generateProjectSkeleton: vi.fn() }));

function confirmedPackage(): CourseResourcePackage {
  const draft = emptyResourcePackageDraft();
  const minutes = [10, 80, 35, 10, 5];
  Object.assign(draft, {
    courseName: "教师确认的 AI 项目", subject: "信息科技", grade: "七年级",
    drivingQuestion: "如何用可靠的 AI 判断改善校园？", expectedOutcome: "个人研究报告",
    learningObjectives: ["解释训练样本的作用", "用测试样本检查结果"], totalMinutes: 140,
    knowledgePoints: [{ name: "训练与测试", description: "从数据理解分类", subPoints: ["训练样本", "测试样本"] }],
  });
  draft.stages = draft.stages.map((stage, index) => ({ ...stage, durationMin: minutes[index]!, requirements: `阶段任务 ${index + 1}` }));
  return { schemaVersion: 1, id: "package-1", revision: 3, source: { id: "zip-1", fileName: "教学.zip", url: "/private/zip" }, documents: {}, draft, confirmedAt: "2026-09-12T00:00:00Z" };
}

describe("confirmed resource package generation", () => {
  it("releases the design worker only for reviews without a deadline", async () => {
    const { isPersistentCourseDesignReview } = await import("./job-runner");
    expect(isPersistentCourseDesignReview(null)).toBe(true);
    expect(isPersistentCourseDesignReview(20_000)).toBe(false);
  }, 15_000);

  it("requeues a confirmed capacity decision even when its review heartbeat is fresh", async () => {
    const { resumeCourseDesignAfterOutlineReview } = await import("./job-runner");
    const { designGenerationJobs } = await import("@/lib/course-generation/job-storage");
    const job = {
      id: "capacity-review",
      courseId: "course-1",
      status: "review_available",
      step: "capacityReview",
      request: { courseId: "course-1", teacherBrief: "", generationContractVersion: 3 },
      lastHeartbeatAt: new Date(),
    };
    const find = vi.spyOn(designGenerationJobs, "findUnique").mockResolvedValue(job as never);
    const update = vi.spyOn(designGenerationJobs, "update").mockImplementation(async (input) => ({
      ...job,
      ...input.data,
    }) as never);
    try {
      await resumeCourseDesignAfterOutlineReview("course-1", {
        reviewKind: "capacity",
        actorId: "teacher-1",
      });
      expect(update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "capacity-review" },
        data: expect.objectContaining({
          status: "queued",
          reviewStatus: "approved",
          request: expect.objectContaining({
            capacityDecisionAccepted: true,
            resumeReviewKind: "capacity",
            reviewActorId: "teacher-1",
          }),
        }),
      }));
    } finally {
      find.mockRestore();
      update.mockRestore();
    }
  });

  it("preserves teacher facts and required subpoints without asking the model to infer them", async () => {
    const { applyResourcePackageGenerationInput, inferCourseSeed } = await import("./job-runner");
    const resourcePackage = confirmedPackage();
    const original = createPblTemplateCourse("course-1", { name: "旧课程", hours: 2 });
    const course = applyResourcePackageGenerationInput(original, resourcePackage);
    const seed = await inferCourseSeed(course, { courseId: course.id, teacherBrief: "可选补充", resourcePackage }, new AbortController().signal);
    expect(seed).toMatchObject({ name: resourcePackage.draft.courseName, grade: "七年级", hours: 140 / 60, learningObjectives: resourcePackage.draft.learningObjectives });
    expect(modelCall).not.toHaveBeenCalled();
    expect(course.content.teacherRequiredKnowledgePoints).toEqual([]);
    expect(course.content.knowledgeGroups?.[0]?.knowledgePointIds).toHaveLength(2);
    expect(course.drivingQuestion).toBe(resourcePackage.draft.drivingQuestion);
    expect(course.pblConfig?.projectMode).toBe("personal");
    expect(course.content.stagePlan?.totalMinutes).toBe(140);
  }, 15_000);

  it("locks teaching to the approved minutes even outside the legacy ratio", () => {
    const stagePlan = stagePlanFromResourcePackage(confirmedPackage().draft);
    expect(knowledgeLectureBudgetBounds(2, stagePlan)).toMatchObject({ courseMinutes: 140, minMinutes: 80, maxMinutes: 80 });
    const input = { course: { name: "AI", subject: "科技", grade: "七年级", hours: 140 / 60, summary: "" }, stagePlan, knowledgePoints: [{ id: "kp-1", name: "训练样本", description: "作用" }, { id: "kp-2", name: "测试样本", description: "检验" }], teacherBrief: "", generationMode: "standard" as const };
    const messages = buildNewSystemAiDurationMessages(input);
    expect(messages[0].content).toContain("固定 80 分钟");
    expect(messages[0].content).not.toContain("20%–40%");
    const recommendation = normalizeNewSystemAiDurationRecommendation({ durationMin: 20, rationale: "按教案分配", teachingClusterBudgets: [{ clusterId: "teaching-cluster-1", knowledgePointIds: ["kp-1"], durationMin: 1 }, { clusterId: "teaching-cluster-2", knowledgePointIds: ["kp-2"], durationMin: 3 }] }, input);
    expect(recommendation.durationMin).toBe(80);
    expect(recommendation.teachingClusterBudgets.map((item) => item.durationMin)).toEqual([20, 60]);
    expect(isNewSystemAiTimingPlan(buildNewSystemTimingPlan(80), 140 / 60, stagePlan)).toBe(true);
    expect(isNewSystemAiTimingPlan(buildNewSystemTimingPlan(40), 140 / 60, stagePlan)).toBe(false);
  });

  it("uses all five package durations for the live clock and preserves an active session", () => {
    const course = createPblTemplateCourse("course-1");
    course.content.stagePlan = stagePlanFromResourcePackage(confirmedPackage().draft);
    course.content.moduleTimingPlan = buildNewSystemTimingPlan(80);
    const input = { stages: course.stages, totalMinutes: resolveCourseTimingMinutes(course), stagePlan: course.content.stagePlan, moduleTimingPlan: course.content.moduleTimingPlan };
    const clock = createClassroomTimingState({ ...input, now: "2026-09-12T00:00:00Z" });
    expect(clock.stages.map((stage) => stage.basePlannedSec)).toEqual([600, 4800, 2100, 600, 300]);
    expect(deriveClassroomTimingSnapshot(clock, "2026-09-12T00:01:00Z")).toMatchObject({ coursePlannedSec: 8400, courseElapsedSec: 60 });
    const paused = pauseClassroomTiming(clock, "2026-09-12T00:01:00Z");
    expect(reconcileClassroomTimingState({ ...input, state: paused })).toBe(paused);
    expect(deriveClassroomTimingSnapshot(paused, "2026-09-12T00:30:00Z").courseElapsedSec).toBe(60);
  });

  it("invalidates a previous generation after package revision or supplementary answers change", () => {
    const request = { courseId: "course-1", teacherBrief: "", resourcePackage: confirmedPackage(), supplementalAnswers: { brief: "多举校园例子" } };
    expect(isSameCourseDesignRequest(request, structuredClone(request))).toBe(true);
    expect(isSameCourseDesignRequest(request, { ...request, resourcePackage: { ...request.resourcePackage, revision: 4 } })).toBe(false);
    expect(isSameCourseDesignRequest(request, { ...request, supplementalAnswers: { brief: "使用生活例子" } })).toBe(false);
    expect(isSameCourseDesignRequest(request, { courseId: request.courseId, teacherBrief: "" })).toBe(false);
  });

  it("does not automatically revive a legacy failed task while the first package is still parsing", async () => {
    const { resumeRecoverableCourseDesignJob } = await import("./job-runner");
    const { designGenerationJobs, resourcePackageJobs } = await import("@/lib/course-generation/job-storage");
    const legacy = { courseId: "course-1", teacherBrief: "旧课程要求" };
    const job = { id: "old-design", courseId: "course-1", status: "failed", error: "生成的数据结构不完整", request: legacy };
    const update = vi.spyOn(designGenerationJobs, "updateMany");
    vi.spyOn(designGenerationJobs, "findUnique").mockResolvedValue(job as never);
    vi.spyOn(resourcePackageJobs, "findUnique").mockResolvedValue({ id: "new-import", status: "running" } as never);
    try {
      expect(await resumeRecoverableCourseDesignJob("course-1")).toEqual(job);
      expect(update).not.toHaveBeenCalled();
      expect(canResumeCourseDesignWithPackageState(legacy, null)).toBe(true);
      expect(canResumeCourseDesignWithPackageState({ ...legacy, resourcePackage: confirmedPackage() }, { status: "running" })).toBe(false);
      expect(canResumeCourseDesignWithPackageState({ ...legacy, resourcePackage: confirmedPackage() }, { status: "ready" })).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("keeps confirmed audience and supplementary instructions before long DOCX evidence in real generation context", async () => {
    const { buildCourseTeachingSourceContext } = await import("./job-runner");
    const resourcePackage = confirmedPackage();
    resourcePackage.draft.grade = "小学五年级（教师已修正）";
    resourcePackage.draft.knowledgePoints[0]!.taskAssociation = "把训练样本写入最终研究报告";
    resourcePackage.draft.knowledgePoints[0]!.source = {
      documentRole: "knowledge", locator: "第 1 节",
      quote: "内容：训练样本用于学习规律。\n任务关联：把训练样本写入最终研究报告",
    };
    const context = buildCourseTeachingSourceContext(resourcePackage, "使用校园生活例证", [{
      id: "docx-1", fileName: "原始教案.docx", mimeType: "application/docx", content: `原始正文开始${"正文".repeat(40_000)}`,
    }]);
    const boundedReviewContext = context.slice(0, 60_000);
    expect(boundedReviewContext).toContain(`"courseName":"${resourcePackage.draft.courseName}"`);
    expect(boundedReviewContext).toContain('"grade":"小学五年级（教师已修正）"');
    expect(boundedReviewContext).toContain('"durationMin":80');
    expect(boundedReviewContext).toContain('"optionalFinalTaskContext"');
    expect(boundedReviewContext).toContain('"suggestion":"把训练样本写入最终研究报告"');
    expect(boundedReviewContext).not.toContain('"taskAssociation":');
    expect(boundedReviewContext).not.toContain("任务关联：把训练样本写入最终研究报告");
    expect(boundedReviewContext).toContain("不得据此要求每个知识点、页面、活动或小测都连接最终成果");
    expect(context.indexOf("教师已确认")).toBeLessThan(context.indexOf("教师补充要求：使用校园生活例证"));
    expect(context.indexOf("教师补充要求：使用校园生活例证")).toBeLessThan(context.indexOf("原始正文开始"));
    expect(boundedReviewContext).toContain("教师补充要求：使用校园生活例证");
  });

  it("keeps management status and raw package documents outside teaching context without deleting normal subject language", async () => {
    const { buildCourseTeachingSourceContext } = await import("./job-runner");
    const resourcePackage = confirmedPackage();
    resourcePackage.draft.knowledgePoints[0]!.evidenceStatus = "PARTIAL";
    resourcePackage.draft.knowledgePoints[0]!.evidenceGap = "缺少直接证据";
    resourcePackage.draft.knowledgePoints[0]!.source = { documentRole: "knowledge", locator: "第 2 节", quote: "训练样本用于学习规律。" };
    resourcePackage.draft.knowledgeEvidenceSummary = { overallStatus: "PARTIAL", gaps: ["待审核"] };
    resourcePackage.documents.knowledge = { id: "package-knowledge", fileName: "知识点.md", url: "/private/knowledge", format: "markdown" };
    resourcePackage.planningIssues = [{
      id: "issue-1", kind: "evidence", severity: "warning", requiresAcknowledgement: true,
      summary: "证据不完整", detail: "PARTIAL", suggestion: "教师复核", evidence: [],
    }];
    const context = buildCourseTeachingSourceContext(resourcePackage, "保留数学术语", [
      { id: "package-knowledge", fileName: "知识点.md", mimeType: "text/markdown", content: "# 内部审查\n**PARTIAL**\n证据状态：PARTIAL" },
      { id: "package-knowledge:part-2", fileName: "知识点.md（第2段）", mimeType: "text/markdown", content: "原始包尾部管理信息 PARTIAL" },
      { id: "teacher-extra", fileName: "补充资料.md", mimeType: "text/markdown", content: "偏导数的英文是 partial derivative。讨论证据状态随实验条件变化的科学含义。\nevidenceStatus: PARTIAL\n用于课堂的可靠例子。" },
    ]);
    expect(context).not.toContain("evidenceStatus");
    expect(context).not.toContain("evidenceGap");
    expect(context).not.toContain("knowledgeEvidenceSummary");
    expect(context).not.toContain("planningIssues");
    expect(context).not.toContain("**PARTIAL**");
    expect(context).not.toContain("内部审查");
    expect(context).not.toContain("原始包尾部管理信息");
    expect(context).toContain("partial derivative");
    expect(context).toContain("讨论证据状态随实验条件变化的科学含义");
    expect(context).toContain("用于课堂的可靠例子");
    expect(context).toContain("训练样本用于学习规律");
    expect(context).toContain("第 2 节");
  });

  it("requires actual teaching coverage instead of quiz-only coverage and rejects duplicate pages", async () => {
    const { assertAiOutlineKnowledgeCoverage } = await import("./job-runner");
    const points = [{ id: "kp-1", name: "训练样本", description: "作用" }, { id: "kp-2", name: "测试样本", description: "检验" }];
    const slide = { id: "slide-1", type: "slide" as const, title: "训练样本", description: "比较带标签样本的作用", keyPoints: ["训练样本"], knowledgePointIds: ["kp-1"], order: 0 };
    const quiz = { ...slide, id: "quiz-1", type: "quiz" as const, knowledgePointIds: ["kp-2"], order: 1 };
    expect(() => assertAiOutlineKnowledgeCoverage([slide, quiz], points)).toThrow("测试样本");
    const complete = { ...slide, knowledgePointIds: ["kp-1", "kp-2"] };
    expect(() => assertAiOutlineKnowledgeCoverage([complete], points)).not.toThrow();
    expect(() => assertAiOutlineKnowledgeCoverage([complete, { ...complete, id: "duplicate" }], points)).toThrow("重复教学页面");
  });
});
