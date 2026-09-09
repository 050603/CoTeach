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
    ["reflection", "反思提交状态"],
  ])("builds a compact stage-specific chart for %s", (stageKey, chartLabel) => {
    const pulse = deriveTeacherClassroomPulse(makeCourse(), stageKey);
    expect(pulse.chartLabel).toBe(chartLabel);
    expect(pulse.metrics.length).toBeGreaterThan(0);
  });
});
