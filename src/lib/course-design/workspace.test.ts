import { describe, expect, it } from "vitest";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import {
  courseDesignWorkspaceStatus,
  mergeCourseDesignClassroomScenes,
  planCourseDesignImpacts,
  recordCourseDesignEdit,
} from "./workspace";

function courseFixture() {
  const course = createPblTemplateCourse("course-1", {
    name: "生态系统",
    subject: "科学",
    grade: "七年级",
    hours: 1,
    learningObjectives: ["解释生态关系"],
  });
  course.content.knowledgePoints = [{ id: "kp-1", name: "食物链", description: "关系", level: "core" }];
  course.content.teachingBlueprint = {
    schemaVersion: 3,
    inputFingerprint: "input",
    assessmentMode: "adaptive",
    createdAt: "2026-01-01T00:00:00.000Z",
    budget: { totalDurationSec: 600, teachingDurationSec: 480, learnerActivityDurationSec: 60, assessmentDurationSec: 60, teachingRatio: 0.8, assessmentRatio: 0.1 },
    sections: [{ id: "section-1", title: "食物链", order: 0, learningObjective: "解释关系", sharedContext: { learningPurpose: "解释生态关系", caseId: "campus", caseFacts: ["校园中存在多种生物"], fixedWording: [], stableTerms: ["食物链"], conceptBoundaries: [] }, knowledgePointIds: ["kp-1"], units: [], pages: [], assessmentFocus: ["关系"], understandingCriteria: { goals: ["能解释"], answerEssentials: ["方向正确"], misconceptions: ["混淆方向"], supportingUnitIds: [] }, teachingDurationSec: 480, learnerActivityDurationSec: 60, assessmentDurationSec: 60 }],
  };
  course.content._openmaicSceneOutlines = [{ id: "outline-1", title: "食物链", lectureSectionId: "section-1", knowledgePointIds: ["kp-1"] }];
  course.aiLearningClassroomId = "classroom-1";
  return course;
}

describe("course design workspace dependencies", () => {
  it("limits knowledge impacts to the sections and outlines that use the changed points", () => {
    const impacts = planCourseDesignImpacts(courseFixture(), "knowledge", { changedKnowledgePointIds: ["kp-1"], now: "2026-01-02T00:00:00.000Z" });
    expect(impacts.map((item) => item.target)).toEqual(["blueprint", "classroom"]);
    expect(impacts.find((item) => item.target === "classroom")?.affectedOutlineIds).toEqual(["outline-1"]);
  });

  it("marks downstream artifacts stale while keeping the edited artifact ready", () => {
    const course = courseFixture();
    course.content.designWorkspaceRevision = recordCourseDesignEdit(course, "knowledge", { changedKnowledgePointIds: ["kp-1"] });
    expect(courseDesignWorkspaceStatus(course, "knowledge")).toBe("ready");
    expect(courseDesignWorkspaceStatus(course, "blueprint")).toBe("stale");
    expect(courseDesignWorkspaceStatus(course, "classroom")).toBe("stale");
  });

  it("does not stale generated classroom content for review-only stage-plan edits", () => {
    const course = courseFixture();
    const revision = recordCourseDesignEdit(course, "stage-plan", { impactTargets: [] });
    expect(revision.pendingUpdates).toEqual([]);
    expect(revision.sections["stage-plan"]?.status).toBe("ready");
  });

  it("replaces only affected classroom scenes and preserves manual edits elsewhere", () => {
    const manualScene = { id: "scene-2", outlineId: "outline-2", title: "教师手工调整" };
    const merged = mergeCourseDesignClassroomScenes({
      outlineIds: ["outline-1", "outline-2"],
      affectedOutlineIds: ["outline-1"],
      baseScenes: [
        { id: "scene-1", outlineId: "outline-1", title: "旧内容" },
        manualScene,
      ],
      candidateScenes: [{ id: "candidate-1", outlineId: "outline-1", title: "新候选" }],
    });
    expect(merged).toEqual([
      { id: "candidate-1", outlineId: "outline-1", title: "新候选" },
      manualScene,
    ]);
    expect(merged?.[1]).toBe(manualScene);
  });

  it("rejects an incomplete local update candidate", () => {
    expect(mergeCourseDesignClassroomScenes({
      outlineIds: ["outline-1", "outline-2"],
      affectedOutlineIds: ["outline-1"],
      baseScenes: [{ id: "scene-2", outlineId: "outline-2" }],
      candidateScenes: [],
    })).toBeNull();
  });
});
