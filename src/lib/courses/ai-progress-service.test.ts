import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudentAiProgress } from "@/lib/session/types";

const mocks = vi.hoisted(() => ({
  lock: vi.fn(),
  publish: vi.fn(),
  tx: {
    $queryRaw: vi.fn(),
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

function setParticipation(row: { id: string; enrollment?: { offeringId?: string; researchKey?: string }; workspace?: { projectState: unknown }; stageProgress?: unknown }) {
  mocks.tx.$queryRaw.mockResolvedValueOnce([{ ...row, offeringId: row.enrollment?.offeringId, researchKey: row.enrollment?.researchKey,
    projectState: row.workspace?.projectState, runtimeConfig: { version: 2 }, userStatus: "ACTIVE", userRole: "STUDENT", sessionVersion: 1, enrollmentStatus: "ACTIVE", classroomStatus: "TEACHING", offeringStatus: "OPEN", archivedAt: null }]);
}

function committedJson() {
  return mocks.tx.$queryRaw.mock.calls[1].slice(1).flatMap(value => {
    if (typeof value !== "string" || !value.startsWith("{")) return [];
    return [JSON.parse(value)];
  });
}

describe("persistStudentAiProgress", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.tx.$queryRaw.mockResolvedValue([{ id: "event-1", createdAt: new Date("2026-09-26T00:00:01.000Z") }]);
  });

  it("merges a stale playback report without losing concurrent quiz and tutor records", async () => {
    const attempts = Array.from({ length: 45 }, (_, index) => ({ id: `quiz-${index}` }));
    setParticipation({
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
    }));

    expect(saved.completedScenes).toEqual(["scene-1", "scene-2", "scene-3"]);
    expect(saved.masteryLevel).toBe("completed");
    expect(saved.quizScore).toBeUndefined();
    expect(saved.knowledgeLectureAttempts).toBeUndefined();
    expect(saved.knowledgeLectureTutorThreads).toBeUndefined();
    expect(saved.adaptiveLearning).toBeUndefined();
    expect(mocks.lock).toHaveBeenCalledWith(mocks.tx, "classroom-1");
    const writes = committedJson();
    expect(writes).toContainEqual(expect.objectContaining({ progress: 100, scope: "student", courseVersion: 3 }));
    expect(writes).toContainEqual(expect.objectContaining({ aiLearningProgress: expect.objectContaining({ knowledgeLectureAttempts: attempts }) }));
    expect(writes).toContainEqual({ progress: { launch: 40, "ai-learning": 100 } });
    expect(mocks.publish).toHaveBeenCalledWith("classroom-1", expect.objectContaining({ payload: expect.objectContaining({ courseVersion: 3, eventCursor: "2026-09-26T00:00:01.000Z~event-1" }) }));
  });

  it("removes invalid prior completions and derives percentage from legal merged scenes", async () => {
    setParticipation({
      id: "participation-1", enrollment: { offeringId: "offering-1" },
      workspace: { projectState: { aiLearningProgress: progress({ completedScenes: ["teacher", "scene-1"], completedOutlineIds: ["teacher", "scene-1"] }) } },
      stageProgress: { progress: { "ai-learning": 100 } },
    });
    const saved = await persistStudentAiProgress("classroom-1", "student-1", progress({ totalScenes: 2 }), [{ id: "scene-1" }, { id: "scene-2" }]);
    expect(saved.completedScenes).toEqual(["scene-1"]);
    expect(saved.completedOutlineIds).toEqual(["scene-1"]);
    expect(saved.masteryLevel).toBe("in-progress");
    expect(committedJson()).toContainEqual({ progress: { "ai-learning": 50 } });
  });

  it("rejects a playback report queued behind classroom closure", async () => {
    mocks.tx.$queryRaw.mockResolvedValue([{ id: "participation-1", userStatus: "ACTIVE", userRole: "STUDENT", enrollmentStatus: "ACTIVE", classroomStatus: "FINISHED", offeringStatus: "OPEN" }]);
    await expect(persistStudentAiProgress("classroom-1", "student-1", progress())).rejects.toMatchObject({ code: "CLASSROOM_READ_ONLY", status: 409 });
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("returns the original compact receipt after newer progress or closure without touching versions/events", async () => {
    const response = progress();
    mocks.tx.$queryRaw.mockResolvedValue([{ userStatus: "ACTIVE", userRole: "STUDENT", sessionVersion: 1, enrollmentStatus: "COMPLETED", classroomStatus: "FINISHED", receipt: { fingerprint: "hash", response } }]);
    expect(await persistStudentAiProgress("course", "student", progress({ currentSceneIndex: 0 }), undefined, { requestId: "request", fingerprint: "hash", sessionVersion: 1 })).toEqual(response);
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(1); expect(mocks.publish).not.toHaveBeenCalled();
    await expect(persistStudentAiProgress("course", "student", progress(), undefined, { requestId: "request", fingerprint: "changed" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });
  it.each([{ userStatus: "DISABLED" }, { userRole: "TEACHER" }, { sessionVersion: 2 }, { enrollmentStatus: "WITHDRAWN" }])("authorizes before replaying receipts: %s", async revoked => {
    mocks.tx.$queryRaw.mockResolvedValue([{ userStatus: "ACTIVE", userRole: "STUDENT", sessionVersion: 1, enrollmentStatus: "ACTIVE", receipt: { fingerprint: "hash", response: progress() }, ...revoked }]);
    await expect(persistStudentAiProgress("course", "student", progress(), undefined, { requestId: "request", fingerprint: "hash", sessionVersion: 1 })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it.each([[], new Error("receipt insert failed")])("never acknowledges or publishes an incomplete commit: %s", async result => {
    setParticipation({ id: "participation-1", enrollment: { offeringId: "offering-1" } });
    if (result instanceof Error) mocks.tx.$queryRaw.mockRejectedValueOnce(result);
    else mocks.tx.$queryRaw.mockResolvedValueOnce(result);
    await expect(persistStudentAiProgress("classroom-1", "student-1", progress())).rejects.toThrow();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
