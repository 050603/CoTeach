import { describe, expect, it } from "vitest";
import { emptyResourcePackageDraft, type CourseResourcePackage } from "@/lib/resource-package/types";
import { buildCourseTeachingRequirements, mergeTeacherRequirementBriefs } from "./teaching-requirements";

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
      expect.objectContaining({ kind: "highlight", appliesTo: "ai-learning", sourceKnowledgePointIds: ["constructivism"] }),
      expect.objectContaining({ kind: "difficulty", appliesTo: "ai-learning", sourceKnowledgePointIds: ["assimilation"] }),
    ]));
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
