import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSupportRecord, Course, ReflectionSurveyResponseV1 } from "@/lib/session/types";
import { ReflectionSummarySidebar } from "./reflection-summary-sidebar";

const mocks = vi.hoisted(() => ({
  buildSummary: vi.fn(),
}));

vi.mock("@/lib/teaching-ai/client-api", () => ({
  buildReflectionClassSummary: mocks.buildSummary,
}));

const survey: ReflectionSurveyResponseV1 = {
  schemaVersion: 1,
  learningReflection: "我学会了比较证据，但整理资料时遇到了困难。",
  systemReflection: "AI 帮助我归纳资料，希望下次任务要求更清楚。",
  aiHelpfulness: 4,
  systemUsability: 4,
  reuseIntention: 5,
};

function makeCourse(withReflection: boolean): Course {
  return {
    id: "course-one-student",
    name: "单人测试课",
    subject: "综合实践",
    grade: "七年级",
    hours: 1,
    summary: "",
    drivingQuestion: "",
    status: "teaching",
    stages: [{ key: "reflection", label: "学习反思", view: "reflection-survey", description: "" }],
    currentStageIndex: 0,
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: {} },
    students: [{ id: "student-1", name: "小明" }],
    reflections: withReflection ? [{
      id: "reflection-1",
      courseId: "course-one-student",
      studentId: "student-1",
      studentName: "小明",
      content: "学习反思",
      survey,
      createdAt: "2026-09-05T12:00:00.000Z",
      updatedAt: "2026-09-05T12:00:00.000Z",
    }] : [],
  } as unknown as Course;
}

describe("ReflectionSummarySidebar", () => {
  beforeEach(() => {
    mocks.buildSummary.mockReset();
    mocks.buildSummary.mockResolvedValue({
      id: "summary-1",
      courseId: "course-one-student",
      targetType: "course",
      targetId: "course-one-student",
      stageKey: "reflection",
      kind: "reflection-class-summary",
      structuredPayload: {},
      updatedAt: "2026-09-05T12:01:00.000Z",
    } as unknown as AiSupportRecord);
  });

  it("automatically generates the 100% summary when the only student submits", async () => {
    const { rerender } = render(<ReflectionSummarySidebar course={makeCourse(false)} />);
    expect(mocks.buildSummary).not.toHaveBeenCalled();

    rerender(<ReflectionSummarySidebar course={makeCourse(true)} />);

    await waitFor(() => expect(mocks.buildSummary).toHaveBeenCalledWith("course-one-student", "threshold"));
  });

  it("keeps the priority recommendation whole and reveals the complete summary in a dialog", () => {
    const course = makeCourse(true);
    course.aiSupports = [{
      id: "summary-stored",
      courseId: course.id,
      targetType: "course",
      targetId: course.id,
      stageKey: "reflection",
      kind: "reflection-class-summary",
      structuredPayload: {
        schemaVersion: 1,
        generatedAt: "2026-09-05T12:01:00.000Z",
        coveragePercent: 100,
        coverageBucket: 100,
        trigger: "threshold",
        responseCount: 1,
        totalStudentCount: 1,
        sourceRevision: "student-1:reflection-1:2026-09-05T12:00:00.000Z",
        sourceRefs: [{ reflectionId: "reflection-1", studentId: "student-1", updatedAt: "2026-09-05T12:00:00.000Z" }],
        courseSummary: "学生已经能够比较证据，但在整理资料和理解任务要求方面仍需要更清晰的课堂支架。",
        teachingRecommendations: [
          "下一节课先用一个完整示例带领学生拆解资料整理步骤，并现场确认每一步的产出要求。",
          "安排同伴互查，让学生依据统一清单核对证据是否完整、来源是否清楚。",
          "收集学生对任务说明的疑问，在下一轮教学前集中改写容易误解的部分。",
        ],
        categories: [],
        studentSummaries: [],
      },
      createdAt: "2026-09-05T12:01:00.000Z",
      updatedAt: "2026-09-05T12:01:00.000Z",
    } as unknown as AiSupportRecord];

    render(<ReflectionSummarySidebar compact course={course} />);

    expect(screen.getByText("下一节课先用一个完整示例带领学生拆解资料整理步骤，并现场确认每一步的产出要求。")).toBeTruthy();
    expect(screen.queryByText("学生已经能够比较证据，但在整理资料和理解任务要求方面仍需要更清晰的课堂支架。")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "还有 2 条建议，查看完整总结" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("AI 课程总结与教学建议")).toBeTruthy();
    expect(screen.getByText("学生已经能够比较证据，但在整理资料和理解任务要求方面仍需要更清晰的课堂支架。")).toBeTruthy();
    expect(screen.getByText("收集学生对任务说明的疑问，在下一轮教学前集中改写容易误解的部分。")).toBeTruthy();
  });
});
