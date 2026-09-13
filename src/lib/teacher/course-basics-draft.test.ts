import { describe, expect, it } from "vitest";
import type { Course } from "@/lib/session/types";
import {
  buildCourseBasicsPatch,
  createCourseBasicsDraft,
  DEFAULT_NEW_COURSE_HOURS,
  DEFAULT_NEW_COURSE_SUBJECT,
  getEmptyCourseBasicsSuggestionParts,
  parseLearningObjectives,
  validateCourseBasicsDraft,
} from "./course-basics-draft";

function courseFixture(): Course {
  return {
    id: "course-1",
    name: "旧课程",
    subject: "科学",
    grade: "七年级",
    hours: 6,
    summary: "旧说明",
    drivingQuestion: "旧问题？",
    learningObjectives: ["旧目标"],
    status: "draft",
    stages: [],
    currentStageIndex: 0,
    content: {
      pblOutline: "",
      knowledgePoints: [],
      lessonOutline: [],
      evaluationPlan: { dimensions: [], overallRubric: "" },
    },
    students: [],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

describe("course basics draft", () => {
  it("uses the AI-literacy subject and two lessons for a newly created course", () => {
    expect(DEFAULT_NEW_COURSE_SUBJECT).toBe("人工智能通识课程");
    expect(DEFAULT_NEW_COURSE_HOURS).toBe(2);
  });

  it("only requests AI candidates for fields that are still empty", () => {
    const draft = createCourseBasicsDraft(courseFixture());
    draft.learningObjectivesText = "教师已经填写的目标";
    draft.summary = "";
    draft.priorKnowledge = "";
    draft.learningNeeds = "";
    draft.familiarContexts = "";
    draft.drivingQuestions = ["  "];

    expect(getEmptyCourseBasicsSuggestionParts(draft)).toEqual([
      "summary",
      "drivingQuestions",
    ]);
  });

  it("keeps typing local until a save patch is explicitly built", () => {
    const course = courseFixture();
    const draft = createCourseBasicsDraft(course);

    draft.name = "新的课程名称";
    draft.summary = "新的说明";

    expect(course.name).toBe("旧课程");
    expect(course.summary).toBe("旧说明");
    expect(buildCourseBasicsPatch(course, draft)).toMatchObject({
      name: "新的课程名称",
      summary: "新的说明",
    });
  });

  it("normalizes multiline objectives and keeps optional evidence unselected", () => {
    const course = courseFixture();
    const draft = createCourseBasicsDraft(course);
    draft.learningObjectivesText = "  解释概念  \n\n运用证据\n";

    const patch = buildCourseBasicsPatch(course, draft);

    expect(parseLearningObjectives(draft.learningObjectivesText)).toEqual([
      "解释概念",
      "运用证据",
    ]);
    expect(patch.pblConfig.evidenceRequirements.map((item) => item.kind)).not.toEqual(
      expect.arrayContaining(["ai-decision-log", "artifact-version"]),
    );
  });

  it("keeps the common AI-literacy course duration within one to five hours", () => {
    const course = courseFixture();
    const draft = createCourseBasicsDraft(course);
    draft.hours = 8;

    expect(buildCourseBasicsPatch(course, draft).hours).toBe(5);
  });

  it.each([45, 135, 360])("preserves a %i minute package budget when saving course basics", (totalMinutes) => {
    const course = courseFixture();
    course.content.stagePlan = { schemaVersion: 1, source: "resource-package", totalMinutes, lessonCount: null, minutesPerLesson: null, stages: [], evaluationCriteria: "", reflectionQuestions: [] };
    const draft = createCourseBasicsDraft(course);
    expect(draft.hours).toBe(totalMinutes / 60);
    expect(validateCourseBasicsDraft(draft)).toBeNull();
    draft.name = "只编辑课程名称";
    draft.hours = 3;
    expect(buildCourseBasicsPatch(course, draft).hours).toBe(totalMinutes / 60);
  });

  it("persists only one core project driving question", () => {
    const course = courseFixture();
    const draft = createCourseBasicsDraft(course);
    draft.drivingQuestions = [
      "我们如何减少校园用水浪费？",
      "我们如何让雨水被校园重新利用？",
    ];

    const patch = buildCourseBasicsPatch(course, draft);

    expect(patch.drivingQuestion).toBe("我们如何减少校园用水浪费？");
    expect(patch.pblConfig.inquiryQuestions).toEqual([draft.drivingQuestions[0]]);
  });
});
