import { describe, expect, it } from "vitest";
import { emptyResourcePackageDraft, type CourseResourcePackage } from "@/lib/resource-package/types";
import { resourcePackageTeachingPoints } from "./resource-package-knowledge";

describe("resource package teaching responsibilities", () => {
  it("keeps a pure navigation group out of the teaching responsibilities", () => {
    const resourcePackage: CourseResourcePackage = { schemaVersion: 2, id: "package", revision: 1, source: { id: "zip", fileName: "course.zip", url: "/api/uploads/zip" }, documents: {}, draft: { ...emptyResourcePackageDraft(), knowledgePoints: [{ id: "group", name: "学习理论", description: "分组", subPoints: ["建构主义：结合已有经验建构理解"], children: [{ id: "leaf", name: "建构主义", description: "结合已有经验建构理解" }] }] } };
    expect(resourcePackageTeachingPoints(resourcePackage)).toEqual([{ id: "leaf", name: "建构主义", description: "结合已有经验建构理解", groupId: "group", groupName: "学习理论", teachingRole: "detail-concept" }]);
    resourcePackage.draft.knowledgePoints[0].children = undefined;
    const legacy = resourcePackageTeachingPoints(resourcePackage);
    expect(legacy[0].name).toBe("建构主义");
    resourcePackage.revision = 2;
    expect(resourcePackageTeachingPoints(resourcePackage)[0].id).toBe(legacy[0].id);
  });

  it("keeps a substantive parent concept as a definition responsibility before its details", () => {
    const resourcePackage: CourseResourcePackage = { schemaVersion: 2, id: "package", revision: 1, source: { id: "zip", fileName: "course.zip", url: "/api/uploads/zip" }, documents: {}, draft: { ...emptyResourcePackageDraft(), knowledgePoints: [{ id: "constructivism", name: "建构主义学习理论", description: "知识不是被动接收的结果，而是学习者结合已有经验主动建构意义的过程。", subPoints: [], children: [{ id: "assimilation", name: "同化与顺应", description: "认知结构通过同化与顺应发生变化。" }] }] } };

    expect(resourcePackageTeachingPoints(resourcePackage)).toEqual([
      expect.objectContaining({ id: "constructivism", teachingRole: "core-concept" }),
      expect.objectContaining({ id: "assimilation", teachingRole: "detail-concept", parentKnowledgePointId: "constructivism" }),
    ]);
  });
});
