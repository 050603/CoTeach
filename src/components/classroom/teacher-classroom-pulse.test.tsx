import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Course } from "@/lib/session/types";
import { TeacherClassroomPulse, deriveTeacherClassroomPulse } from "./teacher-classroom-pulse";

function makeCourse(): Course {
  return {
    id: "course-1",
    name: "测试课",
    subject: "综合实践",
    grade: "七年级",
    hours: 2,
    summary: "",
    drivingQuestion: "",
    status: "teaching",
    stages: [
      { key: "launch", label: "项目启动", view: "simple-resource", description: "" },
      { key: "ai-learning", label: "知识讲授", view: "ai-learning", description: "" },
      { key: "make", label: "项目实践", view: "ai-collaboration", description: "" },
      { key: "showcase", label: "成果汇报与评价", view: "showcase-reporting", description: "" },
      { key: "reflection", label: "学习反思", view: "reflection-survey", description: "" },
    ],
    currentStageIndex: 0,
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: {} },
    students: [{ id: "s1", name: "小明" }, { id: "s2", name: "小华" }],
    resources: [{ id: "r1", title: "项目说明", type: "PDF", size: "1 MB", stageKey: "launch", downloadedBy: ["s1"] }],
    experimentPosttestSummary: {
      enabled: true,
      openedAt: "2026-09-25T08:00:00.000Z",
      notStartedCount: 1,
      inProgressCount: 0,
      submittedCount: 1,
      studentRows: [{ studentId: "s1", status: "submitted" }, { studentId: "s2", status: "not-started" }],
    },
  } as unknown as Course;
}

describe("TeacherClassroomPulse", () => {
  it("keeps important launch metrics in the main classroom area", () => {
    render(<TeacherClassroomPulse course={makeCourse()} stageKey="launch" />);

    expect(screen.getByRole("region", { name: "项目启动课堂数据速览" })).toBeTruthy();
    expect(screen.getByText("课堂数据速览")).toBeTruthy();
    expect(screen.getByText("已开始浏览")).toBeTruthy();
    expect(screen.getByRole("img", { name: "已完成0、阅读中1、未打开1" })).toBeTruthy();
  });

  it.each([
    ["ai-learning", "全班学习状态"],
    ["make", "成果推进状态"],
    ["showcase", "汇报队列"],
    ["reflection", "后测作答状态"],
  ])("builds a compact stage-specific chart for %s", (stageKey, chartLabel) => {
    const pulse = deriveTeacherClassroomPulse(makeCourse(), stageKey);
    expect(pulse.chartLabel).toBe(chartLabel);
    expect(pulse.metrics.length).toBeGreaterThan(0);
  });

  it("counts only experiment posttest submissions and ignores legacy reflection records", () => {
    const course = { ...makeCourse(), reflections: [{ id: "old-reflection", studentId: "s2" }] } as Course;
    const pulse = deriveTeacherClassroomPulse(course, "reflection");
    expect(pulse.metrics.map((metric) => `${metric.label}:${metric.value}`)).toEqual(["未开始:1", "作答中:0", "已提交:1"]);
    expect(pulse.segments.map((segment) => `${segment.label}:${segment.count}`)).toEqual(["已提交:1", "作答中:0", "未开始:1"]);
    render(<TeacherClassroomPulse course={course} stageKey="reflection" />);
    expect(screen.getByRole("region", { name: "后测课堂数据速览" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "已提交1、作答中0、未开始1" })).toBeTruthy();
  });

  it("shows the experiment-disabled state instead of old reflection metrics", () => {
    const course = makeCourse();
    course.experimentPosttestSummary = undefined;
    const pulse = deriveTeacherClassroomPulse(course, "reflection");
    expect(pulse.chartLabel).toBe("本课堂未开启后测");
    expect(pulse.metrics[0]?.value).toBe("未开启");
  });
});
