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
    expect(ai.mock.calls[0][0]).toContain("不是要求在课堂中逐字复现的最终目录");
  });

  it("sends each section only its mapped course nodes and textbook evidence", async () => {
    const course = createPblTemplateCourse("course");
    course.content.knowledgePoints = [
      { id: "target-a", name: "教材概念 A", description: "教材解释 A", sourceKnowledgePointIds: ["source-a"], evidenceItemIds: ["evidence-a"] },
      { id: "target-b", name: "教材概念 B", description: "教材解释 B", sourceKnowledgePointIds: ["source-b"], evidenceItemIds: ["evidence-b"] },
    ];
    course.content.knowledgeGraph = {
      nodes: course.content.knowledgePoints.map((point) => ({ id: point.id, label: point.name, description: point.description, level: "core", instructionalRole: "lesson" })),
      edges: [],
    };
    course.content.knowledgeScopePlan = {
      schemaVersion: 1, planningDurationMin: 30, durationRangeMin: 30, durationRangeMax: 30,
      durationSource: "resource-package", assessmentReserveMin: 4, explanationAndActivityMin: 26,
      sourcePointCount: 2, targetPointCount: 2, rationale: "教材映射",
      decisions: ["a", "b"].map((id) => ({
        sourceKnowledgePointId: `source-${id}`, sourceKnowledgePointName: `来源 ${id}`,
        disposition: "mapped" as const, targetKnowledgePointId: `target-${id}`,
        targetKnowledgePointIds: [`target-${id}`], rationale: "教材化改写",
      })),
    };
    course.content.courseEvidence = {
      schemaVersion: 1, version: 1, fingerprint: "evidence-fingerprint", createdAt: new Date(0).toISOString(), retrievalMode: "hybrid",
      selections: [], warnings: [],
      mappings: ["a", "b"].map((id) => ({ sourceKnowledgePointId: `source-${id}`, sourceKnowledgePointName: `来源 ${id}`, status: "direct" as const, evidenceItemIds: [`evidence-${id}`], rationale: "教材支持" })),
      items: ["a", "b"].map((id) => ({ id: `evidence-${id}`, kind: "concept" as const, title: `证据 ${id}`, content: `教材内容 ${id}`, source: { textbookId: "book", textbookTitle: "教材", revisionId: "revision", revisionVersion: 1, sectionPath: [] } })),
    };
    const sectionOutline = { ...outline, lectureSectionId: "section-a", knowledgePointIds: ["target-a"] };
    const ai = vi.fn().mockResolvedValue('{"issues":[]}');
    await reviewCourseSection({ course, scenes: [scene], outlines: [sectionOutline], sourceContext: "", includeKnowledgeGraph: true }, ai);
    const payload = JSON.parse(ai.mock.calls[0][1]);
    expect(payload.knowledgePoints.map((point: { id: string }) => point.id)).toEqual(["target-a"]);
    expect(payload.knowledgeScopePlan.decisions.map((decision: { sourceKnowledgePointId: string }) => decision.sourceKnowledgePointId)).toEqual(["source-a"]);
    expect(payload.courseEvidence.mappings.map((mapping: { sourceKnowledgePointId: string }) => mapping.sourceKnowledgePointId)).toEqual(["source-a"]);
    expect(payload.courseEvidence.items.map((item: { id: string }) => item.id)).toEqual(["evidence-a"]);
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

  it("blocks authoring status labels in student artifacts without banning normal subject vocabulary", () => {
    const course = confirmedCourse();
    const leaked = structuredClone(scene);
    if (leaked.content.type !== "slide" || leaked.content.canvas.elements[0]?.type !== "text") throw new Error("fixture must be a slide");
    leaked.content.canvas.elements[0].content = "<p>证据状态：PARTIAL</p>";
    expect(collectCourseStructureIssues(course, [leaked]).some((issue) => issue.title === "教师侧管理字段进入学生内容")).toBe(true);
    leaked.content.canvas.elements[0].content = "<p><strong>PARTIAL</strong></p>";
    expect(collectCourseStructureIssues(course, [leaked]).some((issue) => issue.title === "教师侧管理字段进入学生内容")).toBe(true);
    leaked.content.canvas.elements[0].content = "<p>偏导数的英文是 partial derivative；本节还会讨论证据状态随实验条件变化的科学含义。</p>";
    expect(collectCourseStructureIssues(course, [leaked]).some((issue) => issue.title === "教师侧管理字段进入学生内容")).toBe(false);
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

  it("reviews textbook-shaped course nodes instead of requiring upstream ids or wording verbatim", () => {
    const course = confirmedCourse();
    course.content.knowledgePoints = [];
    expect(collectCourseStructureIssues(course, [scene]).some((issue) => issue.title === "教师确认的必需知识未进入课程")).toBe(false);
    course.content.knowledgePoints = [{
      id: "textbook-evaluation-boundary",
      sourceKnowledgePointIds: ["kp"],
      name: "训练信息与评估信息的边界",
      description: "依据教材区分参与模型选择的信息与独立检验信息。",
    }];
    course.content.knowledgeScopePlan = {
      schemaVersion: 1,
      policyVersion: "textbook-evidence-mapping-v2",
      planningDurationMin: 30,
      durationRangeMin: 30,
      durationRangeMax: 30,
      durationSource: "resource-package",
      assessmentReserveMin: 4,
      explanationAndActivityMin: 26,
      sourcePointCount: 1,
      targetPointCount: 1,
      rationale: "按教材概念体系重新组织。",
      decisions: [{
        sourceKnowledgePointId: "kp",
        sourceKnowledgePointName: "独立测试",
        disposition: "mapped",
        targetKnowledgePointId: "textbook-evaluation-boundary",
        targetKnowledgePointIds: ["textbook-evaluation-boundary"],
        rationale: "教材采用信息边界解释原有要求。",
      }],
    };
    course.content._openmaicSceneOutlines![0].knowledgePointIds = ["textbook-evaluation-boundary"];
    expect(collectCourseStructureIssues(course, [scene]).filter((issue) => issue.origin === "structure")).toEqual([]);
    course.content._openmaicSceneOutlines![0].type = "quiz";
    expect(collectCourseStructureIssues(course, [scene]).some((issue) => issue.title === "课程体系知识节点缺少讲授页面")).toBe(true);
  });

  it("reports only a genuinely unmapped upstream responsibility, without requiring its original wording", () => {
    const course = confirmedCourse();
    course.content.knowledgePoints = [{ id: "textbook-target", name: "教材化概念", description: "采用教材表述" }];
    course.content._openmaicSceneOutlines![0].knowledgePointIds = ["textbook-target"];
    course.content.knowledgeScopePlan = {
      schemaVersion: 1, policyVersion: "textbook-evidence-mapping-v2",
      planningDurationMin: 30, durationRangeMin: 30, durationRangeMax: 30,
      durationSource: "resource-package", assessmentReserveMin: 4, explanationAndActivityMin: 26,
      sourcePointCount: 1, targetPointCount: 1, rationale: "按教材体系组织",
      decisions: [{
        sourceKnowledgePointId: "source-original", sourceKnowledgePointName: "教师原始知识点",
        disposition: "mapped", targetKnowledgePointId: "missing-target", targetKnowledgePointIds: ["missing-target"], rationale: "待补映射",
      }],
    };
    const issues = collectCourseStructureIssues(course, [scene]);
    expect(issues.filter((issue) => issue.title === "上游教学要求缺少课程映射")).toHaveLength(1);
    expect(issues.some((issue) => issue.title === "教师确认的必需知识未进入课程")).toBe(false);
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

  it("keeps criteria and required media blockers without requiring visible wording verbatim", () => {
    const course = confirmedCourse();
    const savedOutline = course.content._openmaicSceneOutlines![0]!;
    savedOutline.teachingBrief = {
      schemaVersion: 1,
      designVersion: "shared-page-contract-v11-dynamic-progression",
      explanation: "独立测试数据不参与学习，因此能检查模型面对新数据的表现。",
      examples: [], conditions: [], evidence: [], assessmentFocus: "解释独立性及理由",
      teachingPlan: {
        purpose: "解释独立测试",
        priorKnowledge: "知道训练用于学习",
        newContent: "测试数据不参与模型学习，并在模型确定后检查新数据表现。",
        learnerQuestion: "为什么不能反复据此调参",
        reasoningSteps: ["测试结果一旦用于调参，测试信息就进入了开发过程。"],
        takeaway: "独立性来自测试信息不参与学习与选择",
        visibleContent: ["测试数据不参与模型学习"],
        narrationFocus: ["说明信息回流为何破坏独立性"],
      },
      understandingCriteria: {
        goals: ["解释独立测试解决的问题"],
        answerEssentials: ["指出测试信息不参与学习并说明理由"],
        misconceptions: ["把更难的数据当成测试集定义"],
        supportingUnitIds: ["unit-1"],
      },
      resourceNeeds: [{ kind: "image", purpose: "展示训练信息与测试信息分离", required: true }],
    };
    const teachingBlueprint: NonNullable<typeof course.content.teachingBlueprint> = {
      schemaVersion: 2, inputFingerprint: "input", assessmentMode: "adaptive", createdAt: "2026-09-12T00:00:00Z",
      budget: { totalDurationSec: 300, teachingDurationSec: 240, learnerActivityDurationSec: 0, assessmentDurationSec: 60, teachingRatio: 0.8, assessmentRatio: 0.2 },
      sections: [{
        id: "section-1", title: "独立测试", order: 0, learningObjective: "解释独立测试", knowledgePointIds: ["kp"],
        sharedContext: { learningPurpose: "判断评估是否可信", caseId: "", caseFacts: [], fixedWording: [], stableTerms: ["独立测试"], conceptBoundaries: ["难度不是定义"] },
        units: [{ id: "unit-1", title: "独立性", knowledgePointIds: ["kp"], learningOutcome: "解释独立性", explanation: "测试不参与学习。", mechanism: "信息回流会破坏独立性。", workedExample: "", conditions: [], misconceptions: ["难度不是定义"], sourceKind: "general-knowledge", evidenceQuotes: [] }],
        pages: [{ id: savedOutline.id, outlineId: savedOutline.id, title: savedOutline.title, type: "slide", unitIds: ["unit-1"], knowledgePointIds: ["kp"], description: savedOutline.description ?? "", keyPoints: savedOutline.keyPoints ?? [], teachingObjective: "解释独立性", resourceNeeds: savedOutline.teachingBrief.resourceNeeds }],
        assessmentFocus: ["解释理由"], understandingCriteria: savedOutline.teachingBrief.understandingCriteria!,
        teachingDurationSec: 240, learnerActivityDurationSec: 0, assessmentDurationSec: 60,
      }],
    };
    course.content.teachingBlueprint = teachingBlueprint;

    const issues = collectCourseStructureIssues(course, [scene]);
    expect(issues.some((issue) => issue.title === "课件缺少设计规定的必要材料")).toBe(false);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "必要教学资源尚未落到实际页面", blocking: true }),
    ]));
    teachingBlueprint.sections[0]!.understandingCriteria.answerEssentials = [];
    expect(collectCourseStructureIssues(course, [scene])).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "小节缺少预定理解标准", blocking: true }),
    ]));
  });
});
