import { describe, expect, it, vi } from "vitest";
import type { GenerateInput } from "@/lib/llm/types";
import type { KnowledgeStructureGenerationContext } from "@/lib/knowledge-structure-generation";
import {
  generateDurableCourseDesignKnowledgeStructure,
  recordCourseDesignKnowledgeResponse,
  restoreCourseDesignAttemptCount,
  restoreCourseDesignKnowledgeCheckpoint,
  restoreCourseDesignKnowledgeResponse,
} from "./job-runner";

const input: GenerateInput = {
  name: "概念与应用", subject: "信息科技", grade: "初中", hours: 1,
  summary: "理解概念并解释应用", drivingQuestion: "概念如何用于解释实际现象？",
  learningObjectives: ["解释概念"], stages: [],
};
const inputFingerprint = "current-request-and-adopted-source";
const modelFingerprint = "original-model-and-budget";
const validRaw = JSON.stringify({
  knowledgePoints: [{ id: "kp", name: "概念", description: "用明确条件解释实际现象" }],
  knowledgeGraph: { nodes: [{ id: "kp", instructionalRole: "lesson" }], edges: [] },
});
const incompleteRaw = '{"knowledgePoints":[';
type DiagnosticCheckpoint = NonNullable<ReturnType<typeof restoreCourseDesignKnowledgeCheckpoint>>;

function responseCheckpoint(rawResponse: string, attempt = 2): DiagnosticCheckpoint {
  return recordCourseDesignKnowledgeResponse(undefined, inputFingerprint, modelFingerprint, {
    rawResponse, attempt, status: "response-complete", issues: [],
  });
}

function harness(options: {
  storedCheckpoint?: unknown;
  attemptsStarted?: number;
  responses?: string[];
  inputFingerprint?: string;
  modelFingerprint?: string;
  context?: KnowledgeStructureGenerationContext;
} = {}) {
  let attemptsStarted = options.attemptsStarted ?? 0;
  const responses = [...(options.responses ?? [validRaw])];
  const network = vi.fn(async () => responses.shift() ?? incompleteRaw);
  const aiCall = vi.fn(async (_system: string, _prompt: string) => {
    void _system;
    void _prompt;
    if (attemptsStarted >= 3) throw new Error("Durable model request budget exhausted");
    attemptsStarted += 1;
    return network();
  });
  const saved: DiagnosticCheckpoint[] = [];
  const saveCheckpoint = vi.fn(async (checkpoint: DiagnosticCheckpoint) => {
    saved.push(structuredClone(checkpoint));
  });
  const setOutputPhase = vi.fn(async (_status: "validating-output" | "correcting-output", _reason?: string) => {
    void _status;
    void _reason;
  });
  return {
    aiCall, network, saved, saveCheckpoint, setOutputPhase,
    getAttemptsStarted: () => attemptsStarted,
    run: () => generateDurableCourseDesignKnowledgeStructure(input, options.context ?? {}, {
      inputFingerprint: options.inputFingerprint ?? inputFingerprint,
      modelFingerprint: options.modelFingerprint ?? modelFingerprint,
      storedCheckpoint: options.storedCheckpoint,
      aiCall, getAttemptsStarted: () => attemptsStarted,
      saveCheckpoint, setOutputPhase, retrySleep: async () => {},
    }),
  };
}

describe("durable knowledge-structure response recovery", () => {
  it("persists malformed visible output before parsing and stops with the original diagnostic", async () => {
    const run = harness({ responses: [incompleteRaw, validRaw] });
    await expect(run.run()).rejects.toThrow("JSON 无法解析");
    expect(run.saved[0]).toMatchObject({ status: "response-complete", rawResponse: incompleteRaw });
    expect(run.saved[1]).toMatchObject({ status: "rejected", rawResponse: incompleteRaw });
    expect(run.saved[1].validationIssues?.[0]).toContain("JSON 无法解析");
    expect(run.saved[1].responseHistory).toMatchObject([
      { attempt: 1, status: "rejected", rawResponse: incompleteRaw },
    ]);
    expect(run.aiCall).toHaveBeenCalledOnce();
    expect(run.setOutputPhase).toHaveBeenCalledWith("validating-output", expect.stringContaining("JSON 无法解析"));
    expect(run.setOutputPhase.mock.calls.some(([status]) => status === "correcting-output")).toBe(false);
  });

  it("revalidates a completed valid response without spending another model request", async () => {
    const run = harness({ storedCheckpoint: responseCheckpoint(validRaw), attemptsStarted: 2 });
    const result = await run.run();

    expect(run.aiCall).not.toHaveBeenCalled();
    expect(run.getAttemptsStarted()).toBe(2);
    expect(result.generated.knowledgePoints[0].id).toBe("kp");
    expect(result.checkpoint?.responseHistory).toEqual([
      { attempt: 2, rawResponse: validRaw, status: "validated", issues: [] },
    ]);
  });

  it('never adopts a parseable interrupted knowledge response or reissues it during recovery', async () => {
    const run = harness({ storedCheckpoint: { ...responseCheckpoint(validRaw, 1), complete: false }, attemptsStarted: 1 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(run.run()).rejects.toMatchObject({ code: 'LLM_STREAM_INCOMPLETE', isRetryable: false });
    }
    expect(run.aiCall).not.toHaveBeenCalled();
    expect(run.saveCheckpoint).not.toHaveBeenCalled();
  });

  it('revalidates an empty saved knowledge response as a failed draft with zero provider calls', async () => {
    const run = harness({ storedCheckpoint: responseCheckpoint('', 1), attemptsStarted: 1 });
    await expect(run.run()).rejects.toThrow();
    expect(run.aiCall).not.toHaveBeenCalled();
    expect(run.saved.at(-1)).toMatchObject({ status: 'rejected', rawResponse: '' });
  });

  it("revalidates a rejected saved draft without spending remaining requests", async () => {
    const raw = JSON.stringify({ knowledgePoints: [{ id: "kp", name: "设计流程",
      description: "流程有两个步骤：确定目标、设计活动、评价效果。", evidenceItemIds: ["ev"] }],
    knowledgeGraph: { nodes: [], edges: [] } });
    const correctedRaw = raw.replace("两个步骤", "三个步骤");
    const context: KnowledgeStructureGenerationContext = { textbookEvidence: {
      schemaVersion: 2, version: 1, fingerprint: "adopted-three-step-source", createdAt: "2026-09-30T00:00:00Z",
      retrievalMode: "hybrid", warnings: [], mappings: [], selections: [],
      items: [{ id: "ev", kind: "concept", title: "设计流程", content: "确定目标、设计活动、评价效果",
        source: { textbookId: "book", textbookTitle: "主教材", revisionId: "revision", revisionVersion: 1, sectionPath: [] },
        sourceSequences: [{ anchorSourceBlockId: "three-steps", kind: "ordered-steps",
          steps: ["确定目标", "设计活动", "评价效果"].map((label, index) => ({ label, sourceBlockId: `step-${index}` })) }],
      }],
    } };
    const run = harness({ storedCheckpoint: responseCheckpoint(raw), attemptsStarted: 2,
      responses: [correctedRaw], context });
    await expect(run.run()).rejects.toThrow("教材完整步骤不一致");
    expect(run.aiCall).not.toHaveBeenCalled();
    expect(run.getAttemptsStarted()).toBe(2);
    expect(run.saved[0]).toMatchObject({ status: "rejected", rawResponse: raw });
    expect(run.saved[0].responseHistory.map((entry) => [entry.attempt, entry.status])).toEqual([[2, "rejected"]]);
  });

  it("restores old single-response checkpoints using their already persisted request count", async () => {
    const legacy = { schemaVersion: 1, status: "response-complete", inputFingerprint, modelFingerprint,
      rawResponse: incompleteRaw };
    const run = harness({ storedCheckpoint: legacy, attemptsStarted: 2 });
    await expect(run.run()).rejects.toThrow("JSON 无法解析");
    expect(run.aiCall).not.toHaveBeenCalled();
    expect(run.getAttemptsStarted()).toBe(2);
    expect(run.saved[0].responseHistory).toMatchObject([
      { attempt: 2, rawResponse: incompleteRaw, status: "rejected" },
    ]);
  });

  it("revalidates attempt one without overwriting a later broken response or resetting the spent budget", async () => {
    const laterRaw = '{"knowledgeGraph":[';
    let checkpoint = recordCourseDesignKnowledgeResponse(undefined, inputFingerprint, modelFingerprint, {
      rawResponse: incompleteRaw, attempt: 1, status: "rejected", issues: ["JSON 无法解析"],
    });
    checkpoint = recordCourseDesignKnowledgeResponse(checkpoint, inputFingerprint, modelFingerprint, {
      rawResponse: laterRaw, attempt: 2, status: "rejected", issues: ["JSON 无法解析"],
    });
    expect(checkpoint.bestCandidateAttempt).toBe(1);
    const run = harness({ storedCheckpoint: checkpoint, attemptsStarted: 2 });
    await expect(run.run()).rejects.toThrow("JSON 无法解析");

    expect(run.saved[0].responseHistory).toMatchObject([
      { attempt: 1, rawResponse: incompleteRaw, status: "rejected" },
      { attempt: 2, rawResponse: laterRaw, status: "rejected", issues: ["JSON 无法解析"] },
    ]);
    expect(run.saved[0].responseHistory[0].issues[0]).toContain("知识结构 JSON 无法解析");
    expect(run.aiCall).not.toHaveBeenCalled();
    expect(run.network).not.toHaveBeenCalled();
    expect(run.getAttemptsStarted()).toBe(2);
    expect(run.saved.at(-1)?.responseHistory).toHaveLength(2);
  });

  it.each(["request/source", "model"])("rejects a %s identity mismatch instead of adopting or correcting stale output", async (identity) => {
    const run = harness({ storedCheckpoint: responseCheckpoint(incompleteRaw),
      ...(identity === "model" ? { modelFingerprint: "new-model" } : { inputFingerprint: "new-confirmed-source" }) });
    const result = await run.run();

    expect(run.aiCall).toHaveBeenCalledOnce();
    expect(run.aiCall.mock.calls[0][0]).not.toContain("当前是已有知识结构的局部修正");
    expect(result.checkpoint?.responseHistory).toEqual([
      { attempt: 1, rawResponse: validRaw, status: "validated", issues: [] },
    ]);
  });

  it("does not reset the total three-request budget after revalidating a saved failure", async () => {
    const run = harness({ storedCheckpoint: responseCheckpoint(incompleteRaw),
      attemptsStarted: 2, responses: [incompleteRaw] });

    await expect(run.run()).rejects.toThrow("JSON 无法解析");
    expect(run.network).not.toHaveBeenCalled();
    expect(run.getAttemptsStarted()).toBe(2);
    expect(run.saved.at(-1)?.responseHistory.map((entry) => entry.attempt)).toEqual([2]);
    const attemptCheckpoint = { schemaVersion: 1, inputFingerprint, modelFingerprint, attemptsStarted: 3 };
    expect(restoreCourseDesignAttemptCount(attemptCheckpoint, inputFingerprint, modelFingerprint)).toBe(3);
  });

  it("does not make any model request when a saved invalid draft has already consumed all three attempts", async () => {
    const run = harness({ storedCheckpoint: responseCheckpoint(incompleteRaw, 3), attemptsStarted: 3 });

    await expect(run.run()).rejects.toThrow("JSON 无法解析");
    expect(run.network).not.toHaveBeenCalled();
    expect(run.saved[0].responseHistory).toHaveLength(1);
    expect(run.saved[0].responseHistory[0]).toMatchObject({ attempt: 3, status: "rejected" });
  });

  it.each(["response-complete", "rejected"])("does not retry a model request when persisting %s fails", async (status) => {
    const run = harness({ responses: [status === "response-complete" ? validRaw : incompleteRaw] });
    run.saveCheckpoint.mockImplementation(async (checkpoint) => {
      if (checkpoint.status === status) throw new Error("Checkpoint storage unavailable");
    });

    await expect(run.run()).rejects.toThrow("Checkpoint storage unavailable");
    expect(run.network).toHaveBeenCalledOnce();
    expect(run.getAttemptsStarted()).toBe(1);
  });

  it("keeps the parseable best draft when a later completed stream contains broken JSON", () => {
    const first = recordCourseDesignKnowledgeResponse(undefined, inputFingerprint, modelFingerprint, {
      rawResponse: validRaw, attempt: 1, status: "rejected", issues: ["教材列表缺项", "映射未覆盖"],
    });
    const next = recordCourseDesignKnowledgeResponse(first, inputFingerprint, modelFingerprint, {
      rawResponse: incompleteRaw, attempt: 2, status: "response-complete", issues: [],
    });
    const rejected = recordCourseDesignKnowledgeResponse(next, inputFingerprint, modelFingerprint, {
      rawResponse: incompleteRaw, attempt: 2, status: "rejected", issues: ["JSON 无法解析"],
    });

    expect(restoreCourseDesignKnowledgeResponse(next, inputFingerprint, modelFingerprint, 2)).toBe(validRaw);
    expect(restoreCourseDesignKnowledgeResponse(rejected, inputFingerprint, modelFingerprint, 2)).toBe(validRaw);
    expect(rejected.responseHistory.map((entry) => entry.rawResponse)).toEqual([validRaw, incompleteRaw]);
    expect(first.responseHistory).toHaveLength(1);
  });

  it("retains the best draft unless a parseable correction strictly reduces its existing quality errors", () => {
    const first = recordCourseDesignKnowledgeResponse(undefined, inputFingerprint, modelFingerprint, {
      rawResponse: validRaw, attempt: 1, status: "rejected", issues: ["教材列表缺项", "映射未覆盖"],
    });
    const improvedRaw = validRaw.replace("实际现象", "具体案例");
    const improved = recordCourseDesignKnowledgeResponse(first, inputFingerprint, modelFingerprint, {
      rawResponse: improvedRaw, attempt: 2, status: "rejected", issues: ["映射未覆盖"],
    });
    const replacedIssue = recordCourseDesignKnowledgeResponse(improved, inputFingerprint, modelFingerprint, {
      rawResponse: validRaw, attempt: 3, status: "rejected", issues: ["新增错误数量"],
    });

    expect(improved.bestCandidateAttempt).toBe(2);
    expect(replacedIssue.bestCandidateAttempt).toBe(2);
    expect(replacedIssue.responseHistory).toHaveLength(3);
    expect(() => recordCourseDesignKnowledgeResponse(replacedIssue, inputFingerprint, modelFingerprint, {
      rawResponse: validRaw, attempt: 4, status: "response-complete", issues: [],
    })).toThrow("persisted model attempt");
  });

  it("keeps all completed/rejected diagnostics after validation while refusing to use them as a new initial draft", () => {
    let checkpoint = responseCheckpoint(incompleteRaw, 1);
    checkpoint = recordCourseDesignKnowledgeResponse(checkpoint, inputFingerprint, modelFingerprint, {
      rawResponse: incompleteRaw, attempt: 1, status: "rejected", issues: ["JSON 无法解析"],
    });
    checkpoint = recordCourseDesignKnowledgeResponse(checkpoint, inputFingerprint, modelFingerprint, {
      rawResponse: validRaw, attempt: 2, status: "validated", issues: [],
    });

    expect(restoreCourseDesignKnowledgeCheckpoint(checkpoint, inputFingerprint, modelFingerprint)?.responseHistory)
      .toEqual(checkpoint.responseHistory);
    expect(restoreCourseDesignKnowledgeResponse(checkpoint, inputFingerprint, modelFingerprint)).toBeUndefined();
    expect(restoreCourseDesignKnowledgeCheckpoint(checkpoint, "other-source", modelFingerprint)).toBeUndefined();
    expect(restoreCourseDesignKnowledgeCheckpoint(checkpoint, inputFingerprint, "other-model")).toBeUndefined();
  });
});
