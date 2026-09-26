import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudentAiProgress } from "@/lib/session/types";

const mocks = vi.hoisted(() => ({
  lock: vi.fn(),
  publish: vi.fn(),
  tx: {
    classroomParticipation: { findFirst: vi.fn(), update: vi.fn() },
    studentProjectWorkspace: { upsert: vi.fn() },
    classroomInstance: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    domainEvent: { create: vi.fn() },
  },
}));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: (callback: (tx: typeof mocks.tx) => unknown) => callback(mocks.tx) }));
vi.mock("@/lib/db/session-repository", () => ({ lockProjectedCourse: mocks.lock }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: mocks.publish }));

import { persistStudentAiProgress } from "./ai-progress-service";

function progress(overrides: Partial<StudentAiProgress> = {}): StudentAiProgress {
  return {
    classroomId: "classroom-1", studentId: "student-1", currentSceneIndex: 2,
    totalScenes: 3, completedScenes: ["scene-1"], masteryLevel: "in-progress",
    lastActiveAt: "2026-09-26T00:00:00.000Z", completionModelVersion: 2,
    ...overrides,
  };
}

describe("persistStudentAiProgress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.classroomInstance.findUniqueOrThrow.mockResolvedValue({ runtimeConfig: { version: 2 } });
    mocks.tx.domainEvent.create.mockResolvedValue({ id: "event-1", createdAt: new Date("2026-09-26T00:00:01.000Z") });
  });

  it("merges a stale playback report without losing concurrent quiz and tutor records", async () => {
    const attempts = Array.from({ length: 45 }, (_, index) => ({ id: `quiz-${index}` }));
    mocks.tx.classroomParticipation.findFirst.mockResolvedValue({
      id: "participation-1",
      enrollment: { offeringId: "offering-1", researchKey: "research-1" },
      workspace: { projectState: { aiLearningProgress: progress({
        completedScenes: ["scene-1", "scene-2"], masteryLevel: "mastered", quizScore: 100,
        knowledgeLectureAttempts: attempts,
        knowledgeLectureTutorThreads: [{ id: "thread-1" }],
        adaptiveLearning: { enabled: true },
      } as unknown as Partial<StudentAiProgress>) } },
      stageProgress: { progress: { launch: 40, "ai-learning": 20 } },
    });

    const saved = await persistStudentAiProgress("classroom-1", "student-1", progress({
      completedScenes: ["scene-1", "scene-3"], masteryLevel: "in-progress",
    }), 67);

    expect(saved.completedScenes).toEqual(["scene-1", "scene-2", "scene-3"]);
    expect(saved.masteryLevel).toBe("completed");
    expect(saved.quizScore).toBeUndefined();
    expect(saved.knowledgeLectureAttempts).toHaveLength(45);
    expect(saved.knowledgeLectureTutorThreads).toHaveLength(1);
    expect(saved.adaptiveLearning).toEqual({ enabled: true });
    expect(mocks.lock).toHaveBeenCalledWith(mocks.tx, "classroom-1");
    expect(mocks.tx.studentProjectWorkspace.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ projectState: expect.objectContaining({ aiLearningProgress: expect.objectContaining({ knowledgeLectureAttempts: attempts }) }) }),
    }));
    expect(mocks.tx.classroomParticipation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { stageProgress: { progress: { launch: 40, "ai-learning": 67 } } },
    }));
  });
});
