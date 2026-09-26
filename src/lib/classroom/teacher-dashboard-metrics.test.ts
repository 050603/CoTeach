import { describe, expect, it } from "vitest";
import type {
  Course,
  KnowledgeLectureAttempt,
  Student,
  StudentAiProgress,
} from "@/lib/session/types";
import {
  deriveKnowledgeDashboardMetrics,
  deriveLaunchDashboardMetrics,
  deriveMakeDashboardMetrics,
  deriveReflectionDashboardMetrics,
  deriveShowcaseDashboardMetrics,
} from "./teacher-dashboard-metrics";

const student = (id: string, name = id): Student => ({ id, name, joinedAt: "2026-01-01T00:00:00.000Z", stageProgress: {} });

function course(overrides: Partial<Course> = {}): Course {
  return {
    id: "course-1",
    name: "测试课",
    subject: "综合实践",
    grade: "七年级",
    hours: 2,
    summary: "",
    drivingQuestion: "",
    status: "teaching",
    stages: [],
    currentStageIndex: 0,
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } } as unknown as Course["content"],
    students: [],
    resources: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("teacher dashboard metric selectors", () => {
  it("returns honest empty states with no denominator", () => {
    const empty = course();
    expect(deriveLaunchDashboardMetrics(empty).headlines.map((item) => item.value)).toEqual(["—", "—", "未投屏"]);
    expect(deriveShowcaseDashboardMetrics(empty).headlines.every((item) => item.value === "—")).toBe(true);
    const reflection = deriveReflectionDashboardMetrics(empty);
    expect(reflection.headlines[0]?.value).toBe("—");
    expect(reflection.averages).toEqual({});
  });

  it("separates launch opens, progress, completed boundaries and legacy downloads", () => {
    const launch = course({
      students: [student("s1"), student("s2")],
      resources: [{ id: "r1", title: "说明", type: "PDF", size: "1 MB", stageKey: "launch", downloadedBy: ["s2"] }],
      learningEvents: [
        { id: "open", idempotencyKey: "open", courseId: "course-1", studentId: "s1", stageKey: "launch", sceneId: "r1", type: "resource-open", occurredAt: "2026-01-01T00:00:00.000Z", metadata: { resourceId: "r1", source: "student" } },
        { id: "p50", idempotencyKey: "p50", courseId: "course-1", studentId: "s1", stageKey: "launch", sceneId: "r1", type: "resource-progress", occurredAt: "2026-01-01T00:01:00.000Z", progressMarker: "in-progress", metadata: { resourceId: "r1", progressPercent: 50, source: "student" } },
        { id: "done", idempotencyKey: "done", courseId: "course-1", studentId: "s1", stageKey: "launch", sceneId: "r1", type: "resource-complete", occurredAt: "2026-01-01T00:02:00.000Z", progressMarker: "completed", metadata: { resourceId: "r1", progressPercent: 100, source: "student" } },
        { id: "projection", idempotencyKey: "projection", courseId: "course-1", studentId: "s2", stageKey: "launch", sceneId: "r1", type: "resource-complete", occurredAt: "2026-01-01T00:02:00.000Z", progressMarker: "completed", metadata: { resourceId: "r1", progressPercent: 100, source: "teacher-projection" } },
      ],
    });
    const metrics = deriveLaunchDashboardMetrics(launch);
    expect(metrics.startedCount).toBe(2);
    expect(metrics.completedAllCount).toBe(1);
    expect(metrics.resourceCoverage[0]).toMatchObject({ openedCount: 2, completedCount: 1 });
    expect(metrics.studentRows.find((row) => row.student.id === "s2")?.status).toBe("in-progress");
  });

  it("uses unique quiz submissions, section-level denominators and severity ordering", () => {
    const attempt = (id: string, score: number): KnowledgeLectureAttempt => ({
      id,
      sectionId: "section-1",
      quizOutlineId: "quiz-1",
      runtimeSceneId: "runtime",
      submittedAt: `2026-01-0${id.endsWith("1") ? "1" : "2"}T00:00:00.000Z`,
      score,
      maxScore: 10,
      gradingSource: "server",
      gradingStatus: "graded",
      knowledgePointIds: ["kp-1"],
      questions: [{ questionId: "q1", prompt: "问题", answer: "答", points: 10, earned: score, gradingStatus: "graded", correct: score >= 8, feedback: "", knowledgePointIds: ["kp-1"] }],
    });
    const progress = (studentId: string, attempts: KnowledgeLectureAttempt[]): StudentAiProgress => ({ classroomId: "class", studentId, currentSceneIndex: 1, totalScenes: 2, completedScenes: [], lastActiveAt: "2026-01-01T00:00:00.000Z", masteryLevel: "in-progress", knowledgeLectureAttempts: attempts });
    const result = deriveKnowledgeDashboardMetrics(course({
      students: [student("s1"), student("s2"), student("s3")],
      content: { pblOutline: "", knowledgePoints: [{ id: "kp-1", name: "核心概念", description: "" }], knowledgeLectureSections: [{ id: "section-1", title: "第一节", order: 0, knowledgePointIds: ["kp-1"], sceneOutlineIds: [], quizOutlineId: "quiz-1", estimatedMinutes: 5 }], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } } as unknown as Course["content"],
      aiLearningProgress: { s1: progress("s1", [attempt("attempt-1", 2), attempt("attempt-2", 9)]), s2: progress("s2", [attempt("attempt-2", 2)]) },
      learningEvents: [{ id: "enter", idempotencyKey: "enter", courseId: "course-1", studentId: "s2", stageKey: "ai-learning", sceneId: "scene", type: "scene-enter", occurredAt: "2026-01-01T00:00:00.000Z" }],
      learningSignals: [{ id: "signal", courseId: "course-1", studentId: "s2", stageKey: "ai-learning", sceneId: "scene", kind: "idle", severity: "high", status: "open", title: "需要帮助", summary: "", normalizedIssueKey: "idle", evidenceEventIds: [], aiInterventionAttempts: 0, firstDetectedAt: "2026-01-01", lastDetectedAt: "2026-01-01" }],
    }));
    expect(result.headlines[1]?.value).toBe("2/3");
    expect(result.sectionRows[0]).toMatchObject({ answeredCount: 2 });
    expect(result.masteryRows[0]?.answeredStudents).toBe(2);
    expect(result.attentionRows[0]?.student.id).toBe("s2");
  });

  it("excludes quiz and progress records from a classroom no longer linked to the course", () => {
    const oldAttempt: KnowledgeLectureAttempt = {
      id: "old", sectionId: "section-1", quizOutlineId: "quiz-1", runtimeSceneId: "old-scene",
      submittedAt: "2026-01-01T00:00:00.000Z", score: 10, maxScore: 10,
      gradingSource: "server", gradingStatus: "graded", knowledgePointIds: ["kp-1"],
      questions: [{ questionId: "q1", prompt: "问题", answer: "答案", points: 10, earned: 10, correct: true, gradingStatus: "graded", feedback: "", knowledgePointIds: ["kp-1"] }],
    };
    const result = deriveKnowledgeDashboardMetrics(course({
      aiLearningClassroomId: "new-classroom",
      students: [student("s1")],
      content: { pblOutline: "", knowledgePoints: [{ id: "kp-1", name: "知识点", description: "" }], knowledgeLectureSections: [{ id: "section-1", title: "第一节", order: 0, knowledgePointIds: ["kp-1"], sceneOutlineIds: [], quizOutlineId: "quiz-1", estimatedMinutes: 5 }], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } } as unknown as Course["content"],
      aiLearningProgress: { s1: { classroomId: "old-classroom", studentId: "s1", currentSceneIndex: 1, totalScenes: 1, completedScenes: ["old-scene"], completionModelVersion: 2, lastActiveAt: "2026-01-01T00:00:00.000Z", masteryLevel: "completed", knowledgeLectureAttempts: [oldAttempt] } },
    }));
    expect(result.stateCounts.unverified).toBe(1);
    expect(result.sectionRows[0]).toMatchObject({ answeredCount: 0, gradedCount: 0, averageScore: undefined });
    expect(result.masteryRows[0]?.answeredStudents).toBe(0);
    expect(result.headlines[1]?.value).toBe("—");
  });

  it("keeps make decisions and boundaries separate from draft/submission counts", () => {
    const make = course({
      students: [student("s1"), student("s2")],
      projectDocumentVersions: [{ id: "v1", courseId: "course-1", submissionId: "sub", studentId: "s1", stageKey: "make", sequence: 1, sourceVersion: 1, title: "草稿", sourceHtml: "", status: "processing", createdAt: "2026-01-01" }],
      aiInteractionEvents: [
        { id: "d1", courseId: "course-1", studentId: "s1", stageKey: "make", source: "sidebar", eventType: "decision", actorRole: "student", requestId: "req", payload: { decision: "adopted" }, createdAt: "2026-01-01" },
        { id: "d2", courseId: "course-1", studentId: "s1", stageKey: "make", source: "sidebar", eventType: "decision", actorRole: "student", requestId: "req", payload: { decision: "adopted" }, createdAt: "2026-01-01" },
        { id: "b", courseId: "course-1", studentId: "s2", stageKey: "make", source: "sidebar", eventType: "response", actorRole: "ai", payload: { kind: "boundary" }, requestId: "boundary", createdAt: "2026-01-01" },
      ],
    });
    const metrics = deriveMakeDashboardMetrics(make);
    expect(metrics.draftStudentIds).toEqual(new Set(["s1"]));
    expect(metrics.submittedStudentIds).toEqual(new Set());
    expect(metrics.decisionCounts).toEqual({ adopted: 1, rejected: 0 });
    expect(metrics.boundaryTriggerCount).toBe(1);
  });

  it("prefers durable AI decisions and falls back to legacy interaction records", () => {
    const result = deriveMakeDashboardMetrics(course({
      students: [student("s1")],
      studentAiDecisions: [{ id: "decision-1", courseId: "course-1", studentId: "s1", stageKey: "make", contributionId: "contribution-1", decision: "rejected", reason: "不采用", resultingEvidenceIds: [], decidedAt: "2026-01-01" }],
      aiInteractionEvents: [{ id: "event-1", courseId: "course-1", studentId: "s1", stageKey: "make", source: "sidebar", eventType: "decision", actorRole: "student", requestId: "contribution-1", payload: { decision: "adopted", contributionId: "contribution-1" }, createdAt: "2026-01-01" }],
    }));
    expect(result.decisionCounts).toEqual({ adopted: 0, rejected: 1 });
    expect(result.collaborationStudentIds).toEqual(new Set(["s1"]));
  });

  it("calculates showcase actual duration only from started and ended timestamps", () => {
    const showcase = course({ students: [student("s1")], showcasePresentations: [{ id: "p1", courseId: "course-1", groupId: "g", studentId: "s1", studentName: "s1", artifactKind: "pdf", artifactVersionId: "v", artifactTitle: "成果", displayMode: "continuous", status: "ended", requestedAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:05:00.000Z", endedAt: "2026-01-01T00:08:30.000Z", evaluatedAt: "2026-01-01T00:15:00.000Z", updatedAt: "2026-01-01T00:15:00.000Z", revision: 1 }] });
    const metrics = deriveShowcaseDashboardMetrics(showcase);
    expect(metrics.actualDurations[0]?.actualMinutes).toBe(3.5);
    expect(metrics.actualDurations[0]?.plannedMinutes).toBe(5);
  });
});
