import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { AiCollaborationTeacherMonitor, deriveAiCollaborationMetrics } from "./ai-collaboration-monitor";

vi.mock("@/lib/session/store", () => ({
  useSession: () => ({ updateCourse: vi.fn() }),
}));

const course = {
  students: [{ id: "student-1", name: "小明" }],
  groups: [],
  submissions: [],
  aiContributions: [],
} as unknown as Course;

describe("AI collaboration teacher monitor", () => {
  it("uses classroom-facing headings instead of implementation language", () => {
    render(<AiCollaborationTeacherMonitor course={course} />);

    expect(screen.getByRole("heading", { name: "项目实践进度" })).toBeTruthy();
    expect(screen.queryByText("成果完成情况")).toBeNull();
    expect(screen.queryByText("已保存成果")).toBeNull();
    expect(screen.getByRole("heading", { name: "学生列表" })).toBeTruthy();
    expect(screen.queryByText(/真实产物/)).toBeNull();
    expect(screen.queryByText(/名学生/)).toBeNull();
    expect(screen.queryByText(/\d+\/\d+ 已保存/)).toBeNull();
  });

  it("renders student and AI message Markdown without changing the source transcript", () => {
    render(<AiCollaborationTeacherMonitor course={{
      ...course,
      aiInteractionEvents: [
        { id: "md-student", courseId: "course-1", studentId: "student-1", stageKey: "make", conversationId: "conversation-md", source: "sidebar", eventType: "request", actorRole: "student", content: "**我的问题**\n\n- 数据是否充分？", createdAt: "2026-09-01T01:00:00.000Z" },
        { id: "md-ai", courseId: "course-1", studentId: "student-1", stageKey: "make", conversationId: "conversation-md", source: "sidebar", eventType: "response", actorRole: "ai", content: "## 核查建议\n\n1. 补充样本\n2. 说明来源", createdAt: "2026-09-01T01:00:01.000Z" },
      ],
    } as Course} />);

    expect(screen.getByText("我的问题").getAttribute("data-streamdown")).toBe("strong");
    expect(screen.getByRole("heading", { name: "核查建议" })).toBeTruthy();
    expect(screen.getByText("数据是否充分？").closest("li")).toBeTruthy();
    expect(screen.getByText("补充样本").closest("li")).toBeTruthy();
  });

  it("shows student and AI messages as a located conversation without read receipts", () => {
    render(<AiCollaborationTeacherMonitor course={{
      ...course,
      aiInteractionEvents: [
        { id: "1", courseId: "course-1", studentId: "student-1", stageKey: "make", conversationId: "conversation-12345678", source: "sidebar", eventType: "request", actorRole: "student", requestId: "request-1", content: "我们的观察还缺什么？", createdAt: "2026-09-01T01:00:00.000Z" },
        { id: "2", courseId: "course-1", studentId: "student-1", stageKey: "make", conversationId: "conversation-12345678", source: "sidebar", eventType: "response", actorRole: "ai", requestId: "request-1", content: "还需要说明观察时段为什么具有代表性。", createdAt: "2026-09-01T01:00:01.000Z" },
        { id: "2b", courseId: "course-1", studentId: "student-1", stageKey: "make", conversationId: "conversation-12345678", source: "sidebar", eventType: "request", actorRole: "student", requestId: "request-2", content: "那应该怎样说明？", createdAt: "2026-09-01T01:00:01.500Z" },
        { id: "2c", courseId: "course-1", studentId: "student-1", stageKey: "make", conversationId: "conversation-12345678", source: "sidebar", eventType: "response", actorRole: "ai", requestId: "request-2", content: "说明固定时段可以减少变量干扰。", createdAt: "2026-09-01T01:00:01.800Z" },
        { id: "3", courseId: "course-1", studentId: "student-1", stageKey: "make", conversationId: "comment-1", source: "proactive-comment", eventType: "comment", actorRole: "student", content: "学生阅读了段落批注。", payload: { action: "read" }, createdAt: "2026-09-01T01:00:02.000Z" },
      ],
    } as Course} />);

    expect(screen.getByText("侧边栏对话")).toBeTruthy();
    expect(screen.getByText("我们的观察还缺什么？")).toBeTruthy();
    expect(screen.getByText("还需要说明观察时段为什么具有代表性。")).toBeTruthy();
    expect(screen.getByText("那应该怎样说明？")).toBeTruthy();
    expect(screen.getByText("说明固定时段可以减少变量干扰。")).toBeTruthy();
    expect(screen.getByText("第 1 轮对话 · 4 条消息")).toBeTruthy();
    expect(screen.queryByText("学生阅读了段落批注。")).toBeNull();
    expect(screen.getByRole("link", { name: /导出该生 JSON/ }).getAttribute("href"))
      .toContain("studentId=student-1");
  });

  it("derives proactive suggestions, actual request rounds, and boundary hits from audit events", () => {
    const events = [
      { id: "comment", courseId: "course-1", studentId: "student-1", stageKey: "make", conversationId: "comment-1", source: "proactive-comment", eventType: "comment", actorRole: "ai", content: "这里需要补充证据。", createdAt: "2026-09-01T01:00:00.000Z" },
      { id: "request-1", courseId: "course-1", studentId: "student-1", stageKey: "make", conversationId: "conversation-1", source: "sidebar", eventType: "request", actorRole: "student", requestId: "request-1", content: "帮我写完整方案", createdAt: "2026-09-01T01:01:00.000Z" },
      { id: "policy-1", courseId: "course-1", studentId: "student-1", stageKey: "make", conversationId: "conversation-1", source: "sidebar", eventType: "policy", actorRole: "system", requestId: "request-1", payload: { outcome: "guide_only", protectedCapability: "核心方案决策" }, createdAt: "2026-09-01T01:01:00.100Z" },
      { id: "response-1", courseId: "course-1", studentId: "student-1", stageKey: "make", conversationId: "conversation-1", source: "sidebar", eventType: "response", actorRole: "ai", requestId: "request-1", payload: { kind: "boundary" }, content: "我不能代替你完成核心方案。", createdAt: "2026-09-01T01:01:01.000Z" },
      { id: "request-2", courseId: "course-1", studentId: "student-1", stageKey: "make", conversationId: "conversation-1", source: "sidebar", eventType: "request", actorRole: "student", requestId: "request-2", content: "帮我比较两个方案", createdAt: "2026-09-01T01:02:00.000Z" },
    ] as NonNullable<Course["aiInteractionEvents"]>;

    expect(deriveAiCollaborationMetrics(events)).toMatchObject({
      proactiveSuggestions: 1,
      dialogueRounds: 2,
      boundaryTriggers: 1,
    });

    render(<AiCollaborationTeacherMonitor course={{ ...course, aiInteractionEvents: events } as Course} />);
    expect(screen.getByText("AI 主动建议 1")).toBeTruthy();
    expect(screen.getByText("学生对话 2 轮")).toBeTruthy();
    expect(screen.getByText("边界触发 1 次")).toBeTruthy();
    expect(screen.queryByText(/待学生决定/)).toBeNull();
  });

  it("shows the most recently active conversation first", () => {
    render(<AiCollaborationTeacherMonitor course={{
      ...course,
      aiInteractionEvents: [
        { id: "old", courseId: "course-1", studentId: "student-1", stageKey: "make", conversationId: "conversation-old", source: "sidebar", eventType: "request", actorRole: "student", content: "较早的对话", createdAt: "2026-09-01T01:00:00.000Z" },
        { id: "new", courseId: "course-1", studentId: "student-1", stageKey: "make", conversationId: "conversation-new", source: "sidebar", eventType: "request", actorRole: "student", content: "最近的对话", createdAt: "2026-09-01T02:00:00.000Z" },
      ],
    } as Course} />);

    const latest = screen.getByText("最近的对话");
    const earlier = screen.getByText("较早的对话");
    expect(latest.compareDocumentPosition(earlier) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows locally uploaded artifact versions in the default document mode", () => {
    render(<AiCollaborationTeacherMonitor course={{
      ...course,
      id: "course-1",
      pblConfig: { makeArtifactMode: "document" },
      projectPdfVersions: [{
        id: "local-version-1",
        courseId: "course-1",
        studentId: "student-1",
        stageKey: "make",
        sequence: 1,
        title: "项目展示.pptx",
        uploadId: "upload-1",
        kind: "file",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        size: 2048,
        status: "submitted",
        submittedAt: "2026-09-05T10:00:00.000Z",
        createdAt: "2026-09-05T10:00:00.000Z",
      }],
    } as Course} />);

    expect(screen.getByText("项目展示.pptx")).toBeTruthy();
    expect(screen.getByText("学生上传的本地成果版本")).toBeTruthy();
    expect(screen.getByText("第 1 版 · 项目展示.pptx")).toBeTruthy();
    expect(screen.getByText("本地成果 1 版")).toBeTruthy();
    expect(screen.getByRole("link", { name: "下载" }).getAttribute("href"))
      .toBe("/api/uploads/upload-1?download=1");
  });
});


describe("practice projection", () => {
  it("requires explicit artifact selection and never includes AI conversations in the projected artifact", () => {
    const projectedCourse = {
      ...course,
      stages: [{ key: "make", label: "项目实践", view: "ai-collaboration", description: "比较实验数据并提交方案。" }],
      currentStageIndex: 0,
      pblConfig: { makeArtifactMode: "document" },
      content: { teachingOutline: [] },
      submissions: [{ id: "work-1", studentId: "student-1", stageKey: "make", type: "document", title: "学生方案", content: "<p>已经选中的公开作品</p>", updatedAt: "2026-09-01T01:00:00.000Z" }],
      aiInteractionEvents: [{ id: "private-1", courseId: "course-1", studentId: "student-1", stageKey: "make", source: "sidebar", eventType: "request", actorRole: "student", content: "不应投影的私人提问", createdAt: "2026-09-01T01:00:00.000Z" }],
    } as unknown as Course;
    const { rerender } = render(<AiCollaborationTeacherMonitor course={projectedCourse} presentation="teaching" />);
    expect(screen.getByText("比较实验数据并提交方案。")).toBeTruthy();
    expect(screen.queryByText("小明")).toBeNull();
    expect(screen.queryByText("已经选中的公开作品")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "选择学生成果" }));
    expect(screen.queryByText("已经选中的公开作品")).toBeNull();
    fireEvent.change(screen.getByLabelText("选择展示学生成果"), { target: { value: "student-1" } });
    expect(screen.getByText("已经选中的公开作品")).toBeTruthy();
    expect(screen.queryByText("不应投影的私人提问")).toBeNull();
    expect(screen.queryByText("学生与 AI 协作对话")).toBeNull();
    rerender(<AiCollaborationTeacherMonitor course={projectedCourse} presentation="analytics" />);
    rerender(<AiCollaborationTeacherMonitor course={projectedCourse} presentation="teaching" />);
    expect(screen.queryByText("已经选中的公开作品")).toBeNull();
    expect(screen.queryByLabelText("选择展示学生成果")).toBeNull();
  });
});
