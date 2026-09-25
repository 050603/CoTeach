import { describe, expect, it } from "vitest";
import { AI_COMPANIONS, buildCompanionSystemPrompt, recommendedCompanions } from "./ai-companions";
import type { CompanionContextSnapshot } from "./companion/context";

const context: CompanionContextSnapshot = {
  stageKey: "proposal",
  stageLabel: "方案构思与校准",
  studentId: "student-1",
  studentName: "小明",
  sections: {
    course: "AI 校园",
    project: "校园用电提醒器",
    progress: "方案构思与校准进度=40%",
    submissions: "我准备做一个校园用电提醒器",
    uploads: "（无记录）",
    teacherFeedback: "（无记录）",
    scoring: "（无记录）",
    aiEvaluation: "（无记录）",
    aiSupports: "（无记录）",
    reflection: "（无记录）",
    processEvidence: "（无记录）",
    teacherGuidance: "先说明证据",
  },
  prompt: "学生项目：我准备做一个校园用电提醒器。",
};

describe("AI companions", () => {
  it("provides six distinct learning roles", () => {
    expect(AI_COMPANIONS).toHaveLength(6);
    expect(new Set(AI_COMPANIONS.map((item) => item.role)).size).toBe(6);
  });

  it("recommends role-appropriate companions for project practice", () => {
    expect(recommendedCompanions("make").map((item) => item.id)).toEqual(["knowledge", "ideation", "critic", "planner", "reviewer", "recorder"]);
  });

  it("does not expose ideation during reflection", () => {
    expect(recommendedCompanions("reflection").map((item) => item.id)).toEqual(["reviewer", "recorder"]);
  });

  it("enforces student ownership in every role prompt", () => {
    const prompt = buildCompanionSystemPrompt({ companion: AI_COMPANIONS[2], courseName: "AI 校园", drivingQuestion: "如何设计？", stageKey: "proposal", stageLabel: "方案构思与校准", teacherContext: "先说明证据", context, peerResponses: ["知知：需要先定义用电数据来源"] });
    expect(prompt).toContain("不直接代替学生完成最终作品");
    expect(prompt).toContain("不替学生作最终决定");
    expect(prompt).toContain("采纳或拒绝建议的理由");
    expect(prompt).toContain("供学生审核的草稿");
    expect(prompt).toContain("不能替学生确定项目方向");
    expect(prompt).toContain("学生始终是项目负责人");
    expect(prompt).toContain("核验、选择、修改或亲自完成");
    expect(prompt).toContain("校园用电提醒器");
    expect(prompt).toContain("不要复述前序伙伴");
    expect(prompt).toContain("现在就能完成的动作");
    expect(prompt).toContain("只给一个学生现在就能完成的动作");
    expect(prompt).toContain("50-110 字");
  });

  it("keeps posttest companions away from question answers", () => {
    const prompt = buildCompanionSystemPrompt({
      companion: AI_COMPANIONS.find((item) => item.id === "recorder")!,
      courseName: "算法探究",
      drivingQuestion: "如何改进？",
      stageKey: "reflection",
      stageLabel: "后测",
      teacherContext: "引用过程证据",
      context: {
        ...context,
        stageKey: "reflection",
        stageLabel: "后测",
        prompt: "前序成果：我比较了两次测试结果。教师评分=82；AI 评价指出证据链不完整。",
      },
    });

    expect(prompt).toContain("后测");
    expect(prompt).toContain("代答后测");
    expect(prompt).toContain("解释本场测验的具体题目或选项");
  });
});
