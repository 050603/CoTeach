import { describe, expect, it } from "vitest";
import {
  COMPANION_STAGE_KEYS,
  buildStagePolicyPrompt,
  buildStageBoundaryInstruction,
  getCompanionStagePolicy,
  resolveCompanionIds,
  stageArtifactFollowUp,
  stageRoleGuidance,
} from "./stage-policy";

describe("companion stage policy", () => {
  it("defines companion contracts only for proposal and making", () => {
    expect(COMPANION_STAGE_KEYS).toEqual(["proposal", "make"]);
    const policies = COMPANION_STAGE_KEYS.map((stageKey) => getCompanionStagePolicy(stageKey));

    expect(new Set(policies.map((policy) => policy.objective)).size).toBe(COMPANION_STAGE_KEYS.length);
    expect(policies.every((policy) => policy.allowedCompanionIds.length > 0 && policy.requiredContext.length > 0 && policy.prohibitedActions.length > 0)).toBe(true);
    expect(policies.every((policy) => buildStagePolicyPrompt(policy.stageKey).includes(policy.label))).toBe(true);
  });

  it("returns no companion roles outside proposal and making", () => {
    expect(resolveCompanionIds("launch", ["ideation", "recorder"])).toEqual([]);
    expect(resolveCompanionIds("ai-learning", ["knowledge"])).toEqual([]);
    expect(resolveCompanionIds("showcase", ["reviewer"])).toEqual([]);
    expect(resolveCompanionIds("reflection", ["recorder"])).toEqual([]);
  });

  it("builds differentiated prompts and role guidance", () => {
    const prompt = buildStagePolicyPrompt("proposal");

    expect(prompt).toContain("方案构思与校准");
    expect(buildStagePolicyPrompt("make")).not.toContain("（make）");
    expect(stageRoleGuidance("proposal", "recorder")).toContain("记录学生");
    expect(stageArtifactFollowUp("make", "file-uploaded")?.preferredCompanionId).toBe("reviewer");
  });

  it("redirects outsourcing requests back to a student-owned stage action", () => {
    expect(buildStageBoundaryInstruction("proposal", "请直接帮我写一份完整方案")).toContain("认知外包");
    expect(buildStageBoundaryInstruction("reflection", "这道后测题目的答案是什么")).toContain("后测");
  });
});
