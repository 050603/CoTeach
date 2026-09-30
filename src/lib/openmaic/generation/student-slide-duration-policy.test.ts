import { describe, expect, it } from "vitest";
import { splitLongStudentSlides } from "./student-slide-duration-policy";

describe("student slide duration policy", () => {
  it("splits a 22-minute student PPT into teachable semantic pages", () => {
    const result = splitLongStudentSlides([{
      id: "long",
      type: "slide",
      title: "核心知识",
      description: "讲解核心知识",
      keyPoints: ["概念", "证据", "例子", "反例"],
      order: 0,
      audience: "student",
      stageKey: "ai-learning",
      targetDurationSec: 22 * 60,
    }]);

    expect(result).toHaveLength(4);
    expect(result.map((item) => item.title)).toEqual(Array(4).fill("核心知识"));
    expect(Math.max(...result.map((item) => item.targetDurationSec ?? 0))).toBeLessThanOrEqual(6 * 60);
    expect(result.reduce((sum, item) => sum + (item.targetDurationSec ?? 0), 0)).toBe(22 * 60);
  });

  it("does not split teacher resources whose duration represents student activity time", () => {
    const result = splitLongStudentSlides([{
      id: "teacher",
      type: "slide",
      title: "项目实践教师支架",
      description: "教师主持提示",
      keyPoints: [],
      order: 0,
      audience: "teacher",
      stageKey: "make",
      targetDurationSec: 22 * 60,
    }]);

    expect(result).toHaveLength(1);
  });
});
