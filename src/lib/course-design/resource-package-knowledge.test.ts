import { describe, expect, it } from "vitest";
import { emptyResourcePackageDraft, type CourseResourcePackage } from "@/lib/resource-package/types";
import { resourcePackageTeachingPoints } from "./resource-package-knowledge";

describe("resource package teaching leaves", () => {
  it("retains group metadata and leaf ids without teaching descriptions or parents as extra points", () => {
    const resourcePackage: CourseResourcePackage = { schemaVersion: 2, id: "package", revision: 1, source: { id: "zip", fileName: "course.zip", url: "/api/uploads/zip" }, documents: {}, draft: { ...emptyResourcePackageDraft(), knowledgePoints: [{ id: "group", name: "学习理论", description: "分组", subPoints: ["建构主义：结合已有经验建构理解"], children: [{ id: "leaf", name: "建构主义", description: "结合已有经验建构理解" }] }] } };
    expect(resourcePackageTeachingPoints(resourcePackage)).toEqual([{ id: "leaf", name: "建构主义", description: "结合已有经验建构理解", groupId: "group", groupName: "学习理论" }]);
    resourcePackage.draft.knowledgePoints[0].children = undefined;
    const legacy = resourcePackageTeachingPoints(resourcePackage);
    expect(legacy[0].name).toBe("建构主义");
    resourcePackage.revision = 2;
    expect(resourcePackageTeachingPoints(resourcePackage)[0].id).toBe(legacy[0].id);
  });
});
