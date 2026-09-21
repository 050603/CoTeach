import { describe, expect, it } from "vitest";
import type { Course, KnowledgeLectureAttempt, StudentAiProgress } from "@/lib/session/types";
import {
  canApplyDiscussionAsyncResult,
  canStartDiscussionRecording,
  discussionStatusAfterPlayback,
  parseAssistantDecision,
  rankDiscussionCandidates,
} from "./service";

function attempt(studentId: string, earned: number, answer: string): StudentAiProgress {
  const quiz: KnowledgeLectureAttempt = {
    id: `attempt-${studentId}`,
    sectionId: "section-1",
    quizOutlineId: "quiz-1",
    runtimeSceneId: "scene-1",
    submittedAt: "2026-09-16T00:00:00.000Z",
    score: earned,
    maxScore: 10,
    knowledgePointIds: ["kp-1"],
    questions: [{
      questionId: `question-${studentId}`,
      prompt: "请说明判断依据",
      answer,
      points: 10,
      earned,
      correct: earned >= 8,
      feedback: "请核对概念与证据。",
      knowledgePointIds: ["kp-1"],
    }],
  };
  return {
    classroomId: "course-1",
    studentId,
    currentSceneIndex: 1,
    totalScenes: 2,
    completedScenes: [],
    lastActiveAt: "2026-09-16T00:00:00.000Z",
    masteryLevel: "in-progress",
    knowledgeLectureAttempts: [quiz],
  };
}

function course(): Course {
  return {
    id: "course-1",
    name: "公开讨论模拟课堂",
    subject: "科学",
    grade: "八年级",
    hours: 1,
    summary: "",
    drivingQuestion: "证据怎样支持结论？",
    status: "teaching",
    stages: [],
    currentStageIndex: 0,
    content: { knowledgePoints: [{ id: "kp-1", name: "证据链", description: "" }] },
    students: [
      { id: "student-a", name: "安同学", joinedAt: "2026-09-16T00:00:00.000Z", stageProgress: {} },
      { id: "student-b", name: "白同学", joinedAt: "2026-09-16T00:00:00.000Z", stageProgress: {} },
      { id: "student-c", name: "陈同学", joinedAt: "2026-09-16T00:00:00.000Z", stageProgress: {} },
    ],
    aiLearningProgress: {
      "student-a": attempt("student-a", 2, "只要结论正确就算有证据"),
      "student-b": attempt("student-b", 7, "实验记录可以支持结论"),
      "student-c": attempt("student-c", 2, "只要结论正确就算有证据"),
    },
  } as unknown as Course;
}

describe("public discussion candidate selection", () => {
  it("only recommends online students and prioritizes representative misunderstanding for inquiry", () => {
    const ranked = rankDiscussionCandidates(
      course(),
      "kp-1",
      "inquiry",
      new Set(["student-a", "student-b"]),
    );

    expect(ranked.map((candidate) => candidate.studentId)).toEqual(["student-a", "student-b"]);
    expect(ranked[0]).toMatchObject({ online: true, evidence: expect.stringContaining("结论正确") });
  });

  it("uses lower prior participation as the tie breaker for comparable evidence", () => {
    const ranked = rankDiscussionCandidates(
      course(),
      "kp-1",
      "inquiry",
      new Set(["student-a", "student-c"]),
      new Map([["student-a", 2], ["student-c", 0]]),
    );

    expect(ranked.map((candidate) => candidate.studentId)).toEqual(["student-c", "student-a"]);
    expect(rankDiscussionCandidates(course(), "kp-1", "debate", new Set())).toEqual([]);
  });
});

describe("public discussion stale async result guard", () => {
  const current = { version: 7, status: "AI_GENERATING", currentStudentId: "student-a" };

  it("accepts only the generation that still owns the same state and student", () => {
    expect(canApplyDiscussionAsyncResult(current, {
      version: 7,
      status: "AI_GENERATING",
      studentId: "student-a",
    })).toBe(true);
    expect(canApplyDiscussionAsyncResult(current, {
      version: 6,
      status: "AI_GENERATING",
      studentId: "student-a",
    })).toBe(false);
    expect(canApplyDiscussionAsyncResult(current, {
      version: 7,
      status: "PAUSED",
      studentId: "student-a",
    })).toBe(false);
    expect(canApplyDiscussionAsyncResult(current, {
      version: 7,
      status: "AI_GENERATING",
      studentId: "student-b",
    })).toBe(false);
  });
});

describe("public discussion voice-loop state helpers", () => {
  it("allows a second recording after ASR failure and for legacy confirmation sessions", () => {
    expect(canStartDiscussionRecording("AWAITING_STUDENT")).toBe(true);
    expect(canStartDiscussionRecording("AWAITING_RETRY")).toBe(true);
    expect(canStartDiscussionRecording("AWAITING_CONFIRMATION")).toBe(true);
    expect(canStartDiscussionRecording("AI_GENERATING")).toBe(false);
  });

  it("waits for the student after a follow-up and for the teacher after a completion recommendation", () => {
    expect(discussionStatusAfterPlayback("AI_READY")).toBe("AWAITING_STUDENT");
    expect(discussionStatusAfterPlayback("AI_COMPLETION_READY")).toBe("AWAITING_TEACHER_CONFIRMATION");
    expect(discussionStatusAfterPlayback("AI_FAILED")).toBeUndefined();
  });

  it("parses the model decision and enforces the third-round limit", () => {
    expect(parseAssistantDecision('{"reply":"再举一个例子。","decision":"continue"}', 1)).toEqual({
      reply: "再举一个例子。",
      decision: "continue",
    });
    expect(parseAssistantDecision('{"reply":"你的解释已经完整。","decision":"recommend_end"}', 2)).toEqual({
      reply: "你的解释已经完整。",
      decision: "recommend_end",
    });
    expect(parseAssistantDecision('{"reply":"还可以继续。","decision":"continue"}', 3)).toEqual({
      reply: "还可以继续。",
      decision: "recommend_end",
    });
    expect(parseAssistantDecision('{"reply":"继续做迁移说明。","decision":"recommend_end"}', 2, true)).toEqual({
      reply: "继续做迁移说明。",
      decision: "continue",
    });
  });
});
