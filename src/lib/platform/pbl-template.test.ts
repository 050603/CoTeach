import { describe, expect, it } from "vitest";
import { createPblTemplateCourse, decodePblTemplate, encodePblTemplate } from "./pbl-template";
import { emptyResourcePackageDraft } from "@/lib/resource-package/types";

describe("PBL authoring snapshot", () => {
  it("round-trips resource package provenance and a separate full-course minute plan", () => {
    const course = createPblTemplateCourse("package-template", { hours: 2.25 });
    course.content.resourcePackage = { schemaVersion: 1, id: "package", revision: 2,
      source: { id: "private-zip", fileName: "资源包.zip", url: "/api/uploads/private-zip" }, documents: {}, draft: emptyResourcePackageDraft(), confirmedAt: "2026-09-12T00:00:00Z" };
    course.content.stagePlan = { schemaVersion: 1, source: "resource-package", totalMinutes: 135, lessonCount: 3,
      minutesPerLesson: 45, stages: [], evaluationCriteria: "评价要求", reflectionQuestions: ["如何改进？"] };
    course.content.knowledgeGroups = [{ id: "theory", name: "学习理论", description: "理论依据", knowledgePointIds: ["constructivism"] }];
    course.content.classroomGenerationRun = {
      scope: "test-lesson", status: "completed", generatedOutlineIds: ["scene-1"], fullOutlineCount: 6,
      testLesson: { sectionId: "section-1", sectionTitle: "第一节", sceneOutlineIds: ["scene-1"], durationSeconds: 300 },
    };
    const restored = decodePblTemplate(encodePblTemplate(course));
    expect(restored?.content.resourcePackage).toEqual(course.content.resourcePackage);
    expect(restored?.content.stagePlan).toEqual(course.content.stagePlan);
    expect(restored?.content.knowledgeGroups).toEqual(course.content.knowledgeGroups);
    expect(restored?.content.classroomGenerationRun).toEqual(course.content.classroomGenerationRun);
    expect(restored?.hours).toBe(2.25);
  });
  it("retains all five stages and OpenMAIC authoring content without student evidence", () => {
    const course = createPblTemplateCourse("template", { name: "Project" });
    course.resources = [{ id: "asset", title: "Handout", type: "PDF", size: "1 MB", downloadedBy: ["private-student"] }];
    course.students = [{ id: "private-student" }] as typeof course.students;
    course.content._openmaicSceneOutlines = [{ id: "slide", title: "Lesson" }];
    course.reflections = [{ id: "private-reflection" }] as typeof course.reflections;
    course.content.courseSummaryPresentation = { privateEvidence: true } as unknown as NonNullable<typeof course.content.courseSummaryPresentation>;
    const snapshot = encodePblTemplate(course);
    expect(snapshot.design.stages).toHaveLength(5);
    expect(snapshot.design.content._openmaicSceneOutlines?.[0].title).toBe("Lesson");
    expect(snapshot.design.resources?.[0]).not.toHaveProperty("downloadedBy");
    expect(createPblTemplateCourse("copy", snapshot.design).resources?.[0].downloadedBy).toEqual([]);
    expect(snapshot.design).not.toHaveProperty("students");
    expect(snapshot.design).not.toHaveProperty("reflections");
    expect(snapshot.design.content).not.toHaveProperty("courseSummaryPresentation");
    expect(decodePblTemplate(snapshot)).toEqual(snapshot.design);
  });
  it("does not accept arbitrary aggregate JSON as a template", () => {
    expect(decodePblTemplate(createPblTemplateCourse("template"))).toBeNull();
    expect(decodePblTemplate({ schemaVersion: 2, kind: "pbl-course", design: { name: "Invalid" } })).toBeNull();
  });
});
