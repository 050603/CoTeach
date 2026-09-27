import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeAiMemberWorkspace } from "./code-ai-member-workspace";

vi.mock("./project-support-cards", () => ({
  ProjectMemoryPanel: () => null,
  ProjectReplyContent: ({ content }: { content: string }) => <p>{content}</p>,
  ProjectSupportCard: () => null,
}));

describe("code AI member workspace", () => {
  it("shows a separate AI processing bubble while a response is pending", () => {
    const props = {
      busy: true, changeSet: null, draft: "", error: null, historyLoaded: true,
      messages: [{ id: "student-1", role: "user" as const, content: "检查这段代码", createdAt: "2026-09-25T10:00:00.000Z" }],
      memories: [], mode: "discuss" as const, previewChangeIndex: 0, projectTitle: "代码项目", starters: [],
      onAcceptChangeSet: vi.fn(), onChangeDraft: vi.fn(), onClearSelection: vi.fn(), onClose: vi.fn(),
      onDeleteMessage: vi.fn(), onDismissError: vi.fn(), onModeChange: vi.fn(), onNewConversation: vi.fn(),
      onPreviewChange: vi.fn(), onRejectChangeSet: vi.fn(), onSubmit: vi.fn(), onUpdateMemory: vi.fn(),
      onDeleteMemory: vi.fn(), onClearMemories: vi.fn(),
    };
    const { rerender } = render(<CodeAiMemberWorkspace {...props} />);
    expect(screen.getByText("检查这段代码")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "AI 组员正在处理" })).toHaveTextContent("思考中");
    rerender(<CodeAiMemberWorkspace {...props} busy={false} />);
    expect(screen.queryByRole("status", { name: "AI 组员正在处理" })).not.toBeInTheDocument();
  });

  it("keeps the old reading position when a new answer arrives", () => {
    const noop = vi.fn();
    const first = { id: "first", role: "assistant" as const, content: "先前的回答", createdAt: "2026-09-25T10:00:00.000Z" };
    const props = {
      busy: false, changeSet: null, draft: "", error: null, historyLoaded: true,
      messages: [first], memories: [], mode: "discuss" as const, previewChangeIndex: 0,
      projectTitle: "代码项目", starters: [], onAcceptChangeSet: noop, onChangeDraft: noop,
      onClearSelection: noop, onClose: noop, onDeleteMessage: noop, onDismissError: noop,
      onModeChange: noop, onNewConversation: noop, onPreviewChange: noop, onRejectChangeSet: noop,
      onSubmit: noop, onUpdateMemory: noop, onDeleteMemory: noop, onClearMemories: noop,
    };
    const { rerender } = render(<CodeAiMemberWorkspace {...props} />);
    const log = screen.getByRole("log", { name: "代码协作消息" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 200 });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    rerender(<CodeAiMemberWorkspace {...props} messages={[first, { ...first, id: "new", content: "新的回答" }]} />);
    expect(log.scrollTop).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: "查看新消息" }));
    expect(log.scrollTop).toBe(1000);
  });
});
