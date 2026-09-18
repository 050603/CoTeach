import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AICallFn } from "@openmaic/lib/generation/pipeline-types";
import { LAB_BATCHES, LAB_SECTION_FIXTURES } from "./fixtures";
import {
  LAB_EXPERIMENT_ID,
  applySlideElementUpdates,
  compactLabNarrationSystem,
  compactLabSlideSystem,
  initialManifest,
  narrationStyleIssues,
  normalizeLabPageJointReview,
  normalizeNarrationRewrite,
  normalizeNarrationPatch,
  normalizeTeachingDesign,
  recordDurationCheck,
  recoverVariantAfterGenerationFailure,
  runLoggedStage,
  stageNarrationBudgetState,
  withActuallyTaughtNarration,
  withEnhancedNarrationGuidance,
} from "./generate";
import type { LoggedCall } from "./generate";
import type { CourseQualityLabManifest, LabVariantResult, TeachingDesign } from "./types";
import type { SceneOutline } from "@openmaic/lib/types/generation";
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
      issues: [{
        category: "factual-grounding",
        targetType: "speech-segment",
        targetId: "s1",
        evidence: "生成完整论证对工具成本极低",
        repair: "删除没有资料支持的成本判断",
      }],
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
        reason: expect.stringContaining("依据不足或真伪存疑"),
        suggestion: expect.stringContaining("课程已保存"),
      }),
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
