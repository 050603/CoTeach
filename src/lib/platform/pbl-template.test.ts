import { describe, expect, it } from "vitest";
import { createPblTemplateCourse, decodePblTemplate, encodePblTemplate } from "./pbl-template";

describe("PBL authoring snapshot", () => {
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
