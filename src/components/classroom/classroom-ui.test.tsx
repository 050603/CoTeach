import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ClassroomContextHeader,
  ClassroomStatus,
  StageEmptyState,
  StagePageHeader,
  StageSplitLayout,
} from "./classroom-ui";

describe("classroom UI primitives", () => {
  it("keeps stage title, status, and the single primary action in a clear order", () => {
    render(
      <StagePageHeader
        action={<button type="button">开始学习</button>}
        description="完成本阶段的主要任务。"
        status={<ClassroomStatus label="进行中" state="active" />}
        title="项目启动"
      />,
    );

    const title = screen.getByRole("heading", { name: "项目启动" });
    const status = screen.getByText("进行中");
    const action = screen.getByRole("button", { name: "开始学习" });
    expect(title.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(status.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders the task column before the auxiliary column", () => {
    render(
      <StageSplitLayout
        aside={<p>辅助信息</p>}
        main={<p>主要任务</p>}
      />,
    );
    expect(screen.getByText("主要任务").compareDocumentPosition(screen.getByText("辅助信息")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("provides a quiet next-step empty state", () => {
    render(<StageEmptyState description="教师发布资料后会显示在这里。" title="等待教师发布" />);
    expect(screen.getByRole("heading", { name: "等待教师发布" })).toBeTruthy();
    expect(screen.getByText("教师发布资料后会显示在这里。")).toBeTruthy();
  });

  it("shows course context and stage progress for the project workbench", () => {
    render(
      <ClassroomContextHeader
        courseName="校园减塑"
        homeHref="/student"
        role="student"
        stageIndex={2}
        stageLabel="项目实践"
        totalStages={5}
        userName="小林"
      />,
    );
    expect(screen.getByText("校园减塑")).toBeTruthy();
    expect(screen.getByText("阶段 3/5")).toBeTruthy();
    expect(screen.getByText("项目实践")).toBeTruthy();
    expect(screen.getByText("小林")).toBeTruthy();
  });

  it("can omit the duplicate back control while keeping the course link", () => {
    render(
      <ClassroomContextHeader
        courseName="校园减塑"
        homeHref="/student/classroom/course-1"
        role="student"
        showBackButton={false}
        stageLabel="项目实践"
      />,
    );

    expect(screen.queryByRole("link", { name: "返回课堂" })).toBeNull();
    expect(screen.getByRole("link", { name: /CoTeach/ }).getAttribute("href")).toBe("/student/classroom/course-1");
  });
});
