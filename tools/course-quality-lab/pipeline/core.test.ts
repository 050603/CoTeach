import { describe, expect, it } from "vitest";
import type { GeneratedSlideContent } from "@openmaic/lib/types/generation";
import {
  adaptTeachingDesign,
  compileActionBindings,
  createV5InvalidationGraph,
  evaluateCourseDuration,
  fingerprint,
  MemoryPipelineStorage,
  persistedModelCall,
  PipelineError,
  RepairStrategy,
  stableSerialize,
  V5_ARTIFACT_ASPECTS,
  validateActionReferences,
  type NarrationModuleOutput,
  type PipelineIssue,
  type SlideModuleOutput,
  type VisualActionCue,
} from "./index";
import type { TeachingDesign } from "../types";

function teachingDesign(newContent = "识别证据与结论"): TeachingDesign {
  return {
    pagePlan: [{
      page: 1,
      purpose: "理解证据关系",
      priorKnowledge: "知道事实与观点的区别",
      newContent,
      explanation: ["证据必须与结论相关"],
      examples: ["降雨后地面湿润"],
      conditions: [],
      requiredVisibleContent: ["证据 → 推理 → 结论"],
      narrationFocus: ["解释相关不等于因果"],
      evidenceQuotes: ["相关关系本身不能证明因果关系"],
      assessmentFocus: ["能指出推理缺口"],
      narrationBudget: {
        targetDurationSec: 180,
        targetUnits: 420,
        minUnits: 380,
        maxUnits: 460,
        unit: "cjk-char",
      },
    }],
  };
}

function slide(elementId = "relationship-box"): SlideModuleOutput {
  const content: GeneratedSlideContent = {
    elements: [{
      id: elementId,
      type: "text",
      left: 10,
      top: 10,
      width: 300,
      height: 80,
      rotate: 0,
      content: "<p>证据 → 推理 → 结论</p>",
      defaultFontName: "Microsoft YaHei",
      defaultColor: "#333333",
    }],
  };
  return {
    pageId: "page-001",
    content,
    bindings: [{
      semanticId: "page-001-visible-relationship-001",
      elementIds: [elementId],
    }],
  };
}

function narration(text = "我们先看证据，再说明推理怎样支撑结论。"): NarrationModuleOutput {
  return {
    pageId: "page-001",
    segments: [{
      id: "page-001-speech-001",
      pageId: "page-001",
      text,
      semanticIds: ["page-001-narration-step-001"],
      anchors: [{
        id: "page-001-anchor-001",
        semanticId: "page-001-narration-step-001",
        quote: "先看证据",
      }],
    }],
  };
}

function cue(): VisualActionCue {
  return {
    id: "page-001-cue-001",
    type: "spotlight",
    semanticId: "page-001-visible-relationship-001",
    narrationSegmentId: "page-001-speech-001",
    anchorId: "page-001-anchor-001",
    necessity: "essential",
    omissionRisk: "学生无法看出三者的推理方向",
  };
}

function issue(id: string, artifactFingerprint: string): PipelineIssue {
  return {
    id,
    category: "knowledge-coverage",
    severity: "blocking",
    ownerModule: "review",
    artifact: {
      artifactId: `artifact:${artifactFingerprint}`,
      artifactFingerprint,
      moduleId: "slides",
      moduleVersion: "v1",
    },
    target: { type: "element", id: "relationship-box" },
    evidence: id,
    repair: "补充推理桥",
    detectedAt: "2026-09-18T00:00:00.000Z",
  };
}

describe("V5 pipeline core", () => {
  it("creates stable semantic ids that survive wording repairs", () => {
    const first = adaptTeachingDesign(teachingDesign(), { courseId: "reasoning" });
    const repaired = adaptTeachingDesign(teachingDesign("区分证据、推理与结论"), {
      courseId: "reasoning",
    });
    expect(first.pages[0].units.map((unit) => unit.id)).toEqual(
      repaired.pages[0].units.map((unit) => unit.id),
    );
    expect(first.pages[0].units.find((unit) => unit.kind === "visible-relationship")).toMatchObject({
      id: "page-001-visible-relationship-001",
      actionSupport: "helpful",
    });
  });

  it("fingerprints objects canonically", () => {
    expect(stableSerialize({ b: 2, a: 1 })).toBe(stableSerialize({ a: 1, b: 2 }));
    expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }));
  });

  it("invalidates only consumers of the changed artifact aspect", () => {
    const graph = createV5InvalidationGraph();
    const layout = graph.affectedBy([V5_ARTIFACT_ASPECTS.slideLayout]);
    expect([...layout.invalidatedModules]).toEqual([
      "actions",
      "layout-review",
      "action-review",
      "export",
    ]);
    expect(layout.invalidatedModules.has("narration")).toBe(false);
    expect(layout.invalidatedModules.has("audio")).toBe(false);
    expect(layout.invalidatedModules.has("quiz")).toBe(false);
  });

  it("compiles and rebinds actions deterministically after layout changes", () => {
    const first = compileActionBindings({ slide: slide(), narration: narration(), cues: [cue()] });
    expect(first.issues).toEqual([]);
    expect(first.actions.map((action) => action.type)).toEqual(["spotlight", "speech"]);
    expect(first.actions[0]).toMatchObject({
      id: "page-001-cue-001",
      elementId: "relationship-box",
      speechId: "page-001-speech-001",
    });

    const rebound = compileActionBindings({
      slide: slide("relationship-box-moved"),
      narration: narration(),
      cues: [cue()],
    });
    expect(rebound.actions[0]).toMatchObject({ elementId: "relationship-box-moved" });
    expect(rebound.actions[1]).toEqual(first.actions[1]);
  });

  it("reports required cues and stale narration anchors instead of dropping them", () => {
    const missing = slide();
    missing.bindings = [];
    const compiled = compileActionBindings({ slide: missing, narration: narration(), cues: [cue()] });
    expect(compiled.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing-element-binding", severity: "blocking" }),
      expect.objectContaining({ code: "missing-required-cue", severity: "blocking" }),
    ]));

    const valid = compileActionBindings({ slide: slide(), narration: narration(), cues: [cue()] });
    const issues = validateActionReferences({
      actions: valid.actions,
      slide: slide(),
      narration: narration("证据经过推理才能支撑结论。"),
      requiredCues: [cue()],
    });
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "anchor-quote-missing", severity: "blocking" }),
    ]));
  });

  it("persists successful raw responses before parse and structure checks", async () => {
    const storage = new MemoryPipelineStorage();
    const model = {
      identity: { model: "fixed-replay" },
      generate: async () => ({ requestId: "request-1", text: "not-json" }),
    };
    const failure = await persistedModelCall({
      runId: "run-1",
      moduleId: "slides",
      request: { requestId: "request-1", moduleId: "slides", system: "", user: "" },
      model,
      storage,
      parse: (response) => JSON.parse(response.text) as unknown,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PipelineError);
    expect((failure as PipelineError).kind).toBe("parse");
    expect(storage.modelResponses).toHaveLength(1);

    const structure = await persistedModelCall({
      runId: "run-2",
      moduleId: "narration",
      request: { requestId: "request-2", moduleId: "narration", system: "", user: "" },
      model: {
        ...model,
        generate: async () => ({ requestId: "request-2", text: "{}" }),
      },
      storage,
      parse: (response) => JSON.parse(response.text) as Record<string, unknown>,
      validate: () => { throw new Error("segments missing"); },
    }).catch((error: unknown) => error);
    expect((structure as PipelineError).kind).toBe("structure");
    expect(storage.modelResponses).toHaveLength(2);
  });

  it("keeps transport and quality failures distinct", async () => {
    const storage = new MemoryPipelineStorage();
    const request = { requestId: "request", moduleId: "review", system: "", user: "" };
    const transport = await persistedModelCall({
      runId: "transport-run",
      moduleId: "review",
      request,
      model: {
        identity: { model: "offline" },
        generate: async () => { throw new Error("connection reset"); },
      },
      storage,
      parse: () => ({}),
    }).catch((error: unknown) => error);
    expect((transport as PipelineError).kind).toBe("transport");
    expect(storage.modelResponses).toHaveLength(0);

    const quality = await persistedModelCall({
      runId: "quality-run",
      moduleId: "review",
      request,
      model: {
        identity: { model: "offline" },
        generate: async () => ({ requestId: "request", text: "{}" }),
      },
      storage,
      parse: () => ({}),
      review: () => [issue("coverage", "artifact")],
    }).catch((error: unknown) => error);
    expect((quality as PipelineError).kind).toBe("quality");
    expect(storage.modelResponses).toHaveLength(1);
  });

  it("classifies aborts without persisting a nonexistent response", async () => {
    const storage = new MemoryPipelineStorage();
    const failure = await persistedModelCall({
      runId: "run-abort",
      moduleId: "slides",
      request: { requestId: "request-abort", moduleId: "slides", system: "", user: "" },
      model: {
        identity: { model: "abort" },
        generate: async () => { throw new DOMException("cancelled", "AbortError"); },
      },
      storage,
      parse: () => ({}),
    }).catch((error: unknown) => error);
    expect((failure as PipelineError).kind).toBe("cancelled");
    expect(storage.modelResponses).toHaveLength(0);
  });

  it("widens repairs on repeated state or regression, without an attempt cap", () => {
    const strategy = new RepairStrategy();
    expect(strategy.decide({
      artifactFingerprint: "a",
      issues: [issue("one", "a")],
      scope: "target",
      recordedAt: "1",
    })).toMatchObject({ action: "repair", scope: "target", reason: "progress" });
    expect(strategy.decide({
      artifactFingerprint: "b",
      issues: [issue("two", "b")],
      scope: "target",
      recordedAt: "2",
    })).toMatchObject({ action: "repair", scope: "target", reason: "progress" });
    expect(strategy.decide({
      artifactFingerprint: "b",
      issues: [issue("two", "b")],
      scope: "target",
      recordedAt: "3",
    })).toMatchObject({ action: "rediagnose", scope: "page", reason: "repeated-artifact" });
    expect(strategy.snapshots()).toHaveLength(3);

    const regression = new RepairStrategy();
    regression.decide({
      artifactFingerprint: "r1",
      issues: [issue("one", "r1")],
      scope: "target",
      recordedAt: "1",
    });
    expect(regression.decide({
      artifactFingerprint: "r2",
      issues: [issue("one", "r2"), issue("new-regression", "r2")],
      scope: "target",
      recordedAt: "2",
    })).toMatchObject({ action: "rediagnose", scope: "page", reason: "regression" });
  });

  it("accepts whole-course duration only from measured audio", () => {
    const segments = [
      { id: "s1", pageId: "p1", text: "第一段", semanticIds: [] },
      { id: "s2", pageId: "p2", text: "第二段更长", semanticIds: [] },
    ];
    const result = evaluateCourseDuration({
      narration: segments,
      audio: [
        { segmentId: "s1", durationSec: 80 },
        { segmentId: "s2", durationSec: 100 },
      ],
    });
    expect(result).toMatchObject({ actualDurationSec: 180, withinTolerance: true });
    expect(result.pageTargets).toHaveLength(2);
  });
});
