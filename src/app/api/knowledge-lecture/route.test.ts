import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Course } from "@/lib/session/types";
import { callLLM } from "@openmaic/lib/ai/llm";
import { getKnowledgeLectureTutorSettings } from "@/lib/knowledge-lecture-settings";
import { resolveModelFromRequest } from "@openmaic/lib/server/resolve-model";

const store = vi.hoisted(() => ({ course: null as Course | null }));

vi.mock("@/lib/auth/request-guards", () => ({ requireSameOrigin: () => null }));
vi.mock("@/lib/auth/session", () => ({ isAuthConfigured: () => false, readAuthFromRequest: vi.fn() }));
vi.mock("@/lib/session/server-store", () => ({
  getCourse: vi.fn(async () => store.course),
  updateCourse: vi.fn(async (_courseId: string, updater: (course: Course) => Course) => {
    store.course = updater(store.course!);
    return { courses: [store.course] };
  }),
}));
vi.mock("@/lib/knowledge-lecture-settings", () => ({ getKnowledgeLectureTutorSettings: vi.fn() }));
vi.mock("@openmaic/lib/ai/llm", () => ({ callLLM: vi.fn() }));
vi.mock("@openmaic/lib/server/resolve-model", () => ({ resolveModel: vi.fn(), resolveModelFromRequest: vi.fn() }));

import { POST } from "./route";

function request(answer: string, questionCount = 2) {
  return new NextRequest("http://localhost/api/knowledge-lecture", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({
      action: "record-attempt",
      courseId: "course-1",
      studentId: "student-1",
      sectionId: "section-1",
      quizOutlineId: "quiz-1",
      runtimeSceneId: "runtime-quiz-1",
      questions: Array.from({ length: questionCount }, (_, index) => index + 1).map((number) => ({
        questionId: `question-${number}`,
        prompt: `题目${number}`,
        options: number === 1 ? [{ value: "A", label: "变量增加" }, { value: "B", label: "变量减少" }] : undefined,
        answer,
        points: 10,
        earned: 4,
        correct: false,
        feedback: "概念理解有误",
        knowledgePointIds: ["kp-1"],
        teachingUnitIds: ["unit-1", "foreign-unit"],
      })),
    }),
  });
}

describe("knowledge lecture single-attempt integrity", () => {
  beforeEach(() => {
    store.course = {
      id: "course-1",
      students: [{ id: "student-1" }],
      content: {
        knowledgePoints: [{ id: "kp-1", name: "变量关系" }],
        knowledgeLectureSections: [{ id: "section-1", quizOutlineId: "quiz-1", knowledgePointIds: ["kp-1"] }],
        teachingBlueprint: {
          sections: [{ id: "section-1", units: [{ id: "unit-1" }] }],
        },
      },
      aiLearningProgress: {},
    } as Course;
  });

  it("stores the first submission and rejects every later submission for the same section quiz", async () => {
    const first = await POST(request("首次答案"));
    expect(first.status).toBe(200);

    const duplicate = await POST(request("第二次答案"));
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      error: "QUIZ_ALREADY_SUBMITTED",
      attempt: { questions: [{ answer: "首次答案" }, { answer: "首次答案" }] },
    });
    expect(store.course?.aiLearningProgress?.["student-1"].knowledgeLectureAttempts).toHaveLength(1);
  });

  it("accepts a one-question section check and preserves only approved teaching-unit evidence", async () => {
    const response = await POST(request("关键词答案", 1));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      attempt: { questions: [{ teachingUnitIds: ["unit-1"] }] },
    });
  });

  it("keeps question choices for the tutor board and includes them in the tutor prompt", async () => {
    const response = await POST(request("B", 1));
    expect(response.status).toBe(200);
    const payload = await response.json() as { attempt: { id: string; questions: Array<{ options: unknown }> } };
    expect(payload.attempt.questions[0]?.options).toEqual([
      { value: "A", label: "变量增加" },
      { value: "B", label: "变量减少" },
    ]);

    vi.mocked(getKnowledgeLectureTutorSettings).mockResolvedValue({ modelString: "" } as never);
    vi.mocked(resolveModelFromRequest).mockResolvedValue({ model: {} } as never);
    vi.mocked(callLLM).mockResolvedValue({ text: '{"answer":"请对照选项判断","boardNotes":[]}' } as never);
    const tutorResponse = await POST(new NextRequest("http://localhost/api/knowledge-lecture", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        action: "tutor-explain",
        courseId: "course-1",
        studentId: "student-1",
        attemptId: payload.attempt.id,
        questionId: "question-1",
      }),
    }));
    expect(tutorResponse.status).toBe(200);
    expect(vi.mocked(callLLM).mock.calls.at(-1)?.[0].prompt).toContain("选项：\nA. 变量增加\nB. 变量减少");
  });
});
