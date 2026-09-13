import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { DEFAULT_STAGES } from "@/lib/session/types";

vi.mock("@/lib/session/store", () => ({ useSession: () => ({ addActivity: vi.fn(), setUiState: vi.fn() }) }));
vi.mock("./ai-learning-preview", () => ({ AiLearningTeacherPreview: () => <button>预览学生 AI 课程</button> }));

import { adaptiveResponseStatus, AiLearningTeacherView, computeAiLearningProgress, deriveAiLearningClassMetrics } from "./ai-learning";

const course: Course = {
  id: "course-1", name: "测试课", subject: "科学", grade: "六年级", hours: 2, summary: "", drivingQuestion: "", status: "teaching",
  stages: DEFAULT_STAGES, currentStageIndex: 1,
  content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
  students: [{ id: "student-1", name: "张三", joinedAt: "2026-07-11T09:00:00.000Z", stageProgress: {} }],
  aiLearningClassroomId: "classroom-1",
  learningEvents: [{ id: "e1", idempotencyKey: "e1", courseId: "course-1", studentId: "student-1", stageKey: "ai-learning", sceneId: "scene-1", type: "heartbeat", occurredAt: "2026-07-11T10:00:00.000Z", durationMs: 190_000, expectedDurationSec: 120, visible: true }],
  learningSignals: [{ id: "s1", courseId: "course-1", studentId: "student-1", stageKey: "ai-learning", sceneId: "scene-1", kind: "dwell-overrun", severity: "high", status: "open", title: "停留过久", summary: "需要巡视", normalizedIssueKey: "dwell", evidenceEventIds: ["e1"], aiInterventionAttempts: 2, firstDetectedAt: "2026-07-11T10:00:00.000Z", lastDetectedAt: "2026-07-11T10:01:00.000Z" }],
  classCommonIssues: [], createdAt: "2026-07-11T09:00:00.000Z", updatedAt: "2026-07-11T10:00:00.000Z",
};

describe("AiLearningTeacherView", () => {
  it("applies a new dashboard focus without overriding subsequent local navigation", () => {
    const onSelectStudent = vi.fn();
    const { rerender } = render(<AiLearningTeacherView course={course} onSelectStudent={onSelectStudent} />);
    const focus = { stageKey: "ai-learning", target: "student", studentId: "student-1", tab: "answers" } as const;
    rerender(<AiLearningTeacherView course={course} focus={focus} onSelectStudent={onSelectStudent} />);
    expect(screen.getByRole("tab", { name: "答题详情" }).getAttribute("aria-selected")).toBe("true");
    expect(onSelectStudent).toHaveBeenCalledWith("student-1");
    fireEvent.click(screen.getByRole("tab", { name: "学习轨迹" }));
    rerender(<AiLearningTeacherView course={{ ...course }} focus={{ ...focus }} onSelectStudent={onSelectStudent} />);
    expect(screen.getByRole("tab", { name: "学习轨迹" }).getAttribute("aria-selected")).toBe("true");
  });

  it("uses completed scenes for visible in-stage progress", () => {
    expect(computeAiLearningProgress({
      classroomId: "classroom-1",
      studentId: "student-1",
      currentSceneIndex: 0,
      totalScenes: 4,
      completedScenes: ["scene-1"],
      completionModelVersion: 2,
      masteryLevel: "in-progress",
      lastActiveAt: "2026-07-11T10:00:00.000Z",
    })).toBe(25);
  });

  it("keeps the main work area free of duplicated sidebar metrics", () => {
    render(<AiLearningTeacherView course={course} />);
    expect(screen.queryByText("容忍时长偏差")).toBeNull();
    expect(screen.queryByText("班级答题准确率")).toBeNull();
    expect(screen.queryByText("未解决风险")).toBeNull();
    expect(screen.getByText("学生学习情况")).toBeTruthy();
    expect(screen.getByLabelText("学生状态总览")).toBeTruthy();
    const preview = screen.getByText("预览学生 AI 课程");
    const analytics = screen.getByRole("heading", { name: "全班知识讲授学情" });
    const intervention = screen.getByRole("heading", { name: "教师介入与 PPT 投屏" });
    const students = screen.getByRole("heading", { name: "学生学习情况" });
    expect(preview.compareDocumentPosition(analytics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(analytics.compareDocumentPosition(intervention) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(intervention.compareDocumentPosition(students) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("先决知识证据")).toBeNull();
    expect(screen.queryByText("响应状态")).toBeNull();
    expect(screen.queryByText("重复学习学生")).toBeNull();
    expect(screen.queryByText("用学习证据决定何时现场介入")).toBeNull();
    expect(screen.queryByText("本阶段不控制伴学 Agent；风险用于教师巡视、个别辅导和全班补充教学。")).toBeNull();
    expect(screen.queryByText("AI 课堂状态")).toBeNull();
    expect(screen.queryByText("有学习记录的学生")).toBeNull();
    expect(screen.queryByText(/存在先决缺口/)).toBeNull();
    expect(screen.queryByText(/已学额外资源/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看张三的学习轨迹" }));
    expect(screen.getByRole("tab", { name: "学习轨迹" }).getAttribute("aria-selected")).toBe("true");
  });

  it("describes answer speed in natural language instead of signed variance", () => {
    const fastCourse = {
      ...course,
      learningEvents: course.learningEvents?.map((event) => ({ ...event, durationMs: 60_000 })),
    };
    const text = deriveAiLearningClassMetrics(fastCourse).averageSpeedText;
    expect(text).toMatch(/^比预期快 \d+%$/);
    expect(text).not.toContain("-");
  });

  it("turns shared quiz weaknesses into page-linked whole-class teaching guidance", () => {
    const attempt = (studentId: string) => ({
      id: `attempt-${studentId}`,
      sectionId: "knowledge-section-1",
      quizOutlineId: "knowledge-section-1-check",
      runtimeSceneId: "runtime-quiz",
      submittedAt: "2026-09-01T10:00:00.000Z",
      score: 4,
      maxScore: 10,
      knowledgePointIds: ["kp-model"],
      questions: [{
        questionId: "question-model",
        prompt: "如何建立变量关系？",
        answer: "直接代入",
        points: 10,
        earned: 4,
        correct: false,
        feedback: "没有先说明变量之间的关系",
        knowledgePointIds: ["kp-model"],
      }],
    });
    const students = [
      { id: "student-1", name: "张三", joinedAt: "2026-07-11T09:00:00.000Z", stageProgress: {} },
      { id: "student-2", name: "李四", joinedAt: "2026-07-11T09:00:00.000Z", stageProgress: {} },
    ];
    const progress = Object.fromEntries(students.map((student) => [student.id, {
      classroomId: "classroom-1",
      studentId: student.id,
      currentSceneIndex: 2,
      totalScenes: 3,
      completedScenes: ["scene-1"],
      lastActiveAt: "2026-09-01T10:00:00.000Z",
      masteryLevel: "in-progress" as const,
      knowledgeLectureAttempts: [attempt(student.id)],
    }]));
    render(<AiLearningTeacherView course={{
      ...course,
      students,
      aiLearningProgress: progress,
      learningEvents: [],
      learningSignals: [],
      content: {
        ...course.content,
        knowledgePoints: [{ id: "kp-model", name: "建立变量关系", description: "先明确自变量与因变量，再说明变化方向。" }],
        knowledgeLectureSections: [{ id: "knowledge-section-1", title: "第一节 · 变量关系", order: 0, knowledgePointIds: ["kp-model"], sceneOutlineIds: ["outline-model"], quizOutlineId: "knowledge-section-1-check", estimatedMinutes: 6 }],
        _openmaicSceneOutlines: [{
          id: "outline-model",
          type: "slide",
          title: "变量关系与建模",
          order: 0,
          stageKey: "ai-learning",
          audience: "student",
          knowledgePointIds: ["kp-model"],
        }],
      },
    }} />);

    expect(screen.getByRole("heading", { name: "教师介入与 PPT 投屏" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "知识点未达标率排名" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "各小节测验情况" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "本节逐题详情" })).toBeNull();
    expect(screen.queryByText("如何建立变量关系？")).toBeNull();

    fireEvent.mouseMove(screen.getAllByText("建立变量关系")[0], { clientX: 100, clientY: 120 });
    expect(screen.getByRole("tooltip").textContent).toBe("建立变量关系");
    fireEvent.mouseLeave(screen.getAllByText("建立变量关系")[0]);
    expect(screen.queryByRole("tooltip")).toBeNull();

    const sectionButton = screen.getByRole("button", { name: /第一节 · 变量关系/ });
    fireEvent.click(sectionButton);
    expect(screen.getByRole("heading", { name: "本节逐题详情" })).toBeTruthy();
    expect(screen.getByText("如何建立变量关系？")).toBeTruthy();
    expect(screen.getByText("2 人作答")).toBeTruthy();
    expect(sectionButton.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(sectionButton);
    expect(screen.queryByRole("heading", { name: "本节逐题详情" })).toBeNull();
    expect(screen.queryByText("如何建立变量关系？")).toBeNull();
    expect(screen.getAllByText("建立变量关系").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("100% 未达标率")).toBeTruthy();
    expect(screen.getByText("先明确自变量与因变量，再说明变化方向。")).toBeTruthy();
    expect(screen.getAllByText(/第 1 页 · 变量关系与建模/)).toHaveLength(2);
    expect(screen.getByLabelText("自主选择知识讲授PPT页面")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "班级共性问题" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看张三的答题详情" }));
    expect(screen.getByRole("tab", { name: "答题详情" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "学习轨迹" }));
    expect(screen.getByRole("tab", { name: "学习轨迹" }).getAttribute("aria-selected")).toBe("true");
  });

  it("renders forty students in the compact status overview", () => {
    const students = Array.from({ length: 40 }, (_, index) => ({
      id: `student-${index + 1}`,
      name: `学生${String(index + 1).padStart(2, "0")}`,
      joinedAt: "2026-07-11T09:00:00.000Z",
      stageProgress: {},
    }));

    render(<AiLearningTeacherView course={{ ...course, students, learningEvents: [], learningSignals: [] }} />);

    expect(screen.getByLabelText("学生状态总览").querySelectorAll("li")).toHaveLength(40);
    expect(screen.getByText("学生40")).toBeTruthy();
    expect(screen.getByDisplayValue("按学习进度")).toBeTruthy();
    expect(screen.getByRole("button", { name: "当前倒序，点击改为正序" })).toBeTruthy();
    expect(screen.queryByText("课程未启用")).toBeNull();
  });

  it("describes adaptive response states for teacher monitoring", () => {
    expect(adaptiveResponseStatus(undefined, true).label).toBe("等待前测");
    expect(adaptiveResponseStatus(undefined, true, false).label).toBe("监测触发点");
    expect(adaptiveResponseStatus({
      classroomId: "classroom-1",
      studentId: "student-1",
      currentSceneIndex: 0,
      totalScenes: 1,
      completedScenes: [],
      masteryLevel: "in-progress",
      lastActiveAt: "2026-07-11T10:00:00.000Z",
      adaptiveLearning: {
        enabled: false,
        evidence: [],
        branchRuns: [],
        microLessons: [],
      },
    }, true).label).toBe("个体已关闭");
  });

  it("sorts student cards by accuracy in both directions without adaptive-course status", () => {
    const students = [
      { id: "student-low", name: "低正确率", joinedAt: "2026-07-11T09:00:00.000Z", stageProgress: {} },
      { id: "student-high", name: "高正确率", joinedAt: "2026-07-11T09:00:00.000Z", stageProgress: {} },
    ];
    const progress = Object.fromEntries(students.map((student, index) => [student.id, {
      classroomId: "classroom-1",
      studentId: student.id,
      currentSceneIndex: index + 1,
      totalScenes: 3,
      completedScenes: ["scene-1"],
      completionModelVersion: 2,
      masteryLevel: "in-progress" as const,
      lastActiveAt: "2026-09-01T10:00:00.000Z",
      knowledgeLectureAttempts: [{
        id: `attempt-${student.id}`,
        sectionId: "section-1",
        quizOutlineId: "quiz-1",
        runtimeSceneId: "quiz-runtime",
        submittedAt: "2026-09-01T10:00:00.000Z",
        score: index ? 9 : 3,
        maxScore: 10,
        knowledgePointIds: [],
        questions: [{
          questionId: "q-1",
          prompt: "测试题",
          answer: "回答",
          points: 10,
          earned: index ? 9 : 3,
          correct: Boolean(index),
          feedback: "",
          knowledgePointIds: [],
        }],
      }],
    }]));

    render(<AiLearningTeacherView course={{ ...course, students, aiLearningProgress: progress, learningEvents: [], learningSignals: [] }} />);
    fireEvent.change(screen.getByLabelText("学生排序指标"), { target: { value: "accuracy" } });

    const list = screen.getByLabelText("学生状态总览");
    expect(list.firstElementChild?.textContent).toContain("高正确率");
    fireEvent.click(screen.getByRole("button", { name: "当前倒序，点击改为正序" }));
    expect(list.firstElementChild?.textContent).toContain("低正确率");
    expect(screen.queryByText(/额外资源|拓展课程|课程未启用/)).toBeNull();
  });

});


describe("knowledge lecture projection", () => {
  it("keeps one preview mounted while hiding student evidence and closes details on return", () => {
    const { rerender } = render(<AiLearningTeacherView course={course} />);
    const preview = screen.getByText("预览学生 AI 课程");
    fireEvent.click(screen.getByRole("button", { name: "查看张三的学习轨迹" }));
    expect(screen.getByRole("tab", { name: "学习轨迹" })).toBeTruthy();
    rerender(<AiLearningTeacherView course={course} presentation="teaching" />);
    expect(screen.getByText("预览学生 AI 课程")).toBe(preview);
    expect(screen.queryByText("学生学习情况")).toBeNull();
    expect(screen.queryByRole("tab", { name: "学习轨迹" })).toBeNull();
    expect(screen.queryByText("张三")).toBeNull();
    rerender(<AiLearningTeacherView course={course} presentation="analytics" />);
    expect(screen.getByText("预览学生 AI 课程")).toBe(preview);
    expect(preview.closest("[hidden]")).toBeTruthy();
    rerender(<AiLearningTeacherView course={course} />);
    expect(screen.getByText("预览学生 AI 课程")).toBe(preview);
    expect(screen.queryByRole("tab", { name: "学习轨迹" })).toBeNull();
  });
});
