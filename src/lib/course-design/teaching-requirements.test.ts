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
      expect.objectContaining({ kind: "highlight", sourceKnowledgePointIds: ["constructivism"] }),
      expect.objectContaining({ kind: "difficulty", sourceKnowledgePointIds: ["assimilation"] }),
    ]));
  });
});
