import { describe, expect, it } from "vitest";
import type { Course } from "@/lib/session/types";
import {
  normalizeReflectionClassSummary,
  normalizeReflectionSummaryDraft,
  reflectionClassSummaryIsStale,
  reflectionSummaryCoverage,
  reflectionSummaryMinimumSampleSize,
  reflectionSummaryAutoTrigger,
} from "./reflection-summary";

function makeCourse(studentCount = 5, submittedCount = 0): Course {
  const now = "2026-09-05T00:00:00.000Z";
  return {
    id: "course-1",
    name: "校园减塑",
    subject: "科学",
    grade: "六年级",
    hours: 5,
    summary: "",
    drivingQuestion: "如何改善校园环境？",
    status: "teaching",
    stages: [],
    currentStageIndex: 4,
    students: Array.from({ length: studentCount }, (_, index) => ({
      id: `student-${index + 1}`,
      name: `学生${index + 1}`,
      joinedAt: now,
      stageProgress: {},
    })),
    reflections: Array.from({ length: submittedCount }, (_, index) => ({
      id: `reflection-${index + 1}`,
      courseId: "course-1",
      studentId: `student-${index + 1}`,
      studentName: `学生${index + 1}`,
      content: "兼容文本",
      survey: {
        schemaVersion: 1 as const,
        learningReflection: `收获 ${index + 1}`,
        systemReflection: `体验 ${index + 1}`,
        aiHelpfulness: 4 as const,
        systemUsability: 4 as const,
        reuseIntention: 4 as const,
      },
      createdAt: now,
      updatedAt: `2026-09-05T00:0${index}:00.000Z`,
    })),
    content: {
      pblOutline: "",
      knowledgePoints: [],
      lessonOutline: [],
      evaluationPlan: { dimensions: [], overallRubric: "" },
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe("reflection class summary helpers", () => {
  it("accepts an evidence-based summary without forcing teaching recommendations", () => {
    const draft = normalizeReflectionSummaryDraft({
      courseSummary: "当前样本只支持确认学生已完成反思，尚未形成可行动的共同问题。",
      teachingRecommendations: [],
      categories: [],
      studentSummaries: [],
    }, new Set());

    expect(draft?.teachingRecommendations).toEqual([]);
    expect(draft?.courseSummary).toContain("尚未形成可行动的共同问题");
  });

  it("uses the current highest threshold and the minimum sample gate", () => {
    expect(reflectionSummaryMinimumSampleSize(1)).toBe(1);
    expect(reflectionSummaryMinimumSampleSize(2)).toBe(2);
    expect(reflectionSummaryMinimumSampleSize(20)).toBe(3);
    expect(reflectionSummaryCoverage(makeCourse(100, 19)).coverageBucket).toBe(0);
    expect(reflectionSummaryCoverage(makeCourse(100, 20)).coverageBucket).toBe(20);
    expect(reflectionSummaryCoverage(makeCourse(100, 59)).coverageBucket).toBe(40);
    expect(reflectionSummaryCoverage(makeCourse(100, 100)).coverageBucket).toBe(100);
  });

  it("filters unknown students, invalid fields and duplicate terms before persistence", () => {
    const draft = normalizeReflectionSummaryDraft({
      courseSummary: "学生开始依据证据迭代方案。",
      teachingRecommendations: ["增加分工复盘", "提前明确证据要求", "增加分组互评"],
      categories: [{
        key: "learning-gains",
        summary: "形成证据意识",
        terms: [
          { label: "证据", sources: [{ studentId: "respondent-1", fields: ["learningReflection", "bad"] }] },
          { label: "证据", sources: [{ studentId: "respondent-2", fields: ["learningReflection"] }] },
          { label: "伪造", sources: [{ studentId: "unknown", fields: ["systemReflection"] }] },
        ],
      }],
      studentSummaries: [
        { studentId: "respondent-1", summary: "基于调查修改方案。" },
        { studentId: "unknown", summary: "不应保留。" },
      ],
    }, new Set(["respondent-1", "respondent-2"]));

    expect(draft?.categories[0]?.terms).toEqual([{
      label: "证据",
      sources: [{ studentId: "respondent-1", fields: ["learningReflection"] }],
    }]);
    expect(draft?.studentSummaries).toEqual([{ studentId: "respondent-1", summary: "基于调查修改方案。" }]);
  });

  it("detects a same-bucket edit as stale and normalizes an empty category", () => {
    const course = makeCourse(5, 3);
    const summary = normalizeReflectionClassSummary({
      schemaVersion: 1,
      generatedAt: "2026-09-05T01:00:00.000Z",
      coveragePercent: 60,
      coverageBucket: 60,
      trigger: "threshold",
      responseCount: 3,
      totalStudentCount: 5,
      sourceRefs: course.reflections?.map((reflection) => ({
        reflectionId: reflection.id,
        studentId: reflection.studentId,
        updatedAt: reflection.updatedAt,
      })),
      courseSummary: "已形成初步共识。",
      teachingRecommendations: ["继续追问证据", "安排分工复盘"],
      categories: [{ key: "learning-gains", summary: "暂无", terms: [] }],
      studentSummaries: [],
    }, new Set(course.students.map((student) => student.id)));

    expect(summary?.categories).toHaveLength(4);
    expect(summary?.categories.find((category) => category.key === "ai-collaboration")?.summary).toBe("当前反思中尚未形成明确共识");
    expect(reflectionClassSummaryIsStale(summary, course)).toBe(false);
    course.reflections![0] = { ...course.reflections![0], updatedAt: "2026-09-05T02:00:00.000Z" };
    expect(reflectionClassSummaryIsStale(summary, course)).toBe(true);
  });

  it("generates once for the highest crossed bucket and refreshes the final version", () => {
    const course = makeCourse(100, 40);
    const sourceRefs = course.reflections?.map((reflection) => ({
      reflectionId: reflection.id,
      studentId: reflection.studentId,
      updatedAt: reflection.updatedAt,
    }));
    const summary = normalizeReflectionClassSummary({
      schemaVersion: 1,
      generatedAt: "2026-09-05T01:00:00.000Z",
      coveragePercent: 20,
      coverageBucket: 20,
      trigger: "threshold",
      responseCount: 20,
      totalStudentCount: 100,
      sourceRefs,
      courseSummary: "已有初步共识。",
      teachingRecommendations: ["增加复盘", "明确分工"],
      categories: [],
      studentSummaries: [],
    }, new Set(course.students.map((student) => student.id)));
    expect(reflectionSummaryAutoTrigger(course, summary)).toBe("threshold");

    const sameBucket = makeCourse(100, 20);
    const sameBucketSummary = normalizeReflectionClassSummary({
      schemaVersion: 1,
      generatedAt: "2026-09-05T01:00:00.000Z",
      coveragePercent: 20,
      coverageBucket: 20,
      trigger: "threshold",
      responseCount: 20,
      totalStudentCount: 100,
      sourceRefs: sameBucket.reflections?.map((reflection) => ({ reflectionId: reflection.id, studentId: reflection.studentId, updatedAt: reflection.updatedAt })),
      courseSummary: "已有初步共识。",
      teachingRecommendations: ["增加复盘", "明确分工"],
      categories: [],
      studentSummaries: [],
    }, new Set(sameBucket.students.map((student) => student.id)));
    expect(reflectionSummaryAutoTrigger(sameBucket, sameBucketSummary)).toBeUndefined();
    expect(reflectionSummaryAutoTrigger({ ...sameBucket, status: "finished" }, sameBucketSummary)).toBe("course-finished");
  });
});
