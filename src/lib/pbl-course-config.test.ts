import { describe, expect, it } from "vitest";
import {
  DEFAULT_PBL_COURSE_CONFIG,
  formatPblCourseConfigForPrompt,
  normalizePblCourseConfig,
} from "./pbl-course-config";

describe("PBL course configuration", () => {
  it("defaults legacy courses to LLM resource inquiry and preserves the teacher web-search choice", () => {
    expect(normalizePblCourseConfig().resourceInquiryMode).toBe("llm");
    expect(normalizePblCourseConfig().practiceWebSearchEnabled).toBe(true);
    expect(normalizePblCourseConfig({ resourceInquiryMode: "web-search" }).resourceInquiryMode)
      .toBe("web-search");
    expect(normalizePblCourseConfig({ practiceWebSearchEnabled: false }).practiceWebSearchEnabled)
      .toBe(false);
  });

  it("defaults to a personal project with a process recorder", () => {
    const config = normalizePblCourseConfig();

    expect(config.projectMode).toBe("personal");
    expect(config.makeArtifactMode).toBe("document");
    expect(config.generationTemplate).toBe("new-ai-learning-only");
    expect(config.evaluationModel).toBe("tri-party");
    expect(config.companionIds).toContain("recorder");
    expect(config.evidenceRequirements.map((item) => item.label)).toEqual(
      expect.arrayContaining(["构思草稿", "方案修订记录", "反思日志", "数据 / 测试截图"]),
    );
    expect(config.evidenceRequirements.map((item) => item.kind)).not.toEqual(
      expect.arrayContaining(["ai-decision-log", "artifact-version"]),
    );
  });

  it("preserves the teacher-selected project-practice artifact mode", () => {
    expect(normalizePblCourseConfig({ makeArtifactMode: "other" }).makeArtifactMode).toBe("other");
    expect(normalizePblCourseConfig({ makeArtifactMode: "document" }).makeArtifactMode).toBe("document");
    expect(normalizePblCourseConfig({ makeArtifactMode: "python" }).makeArtifactMode).toBe("python");
    expect(normalizePblCourseConfig({ makeArtifactMode: "c" }).makeArtifactMode).toBe("c");
  });

  it("preserves the explicit new-system AI-only generation template", () => {
    expect(normalizePblCourseConfig({
      generationTemplate: "new-ai-learning-only",
    }).generationTemplate).toBe("new-ai-learning-only");
  });

  it("uses the fixed role set without teacher configuration", () => {
    const config = normalizePblCourseConfig({ companionIds: ["critic", "critic"] });

    expect(config.companionIds).toEqual([
      "knowledge", "ideation", "critic", "planner", "reviewer", "recorder",
    ]);
  });

  it("normalizes legacy inquiry lists to one core project driving question", () => {
    const config = normalizePblCourseConfig({
      inquiryQuestions: ["  如何节水？ ", "如何节水？", "如何回收雨水？"],
    });

    expect(config.inquiryQuestions).toEqual(["如何节水？"]);
  });

  it("treats evidence requirements as selected entries", () => {
    const config = normalizePblCourseConfig({
      evidenceRequirements: [
        { kind: "ai-decision-log", label: "AI 建议采纳记录", description: "记录理由", required: false, stageKeys: ["proposal"] },
        { kind: "artifact-version", label: "作品迭代版本", description: "保留版本", required: true, stageKeys: ["make"] },
      ],
    });

    expect(config.evidenceRequirements.map((item) => item.kind)).toEqual(["artifact-version"]);
  });

  it("does not share nested defaults between courses", () => {
    const first = normalizePblCourseConfig(DEFAULT_PBL_COURSE_CONFIG);
    const second = normalizePblCourseConfig(DEFAULT_PBL_COURSE_CONFIG);

    first.evidenceRequirements[0].stageKeys.push("make");
    first.outcome.artifact = "作品";

    expect(second.evidenceRequirements[0].stageKeys).not.toContain("make");
    expect(second.outcome.artifact).toBe("");
  });

  it("serializes structured configuration for prompt injection", () => {
    const text = formatPblCourseConfigForPrompt({
      ...DEFAULT_PBL_COURSE_CONFIG,
      outcome: { artifact: "校园节能方案", presentation: "现场答辩", reflection: "反思日志" },
    });

    expect(text).toContain('"projectMode": "personal"');
    expect(text).toContain("校园节能方案");
    expect(text).toContain("recorder");
    expect(text).toContain("companionProfiles");
    expect(text).toContain("companionStagePolicies");
    expect(text).not.toContain('"reflection": {');
    expect(text).toContain("过程记录");
  });
});
