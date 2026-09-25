import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AiMemberWorkspace, type AiMemberWorkspaceMessage } from "./ai-member-workspace";

vi.mock("./project-support-cards", () => ({
  ProjectCitedMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
  ProjectMemoryPanel: () => <div>项目记忆面板</div>,
  ProjectReplyContent: ({ content }: { content: string }) => <p>{content}</p>,
  ProjectSourceNumber: ({ number }: { number: number }) => <span>{number}</span>,
  ProjectSupportCard: () => null,
  projectSourceAnchorId: () => "source",
}));

function workspaceProps(overrides: Record<string, unknown> = {}) {
  return {
    busy: false,
    draft: "这个方案如何比较？",
    error: null,
    historyLoaded: true,
    messages: [] as AiMemberWorkspaceMessage[],
    pendingChange: null,
    pendingDelivery: null,
    projectTitle: "校园项目",
    memories: [],
    onAcceptChange: vi.fn(),
    onAdoptDelivery: vi.fn(),
    onChangeDraft: vi.fn(),
    onClose: vi.fn(),
    onDismissError: vi.fn(),
    onDeleteMessage: vi.fn(),
    onRetryMessage: vi.fn(),
    onEditMessage: vi.fn(),
    onCancelMessage: vi.fn(),
    onQuickAction: vi.fn(),
    onNewConversation: vi.fn(),
    onRejectDelivery: vi.fn(),
    onRejectChange: vi.fn(),
    onReviseDelivery: vi.fn(),
    onSubmit: vi.fn(),
    onUpdateMemory: vi.fn(),
    onDeleteMemory: vi.fn(),
    onClearMemories: vi.fn(),
    ...overrides,
  };
}

describe("document AI member workspace", () => {
  it("keeps discussion available while a delivery awaits review", () => {
    const props = workspaceProps({
      pendingDelivery: {
        title: "资料整理",
        summary: "已有资料",
        content: "资料内容",
        documentActions: [{ operation: "none", targetText: "", content: "", description: "只供参考" }],
        sources: [],
        researchMode: "none",
      },
    });
    render(<AiMemberWorkspace {...props} />);

    expect(screen.getByPlaceholderText(/把你的判断/)).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "发送给 AI 组员" }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "安排辅助工作" })).toBeDisabled();
  });

  it("keeps a failed message and offers same-request retry or editing", () => {
    const props = workspaceProps({
      messages: [{
        id: "message-1", role: "user", content: "请解释这个概念", createdAt: "2026-09-25T10:00:00.000Z",
        requestId: "request-1", requestStatus: "failed", requestError: "这次回答没能完成，你的消息已保留。", retryable: true,
      }],
    });
    render(<AiMemberWorkspace {...props} />);

    expect(screen.getByText("请解释这个概念")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("你的消息已保留");
    fireEvent.click(screen.getByRole("button", { name: "重新尝试" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑后发送" }));
    expect(props.onRetryMessage).toHaveBeenCalledWith("request-1");
    expect(props.onEditMessage).toHaveBeenCalledWith("message-1");
  });

  it("does not scroll away from history when a new message arrives", () => {
    const first = { id: "one", role: "assistant" as const, content: "第一条", createdAt: "2026-09-25T10:00:00.000Z" };
    const props = workspaceProps({ messages: [first] });
    const { rerender } = render(<AiMemberWorkspace {...props} />);
    const log = screen.getByRole("log", { name: "协作消息" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 200 });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    rerender(<AiMemberWorkspace {...props} messages={[first, { id: "two", role: "assistant", content: "新消息", createdAt: "2026-09-25T10:01:00.000Z" }]} />);

    expect(log.scrollTop).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: "查看新消息" }));
    expect(log.scrollTop).toBe(1000);
  });

  it("offers separate logic and language checks", () => {
    const props = workspaceProps();
    render(<AiMemberWorkspace {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "检查文稿" }));
    fireEvent.click(screen.getByRole("button", { name: "语言表达" }));
    expect(props.onQuickAction).toHaveBeenCalledWith("check", expect.stringContaining("语言表达"));
  });

  it("shows only four compact actions and hides empty memory", () => {
    const props = workspaceProps({ draft: "" });
    render(<AiMemberWorkspace {...props} />);

    expect(screen.getByLabelText("协作入口").querySelectorAll("button")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "讨论思路" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查文稿" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "安排辅助工作" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "整理当前进展" })).toBeInTheDocument();
    expect(screen.queryByText("项目记忆面板")).not.toBeInTheDocument();
    expect(screen.queryByText(/正在根据当前文稿更新工作建议/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "安排辅助工作" }));
    expect(props.onQuickAction).toHaveBeenCalledWith("delegate", expect.stringContaining("项目要求"));
  });

  it("shows project memory when a student memory exists", () => {
    render(<AiMemberWorkspace {...workspaceProps({ memories: [{ id: "memory-1", content: "先对比两个方案。" }] })} />);
    expect(screen.getByText("项目记忆面板")).toBeInTheDocument();
  });
});
