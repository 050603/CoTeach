import { describe, expect, it } from "vitest";
import { emptyResourcePackageDraft, type CourseResourcePackage } from "@/lib/resource-package/types";
import { teachingRequirementResponsibility } from "@/lib/session/types";
import { buildCourseTeachingRequirements, mergeTeacherRequirementBriefs, recoverCourseTeachingRequirements } from "./teaching-requirements";

function resourcePackage(): CourseResourcePackage {
  return {
    schemaVersion: 2,
    id: "package",
    revision: 1,
    source: { id: "zip", fileName: "course.zip", url: "/course.zip" },
    documents: {},
    draft: {
      ...emptyResourcePackageDraft(),
      teachingHighlights: ["深入理解建构主义学习理论的核心观点。"],
      teachingDifficulties: ["难以把同化与顺应转化为具体课堂活动。"],
      knowledgePoints: [{
        id: "constructivism",
        name: "建构主义学习理论",
        description: "知识由学习者结合已有经验主动建构，教学应支持意义建构。",
        subPoints: [],
        children: [{ id: "assimilation", name: "同化与顺应", description: "认知结构的变化机制。" }],
      }],
    },
  };
}

describe("course teaching requirements", () => {
  it("deduplicates a supplemental brief already contained in the complete teacher submission", () => {
    expect(mergeTeacherRequirementBriefs([
      "使用学生熟悉的例子。\n重点解释建构主义。",
      "重点解释建构主义。",
    ])).toBe("使用学生熟悉的例子。\n重点解释建构主义。");
  });

  it("keeps priorities, difficulties and their source knowledge mappings", () => {
    const requirements = buildCourseTeachingRequirements({
      resourcePackage: resourcePackage(),
      teacherBrief: "先用熟悉案例再给出定义。",
    });
    expect(requirements.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "teacher-directive", source: "teacher" }),
      expect.objectContaining({ kind: "highlight", responsibility: "instruction", appliesTo: "ai-learning", sourceKnowledgePointIds: ["constructivism"] }),
      expect.objectContaining({ kind: "difficulty", responsibility: "instruction", appliesTo: "ai-learning", sourceKnowledgePointIds: ["assimilation"] }),
    ]));
  });

  it("classifies original AI actions as instruction and student requirements as learner activity", () => {
    const pack = resourcePackage();
    const stage = pack.draft.stages.find((item) => item.key === "ai-learning")!;
    stage.aiActions = "解释建构主义学习理论，再给出课堂案例。";
    stage.requirements = "向 AI 提问，记录关键概念，构思教案框架。";
    const requirements = buildCourseTeachingRequirements({ resourcePackage: pack });
    const actions = requirements.items.find((item) => item.text === stage.aiActions)!;
    const studentTask = requirements.items.find((item) => item.text === stage.requirements)!;
    expect(actions).toMatchObject({ kind: "stage-requirement", responsibility: "instruction", appliesTo: "ai-learning" });
    expect(studentTask).toMatchObject({ kind: "stage-requirement", responsibility: "learner-activity", appliesTo: "ai-learning" });
    expect(actions.id).toMatch(/^requirement-stage-requirement-/u);
    expect(studentTask.id).toMatch(/^requirement-stage-requirement-/u);

    const historical = structuredClone(requirements);
    historical.items.forEach((item) => { delete item.responsibility; });
    const recovered = recoverCourseTeachingRequirements(historical, pack)!;
    expect(recovered.items.map((item) => [item.id, item.text, teachingRequirementResponsibility(item, pack)])).toEqual(
      requirements.items.map((item) => [item.id, item.text, item.responsibility]),
    );
    expect(recovered.items.find((item) => item.id === studentTask.id)?.responsibility).toBe("learner-activity");
    expect(historical.items.every((item) => !("responsibility" in item))).toBe(true);
  });

  it("keeps uncertain historical responsibilities instructional", () => {
    const pack = resourcePackage();
    const stage = pack.draft.stages.find((item) => item.key === "ai-learning")!;
    stage.requirements = "共同复盘学习成果。";
    stage.aiActions = stage.requirements;
    const stored = {
      id: "saved-stage-id", kind: "stage-requirement" as const, source: "resource-package" as const,
      text: stage.requirements, sourceKnowledgePointIds: [],
    };
    expect(teachingRequirementResponsibility(stored, pack)).toBe("instruction");
    expect(teachingRequirementResponsibility({ ...stored, text: "已修改的历史文本" }, pack)).toBe("instruction");
    expect(teachingRequirementResponsibility(stored)).toBe("instruction");
    expect(buildCourseTeachingRequirements({ resourcePackage: pack }).items.find((item) => item.kind === "stage-requirement")?.responsibility).toBe("instruction");
  });

  it("keeps later-stage supplements out of AI teaching and exposes substantive conflicts", () => {
    const pack = resourcePackage();
    pack.draft.grade = "初中一年级";
    pack.draft.totalMinutes = 90;
    const requirements = buildCourseTeachingRequirements({
      resourcePackage: pack,
      teacherBrief: "面向小学五年级，整课 45 分钟。项目实践采用四人小组完成成果展示。",
    });
    expect(requirements.items.find((item) => item.kind === "teacher-directive")?.appliesTo).toBe("other-stage");
    expect(requirements.conflicts.map((item) => item.id)).toEqual(expect.arrayContaining([
      "teacher-total-minutes", "teacher-audience", "teacher-organization",
    ]));
  });
});
