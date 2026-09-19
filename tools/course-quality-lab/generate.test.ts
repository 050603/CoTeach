import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AICallFn } from "@openmaic/lib/generation/pipeline-types";
import { FORMAL_QUALITY_REGRESSION_FIXTURES, LAB_BATCHES, LAB_SECTION_FIXTURES } from "./fixtures";
import {
  LAB_EXPERIMENT_ID,
  bindCallGenerationIdentity,
  resolveLabThinking,
  applySlideElementUpdates,
  bindScriptAudioToScenes,
  buildFirstPassTeachingEvidence,
  buildV5SemanticMap,
  compileV5Actions,
  compactLabNarrationSystem,
  compactLabSlideSystem,
  generateV5Narration,
  initialManifest,
  narrationStyleIssues,
  normalizeLabPageJointReview,
  normalizeNarrationRewrite,
  normalizeNarrationPatch,
  normalizeTeachingDesign,
  normalizeV5Narration,
  planNarrationBudgetRepairs,
  repairV5PageOnce,
  recordDurationCheck,
  repairLabCourseOnce,
  recoverVariantAfterGenerationFailure,
  restoreV5SemanticElementIds,
  runLoggedStage,
  reviewLabCourseLightly,
  stageNarrationBudgetState,
  v5NarrationAssemblyIssues,
  v5RelevantLayoutIssues,
  withActuallyTaughtNarration,
  withEnhancedNarrationGuidance,
} from "./generate";
import { cleanManifestRecords } from "./cleanup";
import type { LoggedCall } from "./generate";
import type { CourseQualityLabManifest, LabVariantResult, TeachingDesign } from "./types";
import type { GeneratedSlideContent, SceneOutline } from "@openmaic/lib/types/generation";
import type { Action } from "@openmaic/lib/types/action";
import type { Scene } from "@openmaic/lib/types/stage";

describe("course quality lab fixtures", () => {
  it("defines one independent run for each target teaching scenario", () => {
    expect(LAB_SECTION_FIXTURES).toHaveLength(3);
    expect(LAB_BATCHES).toEqual([1]);
    expect(LAB_SECTION_FIXTURES.every((section) => section.pages.length === 2)).toBe(true);
    expect(LAB_SECTION_FIXTURES.length * LAB_BATCHES.length).toBe(3);
    expect(new Set(LAB_SECTION_FIXTURES.map((section) => section.scenario))).toEqual(new Set([
      "中小学人工智能通识课",
      "大学《人工智能教育导论》",
      "师范本科人工智能教育课程",
    ]));
    expect(LAB_SECTION_FIXTURES.every((section) => section.targetPageDurationSec === 90)).toBe(true);
    expect(LAB_SECTION_FIXTURES.every((section) => section.questionCount === 2)).toBe(true);
    expect(LAB_SECTION_FIXTURES.find((section) => section.id === "ai-education-teaching-methods")?.grade)
      .toContain("已具备教育学、教学设计和人工智能常识基础");
  });

  it("keeps the theory-mode-method progression case as an opt-in formal regression", () => {
    const fixture = FORMAL_QUALITY_REGRESSION_FIXTURES.find((item) => item.id === "theory-mode-method-progression");
    expect(fixture?.pages[0]?.purpose).toContain("完整呈现猫狗分类课堂中教师和学生的行动");
    expect(fixture?.pages[1]?.purpose).toContain("只把半成品对比表改为口头提问");
    expect(fixture?.sources[1]?.detail).toContain("不能单独决定分类");
    expect(fixture?.sources[1]?.detail).toContain("不能据此断定教学设计本身没有依据");
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

  it("removes fixed narration structure and turns the page budget into a first-pass requirement", () => {
    const compact = compactLabNarrationSystem(`before
**Speech is where all verbal content belongs.** details
- encouragement

**CRITICAL — Same-session continuity**: details
- **First page**: greet
Structure:
- **Opening/Transition**
- **Body**
- **Summary**

### 2. Visual Guidance Strategy
keep visual rules
## 时间预算（阶段总量约束，页与段仅供分配参考）
- 时间验收只针对整个知识讲授阶段的总时长（±10%），不要求每页或每段分别命中。下列份额已按内容量分配；不要把阶段总预算全部用在当前页。
- 本页讲稿量参考：约 300 中文字符/混合文本单位；270-330 是规划参考范围，不是逐页验收条件`);
    expect(compact).not.toContain("First page");
    expect(compact).not.toContain("Opening/Transition");
    expect(compact).not.toContain("不是逐页验收条件");
    expect(compact).toContain("首次生成必须执行");
    expect(compact).toContain("270-330 是首次生成必须满足的范围");
    expect(compact).toContain("Visual Guidance Strategy");
  });

  it("keeps slide protocols while removing long generic examples irrelevant to the lab", () => {
    const compact = compactLabSlideSystem(`header
### LineElement
very long routing tutorial
### ChartElement
very long chart tutorial
### LatexElement
very long formula tutorial
### TableElement
table schema
#### Complete Example: Card with centered text
large card JSON
#### Common Mistakes to Avoid
large mistakes
### Rule 6: Decorative Lines
large decorative examples
### Rule 7: Spacing Standards
spacing
## Pre-Output Checklist
checklist
## Output Format
format`);
    expect(compact).not.toContain("very long routing tutorial");
    expect(compact).not.toContain("large card JSON");
    expect(compact).toContain('type:"line"');
    expect(compact).toContain("Required: `id,type,left,top,width,height,chartType,data,themeColors`");
    expect(compact).toContain("### TableElement");
    expect(compact).toContain("## Pre-Output Checklist");
    expect(compact).toContain("## Output Format");
  });

  it("reuses a persisted raw response and isolates a parse failure to its own stage", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-lab-call-"));
    try {
      const callsPath = path.join(directory, "calls.json");
      const calls: LoggedCall[] = [];
      const validModel = vi.fn<AICallFn>(async () => '{"ok":true}');
      const parse = (stageCall: AICallFn) => stageCall("system", "user").then((text) => JSON.parse(text) as { ok: boolean });
      await expect(runLoggedStage(validModel, calls, callsPath, "quiz", parse)).resolves.toEqual({ ok: true });
      await expect(runLoggedStage(validModel, calls, callsPath, "quiz", parse)).resolves.toEqual({ ok: true });
      expect(validModel).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(1);
      expect(await fs.readFile(path.join(directory, calls[0].responseFile ?? ""), "utf8")).toBe('{"ok":true}');

      const repairedModel = vi.fn<AICallFn>()
        .mockResolvedValueOnce("not-json")
        .mockResolvedValueOnce('{"ok":true}');
      await expect(runLoggedStage(repairedModel, calls, callsPath, "review", parse)).resolves.toEqual({ ok: true });
      expect(repairedModel).toHaveBeenCalledTimes(2);
      expect(calls.filter((call) => call.stageId === "review")).toHaveLength(2);
      expect(calls.find((call) => call.stageId === "review")?.parseError).toBeTruthy();

      const reparsed = vi.fn<AICallFn>(async () => {
        throw new Error("stored response should be reparsed without another request");
      });
      const reparsedResult = await runLoggedStage(reparsed, calls, callsPath, "review", parse);
      expect(reparsedResult).toEqual({ ok: true });
      expect(reparsed).not.toHaveBeenCalled();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([undefined, "previous-policy"])("does not reuse responses or attempts from generation %s", async (previousIdentity) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-lab-identity-"));
    try {
      const calls: LoggedCall[] = [];
      const callsPath = path.join(directory, "calls.json");
      if (previousIdentity) bindCallGenerationIdentity(calls, previousIdentity);
      const parse = (stageCall: AICallFn) => stageCall("system", "user").then((text) => JSON.parse(text) as unknown);
      const oldModel = vi.fn<AICallFn>().mockResolvedValueOnce("not-json").mockResolvedValueOnce('{"old":true}');
      await expect(runLoggedStage(oldModel, calls, callsPath, "slide", parse)).resolves.toEqual({ old: true });
      expect(oldModel).toHaveBeenCalledTimes(2);
      const restored = JSON.parse(await fs.readFile(callsPath, "utf8")) as LoggedCall[];
      bindCallGenerationIdentity(restored, "explicit-disabled-policy");
      const newModel = vi.fn<AICallFn>(async () => '{"new":true}');
      await expect(runLoggedStage(newModel, restored, callsPath, "slide", parse)).resolves.toEqual({ new: true });
      await expect(runLoggedStage(newModel, restored, callsPath, "slide", parse)).resolves.toEqual({ new: true });
      expect(newModel).toHaveBeenCalledOnce();
      expect(restored).toHaveLength(3);
      expect(restored[2].generationIdentity).toBe("explicit-disabled-policy");
      expect(restored[2].attempts[0].attempt).toBe(1);
      expect(restored[0]).toEqual(calls[0]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["system", "user", "image"])("does not reuse a stage after its %s changes", async (changed) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-lab-prompt-"));
    try {
      const calls: LoggedCall[] = [];
      bindCallGenerationIdentity(calls, "same-policy");
      const callsPath = path.join(directory, "calls.json");
      const model = vi.fn<AICallFn>().mockResolvedValueOnce("old").mockResolvedValueOnce("new");
      await runLoggedStage(model, calls, callsPath, "slide", (stageCall) => stageCall("system", "user", [{ id: "image", src: "old" }]));
      await expect(runLoggedStage(model, calls, callsPath, "slide", (stageCall) => stageCall(
        changed === "system" ? "new system" : "system",
        changed === "user" ? "new user" : "user",
        [{ id: "image", src: changed === "image" ? "new" : "old" }],
      ))).resolves.toBe("new");
      expect(model).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("does not multiply transport failures at the stage boundary", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-lab-transport-"));
    try {
      const calls: LoggedCall[] = [];
      const model = vi.fn<AICallFn>(async () => { throw new Error("provider unavailable"); });
      await expect(runLoggedStage(
        model,
        calls,
        path.join(directory, "calls.json"),
        "slide-1-content",
        (stageCall) => stageCall("system", "user"),
      )).rejects.toThrow("provider unavailable");
      expect(model).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(1);
      expect(calls[0].status).toBe("failed");
      expect(calls[0].parseError).toBeUndefined();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("stops after two invalid model outputs and sends the validator error to the retry", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-lab-invalid-budget-"));
    try {
      const calls: LoggedCall[] = [];
      const model = vi.fn<AICallFn>(async () => "not-json");
      await expect(runLoggedStage(
        model,
        calls,
        path.join(directory, "calls.json"),
        "slide-1-content",
        (stageCall) => stageCall("json system", "page input").then((text) => JSON.parse(text) as unknown),
      )).rejects.toThrow();
      expect(model).toHaveBeenCalledTimes(2);
      expect(model.mock.calls[1]?.[0]).toContain("技术错误");
      expect(calls).toHaveLength(2);
      expect(calls[1]?.retryReason).toBe("invalid-output");
      expect(calls.every((call) => call.parseError)).toBe(true);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("retries an interrupted stage on the next resume without discarding its checkpoint", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-lab-resume-"));
    try {
      const calls: LoggedCall[] = [];
      const callsPath = path.join(directory, "calls.json");
      await expect(runLoggedStage(
        vi.fn<AICallFn>(async () => { throw new Error("connection interrupted"); }),
        calls,
        callsPath,
        "course-light-review",
        (stageCall) => stageCall("system", "user"),
        { retryInvalidOutput: false },
      )).rejects.toThrow("connection interrupted");
      const resumed = vi.fn<AICallFn>(async () => '{"pages":[]}');
      await expect(runLoggedStage(
        resumed,
        calls,
        callsPath,
        "course-light-review",
        (stageCall) => stageCall("system", "user"),
        { retryInvalidOutput: false },
      )).resolves.toBe('{"pages":[]}');
      expect(resumed).toHaveBeenCalledTimes(1);
      expect(calls.map((call) => call.status)).toEqual(["failed", "complete"]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("does not regenerate an invalid combined repair response", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-lab-single-repair-"));
    try {
      const calls: LoggedCall[] = [];
      const model = vi.fn<AICallFn>(async () => "not-json");
      await expect(runLoggedStage(
        model,
        calls,
        path.join(directory, "calls.json"),
        "slide-1-combined-repair",
        (stageCall) => stageCall("system", "user").then((text) => JSON.parse(text) as unknown),
        { retryInvalidOutput: false },
      )).rejects.toThrow();
      expect(model).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(1);
      expect(calls[0].parseError).toBeTruthy();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps V5 narration and action references stable across independent artifacts", () => {
    const design = normalizeTeachingDesign({ pagePlan: [{
      page: 1,
      purpose: "解释证据与结论的关系",
      priorKnowledge: "学生知道生成模型会输出文本",
      newContent: "流畅表达不能替代核验",
      explanation: ["用校史案例连接现象与结论"],
      examples: ["校史年份案例"],
      conditions: ["高风险主张需要独立来源"],
      requiredVisibleContent: ["流畅表达 ≠ 事实证据"],
      narrationFocus: ["解释为什么流畅度不能证明事实正确"],
      evidenceQuotes: ["流畅度不是事实性的保证"],
      assessmentFocus: ["说明需要核验的原因"],
    }] }, 1);
    const narration = normalizeV5Narration({ segments: [{
      semanticIds: ["page-1-narration-1"],
      text: "语言很顺，只说明表达符合常见模式；年份是否真实，仍要回到校志或原始文件核对。",
    }] }, design, 0);
    expect(narration[0].id).toBe("page-1-narration-1");
    expect(normalizeV5Narration({ response: { segments: [{
      semanticIds: ["page-1-narration-1"],
      text: "语言很顺，只说明表达符合常见模式；年份是否真实，仍要回到校志或原始文件核对。",
    }] } }, design, 0)).toEqual(narration);
    const content = {
      elements: [{
        id: "page-1-visible-1",
        type: "text",
        left: 100,
        top: 100,
        width: 500,
        height: 80,
        content: "<p>流畅表达 ≠ 事实证据</p>",
        rotate: 0,
      }],
    } as GeneratedSlideContent;
    const semanticMap = buildV5SemanticMap(content, design, 0);
    expect(semanticMap.requirementToElement["page-1-visible-1"]).toBe("page-1-visible-1");
    const outline = {
      id: "slide-1",
      type: "slide",
      title: "会表达不等于会求证",
      description: "",
      keyPoints: ["流畅不等于真实"],
      order: 0,
    } as SceneOutline;
    const actions = compileV5Actions(outline, content, narration, semanticMap);
    expect(actions.some((action) => action.type === "speech" && action.id === narration[0].id)).toBe(true);
    expect(actions.some((action) => action.type === "spotlight"
      && action.elementId === "page-1-visible-1"
      && action.speechId === narration[0].id)).toBe(true);

    const spokenTurns = normalizeV5Narration({ segments: [
      {
        semanticIds: ["page-1-narration-1"],
        text: "先看一个现象。系统回答得很流畅，你会马上相信它吗？",
      },
      {
        semanticIds: ["page-1-narration-1"],
        text: "别急着下结论。流畅说明表达自然，却不能说明年份已经核实。",
      },
      {
        semanticIds: ["page-1-narration-1"],
        text: "所以遇到姓名、年份或数据，我们要回到独立来源，一项一项确认。",
      },
    ] }, design, 0);
    expect(spokenTurns.map((segment) => segment.id)).toEqual([
      "page-1-narration-1-turn-1",
      "page-1-narration-1-turn-2",
      "page-1-narration-1-turn-3",
    ]);
    const spokenActions = compileV5Actions(outline, content, spokenTurns, semanticMap);
    expect(spokenActions.filter((action) => action.type === "speech")).toHaveLength(3);
    expect(spokenActions.filter((action) => action.type === "spotlight")).toHaveLength(1);
    expect(() => normalizeV5Narration({ segments: [{
      semanticIds: ["page-1-narration-1"],
      text: `这句话没有给语音留下自然停顿，${"而且还在不断叠加书面信息".repeat(6)}。`,
    }] }, design, 0)).not.toThrow();

    const regionContent = {
      elements: [{
        id: "page-1-visible-1",
        type: "shape",
        left: 80,
        top: 120,
        width: 600,
        height: 260,
        path: "M 0 0 L 1 0 L 1 1 L 0 1 Z",
        viewBox: [1, 1],
        fill: "#F8FAFC",
        fixedRatio: false,
      }],
    } as GeneratedSlideContent;
    expect(buildV5SemanticMap(regionContent, design, 0).requirementToElement)
      .toEqual({ "page-1-visible-1": "page-1-visible-1" });
  });

  it("restores model-authored semantic IDs by exact element identity after renderer reminting", () => {
    const design = normalizeTeachingDesign({ pagePlan: [{
      page: 1,
      purpose: "比较证据和条件",
      priorKnowledge: "理解基本概念",
      newContent: "证据和条件承担不同职责",
      explanation: ["说明两者关系"],
      examples: [],
      conditions: [],
      requiredVisibleContent: ["案例证据", "适用条件"],
      narrationFocus: ["解释案例证据", "解释适用条件"],
      evidenceQuotes: ["课程依据"],
      assessmentFocus: ["能区分证据和条件"],
    }] }, 1);
    const identity = (content: string, left: number) => ({
      type: "text",
      left,
      top: 120,
      width: 260,
      height: 80,
      content: `<p>${content}</p>`,
    });
    const rawResponse = JSON.stringify({ elements: [
      { id: "page-1-visible-2", ...identity("适用条件", 420) },
      { id: "decorative-title", ...identity("比较框架", 100) },
      { id: "page-1-visible-1", ...identity("案例证据", 100) },
    ] });
    const reminted = {
      elements: [
        { id: "text_random_a", ...identity("案例证据", 100), rotate: 0 },
        { id: "text_random_b", ...identity("适用条件", 420), rotate: 0 },
        { id: "text_random_c", ...identity("比较框架", 100), rotate: 0 },
      ],
    } as GeneratedSlideContent;
    const restored = restoreV5SemanticElementIds(reminted, rawResponse, design, 0);
    expect(restored.elements.map((element) => element.id)).toEqual([
      "page-1-visible-1",
      "page-1-visible-2",
      "text_random_c",
    ]);
  });

  it.each([{ visibleIndexes: [] }, { visibleIndexes: [1] }])("allows optional visual references in opening and closing: $visibleIndexes", ({ visibleIndexes }) => {
    const design = normalizeTeachingDesign({ pagePlan: [{
      page: 1,
      purpose: "完成一页课程",
      priorKnowledge: "学生了解基本概念",
      newContent: "证据与结论必须对应",
      explanation: ["用案例解释证据关系"],
      examples: ["核验案例"],
      conditions: ["结论只在证据范围内成立"],
      requiredVisibleContent: ["证据 → 推理 → 结论"],
      narrationFocus: ["解释证据怎样支持结论"],
      pageRole: "single",
      visualPlan: {
        structure: "case-reasoning",
        regions: [{ purpose: "证据链", visibleRequirementIndexes: [1] }],
        relationship: "用箭头连接证据、推理和结论",
      },
      deliveryPlan: [
        { function: "opening", instruction: "简短问好并引入学习方向", visibleRequirementIndexes: visibleIndexes, budgetWeight: 1 },
        { function: "example", instruction: "用案例准确解释证据与结论的关系和成立条件", visibleRequirementIndexes: [1], budgetWeight: 6 },
        { function: "closing", instruction: "回扣核心认识并转入节末练习", visibleRequirementIndexes: visibleIndexes, budgetWeight: 1 },
      ],
      evidenceQuotes: ["课程依据"],
      assessmentFocus: ["能解释证据关系"],
    }] }, 1, {
      requireV5Contract: true,
      timingBudgets: [{ targetDurationSec: 90, targetUnits: 400, minUnits: 360, maxUnits: 440, unit: "cjk-char" }],
    });
    const page = design.pagePlan?.[0];
    expect(page?.pageRole).toBe("single");
    expect(page?.deliveryPlan?.map((step) => step.function)).toEqual(["opening", "example", "closing"]);
    expect(page?.deliveryPlan?.reduce((sum, step) => sum + step.targetUnits, 0)).toBe(400);
    expect(page?.deliveryPlan?.[0].visibleRequirementIndexes).toEqual(visibleIndexes);
    expect(page?.deliveryPlan?.at(-1)?.visibleRequirementIndexes).toEqual(visibleIndexes);
  });

  it("preserves page roles without forcing every page into a delivery template", () => {
    const page = (
      pageNumber: number,
      pageRole: "opening" | "continuation" | "closing",
      functions: Array<"opening" | "knowledge" | "transition" | "closing">,
    ) => ({
      page: pageNumber,
      purpose: `第 ${pageNumber} 页职责`,
      priorKnowledge: "已有基础",
      newContent: `新增认识 ${pageNumber}`,
      explanation: ["完成本页教学"],
      examples: [],
      conditions: ["保留适用条件"],
      requiredVisibleContent: [`可见关系 ${pageNumber}`],
      narrationFocus: [`讲解步骤 ${pageNumber}`],
      pageRole,
      visualPlan: {
        structure: "framework",
        regions: [{ purpose: "主要区域", visibleRequirementIndexes: [1] }],
        relationship: "按框架组织",
      },
      deliveryPlan: functions.map((fn) => ({
        function: fn,
        instruction: `${fn} 表达任务`,
        visibleRequirementIndexes: fn === "knowledge" ? [1] : [],
        budgetWeight: fn === "knowledge" ? 6 : 1,
      })),
      evidenceQuotes: ["课程依据"],
      assessmentFocus: ["检查本页学习结果"],
    });
    const timingBudgets = [1, 2, 3].map(() => ({
      targetDurationSec: 60,
      targetUnits: 240,
      minUnits: 216,
      maxUnits: 264,
      unit: "cjk-char" as const,
    }));
    const design = normalizeTeachingDesign({ pagePlan: [
      page(1, "opening", ["opening", "knowledge"]),
      page(2, "continuation", ["transition", "knowledge"]),
      page(3, "closing", ["knowledge", "closing"]),
    ] }, 3, { requireV5Contract: true, timingBudgets });
    expect(design.pagePlan?.map((item) => item.pageRole)).toEqual(["opening", "continuation", "closing"]);
    expect(design.pagePlan?.[1].deliveryPlan?.map((step) => step.function)).not.toContain("opening");
    const flexible = normalizeTeachingDesign({ pagePlan: [
      page(1, "opening", ["opening", "knowledge"]),
      page(2, "continuation", ["opening", "knowledge"]),
      page(3, "closing", ["knowledge", "closing"]),
    ] }, 3, { requireV5Contract: true, timingBudgets });
    expect(flexible.pagePlan?.[1].deliveryPlan?.map((step) => step.function)).toEqual(["opening", "knowledge"]);
  });

  it("generates long professional narration once without a polishing loop", async () => {
    const fixture = LAB_SECTION_FIXTURES[0];
    const design = normalizeTeachingDesign({ pagePlan: [{
      page: 1,
      purpose: "解释机制",
      priorKnowledge: "学生使用过生成式人工智能",
      newContent: "提示改善不等于事实核验",
      explanation: ["保持机制与条件完整"],
      examples: [],
      conditions: ["关键事实仍需核验"],
      requiredVisibleContent: ["提示改善 ≠ 事实核验"],
      narrationFocus: ["准确解释两者关系"],
      pageRole: "single",
      visualPlan: {
        structure: "comparison",
        regions: [{ purpose: "概念对照", visibleRequirementIndexes: [1] }],
        relationship: "用不等号表达边界",
      },
      deliveryPlan: [
        { function: "opening", instruction: "问好并引入", visibleRequirementIndexes: [], budgetWeight: 1 },
        {
          function: "knowledge",
          instruction: "解释机制与条件",
          visibleRequirementIndexes: [1],
          budgetWeight: 6,
        },
        { function: "closing", instruction: "收束并转入练习", visibleRequirementIndexes: [], budgetWeight: 1 },
      ],
      evidenceQuotes: [fixture.sources.at(-1)?.detail?.slice(0, 12) ?? "生成模型"],
      assessmentFocus: ["能说明二者区别"],
    }] }, 1, {
      requireV5Contract: true,
      timingBudgets: [{ targetDurationSec: 90, targetUnits: 130, minUnits: 100, maxUnits: 160, unit: "cjk-char" }],
    });
    const longProfessionalSentence = "生成模型根据输入与训练中学到的语言模式生成后续内容，因此即使输出在语法、结构和语气上都很流畅，也不能据此推出姓名、年份、数据或引文已经经过独立来源核验。";
    const model = vi.fn<AICallFn>(async () => JSON.stringify({ segments: [
      { semanticIds: ["page-1-narration-1"], function: "opening", text: "同学们好，我们从一个流畅却待核验的回答开始。" },
      { semanticIds: ["page-1-narration-2"], function: "knowledge", text: longProfessionalSentence },
      { semanticIds: ["page-1-narration-3"], function: "closing", text: "记住这个边界，接下来用练习判断哪些主张需要核验。" },
    ] }));
    const narration = await generateV5Narration({ fixture, design, pageIndex: 0, aiCall: model });
    expect(model).toHaveBeenCalledTimes(1);
    expect(model.mock.calls[0]?.[0]).toContain("所有 segments.text 合计必须落在其中 minUnits 到 maxUnits 之间");
    expect(model.mock.calls[0]?.[0]).toContain("以 130 cjk-char 为目标");
    expect(model.mock.calls[0]?.[0]).toContain("把 reasoningSteps 合成一条连续因果链");
    expect(model.mock.calls[0]?.[0]).toContain("不要求每个步骤命中同一比例");
    expect(model.mock.calls[0]?.[0]).toContain("步骤可以采用不同结构");
    expect(model.mock.calls[0]?.[0]).toContain("Adjacent segments may jointly establish");
    expect(model.mock.calls[0]?.[0]).not.toContain("每个 knowledge 或 example 步骤都要形成可独立听懂的解释");
    expect(model.mock.calls[0]?.[0]).toContain("次数由当前内容决定，可以没有");
    expect(model.mock.calls[0]?.[0]).toContain("查不到依据只能说未证实");
    expect(model.mock.calls[0]?.[0]).toContain("数字、时长、篇幅、对象和任务要求必须互相兼容");
    expect(model.mock.calls[0]?.[1]).toContain('"minUnits":100');
    expect(model.mock.calls[0]?.[1]).toContain('"maxUnits":160');
    expect(model.mock.calls[0]?.[1]).toContain('"firstPassPageUnitRequirement"');
    expect(model.mock.calls[0]?.[1]).toContain('"estimatedTotalUnits":130');
    expect(narration[1].text).toBe(longProfessionalSentence);
    const tooShort = vi.fn<AICallFn>(async () => JSON.stringify({ segments: [
      { semanticIds: ["page-1-narration-1"], function: "opening", text: "同学们好。" },
      { semanticIds: ["page-1-narration-2"], function: "knowledge", text: "流畅不等于可靠。" },
      { semanticIds: ["page-1-narration-3"], function: "closing", text: "下面练习。" },
    ] }));
    await expect(generateV5Narration({ fixture, design, pageIndex: 0, aiCall: tooShort }))
      .resolves.toHaveLength(3);
    expect(tooShort).toHaveBeenCalledTimes(1);
  });

  it("keeps every essential V5 cue when more narration segments than visible targets are present", () => {
    const content = {
      elements: ["relation-a", "relation-b", "relation-c"].map((id, index) => ({
        id,
        type: "text",
        left: 100 + index * 400,
        top: 100,
        width: 320,
        height: 80,
        content: `<p>${id}</p>`,
        rotate: 0,
      })),
    } as GeneratedSlideContent;
    const narration = [1, 2, 3, 4].map((index) => ({
      id: `page-1-narration-${index}`,
      semanticIds: [`page-1-narration-${index}`],
      function: "knowledge" as const,
      text: `第${index}段讲解会完整说明观察、推理依据、适用条件和判断结论之间的关系，帮助学生把当前内容连接到页面上可见的证据，并知道什么时候需要继续核验。`,
    }));
    const actions = compileV5Actions({
      id: "slide-1",
      type: "slide",
      title: "证据关系",
      description: "",
      keyPoints: ["观察、依据、条件与结论"],
      order: 0,
    } as SceneOutline, content, narration, {
      requirementToElement: {
        "page-1-visible-1": "relation-a",
        "page-1-visible-2": "relation-b",
        "page-1-visible-3": "relation-c",
      },
      narrationToElements: {
        "page-1-narration-1": ["relation-a"],
        "page-1-narration-2": ["relation-b"],
        "page-1-narration-3": ["relation-c"],
        "page-1-narration-4": ["relation-c"],
      },
    });
    const spotlights = actions.filter((action) => action.type === "spotlight");
    expect(spotlights).toHaveLength(4);
    expect(spotlights.map((action) => action.speechId)).toEqual(narration.map((segment) => segment.id));
    expect(spotlights.at(-1)).toMatchObject({ elementId: "relation-c" });
  });

  it("binds narration to explicit visible requirements even when teaching order differs", () => {
    const design = normalizeTeachingDesign({ pagePlan: [{
      page: 1,
      purpose: "先解释条件，再分析案例",
      priorKnowledge: "理解基本概念",
      newContent: "条件和案例承担不同职责",
      explanation: ["按教学顺序使用两个区域"],
      examples: ["案例"],
      conditions: ["条件"],
      requiredVisibleContent: ["案例证据", "适用条件"],
      narrationFocus: ["先讲条件", "再讲案例"],
      pageRole: "single",
      visualPlan: {
        structure: "case-reasoning",
        regions: [
          { purpose: "案例", visibleRequirementIndexes: [1] },
          { purpose: "条件", visibleRequirementIndexes: [2] },
        ],
        relationship: "条件限定案例结论",
      },
      deliveryPlan: [
        { function: "opening", instruction: "问好并引入", visibleRequirementIndexes: [], budgetWeight: 1 },
        { function: "knowledge", instruction: "先解释适用条件", visibleRequirementIndexes: [2], budgetWeight: 4 },
        { function: "example", instruction: "再分析案例证据", visibleRequirementIndexes: [1], budgetWeight: 4 },
        { function: "closing", instruction: "收束并转入练习", visibleRequirementIndexes: [], budgetWeight: 1 },
      ],
      evidenceQuotes: ["课程依据"],
      assessmentFocus: ["能说明条件和案例关系"],
    }] }, 1, {
      requireV5Contract: true,
      timingBudgets: [{ targetDurationSec: 60, targetUnits: 240, minUnits: 216, maxUnits: 264, unit: "cjk-char" }],
    });
    const content = {
      elements: [1, 2].map((index) => ({
        id: `page-1-visible-${index}`,
        type: "text",
        left: index * 300,
        top: 100,
        width: 250,
        height: 80,
        content: `<p>${index === 1 ? "案例证据" : "适用条件"}</p>`,
      })),
    } as GeneratedSlideContent;
    const narration = normalizeV5Narration({ segments: [
      { semanticIds: ["page-1-narration-1"], function: "opening", text: "同学们好，我们先明确判断边界。" },
      { semanticIds: ["page-1-narration-2"], function: "knowledge", text: "这个结论只在给定条件下成立。" },
      { semanticIds: ["page-1-narration-3"], function: "example", text: "再看案例中的证据怎样支持判断。" },
      { semanticIds: ["page-1-narration-4"], function: "closing", text: "记住条件与证据的关系，接着完成练习。" },
    ] }, design, 0);
    const semanticMap = buildV5SemanticMap(content, design, 0);
    const actions = compileV5Actions({
      id: "slide-1", type: "slide", title: "条件与案例", description: "", keyPoints: [], order: 0,
    } as SceneOutline, content, narration, semanticMap);
    expect(actions.filter((action) => action.type === "spotlight").map((action) => action.elementId)).toEqual([
      "page-1-visible-2",
      "page-1-visible-1",
    ]);
  });

  it("requires complete page ownership while allowing pages without examples or conditions", () => {
    expect(() => normalizeTeachingDesign({ coreExplanation: [] }, 2)).toThrow(/缺少/);
    const design = normalizeTeachingDesign({ pagePlan: [
      {
        page: 1,
        purpose: "建立比较框架",
        priorKnowledge: "具备教学设计常识",
        newContent: "方法选择需要同时对齐目标与学情",
        explanation: ["说明三个判断维度的关系"],
        examples: [],
        conditions: [],
        requiredVisibleContent: ["目标、学情和方法之间的关系"],
        narrationFocus: ["解释三个判断维度怎样共同影响选择"],
        evidenceQuotes: ["课程依据"],
        assessmentFocus: ["能说明选择依据"],
      },
      {
        page: 2,
        purpose: "分析假设案例",
        priorKnowledge: "已经建立比较框架",
        newContent: "用证据解释方法组合",
        explanation: ["把案例现象连接到方法选择"],
        examples: ["假设课堂"],
        conditions: ["结论只适用于给定目标和学情"],
        requiredVisibleContent: ["案例现象到方法选择的推理链"],
        narrationFocus: ["解释现象为什么支持该方法"],
        evidenceQuotes: ["案例依据"],
        assessmentFocus: ["能解释案例理由"],
      },
    ], teacherReviewNotes: [{
      page: 2,
      claim: "某学校已经采用这一评价规则",
      reason: "权威资料没有提供具体学校案例",
      suggestion: "删除学校名称，或由教师补充可核对来源",
    }] }, 2);
    expect(design.pagePlan?.[0]).toMatchObject({ examples: [], conditions: [] });
    expect(design.teacherReviewNotes).toBeUndefined();
    expect(JSON.stringify(design.pagePlan)).not.toContain("权威资料没有提供");
  });

  it("accepts only an evidence excerpt's terminal punctuation as a source boundary change", () => {
    const base = {
      pagePlan: [{
        page: 1,
        purpose: "建立核验意识",
        priorKnowledge: "使用过生成式人工智能",
        newContent: "生成内容需要核验",
        explanation: ["区分表达和事实"],
        examples: [],
        conditions: [],
        requiredVisibleContent: ["表达流畅不等于事实可靠"],
        narrationFocus: ["解释为什么需要核验"],
        evidenceQuotes: ["不应在未经核验时把生成结果当作事实。"],
        assessmentFocus: ["能说明核验理由"],
      }],
      teacherReviewNotes: [],
    };
    expect(normalizeTeachingDesign(base, 1, {
      sourceText: "学生不应在作业中简单复制生成内容，不应在未经核验时把生成结果当作事实，也不应输入个人敏感信息。",
    }).pagePlan).toHaveLength(1);
    expect(() => normalizeTeachingDesign({
      ...base,
      pagePlan: [{ ...base.pagePlan[0], evidenceQuotes: ["不应在未经核验时把生成结果直接当作事实。"] }],
    }, 1, {
      sourceText: "学生不应在作业中简单复制生成内容，不应在未经核验时把生成结果当作事实，也不应输入个人敏感信息。",
    })).toThrow(/缺少逐页职责/);
  });

  it("applies slide repairs as element patches while preserving ids and untouched elements", () => {
    const current = {
      elements: [
        { id: "text-1", type: "text", left: 10, top: 10, width: 100, height: 40, content: "<p>内容难度</p>" },
        { id: "text-2", type: "text", left: 10, top: 60, width: 100, height: 40, content: "<p>保持不变</p>" },
      ],
      background: { type: "solid", color: "#fff" },
    } as unknown as Parameters<typeof applySlideElementUpdates>[1];
    const repaired = applySlideElementUpdates({
      updates: [{ id: "text-1", changes: { content: "<p>内容认知要求</p>" } }],
    }, current);
    expect(repaired.elements.map((element) => element.id)).toEqual(["text-1", "text-2"]);
    expect(repaired.elements[0]).toMatchObject({ type: "text", left: 10, content: "<p>内容认知要求</p>" });
    expect(repaired.elements[1]).toBe(current.elements[1]);
    expect(() => applySlideElementUpdates({
      updates: [{ id: "text-1", changes: { id: "replacement" } }],
    }, current)).toThrow(/不得为空或改变 id\/type/);
    expect(() => applySlideElementUpdates({
      updates: [{ id: "unknown", changes: { content: "<p>越界</p>" } }],
    }, current)).toThrow(/现有元素 id/);
    expect(() => applySlideElementUpdates({
      updates: [{ id: "text-1", changes: { content: '<p style="font-size:15px;">太小</p>' } }],
    }, current)).toThrow(/不得低于 16px/);
    expect(() => applySlideElementUpdates({
      updates: [
        { id: "text-1", changes: { content: "<p>修改一</p>" } },
        { id: "text-2", changes: { content: "<p>修改二</p>" } },
      ],
    }, current, 1)).toThrow(/修改了过多元素/);
  });

  it("combines slide and narration defects into one V5 repair call", async () => {
    const content = {
      elements: [{
        id: "page-1-visible-1",
        type: "text",
        left: 10,
        top: 10,
        width: 300,
        height: 60,
        content: "<p>提示可以保证事实正确</p>",
      }],
    } as GeneratedSlideContent;
    const actions = [{
      id: "page-1-narration-1",
      type: "speech",
      text: "提示写清楚之后，事实就一定正确。",
    }] as Action[];
    const model = vi.fn<AICallFn>(async () => JSON.stringify({
      updates: [{ id: "page-1-visible-1", changes: { content: "<p>提示改善 ≠ 事实核验</p>" } }],
      segments: [{ id: "page-1-narration-1", text: "提示写清楚可以提高任务匹配度，但关键事实仍要核验。" }],
    }));
    const repaired = await repairV5PageOnce({
      fixture: LAB_SECTION_FIXTURES[0],
      outline: { id: "slide-1", type: "slide", title: "提示与核验", description: "", keyPoints: [], order: 0 } as SceneOutline,
      design: { pagePlan: [] },
      pageIndex: 0,
      content,
      actions,
      layoutIssues: ["文字区域过密"],
      deterministicNarrationIssues: [],
      budgetDirective: "适度补足解释",
      issues: [{
        id: "confirmed-error",
        category: "factual-grounding",
        targetType: "speech-segment",
        targetId: "page-1-narration-1",
        evidence: "事实就一定正确",
        sourceEvidence: "提示词改善只能提高任务匹配度，不能替代事实核验",
        repair: "恢复准确关系",
      }],
      aiCall: model,
    });
    expect(model).toHaveBeenCalledTimes(1);
    expect(model.mock.calls[0]?.[0]).toContain("PPT 元素的宽高是固定容量");
    expect(model.mock.calls[0]?.[0]).toContain("不得为了逐字复述 requiredVisibleContent 填入长句");
    expect(repaired.content.elements[0]).toMatchObject({ content: "<p>提示改善 ≠ 事实核验</p>" });
    expect(repaired.actions[0]).toMatchObject({ text: "提示写清楚可以提高任务匹配度，但关键事实仍要核验。" });

    const slideOnlyRepair = await repairV5PageOnce({
      fixture: LAB_SECTION_FIXTURES[0],
      outline: { id: "slide-1", type: "slide", title: "提示与核验", description: "", keyPoints: [], order: 0 } as SceneOutline,
      design: { pagePlan: [] },
      pageIndex: 0,
      content,
      actions,
      layoutIssues: ["文字区域过密"],
      deterministicNarrationIssues: [],
      issues: [],
      aiCall: async () => JSON.stringify({
        updates: [{ id: "page-1-visible-1", changes: { content: "<p>提示改善 ≠ 事实核验</p>" } }],
        segments: [{ id: "page-1-narration-1", text: "顺手润色讲稿。" }],
      }),
    });
    expect(slideOnlyRepair.content.elements[0]).toMatchObject({ content: "<p>提示改善 ≠ 事实核验</p>" });
    expect(slideOnlyRepair.actions).toEqual(actions);
  });

  it("checks the complete lesson once and repairs all affected pages in one request", async () => {
    const fixture = LAB_SECTION_FIXTURES[0];
    const design = {
      pagePlan: fixture.pages.map((_, index) => ({
        page: index + 1,
        purpose: `第 ${index + 1} 页`,
        priorKnowledge: "已有基础",
        newContent: "关键关系",
        explanation: ["解释关系"],
        examples: [],
        conditions: [],
        requiredVisibleContent: ["提示改善不能替代事实核验"],
        narrationFocus: ["解释为什么仍要核验"],
        evidenceQuotes: [],
        assessmentFocus: ["能说明核验原因"],
      })),
    } satisfies TeachingDesign;
    const outlines = fixture.pages.map((page, index) => ({
      id: `slide-${index + 1}`,
      type: "slide",
      title: page.title,
      description: page.purpose,
      keyPoints: page.keyPoints,
      order: index,
    })) as SceneOutline[];
    const pages = fixture.pages.map((_, index) => ({
      content: {
        elements: [{
          id: `page-${index + 1}-visible-1`,
          type: "text",
          left: 10,
          top: 10,
          width: 300,
          height: 60,
          content: "<p>提示可以保证事实正确</p>",
        }],
      } as GeneratedSlideContent,
      actions: [{
        id: `page-${index + 1}-narration-1`,
        type: "speech",
        text: "提示写清楚后，事实就一定正确。",
      }] as Action[],
    }));
    const reviewModel = vi.fn<AICallFn>(async () => JSON.stringify({ pages: [
      {
        page: 1,
        issues: [{
          category: "slide-narration-alignment",
          targetType: "slide-element",
          targetId: "page-1-visible-1",
          evidence: "提示可以保证事实正确",
          repair: "改为提示不能替代核验",
        }],
        teacherReviewNotes: [],
      },
      { page: 2, issues: [], teacherReviewNotes: [] },
    ] }));
    const reviews = await reviewLabCourseLightly({ fixture, outlines, design, pages, aiCall: reviewModel });
    expect(reviewModel).toHaveBeenCalledTimes(1);
    expect(reviews.flatMap((review) => review.issues)).toHaveLength(1);
    expect(reviewModel.mock.calls[0]?.[0]).toContain("不要报告措辞风格");

    const repairModel = vi.fn<AICallFn>(async () => JSON.stringify({ pages: [{
      page: 1,
      updates: [{ id: "page-1-visible-1", changes: { content: "<p>提示改善 ≠ 事实核验</p>" } }],
      segments: [],
    }] }));
    const repaired = await repairLabCourseOnce({ fixture, outlines, design, pages, reviews, aiCall: repairModel });
    expect(repairModel).toHaveBeenCalledTimes(1);
    expect(repaired[0].content.elements[0]).toMatchObject({ content: "<p>提示改善 ≠ 事实核验</p>" });
    expect(repaired[1]).toEqual(pages[1]);
  });

  it("removes only empty unreviewed records from the manifest cleanup plan", () => {
    const empty = (state: "pending" | "failed" = "pending"): LabVariantResult => ({
      statuses: { ppt: { state }, script: { state }, tts: { state } },
      slides: [],
      script: [],
      quiz: [],
    });
    const complete: LabVariantResult = {
      ...empty(),
      statuses: { ppt: { state: "complete" }, script: { state: "complete" }, tts: { state: "complete" } },
      slides: [{ id: "kept-slide" }],
    };
    const fixture = LAB_SECTION_FIXTURES[0];
    const manifest = {
      version: 1,
      sections: [{
        id: fixture.id,
        title: fixture.title,
        learningObjectives: [],
        sources: [],
        pairs: [
          { id: "successful", experimentId: "successful", batch: 1, variants: { baseline: empty(), enhanced: complete } },
          { id: "reviewed-failure", experimentId: "reviewed", batch: 1, variants: { baseline: empty(), enhanced: empty("failed") } },
          { id: "discarded-failure", experimentId: "discarded", batch: 1, variants: { baseline: empty(), enhanced: empty("failed") } },
        ],
      }],
    } satisfies CourseQualityLabManifest;
    const cleaned = cleanManifestRecords(manifest, {
      reviews: [{ pairId: "reviewed-failure", outcome: "undecided", dimensions: {}, pageNotes: {} }],
    });
    expect(cleaned.manifest.sections[0].pairs.map((pair) => pair.id)).toEqual(["successful", "reviewed-failure"]);
    expect(cleaned.removed).toEqual([expect.objectContaining({ pairId: "discarded-failure" })]);
  });

  it("lets the explicit V5 visual plan own semantic structure while retaining physical layout failures", () => {
    expect(v5RelevantLayoutIssues([
      "页面内容需要data语义结构，但当前未使用表格、图表、连线或分组关系表达",
      "关键教学点可见覆盖率仅 66.7%，存在 1 条未完整可见的已确认要点",
      "正文区域网格利用率仅 89.3%，低于 90% 目标",
      "正文区域存在 160px 的连续空白带，信息分布明显失衡",
    ])).toEqual(["正文区域存在 160px 的连续空白带，信息分布明显失衡"]);
    expect(v5RelevantLayoutIssues([
      "正文区域网格利用率仅 87.9%，低于 90% 目标",
    ])).toEqual([]);
    expect(v5RelevantLayoutIssues([
      "正文区域网格利用率仅 84.9%，低于 90% 目标",
    ])).toEqual(["正文区域网格利用率仅 84.9%，低于 90% 目标"]);
  });

  it("rejects slide-production narration while allowing natural classroom page transitions", () => {
    expect(v5NarrationAssemblyIssues([{
      id: "knowledge",
      text: `在适用条件成立且证据来源可追溯时，${"这一专业判断必须完整保留限定条件".repeat(8)}。`,
    }])).toEqual([]);
    expect(v5NarrationAssemblyIssues([{
      id: "transition",
      text: "翻到下一页，我们继续分析这个条件。",
    }])).toEqual([expect.stringContaining("页面制作视角")]);
    expect(v5NarrationAssemblyIssues([{
      id: "transition-natural",
      text: "上一页的校史案例说明，表达流畅不能替代证据，接下来看看怎样核验关键主张。",
    }])).toEqual([]);
    expect(v5NarrationAssemblyIssues([{
      id: "reasoned-sequence",
      text: "面对教学任务，凭什么决定用不用人工智能？先看育人目标，再确定学习证据，然后判断人工智能能否增强学习过程。如果不能增强，就不应把它设为必要环节。",
    }])).toEqual([]);
    expect(v5NarrationAssemblyIssues([{
      id: "evidence-questions",
      text: "怎样判断人工智能是否改善学习？要比较三稿。看四类证据：论证质量是否提高；学生是否投入；核验是否有效；不同学生是否都能使用。如果确有改善且没有增加错误，这次应用才适切。",
    }])).toEqual([]);
    expect(v5NarrationAssemblyIssues([{
      id: "closing",
      function: "closing",
      text: "记住目标、证据与条件的关系。",
    }], { requirePracticeTransition: true })).toEqual([
      expect.stringContaining("转入节末练习"),
    ]);
    expect(v5NarrationAssemblyIssues([{
      id: "closing",
      function: "closing",
      text: "记住目标、证据与条件的关系，下面用练习检验你的判断。",
    }], { requirePracticeTransition: true })).toEqual([]);
  });

  it("rejects outline-like spoken prose while allowing a natural single colon", () => {
    expect(narrationStyleIssues([
      { id: "s1", text: "案例分析：连接情境、证据与判断。" },
      { id: "s2", text: "探究学习：在支架下形成问题解决过程。" },
    ])).toEqual(expect.arrayContaining([
      expect.stringContaining("连续使用术语标签"),
    ]));
    expect(narrationStyleIssues([{
      id: "s3",
      text: "讲授适合建立共同基础；案例分析适合连接证据与判断；探究学习适合形成解决问题的过程；项目学习适合整合作品迭代。",
    }])).toEqual(expect.arrayContaining([
      expect.stringContaining("连续罗列概念职责"),
    ]));
    expect(narrationStyleIssues([{
      id: "s4",
      text: "请观察这个现象：模型回答得很流畅，可其中的年份找不到可靠出处。为什么不能直接相信它？因为流畅只说明语言组织自然，不能证明事实已经核实。",
    }])).toEqual([]);
  });

  it("rejects command chains that omit their teaching reason", () => {
    expect(narrationStyleIssues([{
      id: "commands",
      text: "先标记姓名和年份，再查阅学校官网，然后记录出处，最后改写结论。",
    }])).toEqual(expect.arrayContaining([
      expect.stringContaining("操作指令串"),
    ]));
    expect(narrationStyleIssues([{
      id: "explained-commands",
      text: "先标记姓名和年份，因为这些信息最容易被核验。再查阅独立来源，这样才能判断原来的说法是否站得住。",
    }])).toEqual([]);
    expect(narrationStyleIssues([{
      id: "question-before-steps",
      text: "再问，面对流畅、详细的回答，凭什么判断能不能相信？姓名和年份一旦出错，会影响事实可靠性。先标记高风险主张，再查阅独立来源，并据此改写。先区分表达质量和证据可靠性，再决定是否采用。",
    }])).toEqual([]);
    expect(narrationStyleIssues([{
      id: "explained-workflow",
      text: "对一条高风险主张，核验怎样走？先标记姓名、年份和引文。接着查原始文件，不能只看一个转载网页。然后交叉核验，看来源是否一致；冲突要写出。最后记录证据并据此改写。",
    }])).toEqual([]);
  });

  it("allows a concept framework when the teacher explains its purpose and boundary", () => {
    expect(narrationStyleIssues([{
      id: "explained-framework",
      text: "怎样把任务说清楚，又不把结果当成事实？目标是解决什么问题；背景是给谁看、已有材料是什么；约束是长度和不能编造；输出要求是怎样呈现。这样系统更清楚要做什么，但事实仍要独立核验。",
    }])).toEqual([]);
  });

  it("keeps the frozen course duration while allocating depth between pages", () => {
    const pages = [1, 2].map((page) => ({
      page,
      narrationDurationWeight: page === 1 ? 1 : 2,
      purpose: `第 ${page} 页职责`,
      priorKnowledge: "已有基础",
      newContent: `新内容 ${page}`,
      explanation: ["讲清原因"],
      examples: ["具体案例"],
      conditions: ["适用边界"],
      requiredVisibleContent: [`关系 ${page}`],
      narrationFocus: ["解释原因与判断依据"],
      pageRole: page === 1 ? "opening" : "closing",
      visualPlan: {
        structure: "case-reasoning",
        regions: [{ purpose: "关系", visibleRequirementIndexes: [1] }],
        relationship: "用箭头表达推理",
      },
      deliveryPlan: [
        ...(page === 1 ? [{ function: "opening", instruction: "问好并引入", visibleRequirementIndexes: [], budgetWeight: 1 }] : []),
        {
          function: "knowledge",
          instruction: "讲清原因与判断依据",
          visibleRequirementIndexes: [1],
          objectiveIndexes: [page],
          explanationArc: {
            learnerQuestion: `学生需要解决的问题 ${page}`,
            reasoningSteps: ["观察具体证据", "解释证据怎样支持判断"],
            takeaway: `学生能够形成认识 ${page}`,
          },
          budgetWeight: 6,
        },
        ...(page === 2 ? [{ function: "closing", instruction: "回扣并转入练习", visibleRequirementIndexes: [], budgetWeight: 1 }] : []),
      ],
      evidenceQuotes: ["课程依据"],
      assessmentFocus: ["解释判断依据"],
    }));
    const courseTiming = {
      minimumDurationSec: 180,
      maximumDurationSec: 180,
      budgetForDuration: (durationSec: number) => ({
        targetDurationSec: durationSec,
        targetUnits: durationSec * 4,
        minUnits: Math.floor(durationSec * 3.6),
        maxUnits: Math.ceil(durationSec * 4.4),
        unit: "cjk-char" as const,
      }),
    };
    const design = normalizeTeachingDesign({ courseTargetDurationSec: 180, pagePlan: pages }, 2, {
      requireV5Contract: true,
      objectiveCount: 2,
      courseTiming,
    });
    expect(design.courseTargetDurationSec).toBe(180);
    expect(design.pagePlan?.map((page) => page.narrationBudget?.targetDurationSec)).toEqual([60, 120]);
    expect(design.pagePlan?.map((page) =>
      page.deliveryPlan?.reduce((sum, step) => sum + step.targetUnits, 0)))
      .toEqual([240, 480]);

    const unevenPages = structuredClone(pages);
    unevenPages[1].narrationDurationWeight = 5;
    expect(normalizeTeachingDesign({ courseTargetDurationSec: 180, pagePlan: unevenPages }, 2, {
      requireV5Contract: true,
      objectiveCount: 2,
      courseTiming,
    }).pagePlan?.map((page) => page.narrationBudget?.targetDurationSec)).toEqual([30, 150]);

    const contentDrivenPages = structuredClone(pages);
    const extraStep = structuredClone(contentDrivenPages[0].deliveryPlan[1]);
    extraStep.instruction = "补充另一个必要推理";
    contentDrivenPages[0].deliveryPlan.push(structuredClone(extraStep), structuredClone(extraStep));
    expect(normalizeTeachingDesign({ courseTargetDurationSec: 180, pagePlan: contentDrivenPages }, 2, {
      requireV5Contract: true,
      objectiveCount: 2,
      courseTiming,
    }).pagePlan?.[0].deliveryPlan).toHaveLength(4);
    expect(() => normalizeTeachingDesign({ courseTargetDurationSec: 210, pagePlan: pages }, 2, {
      requireV5Contract: true,
      objectiveCount: 2,
      courseTiming,
    })).toThrow(/必须选择 180-180 秒/);
  });

  it("allocates an out-of-range course budget to page repair opportunities without looping", () => {
    const outlines = [0, 1].map((order) => ({
      id: `slide-${order + 1}`,
      type: "slide",
      title: `第 ${order + 1} 页`,
      description: "",
      keyPoints: [],
      order,
      timingPlan: {
        targetDurationSec: 30,
        targetUnits: 100,
        minUnits: 90,
        maxUnits: 110,
        unit: "cjk-char",
      },
    })) as unknown as SceneOutline[];
    const actions = [0, 1].map((page) => [{
      id: `s${page + 1}`,
      type: "speech",
      text: "证据需要核验。",
    }] as Action[]);
    const directives = planNarrationBudgetRepairs(outlines, actions);
    expect([...directives.keys()]).toEqual([0, 1]);
    expect([...directives.values()].every((directive) => directive.includes("整节首次文稿"))).toBe(true);
  });

  it("allocates only the change needed to reach the nearest valid course-budget boundary", () => {
    const outlines = [0, 1].map((order) => ({
      id: `slide-${order + 1}`,
      type: "slide",
      title: `第 ${order + 1} 页`,
      description: "",
      keyPoints: [],
      order,
      timingPlan: {
        targetDurationSec: 10,
        targetUnits: 10,
        minUnits: 9,
        maxUnits: 11,
        unit: "cjk-char",
      },
    })) as unknown as SceneOutline[];
    const actions = [0, 1].map((page) => [{
      id: `s${page + 1}`,
      type: "speech",
      text: "一二三四五六七八九十甲乙",
    }] as Action[]);
    expect([...planNarrationBudgetRepairs(outlines, actions).values()]).toEqual([
      expect.stringContaining("从约 12 调整到约 11"),
    ]);
  });

  it("rejects production language and source labels before enhanced narration reaches TTS", () => {
    expect(narrationStyleIssues([
      { id: "s1", text: "这一页展示的核心观点是，表达流畅不等于事实可靠。" },
      { id: "s2", text: "资料1要求我们先确认学习目标。" },
    ])).toEqual(expect.arrayContaining([
      expect.stringContaining("页面制作视角"),
      expect.stringContaining("讲稿提纲标签"),
      expect.stringContaining("资料编号"),
    ]));
    expect(narrationStyleIssues([
      { id: "hypothetical", text: "这是用于教学分析的假设案例，不是真实事件。接下来根据目标和学情判断方法组合。" },
    ])).toEqual([]);
    expect(narrationStyleIssues([
      { id: "valid", text: "遇到姓名、年份和数据，先找到独立来源核验，再决定是否采用。" },
      { id: "natural-transition", text: "把这一页连成一句话就是，提示提高匹配度，核验决定可靠性。" },
    ])).toEqual([]);
  });

  it("separates teacher-only uncertainties from student narration issues", () => {
    const review = normalizeLabPageJointReview({
      issues: [{
        category: "teacher-note-leak",
        targetType: "speech-segment",
        targetId: "s1",
        evidence: "资料没有给出统一规定",
        repair: "省略资料缺口，直接讲已有材料支持的判断方法",
      }],
      teacherReviewNotes: [{
        claim: "资料没有给出统一规定",
        reason: "资料没有给出统一规则",
        suggestion: "请教师结合课程条件核实",
      }],
    }, 2, 2, [{ requirementId: "page-2-visible-1", text: "必须显示判断条件" }], [], [{ id: "s1", text: "资料没有给出统一规定，需要教师核实。" }]);
    expect(review.issues[0]).toMatchObject({ targetId: "s1", targetType: "speech-segment" });
    expect(review.teacherReviewNotes[0]).toMatchObject({ page: 2, origin: "content-review" });
    const nonBlockingClaim = normalizeLabPageJointReview({
      issues: [],
      teacherReviewNotes: [{
        claim: "生成完整论证对工具成本极低",
        reason: "资料没有成本依据",
        suggestion: "教师核实",
      }],
    }, 2, 2, [], [], [{ id: "s1", text: "生成完整论证对工具成本极低，学生要练的却是推理。" }]);
    expect(nonBlockingClaim.issues).toEqual([]);
    expect(nonBlockingClaim.teacherReviewNotes).toEqual([
      expect.objectContaining({
        page: 2,
        claim: "生成完整论证对工具成本极低",
        origin: "content-review",
        reason: "资料没有成本依据",
        suggestion: "教师核实",
      }),
    ]);
    const confirmedError = normalizeLabPageJointReview({
      issues: [{
        category: "factual-grounding",
        targetType: "speech-segment",
        targetId: "s1",
        evidence: "提示写清楚就能保证事实正确",
        sourceEvidence: "提示词改善只能提高任务匹配度，不能替代事实核验",
        repair: "恢复提示改善与事实核验的准确关系",
      }],
      teacherReviewNotes: [],
    }, 2, 2, [], [], [{ id: "s1", text: "提示写清楚就能保证事实正确。" }], "提示词改善只能提高任务匹配度，不能替代事实核验");
    expect(confirmedError.issues).toEqual([
      expect.objectContaining({ category: "factual-grounding", sourceEvidence: expect.any(String) }),
    ]);
    expect(() => normalizeLabPageJointReview({
      issues: [],
      teacherReviewNotes: [{
        claim: "学生内容里不存在的断言",
        reason: "资料不足",
        suggestion: "教师核实",
      }],
    }, 2, 2, [], [], [{ id: "s1", text: "原讲稿" }])).toThrow(/必须逐字引用当前页学生内容/);
    expect(() => normalizeLabPageJointReview({
      issues: [{ category: "factual-grounding", targetType: "speech-segment", targetId: "s1", evidence: "不存在的原文", repair: "删除" }],
      teacherReviewNotes: [],
    }, 2, 2, [{ requirementId: "page-2-visible-1", text: "必须显示判断条件" }], [], [{ id: "s1", text: "原讲稿" }])).toThrow(/有效目标与证据/);
    const missing = normalizeLabPageJointReview({
      issues: [{ category: "knowledge-coverage", targetType: "teaching-requirement", targetId: "page-2-visible-1", evidence: "必须显示判断条件", repair: "补入条件" }],
      teacherReviewNotes: [],
    }, 2, 2, [{ requirementId: "page-2-visible-1", text: "必须显示判断条件" }], [], [{ id: "s1", text: "原讲稿" }]);
    expect(missing.issues[0]).toMatchObject({ targetType: "teaching-requirement", targetId: "page-2-visible-1" });
    expect(() => normalizeLabPageJointReview({
      issues: [{ category: "knowledge-coverage", targetType: "teaching-requirement", targetId: "page-2-visible-1", evidence: "模型虚构的要求", repair: "补入条件" }],
      teacherReviewNotes: [],
    }, 2, 2, [{ requirementId: "page-2-visible-1", text: "必须显示判断条件" }], [], [{ id: "s1", text: "原讲稿" }])).toThrow(/有效目标与证据/);
  });

  it("derives review evidence directly from the first-pass semantic narration", () => {
    const design = normalizeTeachingDesign({ pagePlan: [{
      page: 1,
      purpose: "解释流畅与真实的区别",
      priorKnowledge: "学生使用过生成式人工智能",
      newContent: "流畅表达不能证明事实可靠",
      explanation: ["解释机制与核验边界"],
      examples: ["校史年份案例"],
      conditions: ["关键事实需要独立来源"],
      requiredVisibleContent: ["流畅表达不等于事实证据"],
      narrationFocus: ["解释为什么仍需核验"],
      evidenceQuotes: ["课程依据"],
      assessmentFocus: ["说明核验原因"],
    }] }, 1);
    expect(buildFirstPassTeachingEvidence(design, 0, [{
      id: "page-1-narration-1",
      text: "语言流畅只说明表达符合常见模式。年份是否真实，仍要回到独立来源核对。",
    }])).toEqual([{
      requirementId: "page-1-narration-1",
      segmentId: "page-1-narration-1",
      evidence: "语言流畅只说明表达符合常见模式。年份是否真实，仍要回到独立来源核对。",
    }]);
  });

  it("binds generated audio with the scene-and-action compound key", () => {
    const scenes = [{
      id: "scene-runtime",
      outlineId: "outline-1",
      stageId: "stage-1",
      title: "讲授",
      order: 0,
      type: "slide",
      content: { type: "slide", canvas: { id: "canvas", viewportSize: 1000, viewportRatio: 0.5625, theme: {}, elements: [] } },
      actions: [{ id: "speech-1", type: "speech", text: "需要讲清的内容。" }],
    }] as unknown as Scene[];
    bindScriptAudioToScenes([{
      id: "outline-1:speech-1",
      slideIndex: 0,
      text: "需要讲清的内容。",
      audioUrl: "/files/audio/voice.mp3",
      durationSec: 3.5,
    }], scenes);
    expect(scenes[0].actions?.[0]).toMatchObject({
      id: "speech-1",
      audioUrl: "/files/audio/voice.mp3",
      audioDurationSec: 3.5,
    });
  });

  it("uses the whole-stage narration budget and leaves room for natural punctuation pauses", () => {
    const outlines = [1, 2].map((page) => ({
      id: `p${page}`,
      type: "slide",
      title: `第${page}页`,
      description: "解释",
      keyPoints: [],
      order: page - 1,
      timingPlan: { targetUnits: 100, minUnits: 90, maxUnits: 110, unit: "cjk-char" },
    })) as unknown as SceneOutline[];
    const scenes = ["这是自然讲解。".repeat(18), "这是另一段讲解。".repeat(18)].map((text, index) => ({
      id: `s${index}`,
      actions: [{ id: `speech-${index}`, type: "speech", text }],
    })) as unknown as Scene[];
    const state = stageNarrationBudgetState(outlines, scenes);
    expect(state.targetUnits).toBe(200);
    expect(state.actualUnits).toBeGreaterThan(210);
    expect(state.rewriteRequired).toBe(true);
  });

  it("counts English abbreviations and punctuation pauses in the speech budget", () => {
    const outline = {
      id: "p1",
      type: "slide",
      title: "缩写",
      description: "解释",
      keyPoints: [],
      order: 0,
      timingPlan: { targetUnits: 30, minUnits: 27, maxUnits: 33, unit: "mixed-unit" },
    } as unknown as SceneOutline;
    const spoken = "AI、LLM 与 API，分别怎么读？先停一下，再解释。";
    const punctuated = `${spoken}……，；！？`;
    const base = stageNarrationBudgetState([outline], [{ id: "s1", actions: [{ id: "a1", type: "speech", text: spoken }] } as unknown as Scene]);
    const withPauses = stageNarrationBudgetState([outline], [{ id: "s1", actions: [{ id: "a1", type: "speech", text: punctuated }] } as unknown as Scene]);
    expect(base.actualUnits).toBeGreaterThan(0);
    expect(withPauses.actualUnits).toBeGreaterThan(base.actualUnits);
    expect(withPauses.actualUnits - base.actualUnits).toBeLessThan(10);
  });

  it("records real TTS duration outside the target as a non-blocking check", () => {
    const result: LabVariantResult = {
      statuses: { ppt: { state: "complete" }, script: { state: "complete" }, tts: { state: "complete" } },
      slides: [],
      script: [],
      quiz: [],
      durationSec: 220,
    };
    recordDurationCheck(result, LAB_SECTION_FIXTURES[0]);
    expect(result.statuses.tts).toEqual({ state: "complete" });
    expect(result.checks).toEqual([expect.stringContaining("真实 TTS 时长")]);
  });

  it("rewrites only selected narration ids while seeing the full page", () => {
    const original = [
      { id: "s1", text: "这一页的核心观点是，表达流畅不等于事实可靠，我们需要把表达质量和证据可靠性彻底分开。" },
      { id: "s2", text: "校志和官网都查不到这个年份，所以先把它标成待核验。" },
    ];
    const rewritten = normalizeNarrationRewrite({ segments: [
      { id: "s1", text: "先把两件事分开：说得顺，不代表说得对。表达质量再高，也不能代替证据。" },
    ] }, original, ["s1"]);
    expect(rewritten.map((segment) => segment.id)).toEqual(["s1"]);
    expect(narrationStyleIssues(rewritten)).toEqual([]);
    expect(() => normalizeNarrationRewrite({ segments: [
      ...rewritten,
      { id: "s2", text: original[1].text },
    ] }, original, ["s1"])).toThrow(/只能返回 1 个/);
  });

  it("accepts a minimal narration budget patch and rejects production language", () => {
    const original = [
      { id: "s1", text: "先说明学习目标和判断依据。" },
      { id: "s2", text: "这段包含重复定义和重复总结，需要缩短。" },
    ];
    expect(normalizeNarrationPatch({
      segments: [{ id: "s2", text: "删去重复，只保留判断理由。" }],
    }, original)).toEqual([{ id: "s2", text: "删去重复，只保留判断理由。" }]);
    expect(normalizeNarrationPatch({
      response: { segments: [{ id: "s2", text: "删去重复，只保留判断理由。" }] },
    }, original)).toEqual([{ id: "s2", text: "删去重复，只保留判断理由。" }]);
    expect(() => normalizeNarrationPatch({
      segments: [{ id: "s2", text: "这一页展示了需要删去的重复定义。" }],
    }, original)).toThrow(/页面制作视角/);
  });

  it("puts the full page plan and current responsibility into the first action prompt", async () => {
    const base = vi.fn<AICallFn>(async () => "ok");
    const design = normalizeTeachingDesign({ pagePlan: [
      { page: 1, purpose: "比较", priorKnowledge: "已有基础", newContent: "形成框架", explanation: ["解释理由"], examples: [], conditions: [], requiredVisibleContent: ["比较关系"], narrationFocus: ["判断理由"], evidenceQuotes: ["依据一"], assessmentFocus: ["说明依据"] },
      { page: 2, purpose: "案例", priorKnowledge: "已经形成框架", newContent: "应用框架", explanation: ["连接现象与结论"], examples: ["假设案例"], conditions: [], requiredVisibleContent: ["现象到结论的关系"], narrationFocus: ["解释推理"], evidenceQuotes: ["依据二"], assessmentFocus: ["解释选择"] },
    ], teacherReviewNotes: [{ page: 2, claim: "只给教师看的主张", reason: "缺少来源", suggestion: "教师核实" }] }, 2) satisfies TeachingDesign;
    const fixture = LAB_SECTION_FIXTURES[2];
    await withEnhancedNarrationGuidance(base, fixture, design, 1)("action-system", "action-user");
    expect(base.mock.calls[0][0]).toContain("当前页完整合同");
    expect(base.mock.calls[0][0]).toContain("已经形成框架");
    expect(base.mock.calls[0][0]).toContain("案例必须说明现象为什么支持");
    expect(base.mock.calls[0].join("\n")).not.toContain("只给教师看的主张");
    expect(base.mock.calls[0][1]).toBe("action-user");
  });

  it("tells the first narration pass to avoid duplicated cross-page announcements", async () => {
    const call = vi.fn<AICallFn>(async () => JSON.stringify({ segments: [
      { id: "page-2-narration-1", semanticIds: ["page-2-narration-1"], function: "transition", text: "回到刚才的案例，提示写清楚就能保证事实正确吗？" },
    ] }));
    const fixture = LAB_SECTION_FIXTURES[0];
    const design = {
      courseTargetDurationSec: 210,
      pagePlan: fixture.pages.map((_page, index) => ({
        page: index + 1,
        purpose: index === 0 ? "区分表达和证据" : "形成核验工作流",
        priorKnowledge: index === 0 ? "学生听过生成式人工智能" : "已区分表达和证据",
        newContent: index === 0 ? "流畅不等于可靠" : "提示、核验和责任",
        explanation: ["讲清判断理由"],
        examples: [],
        conditions: [],
        requiredVisibleContent: ["判断关系"],
        narrationFocus: ["解释理由"],
        pageRole: index === 0 ? "opening" : "closing",
        narrationDurationWeight: 1,
        deliveryPlan: [{
          id: `page-${index + 1}-narration-1`,
          function: "transition",
          instruction: "自然承接并进入新内容",
          visibleRequirementIndexes: [],
          budgetWeight: 1,
          targetUnits: 20,
        }],
        evidenceQuotes: ["课堂依据"],
        assessmentFocus: ["解释判断"],
      })),
      teacherReviewNotes: [],
    } satisfies TeachingDesign;
    await generateV5Narration({ fixture, design, pageIndex: 1, aiCall: call });
    const input = JSON.parse(call.mock.calls[0]?.[1] ?? "{}");
    expect(input.progression[0].explanationResponsibilities).toEqual([{
      function: "transition", instruction: "自然承接并进入新内容",
    }]);
    expect(call.mock.calls[0]?.[0]).toContain("只让一侧承担完整过渡");
    expect(call.mock.calls[0]?.[0]).toContain("不要再次宣布本页主题、工作流或学习安排");
    expect(call.mock.calls[0]?.[0]).toContain("前一步不得提前讲完后一步");
    expect(call.mock.calls[0]?.[0]).toContain("只允许一个步骤完整复述案例流程");
  });

  it("uses a new pair id and freezes the archived optimized result for comparison", () => {
    const archivedBaseline = {
      label: "当前基线",
      statuses: { ppt: { state: "complete" }, script: { state: "complete" }, tts: { state: "complete" } },
      slides: [{ id: "archived-baseline", renderUrl: `/render/${LAB_SECTION_FIXTURES[0].id}/1/enhanced/0` }],
      script: [],
      quiz: [],
    } satisfies LabVariantResult;
    const emptyEnhanced = {
      ...structuredClone(archivedBaseline),
      label: "首次生成版",
      slides: [{ id: "must-not-migrate" }],
    } satisfies LabVariantResult;
    const fixture = LAB_SECTION_FIXTURES[0];
    const existing = {
      version: 1,
      sections: [{
        id: fixture.id,
        title: fixture.title,
        learningObjectives: [...fixture.learningObjectives],
        sources: fixture.sources.map((source) => ({ ...source })),
        pairs: [{
          id: `${fixture.id}-batch-1`,
          batch: 1,
          variants: { baseline: archivedBaseline, enhanced: emptyEnhanced },
        }],
      }],
    } satisfies CourseQualityLabManifest;
    const manifest = initialManifest(existing);
    const pair = manifest.sections[0].pairs[0];
    expect(pair.id).toBe(`${fixture.id}-${LAB_EXPERIMENT_ID}-batch-1`);
    expect(pair.experimentId).toBe(LAB_EXPERIMENT_ID);
    expect(pair.variants.baseline.slides[0]?.id).toBe("must-not-migrate");
    expect(pair.variants.baseline.slides[0]?.renderUrl).toBe(`/render/${fixture.id}/1/baseline/0`);
    expect(pair.variants.enhanced.slides).toEqual([]);
    expect(manifest.sections.every((section) => section.pairs.length === 1
      && section.pairs[0].batch === 1)).toBe(true);
    expect(initialManifest(manifest).sections[0].pairs[0].variants.baseline.slides[0]?.renderUrl)
      .toBe(`/render/${fixture.id}/1/baseline/0`);
  });

  it("keeps the last complete result when a refresh fails before new artifacts are ready", () => {
    const complete = {
      label: "本次优化版",
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
      label: "本次优化版",
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
    expect(recovered.technicalValidation).toMatchObject({ state: "failed", stage: "tts" });
    expect(recovered.statuses.tts).toMatchObject({ state: "failed", message: "音频打包失败" });
  });
});

 describe("lab reasoning request semantics", () => {
  it("distinguishes provider default from an explicit disable request", () => {
    expect(resolveLabThinking()).toBeUndefined();
    expect(resolveLabThinking("baseline")).toBeUndefined();
    expect(resolveLabThinking("none")).toEqual({ mode: "disabled", enabled: false, effort: "none" });
    expect(resolveLabThinking("low")).toMatchObject({ mode: "enabled", effort: "low" });
    expect(() => resolveLabThinking("typo")).toThrow();
  });
});
