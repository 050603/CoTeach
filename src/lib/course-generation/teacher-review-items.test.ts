import { describe, expect, it } from "vitest";

import type { SceneOutline } from "@/lib/openmaic/types/generation";
import type { Scene } from "@/lib/openmaic/types/stage";
import {
  collectGeneratedTeacherReviewItems,
  mergeTeacherReviewItems,
  teacherReviewSummary,
} from "./teacher-review-items";

describe("teacher review item collection", () => {
  it("keeps constructed material non-blocking, de-duplicates locations, and backfills unregistered numbers", () => {
    const planned = {
      id: "review-example",
      kind: "constructed-example" as const,
      provenance: "constructed" as const,
      content: "校园节能案例为教学构造案例。",
      teachingPurpose: "帮助学生迁移因果判断。",
      outlineId: "page-1",
    };
    const outlines: SceneOutline[] = [{
      id: "page-1",
      type: "slide",
      title: "比较两种方案",
      description: "用数据比较",
      keyPoints: ["方案甲参与率67%"],
      order: 0,
      lectureSectionId: "section-1",
      teachingBrief: {
        schemaVersion: 1,
        explanation: "比较差异",
        examples: [],
        conditions: [],
        evidence: [],
        assessmentFocus: "解释差异",
        reviewItems: [planned],
      },
    }];
    const scenes = [{
      id: "scene-1",
      outlineId: "page-1",
      stageId: "stage",
      type: "slide",
      title: "比较两种方案",
      order: 0,
      content: {
        type: "slide",
        canvas: {
          id: "slide-canvas",
          viewportSize: 1000,
          viewportRatio: 0.5625,
          theme: { backgroundColor: "#fff", themeColors: [], fontColor: "#111", fontName: "Arial" },
          elements: [{ id: "metric", type: "text", left: 10, top: 10, width: 300, height: 80, rotate: 0,
            content: "<p>方案甲参与率67%</p>", defaultFontName: "Arial", defaultColor: "#111" }],
        },
      },
      actions: [{ id: "speech-1", type: "speech", text: "方案甲参与率67%，我们比较变化。" }],
    }] as unknown as Scene[];

    const items = collectGeneratedTeacherReviewItems({ outlines, scenes });
    const illustrative = items.filter((item) => item.kind === "illustrative-data");
    expect(illustrative).toHaveLength(1);
    expect(illustrative[0]).toMatchObject({ values: [{ value: "67", unit: "%" }] });
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "review-example",
      kind: "constructed-example",
    })]));
    expect(teacherReviewSummary(items)).toContain(`本次课程有 ${items.length} 项内容建议授课前确认`);
    expect(JSON.stringify(scenes)).not.toContain("当前资料未提供可核对出处");
  });

  it("does not report source-provided items and merges equivalent records", () => {
    const merged = mergeTeacherReviewItems([
      { id: "source", kind: "unverified-claim", provenance: "course-source", content: "资料事实", teachingPurpose: "讲解" },
      { id: "one", kind: "illustrative-data", provenance: "constructed", content: "两组示意数值", teachingPurpose: "比较", outlineId: "p1" },
      { id: "two", kind: "illustrative-data", provenance: "constructed", content: " 两组示意数值 ", teachingPurpose: "比较", narrationSegmentId: "s1" },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "one", outlineId: "p1", narrationSegmentId: "s1" });
  });
});
