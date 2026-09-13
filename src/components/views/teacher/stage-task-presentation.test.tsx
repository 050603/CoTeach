import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Course } from "@/lib/session/types";
import { StageTaskPresentation } from "./stage-task-presentation";
import { adaptPersonalProjectText, emptyResourcePackageDraft } from "@/lib/resource-package/types";

describe("StageTaskPresentation", () => {
  it("uses only current-stage authored goals and student deliverables, including old stage keys", () => {
    const course = {
      stages: [{ key: "proposal", label: "方案设计", description: "比较两种方案" }],
      currentStageIndex: 0,
      content: { teachingOutline: [
        { id: "other", stageKey: "make", title: "不属于本阶段的任务", studentActivity: "制作最终成果" },
        { id: "current", stageKey: "proposal", title: "方案比选", teachingGoal: "用证据比较方案", studentActivity: "提交比较表", teacherRole: "个别巡视名单", notes: "教师私人备课笔记" },
      ] },
    } as unknown as Course;
    render(<StageTaskPresentation course={course} />);
    expect(screen.getByText("比较两种方案")).toBeTruthy();
    expect(screen.getByText("学习目标：用证据比较方案")).toBeTruthy();
    expect(screen.getByText("任务与交付：提交比较表")).toBeTruthy();
    expect(screen.queryByText("不属于本阶段的任务")).toBeNull();
    expect(screen.queryByText("个别巡视名单")).toBeNull();
    expect(screen.queryByText("教师私人备课笔记")).toBeNull();
  });

  it("has an explicit empty state when the stage has no authored task", () => {
    render(<StageTaskPresentation course={{ stages: [], content: {} } as unknown as Course} />);
    expect(screen.getByText("本阶段暂无任务或展示资料。")).toBeTruthy();
  });

  it("projects confirmed package deliverables and criteria without private teaching notes", () => {
    const draft = emptyResourcePackageDraft();
    const course = { currentStageIndex: 0, stages: [{ key: "make", label: "项目实践", description: "旧的默认说明" }], content: { teachingOutline: [], stagePlan: {
      ...draft, schemaVersion: 1, source: "resource-package", totalMinutes: 135,
      stages: draft.stages.map((stage) => ({ ...stage, durationMin: 60, requirements: adaptPersonalProjectText("每组4人，比较教学方案"), outputs: "提交个人教案", teacherActions: "教师私人提示" })),
      evaluationCriteria: "用理论解释设计选择",
    } } } as unknown as Course;
    render(<StageTaskPresentation course={course} />);
    expect(screen.getByText("交付要求：提交个人教案")).toBeTruthy();
    expect(screen.getByText("评价标准：用理论解释设计选择")).toBeTruthy();
    expect(screen.queryByText("旧的默认说明")).toBeNull();
    expect(screen.queryByText("教师私人提示")).toBeNull();
    expect(screen.getByText(/每位学生与自己的 AI 伙伴协作/)).toBeTruthy();
  });
});
