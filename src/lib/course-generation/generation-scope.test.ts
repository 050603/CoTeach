import { describe, expect, it } from "vitest";
import { isTestLessonPromotion, selectClassroomGenerationOutlines } from "./generation-scope";

const outlines = [
  { id: "s1-a", type: "slide", title: "概念", lectureSectionId: "section-1", lectureSectionTitle: "第一节", targetDurationSec: 180 },
  { id: "s1-b", type: "quiz", title: "检测", lectureSectionId: "section-1", lectureSectionTitle: "第一节", targetDurationSec: 60 },
  { id: "s2-a", type: "interactive", title: "练习", lectureSectionId: "section-2", lectureSectionTitle: "第二节", targetDurationSec: 240 },
  { id: "s2-b", type: "quiz", title: "检测", lectureSectionId: "section-2", lectureSectionTitle: "第二节", targetDurationSec: 60 },
] as const;

describe("classroom generation scope", () => {
  it("only promotes retained test pages when moving from test to the full course", () => {
    expect(isTestLessonPromotion("test-lesson", "full-course")).toBe(true);
    expect(isTestLessonPromotion("full-course", "test-lesson")).toBe(false);
    expect(isTestLessonPromotion(undefined, "full-course")).toBe(false);
  });
  it("keeps the complete confirmed outline for a formal generation", () => {
    const result = selectClassroomGenerationOutlines(outlines, "full-course");
    expect(result.outlines.map((scene) => scene.id)).toEqual(["s1-a", "s1-b", "s2-a", "s2-b"]);
    expect(result.testLesson).toBeUndefined();
  });

  it("selects one complete formal lesson without changing its pages", () => {
    const result = selectClassroomGenerationOutlines(outlines, "test-lesson");
    expect(result.outlines).toEqual([outlines[0], outlines[1]]);
    expect(result).toMatchObject({
      fullSceneCount: 4,
      testLesson: {
        sectionId: "section-1",
        sectionTitle: "第一节",
        sceneOutlineIds: ["s1-a", "s1-b"],
        durationSeconds: 240,
      },
    });
  });

  it("does not silently turn a loose page into a test lesson", () => {
    expect(() => selectClassroomGenerationOutlines([
      { id: "only", type: "slide", title: "孤立页面", targetDurationSec: 60 },
    ], "test-lesson")).toThrow(/完整知识小节/);
  });
});
