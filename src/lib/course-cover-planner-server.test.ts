import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCourseCoverPrompt } from "./course-cover";
import { buildCourseCoverPlanningInput, parseCourseCoverVisualPlan, planCourseCoverImageOnServer } from "./course-cover-planner-server";

const mocks = vi.hoisted(() => ({ resolveModel: vi.fn(), callLLM: vi.fn() }));
vi.mock("@openmaic/lib/server/resolve-model", () => ({ resolveModel: mocks.resolveModel }));
vi.mock("@openmaic/lib/ai/llm", () => ({ callLLM: mocks.callLLM }));

const plan = {
  topicSummary: "通过具体分类学习活动理解人工智能教育中的教学反馈",
  visualAnchor: "学习者把错误分类的图卡移回对应组，表现建构与反馈",
  sceneDescription: "An East Asian trainee teacher moves a misplaced illustrated sample card into its matching cluster beside a compact learning model. The cards show only natural silhouettes on plain surfaces. A close oblique view keeps the activity at the center of a continuous tabletop scene with a quiet pale background.",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveModel.mockResolvedValue({ model: "test-model" });
  mocks.callLLM.mockResolvedValue({ text: JSON.stringify(plan) });
});

describe("course cover content planning", () => {
  it.each(["course", "classroom"] as const)("understands full %s content before compiling an image prompt", async (coverKind) => {
    const summary = "教学背景。".repeat(50) + "第二节重点是项目式教学模式与具身认知。";
    const result = await planCourseCoverImageOnServer({ name: "人工智能教育教学理论与方法", summary, coverKind });
    const request = mocks.callLLM.mock.calls[0][0];
    expect(JSON.parse(request.messages[0].content)).toMatchObject({ coverKind, summary });
    expect(mocks.resolveModel).toHaveBeenCalledWith({});
    expect(request.abortSignal).toBeInstanceOf(AbortSignal);
    const prompt = buildCourseCoverPrompt(result);
    expect(prompt).toContain(plan.sceneDescription);
    expect(prompt).not.toContain(summary);
    expect(prompt).not.toContain("人工智能教育教学理论与方法");
    expect(prompt).not.toContain(request.system);
  });

  it("selects curriculum fields without exposing student or runtime data", () => {
    const course = {
      name: "人工智能教育", term: "2026秋", students: [{ displayName: "PRIVATE_STUDENT" }],
      learningObjectives: ["分析学习反馈"],
      content: {
        pblOutline: "设计分类教学活动",
        lessonOutline: [{ id: "l1", stageKey: "make", title: "分类反馈", durationMin: 20, objectives: ["理解反馈"], activities: ["移动错误样本"] }],
      },
    };
    const input = buildCourseCoverPlanningInput(course);
    expect(input).toContain("分类反馈");
    expect(input).toContain("移动错误样本");
    expect(input).toContain("分析学习反馈");
    expect(input).not.toContain("PRIVATE_STUDENT");
    expect(input).not.toContain("2026秋");
  });

  it("reports malformed output without another planning call", async () => {
    mocks.callLLM.mockResolvedValueOnce({ text: JSON.stringify({ ...plan, sceneDescription: "课堂封面任务：把课程名称印到顶部。" }) });
    await expect(planCourseCoverImageOnServer({ name: "人工智能教育" }))
      .rejects.toMatchObject({ code: "COURSE_COVER_PLAN_INVALID" });
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
  });

  it.each([
    "Course name: Learning feedback. " + plan.sceneDescription,
    plan.sceneDescription + ' A sign titled "Learning feedback".',
    plan.sceneDescription + " 课程简介：请写标题。",
    plan.sceneDescription + " A card displays 123.",
  ])("rejects planner or lettering instructions in the final scene", (sceneDescription) => {
    expect(parseCourseCoverVisualPlan(JSON.stringify({ ...plan, sceneDescription }))).toBeNull();
  });

  it("reports persistent invalid planning without a raw-course fallback", async () => {
    mocks.callLLM.mockResolvedValue({ text: '{"sceneDescription":"draw something"}' });
    await expect(planCourseCoverImageOnServer({ name: "人工智能教育" }))
      .rejects.toMatchObject({ code: "COURSE_COVER_PLAN_INVALID" });
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
  });

  it("returns a planning-stage error when the text model is unavailable", async () => {
    mocks.resolveModel.mockRejectedValue(new Error("No configured model"));
    await expect(planCourseCoverImageOnServer({ name: "人工智能教育" }))
      .rejects.toMatchObject({ code: "COURSE_COVER_PLAN_UNAVAILABLE" });
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it("does not start planning for an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(planCourseCoverImageOnServer({ name: "人工智能教育" }, controller.signal)).rejects.toThrow();
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });
});
