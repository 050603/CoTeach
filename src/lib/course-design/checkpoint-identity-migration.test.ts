import { describe, expect, it, vi } from "vitest";
import type { GenerateInput } from "@/lib/llm/types";
import {
  generateDurableCourseDesignKnowledgeStructure,
  migrateCourseDesignCheckpointIdentity,
  recordCourseDesignKnowledgeResponse,
  restoreCourseDesignAttemptCount,
  restoreCourseDesignStageResponse,
} from "./job-runner";

const oldFingerprint = "previous-expanded-source-contract";
const newFingerprint = "current-deduplicated-source-contract";
const modelFingerprint = "same-model-and-output-budget";
const malformedRaw = '{"knowledgePoints":[';

describe("course design checkpoint identity migration", () => {
  it("retains a parseable but explicitly truncated response and refuses replay as a complete response", () => {
    const previous = { schemaVersion: 1, inputFingerprint: oldFingerprint, modelFingerprint,
      status: "response-complete", attemptsStarted: 1, complete: false,
      rawResponse: JSON.stringify({ knowledgePoints: [{ id: "kp", name: "概念" }] }) };
    const migrated = migrateCourseDesignCheckpointIdentity(previous, newFingerprint, modelFingerprint, [oldFingerprint]);
    expect(migrated).toMatchObject({ complete: false, rawResponse: previous.rawResponse, attemptsStarted: 1 });
    expect(() => restoreCourseDesignStageResponse(migrated, newFingerprint, modelFingerprint))
      .toThrow(expect.objectContaining({ code: "LLM_STREAM_INCOMPLETE", isRetryable: false }));
    expect(restoreCourseDesignAttemptCount(migrated, newFingerprint, modelFingerprint)).toBe(1);
  });

  it.each(["response-complete", "invalid-output", "rejected", "validated"])(
    "preserves the %s response, diagnostics, and spent requests across a compatible policy change",
    (status) => {
      const previous = {
        schemaVersion: 1, inputFingerprint: oldFingerprint, modelFingerprint,
        status, rawResponse: malformedRaw, attemptsStarted: 2,
        validationIssues: ["JSON 无法解析"],
        responseHistory: [{ attempt: 2, rawResponse: malformedRaw, status, issues: ["JSON 无法解析"] }],
        acceptedCandidate: { knowledgePoints: [{ id: "preserved-earlier-candidate" }] },
      };
      const migrated = migrateCourseDesignCheckpointIdentity(previous, newFingerprint, modelFingerprint, [oldFingerprint]);

      expect(migrated).toEqual({ ...previous, inputFingerprint: newFingerprint });
      expect(previous.inputFingerprint).toBe(oldFingerprint);
      expect(restoreCourseDesignStageResponse(migrated, newFingerprint, modelFingerprint)).toBe(malformedRaw);
      expect(restoreCourseDesignAttemptCount(migrated, newFingerprint, modelFingerprint)).toBe(2);
    },
  );

  it("migrates a spent request checkpoint even when no response was received", () => {
    const previous = { schemaVersion: 1, inputFingerprint: oldFingerprint, modelFingerprint, attemptsStarted: 1 };
    const migrated = migrateCourseDesignCheckpointIdentity(previous, newFingerprint, modelFingerprint, [oldFingerprint]);
    expect(restoreCourseDesignAttemptCount(migrated, newFingerprint, modelFingerprint)).toBe(1);
    expect(restoreCourseDesignStageResponse(migrated, newFingerprint, modelFingerprint)).toBeNull();
  });

  it.each([
    { name: "a different model", savedModel: "another-model", savedInput: oldFingerprint, schemaVersion: 1 },
    { name: "an incompatible input", savedModel: modelFingerprint, savedInput: "different-source", schemaVersion: 1 },
    { name: "an unknown checkpoint schema", savedModel: modelFingerprint, savedInput: oldFingerprint, schemaVersion: 2 },
  ])("does not migrate $name", ({ savedModel, savedInput, schemaVersion }) => {
    const previous = { schemaVersion, inputFingerprint: savedInput, modelFingerprint: savedModel,
      status: "invalid-output", rawResponse: malformedRaw, attemptsStarted: 2 };
    const migrated = migrateCourseDesignCheckpointIdentity(previous, newFingerprint, modelFingerprint, [oldFingerprint]);
    expect(migrated).toBe(previous);
    expect(restoreCourseDesignAttemptCount(migrated, newFingerprint, modelFingerprint)).toBe(0);
    expect(restoreCourseDesignStageResponse(migrated, newFingerprint, modelFingerprint)).toBeNull();
  });

  it("validates a compatible unmarked legacy draft without another model call", async () => {
    const input: GenerateInput = {
      name: "概念与应用", subject: "信息科技", grade: "初中", hours: 1,
      summary: "理解概念并解释应用", drivingQuestion: "概念如何用于解释实际现象？",
      learningObjectives: ["解释概念"], stages: [],
    };
    const rawResponse = JSON.stringify({
      knowledgePoints: [{ id: "kp", name: "概念", description: "用明确条件解释实际现象" }],
      knowledgeGraph: { nodes: [{ id: "kp", instructionalRole: "lesson" }], edges: [] },
    });
    const previous = recordCourseDesignKnowledgeResponse(undefined, oldFingerprint, modelFingerprint, {
      rawResponse, attempt: 2, status: "response-complete", issues: [],
    });
    const storedCheckpoint = migrateCourseDesignCheckpointIdentity(previous, newFingerprint, modelFingerprint, [oldFingerprint]);
    const aiCall = vi.fn();
    const result = await generateDurableCourseDesignKnowledgeStructure(input, {}, {
      inputFingerprint: newFingerprint, modelFingerprint, storedCheckpoint,
      aiCall, getAttemptsStarted: () => 2, saveCheckpoint: vi.fn(async () => {}),
      setOutputPhase: vi.fn(async () => {}),
    });
    expect(aiCall).not.toHaveBeenCalled();
    expect(result.generated.knowledgePoints[0].id).toBe("kp");
    expect(result.checkpoint?.responseHistory).toEqual([
      { attempt: 2, rawResponse, status: "validated", issues: [] },
    ]);
    expect(result.checkpoint?.inputFingerprint).toBe(newFingerprint);
  });
});
