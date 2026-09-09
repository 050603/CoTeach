import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateCourseEntryPackage, getCourse, updateCourse, authorizeTemplateRequest } = vi.hoisted(() => ({
  generateCourseEntryPackage: vi.fn(),
  authorizeTemplateRequest: vi.fn(),
  getCourse: vi.fn(),
  updateCourse: vi.fn(),
}));

vi.mock("@/lib/platform/template-access", () => ({ authorizeTemplateRequest }));

vi.mock("@/lib/course-entry-generation", () => ({
  generateCourseEntryPackage,
}));

vi.mock("@/lib/session/server-store", () => ({
  getCourse,
  updateCourse,
}));

import { POST } from "./route";

const knowledgePoint = {
  id: "kp-1",
  name: "图像分类",
  description: "理解图像分类",
  keyInfo: "输入图片并输出类别",
  level: "core",
  masteryBoundary: "能够解释输入与输出",
};

const plan = {
  enabled: true,
  status: "draft",
  updatedAt: "2026-08-12T00:00:00.000Z",
  timeBudgetMin: 6,
  thresholds: { enrichmentMasteryMin: 80 },
  prerequisiteKnowledgePoints: [{ id: "prereq-1", name: "数据集", description: "样本集合" }],
  pretest: { title: "课程入口", introduction: "诊断", estimatedMinutes: 1, questions: [{ id: "q-1" }] },
  branches: [{ id: "b-1", kind: "prerequisite" }],
};
const knowledgeGraph = {
  nodes: [{ id: "kp-1" }, { id: "prereq-1", instructionalRole: "prerequisite" }],
  edges: [{ id: "e-1", source: "prereq-1", target: "kp-1" }],
};

describe("POST /api/adaptive-learning/outline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeTemplateRequest.mockResolvedValue("teacher");
    getCourse.mockResolvedValue({
      id: "course-1",
      name: "计算机视觉",
      subject: "人工智能",
      grade: "高一",
      summary: "课程摘要",
      learningObjectives: [],
      learnerProfile: {},
      content: { knowledgePoints: [knowledgePoint], knowledgeGraph: { nodes: [], edges: [] }, _openmaicSceneOutlines: [] },
    });
    generateCourseEntryPackage.mockResolvedValue({
      plan,
      knowledgeGraph,
      warnings: [],
      reviewSummary: "审校通过",
      reviewFindings: [],
      revisionCount: 1,
    });
    updateCourse.mockImplementation(async (_courseId: string, updater: (course: Record<string, unknown>) => Record<string, unknown>) => {
      const course = await getCourse();
      return { courses: [updater(course)] };
    });
  });

  it("atomically persists the graph and pretest package before returning success", async () => {
    const response = await POST(new Request("http://localhost/api/adaptive-learning/outline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courseId: "course-1" }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(updateCourse).toHaveBeenCalledTimes(1);
    expect(payload.persisted).toBe(true);
    expect(payload.plan.pretest.questions).toHaveLength(1);
    expect(payload.knowledgeGraph.nodes).toHaveLength(2);
  });

  it("does not write an empty fallback when generation fails", async () => {
    generateCourseEntryPackage.mockRejectedValue(new Error("独立审校没有返回完整 finalBlueprint"));

    const response = await POST(new Request("http://localhost/api/adaptive-learning/outline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courseId: "course-1" }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(updateCourse).not.toHaveBeenCalled();
    expect(payload.error).toContain("独立审校没有返回完整 finalBlueprint");
  });
  it.each([403, 404, 409])("rejects inaccessible or non-template targets (%s) before paid generation", async status => {
    authorizeTemplateRequest.mockResolvedValue(Response.json({ error: "Template access denied" }, { status }));
    const response = await POST(new Request("http://localhost/api/adaptive-learning/outline", { method: "POST", body: JSON.stringify({ courseId: "foreign-or-instance" }) }));
    expect(response.status).toBe(status);
    expect(generateCourseEntryPackage).not.toHaveBeenCalled();
    expect(getCourse).not.toHaveBeenCalled();
    expect(updateCourse).not.toHaveBeenCalled();
  });
});
