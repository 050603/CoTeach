import { describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import {
  assessmentToBoundaryResponse,
  buildDelegatedWorkAssessmentPrompts,
  buildDelegatedWorkStarterReviewPrompts,
  buildDelegatedWorkStarterPrompts,
  generateDelegatedDeliveryWithRepair,
  normalizeDelegatedWorkAssessment,
  normalizeDelegatedWorkDelivery,
  normalizeDelegatedWorkStarters,
} from "./delegated-work-policy";

const course = {
  id: "course-1",
  name: "校园节水研究",
  drivingQuestion: "怎样用可靠证据找到校园浪费水的主要原因？",
  expectedOutcome: "基于实地数据形成并验证节水方案",
  learningObjectives: ["自主采集数据", "分析证据并形成结论"],
  stages: [{ key: "make", label: "项目实践", description: "完成实地调查、分析并验证方案" }],
  currentStageIndex: 0,
  students: [{ id: "student-1", name: "小林" }],
  groups: [{
    id: "group-1",
    name: "节水组",
    topic: "教学楼用水调查",
    goal: "识别浪费原因并提出可验证方案",
    selectedForms: ["研究报告"],
    members: [{ studentId: "student-1", name: "小林" }],
  }],
  feedback: [],
  learningEvidence: [],
  teacherAgentDirectives: [],
  content: {
    knowledgePoints: [],
    evaluationPlan: {
      overallRubric: "重视学生自主调查与证据分析过程",
      dimensions: [{ name: "证据质量", weight: 45, description: "数据由学生可靠采集并解释" }],
    },
  },
} as unknown as Course;

describe("delegated work policy", () => {
  it("repairs malformed or empty delivery output only once", async () => {
    const generate = vi.fn().mockResolvedValueOnce("not JSON")
      .mockResolvedValueOnce(JSON.stringify({ deliverable: { content: "可审阅的术语表" } }));
    const repaired = await generateDelegatedDeliveryWithRepair(generate);
    expect((repaired.deliverable as { content: string }).content).toBe("可审阅的术语表");
    expect(generate.mock.calls).toEqual([[false], [true]]);

    const empty = vi.fn().mockResolvedValue(JSON.stringify({ deliverable: { content: "" } }));
    expect(await generateDelegatedDeliveryWithRepair(empty)).toEqual({});
    expect(empty).toHaveBeenCalledTimes(2);
  });

  it("keeps upstream model failures distinct from malformed output", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("upstream unavailable"));
    await expect(generateDelegatedDeliveryWithRepair(generate)).rejects.toThrow("upstream unavailable");
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("requires contextual judgment instead of a static task blacklist", () => {
    const prompts = buildDelegatedWorkAssessmentPrompts({
      course,
      studentId: "student-1",
      studentName: "小林",
      stageKey: "make",
      request: "帮我搜集校园用水数据并汇总结论",
      documentText: "我们准备调查教学楼洗手池。",
    });
    expect(prompts.system).toContain("同一项工作在不同项目中结论可以不同");
    expect(prompts.system).toContain("搜集资料并汇总");
    expect(prompts.user).toContain("自主采集数据");
    expect(prompts.user).toContain("证据质量（权重 45）");
    expect(prompts.user).toContain("重视学生自主调查与证据分析过程");
  });

  it("conservatively normalizes malformed assessments to clarification", () => {
    const assessment = normalizeDelegatedWorkAssessment({ decision: "maybe" });
    expect(assessment.decision).toBe("clarify");
    expect(assessment.studentResponsibility).toBeTruthy();
  });

  it("asks the student directly instead of exposing internal assessment language", () => {
    const response = assessmentToBoundaryResponse(normalizeDelegatedWorkAssessment({
      decision: "clarify",
      taskTitle: "搜集资料",
      reason: "任务描述过于模糊，需要学生澄清。",
      studentMessage: "我还不确定你想先补哪类资料。你希望我先找背景数据、案例，还是表达范例？",
      protectedLearningWork: "学生选择研究方向",
      studentResponsibility: "学生需要选择主题",
      proposedScope: "AI 可以先整理三个资料方向",
    }));
    expect(response.message).toContain("我还不确定你想先补哪类资料");
    expect(response.message).not.toContain("学生");
    expect(response.message).not.toContain("任务描述过于模糊");
  });

  it("turns protected core learning into a refusal with an auxiliary alternative", () => {
    const response = assessmentToBoundaryResponse(normalizeDelegatedWorkAssessment({
      decision: "protected",
      taskTitle: "完成实地数据调查",
      reason: "自主采集与解释数据正是本项目的核心学习目标。",
      protectedLearningWork: "学生亲自采集并解释数据",
      studentResponsibility: "规划调查、采集数据并形成结论",
      proposedScope: "帮你设计一个空白记录表和核验清单",
      needsWebResearch: false,
      searchQuery: "",
    }));
    expect(response.kind).toBe("boundary");
    expect(response.message).toContain("需要由你亲自完成");
    expect(response.message).toContain("空白记录表");
  });

  it("returns an auditable detached delivery instead of an edit suggestion", () => {
    const assessment = normalizeDelegatedWorkAssessment({
      decision: "accepted",
      taskTitle: "整理术语表",
      reason: "术语整理是辅助工作。",
      protectedLearningWork: "证据分析",
      studentResponsibility: "核验术语并完成分析",
      proposedScope: "基于现有文档整理术语表",
      needsWebResearch: false,
      searchQuery: "",
    });
    const response = normalizeDelegatedWorkDelivery({
      assessment,
      researchMode: "model",
      raw: {
        message: "我完成了术语表，请你审阅。",
        deliverable: {
          title: "术语表",
          summary: "统一三个术语。",
          content: "| 术语 | 含义 |\n|---|---|\n| 流量 | 单位时间用水量 |",
          documentActions: [{
            operation: "insert-before",
            targetText: "研究方法",
            content: "| 术语 | 含义 |\n|---|---|\n| 流量 | 单位时间用水量 |",
            description: "在“研究方法”前加入术语表",
          }],
        },
      },
    });
    expect(response.kind).toBe("work-delivery");
    expect(response.suggestion).toBeUndefined();
    expect(response.message).toContain("确认后我再一次性应用");
    expect(response.message).not.toContain("已经插入");
    expect(response.deliverable?.content).toContain("| 术语 | 含义 |");
    expect(response.deliverable?.documentActions[0]).toMatchObject({
      operation: "insert-before",
      targetText: "研究方法",
    });
  });

  it("does not blame an empty model delivery on the student's scope", () => {
    const assessment = normalizeDelegatedWorkAssessment({ decision: "accepted", taskTitle: "整理术语表" });
    const result = normalizeDelegatedWorkDelivery({ raw: { deliverable: { content: "" } }, assessment, researchMode: "model" });
    expect(result.message).toBe("这次内容生成未完成，请重试。");
    expect(result.delegation?.decision).toBe("unavailable");
  });

  it("keeps only cited textbook sources in a delivery", () => {
    const assessment = normalizeDelegatedWorkAssessment({ decision: "accepted", taskTitle: "整理术语表" });
    const sources = [
      { id: "textbook:one", type: "textbook" as const, title: "教材一", note: "定义", locator: "第一章" },
      { id: "textbook:two", type: "textbook" as const, title: "教材二", note: "其他内容" },
    ];
    const result = normalizeDelegatedWorkDelivery({
      raw: { deliverable: { content: "术语定义", sourceIds: ["textbook:one", "fake"] } },
      assessment, sources, researchMode: "textbook",
    });
    expect(result.deliverable?.sources).toEqual([sources[0]]);
    expect(result.deliverable?.researchMode).toBe("textbook");
  });

  it("generates contextual quick tasks from the current document", () => {
    const prompts = buildDelegatedWorkStarterPrompts({
      course,
      studentId: "student-1",
      stageKey: "make",
      documentText: "我们已经记录了三处洗手池漏水现象，但还没有统一记录单位。",
    });
    expect(prompts.user).toContain("三处洗手池漏水现象");
    expect(prompts.system).toContain("不能使用固定通用模板");
    expect(normalizeDelegatedWorkStarters({
      starters: [
        "把文稿里已有的漏水现象整理成统一字段的记录表。",
        "根据当前记录整理一份单位和术语对照表。",
        "把当前文稿中的待补信息整理成资料搜集清单。",
      ],
    })).toHaveLength(3);
    const review = buildDelegatedWorkStarterReviewPrompts({
      course,
      studentId: "student-1",
      stageKey: "make",
      documentText: "我们准备调查教学楼洗手池。",
      candidates: ["替我采集所有数据并得出最终结论。"],
    });
    expect(review.system).toContain("必须改写为边缘性支持工作");
    expect(review.user).toContain("替我采集所有数据并得出最终结论");
  });

});
