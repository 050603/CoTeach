import { describe, expect, it, vi } from "vitest";
import type { AICallFn } from "@openmaic/lib/generation/pipeline-types";
import { LAB_BATCHES, LAB_SECTION_FIXTURES } from "./fixtures";
import {
  narrationStyleIssues,
  normalizeNarrationRewrite,
  normalizeTeachingDesign,
  recoverVariantAfterGenerationFailure,
  withActuallyTaughtNarration,
} from "./generate";
import type { LabVariantResult } from "./types";

describe("course quality lab fixtures", () => {
  it("defines one run for each of the two target teaching scenarios", () => {
    expect(LAB_SECTION_FIXTURES).toHaveLength(2);
    expect(LAB_BATCHES).toEqual([1]);
    expect(LAB_SECTION_FIXTURES.every((section) => section.pages.length === 2)).toBe(true);
    expect(LAB_SECTION_FIXTURES.length * LAB_BATCHES.length).toBe(2);
    expect(new Set(LAB_SECTION_FIXTURES.map((section) => section.scenario))).toEqual(new Set([
      "中小学人工智能通识课",
      "大学《人工智能教育导论》",
    ]));
    expect(LAB_SECTION_FIXTURES.every((section) => section.targetPageDurationSec === 90)).toBe(true);
  });

  it("adds only the actually taught narration at quiz time", async () => {
    const base = vi.fn<AICallFn>(async () => "ok");
    await base("baseline-system", "baseline-user");
    expect(base.mock.calls[0].join("\n")).not.toContain("Actually taught narration");

    const quiz = withActuallyTaughtNarration(base, [{
      id: "slide-1:speech-1",
      slideIndex: 0,
      text: "表达流畅不能替代事实核验。",
    }]);
    await quiz("quiz-system", "quiz-user");
    expect(base.mock.calls[1][0]).toBe("quiz-system");
    expect(base.mock.calls[1][1]).toContain("Actually taught narration");
    expect(base.mock.calls[1][1]).toContain("表达流畅不能替代事实核验。");
    expect(base.mock.calls[1][1].match(/表达流畅不能替代事实核验。/g)).toHaveLength(1);
    expect(base.mock.calls[1][1]).not.toContain("Course-quality lab teaching design");
  });

  it("rejects incomplete or out-of-range teaching designs", () => {
    expect(() => normalizeTeachingDesign({ coreExplanation: [] }, 2)).toThrow(/缺少/);
    expect(normalizeTeachingDesign({
      coreExplanation: ["机制"],
      workedExample: ["示例"],
      conditionsAndMisconceptions: ["边界"],
      assessmentFocus: ["检验"],
      pagePlan: [{ page: 1, purpose: "第一页" }, { page: 3, purpose: "越界" }],
    }, 2).pagePlan).toEqual([{ page: 1, purpose: "第一页" }]);
  });

  it("rejects production language and source labels before enhanced narration reaches TTS", () => {
    expect(narrationStyleIssues([
      { id: "s1", text: "这一页的核心观点是，表达流畅不等于事实可靠。" },
      { id: "s2", text: "资料1要求我们先确认学习目标。" },
    ])).toEqual(expect.arrayContaining([
      expect.stringContaining("页面制作视角"),
      expect.stringContaining("讲稿提纲标签"),
      expect.stringContaining("资料编号"),
    ]));
  });

  it("keeps narration segments aligned while accepting natural teacher speech", () => {
    const original = [
      { id: "s1", text: "这一页的核心观点是，表达流畅不等于事实可靠，我们需要把表达质量和证据可靠性彻底分开。" },
      { id: "s2", text: "接下来我们通过一个校史年份的例子，说明为什么需要查找独立、权威或者原始的材料。" },
    ];
    const rewritten = normalizeNarrationRewrite({ segments: [
      { id: "s1", text: "先把两件事分开：说得顺，不代表说得对。表达质量再高，也不能代替证据。" },
      { id: "s2", text: "大家看这个校史年份。校志和官网都查不到出处，我们就先标成待核验，再去找独立、权威或者原始的材料。" },
    ] }, original);
    expect(rewritten.map((segment) => segment.id)).toEqual(["s1", "s2"]);
    expect(narrationStyleIssues(rewritten)).toEqual([]);
    expect(() => normalizeNarrationRewrite({ segments: [...rewritten].reverse() }, original)).toThrow(/保留 id/);
    expect(() => normalizeNarrationRewrite({ segments: rewritten }, original, 300)).toThrow(/目标约 300 字/);
  });

  it("keeps the last complete result when a refresh fails before new artifacts are ready", () => {
    const complete = {
      label: "教学增强",
      statuses: {
        ppt: { state: "complete", updatedAt: "earlier" },
        script: { state: "complete", updatedAt: "earlier" },
        tts: { state: "complete", updatedAt: "earlier" },
      },
      slides: [{ id: "old-slide", title: "可评判的旧结果" }],
      script: [],
      quiz: [],
      checks: [],
    } satisfies LabVariantResult;
    const running = {
      ...structuredClone(complete),
      statuses: {
        ppt: { state: "running", updatedAt: "now" },
        script: { state: "running", updatedAt: "now" },
        tts: { state: "running", updatedAt: "now" },
      },
    } satisfies LabVariantResult;

    const recovered = recoverVariantAfterGenerationFailure(running, complete, "服务商超时");
    expect(recovered.statuses).toEqual(complete.statuses);
    expect(recovered.slides[0]?.id).toBe("old-slide");
    expect(recovered.checks).toContain("本次重新生成失败，已继续展示上一次完整结果：服务商超时");
  });

  it("keeps newly exported PPT and script when only the final audio stage fails", () => {
    const previous = {
      label: "教学增强",
      statuses: {
        ppt: { state: "complete", updatedAt: "earlier" },
        script: { state: "complete", updatedAt: "earlier" },
        tts: { state: "complete", updatedAt: "earlier" },
      },
      slides: [{ id: "old-slide", title: "旧结果" }],
      script: [],
      quiz: [],
    } satisfies LabVariantResult;
    const current = {
      ...structuredClone(previous),
      statuses: {
        ppt: { state: "complete", updatedAt: "now" },
        script: { state: "complete", updatedAt: "now" },
        tts: { state: "running", updatedAt: "now" },
      },
      slides: [{ id: "new-slide", title: "新结果" }],
    } satisfies LabVariantResult;

    const recovered = recoverVariantAfterGenerationFailure(current, previous, "音频打包失败");
    expect(recovered.slides[0]?.id).toBe("new-slide");
    expect(recovered.statuses.ppt.state).toBe("complete");
    expect(recovered.statuses.script.state).toBe("complete");
    expect(recovered.statuses.tts).toMatchObject({ state: "failed", message: "音频打包失败" });
  });
});
