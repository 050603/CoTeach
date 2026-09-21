import { describe, expect, it } from "vitest";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import type { PersistedClassroomData } from "@/lib/openmaic/server/classroom-storage";
import { computeCourseQualitySignature } from "./signature";

const classroom = {
  id: "classroom",
  revision: 1,
  createdAt: "2026-09-21T00:00:00.000Z",
  stage: { id: "stage" },
  scenes: [],
} as unknown as PersistedClassroomData;

describe("course quality signature", () => {
  it("invalidates a review when textbook mapping or evidence identity changes", () => {
    const course = createPblTemplateCourse("course");
    course.content.knowledgePoints = [{ id: "target", name: "教材概念", description: "教材解释", sourceKnowledgePointIds: ["source"] }];
    course.content.knowledgeScopePlan = {
      schemaVersion: 1, planningDurationMin: 30, durationRangeMin: 30, durationRangeMax: 30,
      durationSource: "resource-package", assessmentReserveMin: 4, explanationAndActivityMin: 26,
      sourcePointCount: 1, targetPointCount: 1, rationale: "教材映射",
      decisions: [{ sourceKnowledgePointId: "source", sourceKnowledgePointName: "教师要求", disposition: "mapped", targetKnowledgePointId: "target", targetKnowledgePointIds: ["target"], rationale: "教材化改写" }],
    };
    course.content.courseEvidence = {
      schemaVersion: 1, version: 1, fingerprint: "evidence-v1", createdAt: "2026-09-21T00:00:00.000Z", retrievalMode: "hybrid",
      selections: [], items: [], warnings: [],
      mappings: [{ sourceKnowledgePointId: "source", sourceKnowledgePointName: "教师要求", status: "direct", evidenceItemIds: ["evidence"], rationale: "教材支持" }],
    };
    const baseline = computeCourseQualitySignature(course, classroom);
    const changedPlan = structuredClone(course);
    changedPlan.content.knowledgeScopePlan!.decisions[0]!.rationale = "教师调整了映射理由";
    const changedEvidence = structuredClone(course);
    changedEvidence.content.courseEvidence!.fingerprint = "evidence-v2";
    expect(computeCourseQualitySignature(changedPlan, classroom)).not.toBe(baseline);
    expect(computeCourseQualitySignature(changedEvidence, classroom)).not.toBe(baseline);
  });
});
