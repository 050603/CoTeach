import { describe, expect, it } from "vitest";
import {
  applyOutlineFallbacks,
  generateSceneOutlinesFromRequirements,
  normalizeSceneOutlinesForDuration,
} from "./outline-generator";
import { buildOpenMaicBaselineOutlinePrompt } from "./openmaic-baseline";
import type { SceneOutline } from "@openmaic/lib/types/generation";

const legacyPblOutline: SceneOutline = {
  id: "legacy-pbl",
  type: "pbl",
  title: "个人项目展示",
  description: "旧版 PBL 场景",
  keyPoints: [],
  order: 1,
  pblConfig: {
    projectTopic: "个人项目",
    projectDescription: "旧版个人项目场景",
    targetSkills: ["方案设计"],
  },
};

describe("PBL outline fallbacks", () => {
  it("routes a standard production outline through the exact upstream one-click prompt", async () => {
    let capturedSystem = "";
    let capturedUser = "";
    const requirements = { requirement: "为初中生讲解变量之间的关系" };
    const result = await generateSceneOutlinesFromRequirements(
      requirements,
      "变量资料原文",
      undefined,
      async (system, user) => {
        capturedSystem = system;
        capturedUser = user;
        return JSON.stringify({
          languageDirective: "使用中文",
          outlines: [{
            id: "official-slide",
            type: "slide",
            title: "变量关系",
            description: "比较变量变化与结果。",
            keyPoints: ["自变量", "因变量"],
            order: 0,
          }],
        });
      },
    );
    const official = buildOpenMaicBaselineOutlinePrompt(requirements, {
      pdfText: "变量资料原文",
    });
    expect({ system: capturedSystem, user: capturedUser }).toEqual(official);
    expect(result.data?.outlines.map((outline) => outline.type)).toEqual(["slide"]);
  });

  it("preserves an AI semantic page plan instead of splitting by fixed seconds", () => {
    const result = normalizeSceneOutlinesForDuration([
      {
        id: "detail-1",
        type: "slide",
        title: "核心方法",
        description: "讲清方法、案例和练习。",
        keyPoints: ["概念", "方法", "案例", "练习"],
        order: 0,
        stageKey: "ai-learning",
        audience: "student",
        parentActivityId: "module-ai",
        targetDurationSec: 300,
        ttsPolicy: "target-duration",
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "detail-1",
      targetDurationSec: 300,
      parentActivityId: "module-ai",
      ttsPolicy: "target-duration",
    });
    expect(result[0]?.segmentCount).toBeUndefined();
  });

  it.each([1500, 3000])("does not turn %s seconds of teacher facilitation time into extra PPT pages", (targetDurationSec) => {
    const result = normalizeSceneOutlinesForDuration([
      {
        id: "teacher-detail",
        type: "slide",
        title: "项目实践教师支架",
        description: "教师用这张 PPT 组织项目实践、巡视和反馈。",
        keyPoints: ["任务说明", "巡视反馈", "成果要求"],
        order: 0,
        stageKey: "practice",
        audience: "teacher",
        generationPurpose: "teacher-resource",
        targetDurationSec,
        ttsPolicy: "none",
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "teacher-detail",
      targetDurationSec,
      ttsPolicy: "none",
    });
    expect(result[0]?.segmentCount).toBeUndefined();
  });

  it("keeps teacher scaffolds intact when audience metadata is incomplete", () => {
    const result = normalizeSceneOutlinesForDuration([
      {
        id: "practice-scaffold",
        type: "slide",
        title: "实践阶段主持提示",
        description: "教师主持项目实践。",
        keyPoints: ["时间提醒", "证据检查"],
        order: 0,
        stageKey: "practice",
        generationPurpose: "facilitation-scaffold",
        targetDurationSec: 1500,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("practice-scaffold");
  });

  it("does not clone interactive activities or short slides", () => {
    const result = normalizeSceneOutlinesForDuration([
      {
        id: "interactive-1",
        type: "interactive",
        title: "练习",
        description: "完成练习。",
        keyPoints: ["练习"],
        order: 0,
        targetDurationSec: 300,
      },
      {
        id: "slide-1",
        type: "slide",
        title: "短讲解",
        description: "短讲解。",
        keyPoints: ["概念"],
        order: 1,
        targetDurationSec: 120,
      },
    ]);

    expect(result.map((outline) => outline.id)).toEqual(["interactive-1", "slide-1"]);
  });

  it("keeps multiple AI-planned semantic details and their target allocation in order", () => {
    const result = normalizeSceneOutlinesForDuration([
      {
        id: "concept",
        type: "slide",
        title: "核心概念",
        description: "先建立概念模型。",
        keyPoints: ["概念"],
        order: 2,
        stageKey: "ai-learning",
        audience: "student",
        parentActivityId: "module-ai",
        targetDurationSec: 80,
        ttsPolicy: "target-duration",
      },
      {
        id: "practice",
        type: "interactive",
        title: "迁移练习",
        description: "用概念分析新情境。",
        keyPoints: ["应用"],
        order: 1,
        stageKey: "ai-learning",
        audience: "student",
        parentActivityId: "module-ai",
        targetDurationSec: 220,
        ttsPolicy: "target-duration",
      },
    ]);

    expect(result.map((outline) => outline.id)).toEqual(["concept", "practice"]);
    expect(result.map((outline) => outline.targetDurationSec)).toEqual([80, 220]);
  });

  it("converts legacy group PBL scenes to ordinary scenes in personal mode", () => {
    const result = applyOutlineFallbacks(legacyPblOutline, true, { personalProject: true });

    expect(result.type).toBe("slide");
    expect(result.pblConfig).toBeUndefined();
  });

  it("keeps legacy PBL scenes available when personal mode is not enabled", () => {
    const result = applyOutlineFallbacks(legacyPblOutline, true);

    expect(result.type).toBe("pbl");
  });
});
