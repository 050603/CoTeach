// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";

const mocks = vi.hoisted(() => ({
  getCourse: vi.fn(),
  canAccessLegacyCourse: vi.fn(),
  updateCourse: vi.fn(),
  buildReflectionClassSummary: vi.fn(),
  checkDistributedRateLimit: vi.fn(),
}));

vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.canAccessLegacyCourse }));
vi.mock("@/lib/auth/request-guards", () => ({
  authenticateRequest: vi.fn(async () => ({ claims: { sub: "teacher-1", role: "teacher" as const } })),
  requireSameOrigin: vi.fn(() => null),
}));
vi.mock("@/lib/auth/distributed-rate-limit", () => ({ checkDistributedRateLimit: mocks.checkDistributedRateLimit }));
vi.mock("@/lib/session/server-store", () => ({
  getCourse: mocks.getCourse,
  updateCourse: mocks.updateCourse,
}));
vi.mock("@/lib/teaching-ai/support-engine", () => ({ buildReflectionClassSummary: mocks.buildReflectionClassSummary }));

import { POST } from "./route";

const courseId = "course-1";
const context = { params: Promise.resolve({ courseId }) };

function makeCourse(submittedCount = 3): Course {
  const now = "2026-09-05T00:00:00.000Z";
  return {
    id: courseId,
    name: "校园减塑",
    subject: "科学",
    grade: "六年级",
    hours: 5,
    summary: "",
    drivingQuestion: "如何改善校园环境？",
    status: "teaching",
    stages: [],
    currentStageIndex: 4,
    students: Array.from({ length: 5 }, (_, index) => ({ id: `student-${index + 1}`, name: `学生${index + 1}`, joinedAt: now, stageProgress: {} })),
    reflections: Array.from({ length: submittedCount }, (_, index) => ({
      id: `reflection-${index + 1}`,
      courseId,
      studentId: `student-${index + 1}`,
      studentName: `学生${index + 1}`,
      content: "",
      survey: { schemaVersion: 1 as const, learningReflection: "收获", systemReflection: "体验", aiHelpfulness: 4 as const, systemUsability: 4 as const, reuseIntention: 4 as const },
      createdAt: now,
      updatedAt: now,
    })),
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
    createdAt: now,
    updatedAt: now,
  };
}

function request(body: unknown) {
  return new Request(`http://localhost:3000/api/courses/${courseId}/reflections/summary`, {
    method: "POST",
    headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("reflection summary route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canAccessLegacyCourse.mockResolvedValue(true);
    mocks.checkDistributedRateLimit.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
    mocks.getCourse.mockResolvedValue(makeCourse());
    mocks.updateCourse.mockResolvedValue({});
    mocks.buildReflectionClassSummary.mockResolvedValue({
      stageKey: "reflection",
      targetType: "course",
      targetId: courseId,
      kind: "reflection-class-summary",
      trigger: "AI 课程总结（manual）",
      inputSummary: "反思",
      diagnosis: "课程总结",
      suggestions: ["建议一", "建议二"],
      evidence: ["反思记录 reflection-1"],
      status: "draft",
      source: "llm",
      structuredPayload: { schemaVersion: 1 },
    });
  });

  it("authenticates, rate-limits and persists one course-level summary", async () => {
    const response = await POST(request({ trigger: "manual" }), context);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.checkDistributedRateLimit).toHaveBeenCalledWith(expect.objectContaining({ namespace: "reflection-summary", limit: 12, windowSeconds: 3600 }));
    expect(mocks.buildReflectionClassSummary).toHaveBeenCalledWith(expect.objectContaining({ course: expect.any(Object), trigger: "manual" }));
    expect(mocks.updateCourse).toHaveBeenCalledWith(courseId, expect.any(Function), { actor: { id: "teacher-1", role: "teacher" } });
    expect(payload.support).toMatchObject({ kind: "reflection-class-summary", courseId });
  });

  it("returns a sample gate before calling the model", async () => {
    mocks.getCourse.mockResolvedValue(makeCourse(2));
    const response = await POST(request({ trigger: "threshold" }), context);
    const payload = await response.json();
    expect(response.status).toBe(409);
    expect(payload.code).toBe("INSUFFICIENT_REFLECTIONS");
    expect(mocks.buildReflectionClassSummary).not.toHaveBeenCalled();
  });

  it("preserves the previous summary when generation fails", async () => {
    mocks.buildReflectionClassSummary.mockRejectedValueOnce(new Error("provider unavailable"));
    const response = await POST(request({ trigger: "manual" }), context);
    expect(response.status).toBe(502);
    expect(mocks.updateCourse).not.toHaveBeenCalled();
    expect((await response.json()).message).toContain("上一版内容仍然保留");
  });
  it("rejects another teacher before reading reflections or calling the model", async () => {
    mocks.canAccessLegacyCourse.mockResolvedValue(false);
    expect((await POST(request({}), context)).status).toBe(403);
    expect(mocks.getCourse).not.toHaveBeenCalled();
    expect(mocks.buildReflectionClassSummary).not.toHaveBeenCalled();
  });
});
