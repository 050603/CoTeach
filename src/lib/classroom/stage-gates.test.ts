import { describe, expect, it } from "vitest";
import { detectInterventionSignals, evaluateStageGate } from "./stage-gates";
import {
  DEFAULT_EVALUATION_FLOWS,
  DEFAULT_STAGES,
  type Course,
  type LearningEvidence,
} from "@/lib/session/types";
import {
  LEARNING_EVIDENCE_SCHEMA_VERSION,
  type LearningEvidenceKind,
  type LearningEvidencePayloadByKind,
} from "@/lib/learning-evidence/types";
import { getStagesForSystemMode } from "@/lib/system-mode";

const now = "2026-07-31T00:00:00.000Z";

function course(overrides: Partial<Course> = {}): Course {
  return {
    id: "course-1", name: "城市水循环", subject: "科学", grade: "八年级", hours: 8,
    summary: "研究社区用水", drivingQuestion: "如何减少校园用水浪费？", learningObjectives: ["解释水循环"], expectedOutcome: "节水方案",
    status: "teaching", stages: DEFAULT_STAGES, currentStageIndex: 0, students: [{ id: "s1", name: "小林", joinedAt: now, stageProgress: {} }],
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "", flows: DEFAULT_EVALUATION_FLOWS } },
    learningEvidence: [], artifactSnapshots: [],
    createdAt: now, updatedAt: now,
    ...overrides,
  };
}

function evidence<Kind extends LearningEvidenceKind>(
  kind: Kind,
  stageKey: string,
  payload: LearningEvidencePayloadByKind[Kind],
  status: LearningEvidence["status"] = "submitted",
): LearningEvidence<Kind> {
  return {
    id: `${kind}-${Math.random()}`,
    schemaVersion: LEARNING_EVIDENCE_SCHEMA_VERSION,
    courseId: "course-1",
    studentId: "s1",
    stageKey,
    kind,
    title: kind,
    summary: "学生证据",
    payload,
    status,
    source: "student",
    countsTowardReadiness: true,
    evidenceRefs: [],
    artifactSnapshotIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

describe("evaluateStageGate", () => {
  it("uses lightweight resource gates for the new system and requires a real practice artifact", () => {
    const previousMode = process.env.NEXT_PUBLIC_OPENPBL_SYSTEM_MODE;
    process.env.NEXT_PUBLIC_OPENPBL_SYSTEM_MODE = "new";
    try {
      const newStages = getStagesForSystemMode("new");
      const base = course({ stages: newStages, currentStageIndex: 0 });
      const launch = evaluateStageGate(base, 0);
      expect(launch.canAdvance).toBe(true);
      expect(launch.blockers).toEqual([]);
      expect(launch.warnings.map((item) => item.code)).toContain("stage-resources");

      const practice = evaluateStageGate({ ...base, currentStageIndex: 2 }, 2);
      expect(practice.blockers.map((item) => item.code)).toContain("collaboration-artifact");
      const withArtifact = evaluateStageGate({
        ...base,
        currentStageIndex: 2,
        submissions: [{
          id: "submission-1",
          courseId: base.id,
          studentId: "s1",
          stageKey: "make",
          type: "document",
          title: "项目成果协作文档",
          content: "<p>节水方案与测试记录</p>",
          createdAt: now,
          updatedAt: now,
        }],
      }, 2);
      expect(withArtifact.canAdvance).toBe(true);
      expect(withArtifact.completed).toContain("所有学生均已保存项目实践产物");
    } finally {
      if (previousMode === undefined) delete process.env.NEXT_PUBLIC_OPENPBL_SYSTEM_MODE;
      else process.env.NEXT_PUBLIC_OPENPBL_SYSTEM_MODE = previousMode;
    }
  });
});
describe("detectInterventionSignals", () => {
  it("returns evidence, targets and action for shared misconceptions", () => {
    const result = detectInterventionSignals(course({ aiLearningProgress: {
      s1: { classroomId: "c", studentId: "s1", currentSceneIndex: 1, totalScenes: 2, completedScenes: [], lastActiveAt: new Date().toISOString(), masteryLevel: "in-progress", unmetGoals: ["解释变量关系"] },
      s2: { classroomId: "c", studentId: "s2", currentSceneIndex: 1, totalScenes: 2, completedScenes: [], lastActiveAt: new Date().toISOString(), masteryLevel: "in-progress", unmetGoals: ["解释变量关系"] },
    } }));
    expect(result[0]).toMatchObject({ kind: "shared-misconception", targetIds: ["s1", "s2"], confidence: "high" });
    expect(result[0].evidence.length).toBeGreaterThan(0);
    expect(result[0].suggestedAction.length).toBeGreaterThan(0);
  });

  it("covers teacher-attention signals from canonical evidence and operational records", () => {
    const old = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const offTarget = {
      ...evidence("artifact-version", "make", {
        iterationId: "round-1",
        versionLabel: "V1",
        artifactTitle: "节水海报",
        changeSummary: "完成第一版",
        contentExcerpt: "提醒随手关水",
      }, "needs-revision"),
      id: "evidence-off-target",
      teacherFeedback: "当前版本偏离驱动问题，需要重新校准范围。",
    };
    const ethics = {
      ...evidence("test-result", "make", {
        iterationId: "round-1",
        method: "现场观察",
        target: "同学",
        observation: "记录用水行为",
        result: "获得初步数据",
      }, "needs-revision"),
      id: "evidence-ethics",
      teacherFeedback: "测试涉及学生隐私与数据安全，请先调整方法。",
    };
    const result = detectInterventionSignals(course({
      currentStageIndex: 2,
      students: [
        { id: "s1", name: "小林", joinedAt: old, stageProgress: {} },
        { id: "s2", name: "小周", joinedAt: old, stageProgress: {} },
      ],
      aiLearningProgress: {
        s1: { classroomId: "c", studentId: "s1", currentSceneIndex: 1, totalScenes: 2, completedScenes: [], lastActiveAt: old, masteryLevel: "in-progress", unmetGoals: ["变量关系"] },
        s2: { classroomId: "c", studentId: "s2", currentSceneIndex: 1, totalScenes: 2, completedScenes: [], lastActiveAt: old, masteryLevel: "in-progress", unmetGoals: ["变量关系"] },
      },
      learningSignals: [{
        id: "signal-stalled",
        courseId: "course-1",
        studentId: "s1",
        stageKey: "make",
        kind: "goal-stalled",
        severity: "warning",
        status: "open",
        title: "当前小目标停滞",
        summary: "尚未形成新的版本证据",
        normalizedIssueKey: "goal-stalled:make",
        evidenceEventIds: ["event-1"],
        aiInterventionAttempts: 1,
        firstDetectedAt: old,
        lastDetectedAt: old,
      }],
      aiContributions: [{
        id: "ai-ready-made",
        courseId: "course-1",
        studentId: "s1",
        stageKey: "make",
        companionId: "planner",
        impact: "high",
        request: "请你直接生成一个可直接提交的完整作品",
        suggestion: "系统已阻止完整代做",
        sourceEvidenceIds: [],
        status: "pending-decision",
        createdAt: old,
      }],
      learningEvidence: [offTarget, ethics],
      aiAssessmentSuggestions: [{
        id: "assessment-gap",
        courseId: "course-1",
        studentId: "s1",
        stageKey: "make",
        dimensions: [],
        evidenceIds: [offTarget.id],
        evidenceGaps: ["缺少真实测试结果"],
        confidence: "low",
        status: "insufficient-evidence",
        createdAt: old,
      }],
    }));
    expect(new Set(result.map((signal) => signal.kind))).toEqual(new Set(["shared-misconception", "off-target", "over-generation", "ethics", "low-confidence", "stalled"]));
    expect(result.every((signal) => signal.evidence.length && signal.targetIds.length && signal.suggestedAction.length)).toBe(true);
  });

  it("does not derive new intervention signals from legacy task progress or AI-support records", () => {
    const old = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const result = detectInterventionSignals(course({
      currentStageIndex: 3,
      groups: [{ id: "g1", name: "旧个人项目", topic: "旧任务", keywords: [], selectedForms: [], members: [{ studentId: "s1", name: "小林" }], createdAt: old, updatedAt: old }],
      workPlan: [{ id: "t1", groupId: "g1", role: "成员", memberName: "小林", task: "旧任务", progress: 0 }],
      aiSupports: [{ id: "old-ai", courseId: "course-1", stageKey: "make", targetType: "group", targetId: "g1", groupId: "g1", kind: "artifact-diagnosis", trigger: "完整生成", inputSummary: "", diagnosis: "证据不足", suggestions: [], evidence: ["旧记录"], status: "draft", createdAt: old, updatedAt: old }],
    }));
    expect(result).toEqual([]);
  });
});
