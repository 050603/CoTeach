import { afterEach, describe, expect, it, vi } from "vitest";
import { COURSE_COVER_GENERATION_SPEC, buildCourseCoverPrompt, requestCourseCoverImage } from "./course-cover";

afterEach(() => vi.unstubAllGlobals());

describe("course cover image request boundary", () => {
  it("sends only the planned scene, not the curriculum or planner explanation", () => {
    const plan = {
      topicSummary: "人工智能教育教学理论与方法：建构主义与项目式教学",
      visualAnchor: "师范生通过分类活动理解学习反馈，而非泛化的科技场景",
      sceneDescription: "An East Asian trainee teacher sorts illustrated sample cards beside a compact learning model, moving one misclassified card into its matching cluster. The continuous tabletop scene has a calm background.",
    };
    const prompt = buildCourseCoverPrompt(plan);
    expect(prompt).toContain(plan.sceneDescription);
    expect(prompt).not.toContain(plan.topicSummary);
    expect(prompt).not.toContain(plan.visualAnchor);
    expect(prompt).not.toMatch(/课程名称|课堂封面任务|例如|根系|桥梁|topicSummary|sceneDescription/);
    expect(prompt).toContain("Absolutely no text");
    expect(prompt).toContain("gouache");
    expect(prompt).toContain("edge-to-edge artwork");
    expect(COURSE_COVER_GENERATION_SPEC).toMatchObject({ aspectRatio: "16:9", promptExtend: false });
    expect(COURSE_COVER_GENERATION_SPEC.negativePrompt.length).toBeLessThanOrEqual(500);
  });

  it("keeps the final image request within the provider prompt limit", () => {
    expect(buildCourseCoverPrompt({
      topicSummary: "不发送给图片模型".repeat(50),
      visualAnchor: "不发送给图片模型".repeat(50),
      sceneDescription: "a".repeat(1500),
    }).length).toBeLessThanOrEqual(2400);
  });

  it("uses the authenticated pipeline instead of sending a client image prompt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      coverImageUrl: "/api/openmaic/classroom-media/template-cover-course-1/media/cover.webp",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestCourseCoverImage({ id: "course-1", name: "人工智能教育" }))
      .resolves.toContain("template-cover-course-1");
    expect(fetchMock).toHaveBeenCalledWith("/api/courses/course-1/cover", {
      method: "POST", signal: undefined,
    });
  });
});
