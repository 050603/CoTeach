import { describe, expect, it, vi } from "vitest";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import type { Scene } from "@/lib/openmaic/types/stage";
import type { SceneOutline } from "@/lib/openmaic/types/generation";
import { collectCourseStructureIssues, reviewCourseSection, reviewSceneEvidence } from "./semantic-review";
import { selectReviewSource } from "./source-selection";
import { normalizeTeachingBrief } from "@/lib/openmaic/generation/teaching-brief";
import { emptyResourcePackageDraft, stagePlanFromResourcePackage } from "@/lib/resource-package/types";
import { packageDraftSignature } from "@/lib/resource-package/compatibility";

const outline: SceneOutline = { id: "outline", type: "slide", title: "边界条件", description: "依据样本条件解释结论", order: 0, keyPoints: ["独立测试数据才能用于检查泛化"], knowledgePointIds: ["kp"] };
const scene = { id: "scene", outlineId: "outline", stageId: "stage", type: "slide", title: "边界条件", order: 0, actions: [{ id: "speech", type: "speech", text: "不能使用训练样本代替独立测试" }],
  content: { type: "slide", canvas: { elements: [{ id: "text", type: "text", left: 80, top: 200, width: 800, height: 160, content: `<p>${"核心解释".repeat(30)}仅适用于独立测试</p>` }] } } } as unknown as Scene;

function confirmedCourse() {
  const course = createPblTemplateCourse("confirmed-course");
  const draft = { ...emptyResourcePackageDraft(), courseName: "样本评估", grade: "本科一年级", drivingQuestion: "如何验证模型在新样本上的表现？", learningObjectives: ["区分训练与评估"], expectedOutcome: "个人评估报告", lessonCount: 3, minutesPerLesson: 45, totalMinutes: 135,
    knowledgePoints: [{ id: "group", name: "模型评估", description: "评估基础", subPoints: [], children: [{ id: "kp", name: "独立测试", description: "使用独立数据评估" }] }],
    stages: emptyResourcePackageDraft().stages.map((stage, index) => ({ ...stage, durationMin: [15, 30, 60, 20, 10][index] })) };
  course.grade = draft.grade; course.drivingQuestion = draft.drivingQuestion; course.hours = 2.25;
  course.content.resourcePackage = { schemaVersion: 2, id: "pack", revision: 3, confirmedAt: "2026-09-12T00:00:00Z", source: { id: "zip", fileName: "course.zip", url: "/api/uploads/zip" }, documents: {}, draft };
  course.content.stagePlan = stagePlanFromResourcePackage(draft);
  course.content.knowledgePoints = [{ id: "kp", name: "独立测试", description: "独立数据" }];
  course.content._openmaicSceneOutlines = [{ ...outline }];
  return course;
}

describe("fast draft and section-wide teaching review", () => {
  it("reviews complete native text, narration and the shared teaching brief together", async () => {
    const course = createPblTemplateCourse("course");
    const page = { ...outline, teachingBrief: normalizeTeachingBrief(outline) };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ issues: [{ sceneId: "scene", elementId: "text", title: "需要核对条件", evidence: "仅适用于独立测试", suggestion: "结合教案说明测试数据来源。" }] }));
    const issues = await reviewCourseSection({ course, scenes: [scene], outlines: [page], sourceContext: "教师确认独立测试条件" }, ai);
    const input = JSON.parse(ai.mock.calls[0][1]);
    expect(input.scenes[0].content.elements[0].content).toContain("仅适用于独立测试");
    expect(input.scenes[0].actions[0].text).toContain("不能使用训练样本");
    expect(input.outlines[0].teachingBrief.explanation).toBe(outline.description);
    expect(issues[0]).toMatchObject({ origin: "semantic", severity: "suggestion", sceneId: "scene", elementId: "text" });
  });

  it("never promotes a model-authored review into a hard structure error or trusts foreign locations", async () => {
    const issues = await reviewCourseSection({ course: createPblTemplateCourse("course"), scenes: [scene], outlines: [outline], sourceContext: "" }, async () => JSON.stringify({ issues: [{ sceneId: "other", elementId: "secret", origin: "structure", severity: "error", title: "核对", evidence: "证据", suggestion: "检查" }] }));
    expect(issues[0]).toMatchObject({ origin: "semantic", severity: "suggestion" });
    expect(issues[0].sceneId).toBeUndefined();
    expect(issues[0].elementId).toBeUndefined();
  });

  it("reports incomplete model results rather than claiming the section passed", async () => {
    await expect(reviewCourseSection({ course: createPblTemplateCourse("course"), scenes: [scene], outlines: [outline], sourceContext: "" }, async () => "{}")).rejects.toThrow("有效问题报告");
  });

  it("selects relevant late source evidence and discloses omitted text instead of cutting at 60000", () => {
    const source = `教师确认的课程条件\n${"其他资料。".repeat(18000)}\n独立测试数据才能用于检查泛化：不得训练后回看训练数据代替评估。`;
    const selected = selectReviewSource(source, [outline]);
    expect(selected.partial).toBe(true);
    expect(selected.selectedChars).toBeLessThanOrEqual(60000);
    expect(selected.text).toContain("教师确认的课程条件");
    expect(selected.text).toContain("不得训练后回看训练数据代替评估");
    expect(selected.totalChars).toBe(source.length);
  });

  it("keeps graph questions advisory but an absent teaching page is a hard structural error", () => {
    const course = createPblTemplateCourse("course");
    course.content.knowledgePoints = [{ id: "kp", name: "测试", description: "作用" }];
    course.content._openmaicSceneOutlines = [{ ...outline }];
    expect(collectCourseStructureIssues(course, []).some((issue) => issue.origin === "structure" && issue.severity === "error")).toBe(true);
    expect(collectCourseStructureIssues(course, [scene]).filter((issue) => issue.origin === "semantic").every((issue) => issue.severity === "suggestion")).toBe(true);
    expect(reviewSceneEvidence({ ...scene, actions: undefined })).toBeTruthy();
  });

  it("blocks changed confirmed audience, driving question and whole-course or stage minutes only for schema 2", () => {
    const course = confirmedCourse();
    expect(collectCourseStructureIssues(course, [scene]).filter((issue) => issue.origin === "structure")).toEqual([]);
    course.grade = "小学"; course.drivingQuestion = "改写后的问题"; course.hours = 0.5;
    course.content.stagePlan!.stages[1].durationMin = 20;
    const titles = collectCourseStructureIssues(course, [scene]).filter((issue) => issue.origin === "structure").map((issue) => issue.title);
    expect(titles).toEqual(expect.arrayContaining(["教学对象与教师确认内容不一致", "驱动问题与教师确认内容不一致", "整课时长与教师确认分钟数不一致", "知识讲授时间与教师确认计划不一致"]));
    course.content.resourcePackage!.schemaVersion = 1;
    expect(collectCourseStructureIssues(course, [scene]).filter((issue) => issue.origin === "structure")).toEqual([]);
  });

  it("requires actual confirmation and adaptation authorization bound to the confirmed source", () => {
    const course = confirmedCourse();
    const pack = course.content.resourcePackage!;
    pack.confirmedAt = undefined;
    pack.conflicts = [{ id: "organization", kind: "organization", summary: "原包要求真人组队", reason: "个人AI课堂", suggestion: "适配", evidence: [] }];
    pack.conflictVersion = "conflict-v1";
    expect(collectCourseStructureIssues(course, [scene]).map((issue) => issue.title)).toEqual(expect.arrayContaining(["资源包尚未由教师确认", "资源包组织或评价冲突尚未获有效适配授权"]));
    pack.confirmedAt = "2026-09-12T00:00:00Z";
    pack.adaptation = { sourceRevision: 1, conflictVersion: "conflict-v1", authorizedBy: "teacher", authorizedAt: "2026-09-11T00:00:00Z", draftSignature: packageDraftSignature(pack.draft), changes: ["个人AI伙伴"] };
    expect(collectCourseStructureIssues(course, [scene]).filter((issue) => issue.origin === "structure")).toEqual([]);
    pack.draft.expectedOutcome = "授权后被替换的要求";
    expect(collectCourseStructureIssues(course, [scene]).some((issue) => issue.title.includes("未获有效适配授权"))).toBe(true);
  });

  it("checks required source knowledge even when the generated catalog deleted or renamed an id", () => {
    const course = confirmedCourse();
    course.content.knowledgePoints = [];
    expect(collectCourseStructureIssues(course, [scene]).some((issue) => issue.title === "教师确认的必需知识未进入课程" && issue.evidence.includes("kp"))).toBe(true);
    course.content.knowledgePoints = [{ id: "mapped-kp", sourceId: "kp", name: "独立测试", description: "独立数据" }];
    course.content._openmaicSceneOutlines![0].knowledgePointIds = ["mapped-kp"];
    expect(collectCourseStructureIssues(course, [scene]).filter((issue) => issue.origin === "structure")).toEqual([]);
    course.content._openmaicSceneOutlines![0].type = "quiz";
    expect(collectCourseStructureIssues(course, [scene]).some((issue) => issue.title === "教师确认的必需知识缺少讲授页面")).toBe(true);
  });

  it("audits the actual custom canvas size and ratio rather than assuming 1000 by 562.5", () => {
    const course = confirmedCourse();
    const custom = structuredClone(scene);
    if (custom.content.type !== "slide") throw new Error("fixture must be a slide");
    custom.content.canvas.viewportSize = 1280; custom.content.canvas.viewportRatio = 0.625;
    custom.content.canvas.elements[0].left = 1100; custom.content.canvas.elements[0].top = 630; custom.content.canvas.elements[0].width = 160;
    if (custom.content.canvas.elements[0].type === "text") custom.content.canvas.elements[0].content = "<p>边界内文字</p>";
    expect(collectCourseStructureIssues(course, [custom]).filter((issue) => issue.origin === "structure")).toEqual([]);
    custom.content.canvas.elements[0].left = 1250;
    expect(collectCourseStructureIssues(course, [custom]).some((issue) => issue.evidence.includes("outside the slide canvas"))).toBe(true);
  });

  it("blocks concrete overlap and unreadable type while keeping subjective composition advisory", () => {
    const course = confirmedCourse();
    const draft = structuredClone(scene);
    if (draft.content.type !== "slide") throw new Error("fixture must be a slide");
    const text = draft.content.canvas.elements[0];
    if (text.type !== "text") throw new Error("fixture must contain text");
    draft.content.canvas.elements.push({ ...text, id: "overlap", top: 210, content: '<p style="font-size:14px">与核心说明重叠的注释</p>' });
    const issues = collectCourseStructureIssues(course, [draft]);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: "structure", severity: "error", sceneId: scene.id, evidence: expect.stringContaining("overlap substantially") }),
      expect.objectContaining({ origin: "structure", severity: "error", evidence: expect.stringContaining("too small") }),
    ]));
  });
});
