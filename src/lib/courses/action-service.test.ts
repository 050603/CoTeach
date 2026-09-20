import { describe, expect, it } from "vitest";
import type { Course } from "@/lib/session/types";
import { createPblTemplateCourse, encodePblTemplate } from "@/lib/platform/pbl-template";
import { applyLearningEvidenceReview, courseForTeacherReviewSnapshot } from "./action-service";

describe("applyLearningEvidenceReview", () => {
  it("updates only the selected evidence and records teacher confirmation", () => {
    const result = applyLearningEvidenceReview(
      [
        { id: "evidence-1", status: "submitted", updatedAt: "earlier" },
        { id: "evidence-2", status: "submitted", updatedAt: "earlier" },
      ],
      {
        evidenceId: "evidence-1",
        status: "teacher-confirmed",
        feedback: " 方案可实施 ",
        reviewedAt: "2026-08-06T08:00:00.000Z",
      },
    );

    expect(result).toEqual([
      {
        id: "evidence-1",
        status: "teacher-confirmed",
        updatedAt: "2026-08-06T08:00:00.000Z",
        teacherFeedback: "方案可实施",
        confirmedAt: "2026-08-06T08:00:00.000Z",
      },
      { id: "evidence-2", status: "submitted", updatedAt: "earlier" },
    ]);
  });

  it("returns null when the evidence does not exist", () => {
    expect(applyLearningEvidenceReview([], {
      evidenceId: "missing",
      status: "needs-revision",
      reviewedAt: "2026-08-06T08:00:00.000Z",
    })).toBeNull();
  });
});

describe("courseForTeacherReviewSnapshot", () => {
  it("excludes resources added by the bound offering from review validation", () => {
    const authored = createPblTemplateCourse("template", {
      name: "已终审课程",
      resources: [{
        id: "authored-resource",
        title: "课程课件",
        type: "PPTX",
        size: "1MB",
      }],
      content: {
        teacherReview: { courseId: "template" },
      } as Course["content"],
    });
    const classroom = {
      ...authored,
      id: "instance",
      platformContext: {
        offeringId: "offering",
        activityId: "activity",
        templateId: "template",
        templateVersionId: "version",
      },
      resources: [
        ...(authored.resources ?? []),
        {
          id: "offering-resource",
          title: "教学班补充视频",
          type: "MP4",
          size: "10MB",
          downloadedBy: [],
        },
      ],
    } satisfies Course;

    const reviewCourse = courseForTeacherReviewSnapshot(
      classroom,
      encodePblTemplate(authored),
    );

    expect(reviewCourse.id).toBe("template");
    expect((reviewCourse.resources ?? []).map((resource) => resource.id)).toEqual([
      "authored-resource",
    ]);
  });
});
