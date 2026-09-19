import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AICallFn } from "@openmaic/lib/generation/pipeline-types";
import { LAB_BATCHES, LAB_SECTION_FIXTURES } from "./fixtures";
import {
  LAB_EXPERIMENT_ID,
  applySlideElementUpdates,
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
  recoverVariantAfterGenerationFailure,
  restoreV5SemanticElementIds,
  runLoggedStage,
  stageNarrationBudgetState,
  v5NarrationAssemblyIssues,
  v5RelevantLayoutIssues,
  withActuallyTaughtNarration,
  withEnhancedNarrationGuidance,
} from "./generate";
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

  it("normalizes opening and closing into one budgeted V5 teaching contract", () => {
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
        { function: "opening", instruction: "简短问好并引入学习方向", visibleRequirementIndexes: [], budgetWeight: 1 },
        { function: "knowledge", instruction: "准确解释证据与结论的关系和成立条件", visibleRequirementIndexes: [1], budgetWeight: 6 },
        { function: "closing", instruction: "回扣核心认识并转入节末练习", visibleRequirementIndexes: [], budgetWeight: 1 },
      ],
      evidenceQuotes: ["课程依据"],
      assessmentFocus: ["能解释证据关系"],
    }] }, 1, {
      requireV5Contract: true,
      timingBudgets: [{ targetDurationSec: 90, targetUnits: 400, minUnits: 360, maxUnits: 440, unit: "cjk-char" }],
    });
    const page = design.pagePlan?.[0];
    expect(page?.pageRole).toBe("single");
    expect(page?.deliveryPlan?.map((step) => step.function)).toEqual(["opening", "knowledge", "closing"]);
    expect(page?.deliveryPlan?.reduce((sum, step) => sum + step.targetUnits, 0)).toBe(400);
    expect(page?.deliveryPlan?.[0].visibleRequirementIndexes).toEqual([]);
    expect(page?.deliveryPlan?.at(-1)?.visibleRequirementIndexes).toEqual([]);
  });

  it("assigns greeting, continuation and closing only to their course positions", () => {
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
    expect(() => normalizeTeachingDesign({ pagePlan: [
      page(1, "opening", ["opening", "knowledge"]),
      page(2, "continuation", ["opening", "knowledge"]),
      page(3, "closing", ["knowledge", "closing"]),
    ] }, 3, { requireV5Contract: true, timingBudgets })).toThrow(/缺少逐页职责/);
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
        { function: "knowledge", instruction: "解释机制与条件", visibleRequirementIndexes: [1], budgetWeight: 6 },
        { function: "closing", instruction: "收束并转入练习", visibleRequirementIndexes: [], budgetWeight: 1 },
      ],
      evidenceQuotes: [fixture.sources.at(-1)?.detail?.slice(0, 12) ?? "生成模型"],
      assessmentFocus: ["能说明二者区别"],
    }] }, 1, {
      requireV5Contract: true,
      timingBudgets: [{ targetDurationSec: 90, targetUnits: 400, minUnits: 360, maxUnits: 440, unit: "cjk-char" }],
    });
    const longProfessionalSentence = "生成模型根据输入与训练中学到的语言模式生成后续内容，因此即使输出在语法、结构和语气上都很流畅，也不能据此推出姓名、年份、数据或引文已经经过独立来源核验。";
    const model = vi.fn<AICallFn>(async () => JSON.stringify({ segments: [
      { semanticIds: ["page-1-narration-1"], function: "opening", text: "同学们好，我们从一个流畅却待核验的回答开始。" },
      { semanticIds: ["page-1-narration-2"], function: "knowledge", text: longProfessionalSentence },
      { semanticIds: ["page-1-narration-3"], function: "closing", text: "记住这个边界，接下来用练习判断哪些主张需要核验。" },
    ] }));
    const narration = await generateV5Narration({ fixture, design, pageIndex: 0, aiCall: model });
    expect(model).toHaveBeenCalledTimes(1);
    expect(narration[1].text).toBe(longProfessionalSentence);
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
    expect(design.teacherReviewNotes).toEqual([expect.objectContaining({
      page: 2,
      claim: "某学校已经采用这一评价规则",
      origin: "design",
    })]);
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

  it("lets the explicit V5 visual plan own semantic structure while retaining physical layout failures", () => {
    expect(v5RelevantLayoutIssues([
      "页面内容需要data语义结构，但当前未使用表格、图表、连线或分组关系表达",
      "关键教学点可见覆盖率仅 66.7%，存在 1 条未完整可见的已确认要点",
      "正文区域网格利用率仅 89.3%，低于 90% 目标",
      "正文区域存在 160px 的连续空白带，信息分布明显失衡",
    ])).toEqual(["正文区域存在 160px 的连续空白带，信息分布明显失衡"]);
    expect(v5RelevantLayoutIssues([
      "正文区域网格利用率仅 87.9%，低于 90% 目标",
    ])).toEqual(["正文区域网格利用率仅 87.9%，低于 90% 目标"]);
  });

  it("checks production perspective deterministically without treating a long professional sentence as a style defect", () => {
    expect(v5NarrationAssemblyIssues([{
      id: "knowledge",
      text: `在适用条件成立且证据来源可追溯时，${"这一专业判断必须完整保留限定条件".repeat(8)}。`,
    }])).toEqual([]);
    expect(v5NarrationAssemblyIssues([{
      id: "transition",
      text: "下一页，我们继续分析这个条件。",
    }])).toEqual([expect.stringContaining("页面制作视角")]);
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
      expect.stringContaining("从约 12 调整到约 10"),
    ]);
  });

  it("rejects production language and source labels before enhanced narration reaches TTS", () => {
    expect(narrationStyleIssues([
      { id: "s1", text: "这一页的核心观点是，表达流畅不等于事实可靠。" },
      { id: "s2", text: "资料1要求我们先确认学习目标。" },
      { id: "s3", text: "先说清楚性质：这是假设案例，不是真实事件。" },
    ])).toEqual(expect.arrayContaining([
      expect.stringContaining("页面制作视角"),
      expect.stringContaining("讲稿提纲标签"),
      expect.stringContaining("资料编号"),
      expect.stringContaining("假设案例免责声明"),
    ]));
    expect(narrationStyleIssues([
      { id: "valid", text: "遇到姓名、年份和数据，先找到独立来源核验，再决定是否采用。" },
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

  it("marks real TTS duration outside the stage tolerance as failed", () => {
    const result = {
      statuses: { ppt: { state: "complete" }, script: { state: "complete" }, tts: { state: "complete" } },
      slides: [],
      script: [],
      quiz: [],
      durationSec: 220,
    } satisfies LabVariantResult;
    recordDurationCheck(result, LAB_SECTION_FIXTURES[0]);
    expect(result.statuses.tts).toMatchObject({ state: "failed", message: expect.stringContaining("±10%") });
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
      segments: [{ id: "s2", text: "这一页删去重复定义。" }],
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
    expect(recovered.statuses.tts).toMatchObject({ state: "failed", message: "音频打包失败" });
  });
});
