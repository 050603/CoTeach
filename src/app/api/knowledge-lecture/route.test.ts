import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Course, KnowledgeLectureAttempt } from "@/lib/session/types";
import type { PersistedClassroomData } from "@openmaic/lib/server/classroom-storage";
import { callLLM } from "@openmaic/lib/ai/llm";
import { getKnowledgeLectureTutorSettings } from "@/lib/knowledge-lecture-settings";
import { resolveModelFromRequest } from "@openmaic/lib/server/resolve-model";

const store = vi.hoisted(() => ({
  course: null as Course | null,
  classroom: null as PersistedClassroomData | null,
  authConfigured: false,
  claims: null as { role: string; sub: string } | null,
}));
vi.mock("@/lib/auth/request-guards", () => ({ requireSameOrigin: () => null }));
vi.mock("@/lib/auth/session", () => ({
  isAuthConfigured: () => store.authConfigured,
  readAuthFromRequest: vi.fn(async () => store.claims),
}));
vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: () => true }));
vi.mock("@/lib/session/server-store", () => ({
  getCourse: vi.fn(async () => store.course),
  updateCourse: vi.fn(async (_courseId: string, updater: (course: Course) => Course) => {
    store.course = updater(store.course!);
    return { courses: [store.course] };
  }),
}));
vi.mock("@openmaic/lib/server/classroom-storage", () => ({ readClassroom: vi.fn(async () => store.classroom) }));
vi.mock("@/lib/knowledge-lecture-settings", () => ({ getKnowledgeLectureTutorSettings: vi.fn() }));
vi.mock("@openmaic/lib/ai/llm", () => ({ callLLM: vi.fn() }));
vi.mock("@openmaic/lib/server/resolve-model", () => ({ resolveModel: vi.fn(), resolveModelFromRequest: vi.fn() }));
import { POST } from "./route";

function request(answers: Record<string, string | string[]>, extra: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/knowledge-lecture", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ action: "record-attempt", courseId: "course-1", studentId: "student-1",
      sectionId: "section-1", quizOutlineId: "quiz-1", runtimeSceneId: "runtime-quiz-1", answers, ...extra }),
  });
}
const attempts = () => store.course?.aiLearningProgress?.["student-1"]?.knowledgeLectureAttempts ?? [];

describe("knowledge lecture server-authoritative grading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.authConfigured = false;
    store.claims = null;
    vi.mocked(resolveModelFromRequest).mockResolvedValue({ model: {}, thinkingConfig: undefined } as never);
    vi.mocked(getKnowledgeLectureTutorSettings).mockResolvedValue({ modelString: "" } as never);
    vi.mocked(callLLM).mockResolvedValue({ text: '{"score":5,"comment":"理解了核心概念"}' } as never);
    store.course = {
      id: "course-1", students: [{ id: "student-1" }], aiLearningClassroomId: "classroom-1",
      content: { knowledgePoints: [{ id: "kp-1", name: "变量关系" }],
        knowledgeLectureSections: [{ id: "section-1", quizOutlineId: "quiz-1", knowledgePointIds: ["kp-1"] }],
        teachingBlueprint: { sections: [{ id: "section-1", units: [{ id: "unit-1" }] }] } },
      aiLearningProgress: {},
    } as Course;
    store.classroom = {
      id: "classroom-1", stage: { id: "classroom-1" }, createdAt: "2026-01-01T00:00:00.000Z",
      scenes: [{ id: "runtime-quiz-1", outlineId: "quiz-1", lectureSectionId: "section-1",
        content: { type: "quiz", questions: [
          { id: "choice-1", type: "single", question: "选哪个？", answer: ["A"], points: 4,
            options: [{ value: "A", label: "变量增加" }, { value: "B", label: "变量减少" }],
            knowledgePointIds: ["kp-1"], teachingUnitIds: ["unit-1", "foreign-unit"] },
          { id: "short-1", type: "short_answer", question: "解释原因", points: 6,
            commentPrompt: "说明变量关系", knowledgePointIds: ["kp-1"] },
        ] } }],
    } as PersistedClassroomData;
  });

  it("ignores forged browser scores and uses the linked scene's question/rubric", async () => {
    const response = await POST(request({ "choice-1": "B", "short-1": "原因" }, {
      questions: [{ questionId: "choice-1", prompt: "伪造题", points: 100, earned: 100, correct: true }],
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ attempt: {
      gradingSource: "server", gradingStatus: "graded", score: 5, maxScore: 10,
      questions: [{ questionId: "choice-1", prompt: "选哪个？", points: 4, earned: 0, correct: false,
        teachingUnitIds: ["unit-1"] }, { questionId: "short-1", points: 6, earned: 5, correct: null }],
    } });
    expect(vi.mocked(callLLM).mock.calls[0]?.[0].prompt).toContain("评分要点：说明变量关系");
  });

  it("rejects altered repeat answers without replacing the first submission", async () => {
    await POST(request({ "choice-1": "A", "short-1": "首次答案" }));
    const response = await POST(request({ "choice-1": "B", "short-1": "第二次答案" }));
    expect(response.status).toBe(409);
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0]?.questions[1]?.answer).toBe("首次答案");
  });

  it("retains a failed answer without invented marks, then retries idempotently", async () => {
    vi.mocked(callLLM).mockResolvedValueOnce({ text: "invalid" } as never);
    const first = await POST(request({ "choice-1": "A", "short-1": "作答" }));
    await expect(first.json()).resolves.toMatchObject({ attempt: { gradingStatus: "failed", score: 4,
      maxScore: 4, questions: [{ gradingStatus: "graded" }, { gradingStatus: "failed", earned: 0 }] } });
    vi.mocked(callLLM).mockResolvedValueOnce({ text: '{"score":3,"comment":"可补充依据"}' } as never);
    const retry = await POST(request({ "choice-1": "A", "short-1": "作答" }));
    await expect(retry.json()).resolves.toMatchObject({ attempt: { gradingStatus: "graded", score: 7, maxScore: 10 } });
    expect(attempts()).toHaveLength(1);
  });

  it("retries the stored server answer even if the classroom scene later changes", async () => {
    vi.mocked(callLLM).mockResolvedValueOnce({ text: "invalid" } as never);
    await POST(request({ "choice-1": "A", "short-1": "保存的答案" }));
    store.classroom = null;
    vi.mocked(callLLM).mockResolvedValueOnce({ text: '{"score":4,"comment":"已补评"}' } as never);
    const response = await POST(request({}, { action: "retry-grading", runtimeSceneId: "changed-scene" }));
    await expect(response.json()).resolves.toMatchObject({ attempt: {
      gradingStatus: "graded", score: 8, questions: [{}, { answer: "保存的答案", correct: null }],
    } });
    expect(attempts()).toHaveLength(1);
  });

  it("coalesces concurrent grading without duplicate attempts", async () => {
    let release!: () => void;
    vi.mocked(callLLM).mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ text: '{"score":2,"comment":"部分正确"}' } as never);
    }));
    const first = POST(request({ "choice-1": "A", "short-1": "并发答案" }));
    const second = POST(request({ "choice-1": "A", "short-1": "并发答案" }));
    await vi.waitFor(() => expect(vi.mocked(callLLM)).toHaveBeenCalledTimes(1));
    release();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0]?.score).toBe(6);
  });

  it("retains more than forty earlier quiz records", async () => {
    await POST(request({ "choice-1": "A", "short-1": "第一次" }));
    const first = attempts()[0]!;
    store.course!.aiLearningProgress!["student-1"].knowledgeLectureAttempts = Array.from({ length: 45 }, (_, index) => ({
      ...first, id: `old-${index}`, quizOutlineId: `old-quiz-${index}`,
    }));
    expect((await POST(request({ "choice-1": "A", "short-1": "新一轮" }))).status).toBe(200);
    expect(attempts()).toHaveLength(46);
  });

  it("rejects a scene outside the course-linked quiz", async () => {
    expect((await POST(request({ "choice-1": "A", "short-1": "作答" }, { runtimeSceneId: "foreign-scene" }))).status).toBe(404);
    expect(attempts()).toHaveLength(0);
  });

  it("requires the submitting student's identity even when a teacher can read the course", async () => {
    store.authConfigured = true;
    store.claims = { role: "teacher", sub: "teacher-1" };
    expect((await POST(request({ "choice-1": "A", "short-1": "作答" }))).status).toBe(403);
    store.claims = { role: "student", sub: "another-student" };
    expect((await POST(request({ "choice-1": "A", "short-1": "作答" }))).status).toBe(403);
    expect(attempts()).toHaveLength(0);
  });

  it("keeps source choices for tutoring", async () => {
    const response = await POST(request({ "choice-1": "B", "short-1": "因为" }));
    const payload = await response.json() as { attempt: KnowledgeLectureAttempt };
    vi.mocked(callLLM).mockResolvedValue({ text: '{"answer":"请对照选项判断","boardNotes":[]}' } as never);
    const tutorResponse = await POST(new NextRequest("http://localhost/api/knowledge-lecture", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ action: "tutor-explain", courseId: "course-1", studentId: "student-1",
        attemptId: payload.attempt.id, questionId: "choice-1" }),
    }));
    expect(tutorResponse.status).toBe(200);
    expect(vi.mocked(callLLM).mock.calls.at(-1)?.[0].prompt).toContain("选项：\nA. 变量增加\nB. 变量减少");
  });
});
