import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeLectureAttempt } from "@/lib/session/types";
const mocks = vi.hoisted(() => ({ query: vi.fn(), workspace: vi.fn(), version: vi.fn(), event: vi.fn(), lock: vi.fn(), publish: vi.fn() }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: (fn: (tx: unknown) => unknown) => fn({ $queryRaw: mocks.query, studentProjectWorkspace: { upsert: mocks.workspace }, classroomInstance: { update: mocks.version }, domainEvent: { create: mocks.event } }) }));
vi.mock("@/lib/db/session-repository", () => ({ lockProjectedCourse: mocks.lock }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: mocks.publish }));
import { persistKnowledgeLectureAttempt } from "./knowledge-lecture-attempts";
const attempt: KnowledgeLectureAttempt = { id: "attempt", sectionId: "section", quizOutlineId: "quiz", runtimeSceneId: "scene", submittedAt: "2026-09-26T00:00:00.000Z", gradingSource: "server", gradingStatus: "pending", score: 0, maxScore: 0, knowledgePointIds: [], questions: [{ questionId: "question", prompt: "Why?", answer: "Original answer", rawAnswer: "Original answer", questionType: "short_answer", points: 5, earned: 0, correct: null, gradingStatus: "pending", feedback: "pending", knowledgePointIds: [], teachingUnitIds: [] }] };
const input = { courseId: "course", studentId: "student", classroomId: "classroom", attempt };
let row: { participationId: string; offeringId: string; researchKey: string; status: string; enrollmentStatus: string; offeringStatus: string; archivedAt: null; runtimeConfig: object; projectState: Record<string, unknown>; classroomId: string };
beforeEach(() => {
  vi.resetAllMocks();
  row = { participationId: "participation", offeringId: "offering", researchKey: "research", status: "TEACHING", enrollmentStatus: "ACTIVE", offeringStatus: "OPEN", archivedAt: null, runtimeConfig: { version: 9, uiState: { controller: "teacher" } }, projectState: { savedDocument: "must survive", aiLearningProgress: { studentId: "student", classroomId: "classroom", completedScenes: ["earlier"], knowledgeLectureAttempts: [] } }, classroomId: "classroom" };
  mocks.query.mockImplementation(async (sql: TemplateStringsArray, ...values: unknown[]) => {
    if (!sql.join("").includes("WITH course AS")) return [row];
    // Model the returned durable facts; PostgreSQL rollback is covered by the isolated worker.
    const event = await mocks.event({ data: { createdAt: values[9], participationId: values[13], researchKey: values[14], eventType: values[16], payload: JSON.parse(values[17] as string) } });
    await mocks.workspace({ update: { projectState: JSON.parse(values[5] as string) } });
    await mocks.version({ data: { runtimeConfig: JSON.parse(values[0] as string) } });
    return [event];
  });
  mocks.workspace.mockImplementation(async ({ update }) => { row.projectState = update.projectState; });
  mocks.version.mockImplementation(async ({ data }) => { row.runtimeConfig = data.runtimeConfig; });
  mocks.event.mockImplementation(async ({ data }) => ({ id: "event", createdAt: data.createdAt }));
});
describe("knowledge lecture narrow persistence", () => {
  it("preserves unrelated workspace/progress and atomically versions owned immutable evidence", async () => {
    expect(await persistKnowledgeLectureAttempt(input)).toEqual(attempt);
    expect(row.projectState).toMatchObject({ savedDocument: "must survive", aiLearningProgress: { completedScenes: ["earlier"], knowledgeLectureAttempts: [attempt] } });
    expect(row.runtimeConfig).toEqual({ version: 10, uiState: { controller: "teacher" } });
    expect(mocks.event.mock.calls[0][0].data).toMatchObject({ participationId: "participation", researchKey: "research", eventType: "KNOWLEDGE_QUIZ_SUBMITTED", payload: { attempt, courseVersion: 10, scope: "student", studentId: "student" } });
    expect(mocks.publish).toHaveBeenCalledWith("course", expect.objectContaining({ payload: expect.objectContaining({ courseVersion: 10, eventCursor: expect.any(String) }) }));
  });
  it("replays first answers without version changes, but rejects altered answers", async () => {
    await persistKnowledgeLectureAttempt(input); await persistKnowledgeLectureAttempt({ ...input, attempt: { ...attempt, submittedAt: "2026-09-26T01:00:00.000Z" } });
    expect(mocks.workspace).toHaveBeenCalledTimes(1);
    await expect(persistKnowledgeLectureAttempt({ ...input, attempt: { ...attempt, questions: [{ ...attempt.questions[0], rawAnswer: "Changed" }] } })).rejects.toMatchObject({ message: "QUIZ_ALREADY_SUBMITTED", attempt });
  });
  it("preserves more than forty previous attempts", async () => {
    const progress = row.projectState.aiLearningProgress as Record<string, unknown>;
    progress.knowledgeLectureAttempts = Array.from({ length: 45 }, (_, index) => ({ ...attempt, id: `old-${index}`, quizOutlineId: `old-quiz-${index}` }));
    await persistKnowledgeLectureAttempt(input);
    expect((row.projectState.aiLearningProgress as { knowledgeLectureAttempts: unknown[] }).knowledgeLectureAttempts).toHaveLength(46);
  });
  it("finishes accepted grading after closure and never overwrites original answer fields", async () => {
    await persistKnowledgeLectureAttempt(input); row.status = "FINISHED"; row.enrollmentStatus = "COMPLETED";
    const progress = row.projectState.aiLearningProgress as Record<string, unknown>; progress.completedScenes = ["earlier", "concurrent-progress"];
    const grades = new Map([["question", { ...attempt.questions[0], answer: "forged", prompt: "forged", points: 100, earned: 4, gradingStatus: "graded" as const, feedback: "correct reasoning" }]]);
    const saved = await persistKnowledgeLectureAttempt(input, grades);
    expect(saved).toMatchObject({ id: "attempt", score: 4, maxScore: 5, questions: [{ answer: "Original answer", rawAnswer: "Original answer", prompt: "Why?", points: 5, earned: 4 }] });
    expect(row.projectState).toMatchObject({ aiLearningProgress: { completedScenes: ["earlier", "concurrent-progress"] } });
    await persistKnowledgeLectureAttempt(input, new Map([["question", { ...grades.get("question")!, earned: 1 }]]));
    expect(mocks.event).toHaveBeenCalledTimes(2);
    await expect(persistKnowledgeLectureAttempt({ ...input, attempt: { ...attempt, id: "new", quizOutlineId: "new" } })).rejects.toMatchObject({ code: "CLASSROOM_READ_ONLY", status: 409 });
  });
  it("keeps failed grading retryable without changing submitted answers", async () => {
    await persistKnowledgeLectureAttempt(input);
    await persistKnowledgeLectureAttempt(input, new Map([["question", { ...attempt.questions[0], gradingStatus: "failed" }]]));
    expect(await persistKnowledgeLectureAttempt(input, new Map([["question", { ...attempt.questions[0], earned: 5, gradingStatus: "graded" }]]))).toMatchObject({ score: 5, gradingStatus: "graded" });
  });
  it("rejects changed classroom binding and never invents an attempt during grading", async () => {
    await expect(persistKnowledgeLectureAttempt(input, new Map())).rejects.toMatchObject({ code: "QUIZ_ATTEMPT_NOT_FOUND" });
    row.classroomId = "different";
    await expect(persistKnowledgeLectureAttempt(input)).rejects.toMatchObject({ code: "QUIZ_SCENE_CHANGED" });
    expect(mocks.workspace).not.toHaveBeenCalled();
  });
  it("rejects an incomplete SQL commit without publishing", async () => {
    mocks.query.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    await expect(persistKnowledgeLectureAttempt(input)).rejects.toThrow("QUIZ_COMMIT_INCOMPLETE");
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("does not emit acknowledgement notification if the durable event fails", async () => {
    mocks.event.mockRejectedValue(new Error("database failure"));
    await expect(persistKnowledgeLectureAttempt(input)).rejects.toThrow("database failure");
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
