import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import type { Course, TeachingBlueprint } from "@/lib/session/types";
import type { CourseTextbookFigureResource } from "@/lib/textbook/course-evidence-types";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  load: vi.fn(),
  updateCourse: vi.fn(),
  designJob: vi.fn(),
  contentJob: vi.fn(),
  publication: vi.fn(),
  figures: vi.fn(),
  hydrate: vi.fn(),
}));

vi.mock("@/lib/platform/template-access", () => ({ authorizeTemplateRequest: mocks.authorize }));
vi.mock("@/lib/platform/pbl-template-repository", () => ({
  loadPblTemplateCourse: mocks.load,
  getPblTemplatePublicationState: mocks.publication,
}));
vi.mock("@/lib/session/server-store", () => ({ updateCourse: mocks.updateCourse }));
vi.mock("@/lib/course-generation/job-storage", () => ({
  designGenerationJobs: { findUnique: mocks.designJob },
  contentGenerationJobs: { findUnique: mocks.contentJob, replace: vi.fn() },
}));
vi.mock("@/lib/course-generation/job-runner", () => ({
  estimatePersistedCourseGenerationSeconds: vi.fn(() => 10),
  runQueuedCourseGenerationToCompletion: vi.fn(),
}));
vi.mock("@/lib/course-generation/capability", () => ({ isBackgroundCourseGenerationEnabled: vi.fn(() => true) }));
vi.mock("@/lib/openmaic/server/classroom-storage", () => ({ readClassroom: vi.fn(), updatePersistedClassroomForEditing: vi.fn() }));
vi.mock("@/lib/course-generation/teacher-review-items", () => ({ collectGeneratedTeacherReviewItems: vi.fn(() => []), teacherReviewSummary: vi.fn(() => "") }));
vi.mock("@/lib/openmaic/server/classroom-asset-generation", () => ({ summarizeTeachingTimingAudit: vi.fn() }));
vi.mock("@/lib/textbook/course-evidence", () => ({
  resolveCourseTextbookFigures: mocks.figures,
  hydrateCourseEvidenceFigureReferences: mocks.hydrate,
}));

import { PATCH } from "./route";

function fixture(): Course {
  const course = createPblTemplateCourse("course-1", {
    name: "原课程",
    subject: "科学",
    grade: "七年级",
    hours: 1,
    learningObjectives: ["原目标"],
  });
  course.version = 10;
  course.status = "ready";
  course.aiLearningClassroomId = "classroom-1";
  course.content._openmaicClassroomId = "classroom-1";
  course.content.knowledgePoints = [{ id: "kp-1", name: "知识", description: "说明" }];
  return course;
}

describe("course design workspace route", () => {
  let course: Course;
  beforeEach(() => {
    vi.clearAllMocks();
    course = fixture();
    mocks.authorize.mockResolvedValue("teacher-1");
    mocks.load.mockImplementation(async () => course);
    mocks.designJob.mockResolvedValue(null);
    mocks.contentJob.mockResolvedValue(null);
    mocks.publication.mockResolvedValue({ latestVersion: 2, publishedVersion: 1, draftVersion: 2 });
    mocks.figures.mockResolvedValue([]);
    mocks.hydrate.mockImplementation(async (items) => items);
    mocks.updateCourse.mockImplementation(async (_id: string, updater: (value: Course) => Course) => {
      course = { ...updater(course), version: (course.version ?? 0) + 1 };
      return { courses: [course] };
    });
  });

  it.each([false, true])("saves independent textbook lists with a retained diagnostic for a missing adopted item (missing=%s)", async (missing) => {
    const figureLabels = ["图流程甲", "图流程乙", "图流程丙", "图流程丁", "图流程戊", "图流程己"];
    const sourceLabels = ["正文步骤甲", "正文步骤乙", "正文步骤丙", "正文步骤丁", "正文步骤戊"];
    const visible = [`图流程有6个环节：${figureLabels.join("、")}`, `正文流程有5个环节：${(missing ? sourceLabels.slice(0, -1) : sourceLabels).join("、")}`];
    course.content.courseEvidence = { items: [{ id: "e-source", content: "正文流程", source: { sectionPath: ["操作步骤"] },
      sourceSequences: [{ anchorSourceBlockId: "source-first", kind: "ordered-steps",
        steps: sourceLabels.map((label, index) => ({ label, sourceBlockId: `source-${index}` })) }] }], mappings: [] } as unknown as NonNullable<Course["content"]["courseEvidence"]>;
    course.content.knowledgePoints[0]!.evidenceItemIds = ["e-source"];
    const figure: CourseTextbookFigureResource = {
      id: "figure-resource", figureId: "figure-id", assetId: "figure-asset", src: "/api/uploads/figure-asset",
      status: "available", relation: "direct", required: true, pageNumber: 1, evidenceItemIds: [],
      knowledgePointIds: ["kp-1"], sourceTitle: "教材",
      orderedSteps: figureLabels.map((label, index) => ({ label, sourceBlockId: `figure-${index}` })),
    };
    mocks.figures.mockResolvedValue([figure]);
    const blueprint: TeachingBlueprint = {
      schemaVersion: 3, inputFingerprint: "accepted", assessmentMode: "adaptive", createdAt: "2026-09-30",
      budget: { totalDurationSec: 600, teachingDurationSec: 480, learnerActivityDurationSec: 0, assessmentDurationSec: 120, teachingRatio: 0.8, assessmentRatio: 0.2 },
      sections: [{ id: "section-1", title: "两类流程", order: 0, knowledgePointIds: ["kp-1"],
        learningObjective: "分别说明两类流程", assessmentFocus: ["分别说明两类流程"],
        sharedContext: { learningPurpose: "分别说明流程", caseId: "", caseFacts: [], stableTerms: [], fixedWording: [], conceptBoundaries: [] },
        understandingCriteria: { goals: ["分别说明流程"], answerEssentials: ["各自步骤完整"], misconceptions: ["混合数量"], supportingUnitIds: ["unit-1"] },
        teachingDurationSec: 480, learnerActivityDurationSec: 0, assessmentDurationSec: 120,
        units: [{ id: "unit-1", title: "两类流程", knowledgePointIds: ["kp-1"], learningOutcome: "分别说明流程",
          explanation: visible.join("。"), mechanism: "两类流程各有独立步骤。", workedExample: "分别执行两类流程。",
          conditions: [], misconceptions: [], sourceKind: "course-source", evidenceQuotes: [] }],
        pages: [{ id: "page-1", title: "两类流程", type: "slide", unitIds: ["unit-1"], knowledgePointIds: ["kp-1"],
          description: visible.join("。"), keyPoints: visible, teachingObjective: "分别说明两类流程" }],
      }],
    };
    const response = await PATCH(new Request("http://localhost/api/courses/course-1/design-workspace", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save", section: "blueprint", expectedVersion: 10, data: blueprint }),
    }), { params: Promise.resolve({ courseId: "course-1" }) });
    expect(response.status).toBe(200);
    if (missing) expect(course.content.teachingBlueprint?.qualityDiagnostics?.join('\n')).toContain("正文步骤戊");
    expect(course.content.teachingBlueprint?.sections[0]?.pages[0]?.keyPoints).toEqual(visible);
  });

  it("saves teacher edits as a draft while preserving generated classroom data", async () => {
    const response = await PATCH(new Request("http://localhost/api/courses/course-1/design-workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "save",
        section: "materials",
        expectedVersion: 10,
        data: {
          name: "更新课程",
          subject: "科学",
          grade: "七年级",
          hours: 1,
          summary: "简介",
          drivingQuestion: "为什么？",
          expectedOutcome: "研究报告",
          learningObjectives: ["更新目标"],
        },
      }),
    }), { params: Promise.resolve({ courseId: "course-1" }) });
    expect(response.status).toBe(200);
    expect(course.name).toBe("更新课程");
    expect(course.status).toBe("preparing");
    expect(course.aiLearningClassroomId).toBe("classroom-1");
    expect(course.content.designWorkspaceRevision?.pendingUpdates.some((item) => item.target === "classroom")).toBe(true);
  });

  it("rejects a stale browser version before applying the edit", async () => {
    const response = await PATCH(new Request("http://localhost/api/courses/course-1/design-workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "confirm-current", target: "classroom", expectedVersion: 9 }),
    }), { params: Promise.resolve({ courseId: "course-1" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "VERSION_CONFLICT" });
  });

  it("requires every write to carry the course version", async () => {
    const response = await PATCH(new Request("http://localhost/api/courses/course-1/design-workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "confirm-current", target: "classroom" }),
    }), { params: Promise.resolve({ courseId: "course-1" }) });
    expect(response.status).toBe(400);
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });
});
