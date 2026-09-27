import { describe, expect, it } from "vitest";
import type { AiInteractionEvent, CompanionThread } from "@/lib/session/types";
import { buildStudentAiInteractionTurns, companionPracticeEvents, mergePracticeAiInteractionEvents } from "./interaction-transcript";

const base = {
  courseId: "course-1",
  studentId: "student-1",
  stageKey: "make",
  conversationId: "conversation-1",
} as const;

describe("student AI interaction transcript", () => {
  it("recovers unaudited practice messages without duplicating audited turns", () => {
    const threads = [{
      id: "stored-thread", courseId: "course-1", studentId: "student-1", stageKey: "ai-code-collaboration:make:python",
      createdAt: "2026-09-01T01:00:00Z", updatedAt: "2026-09-01T01:00:03Z",
      messages: [
        { id: "m1", role: "student", content: "如何调试？", visibility: "student-and-teacher", conversationId: "logical-code", createdAt: "2026-09-01T01:00:00Z" },
        { id: "m2", role: "agent", content: "先检查输入。", visibility: "student-and-teacher", conversationId: "logical-code", createdAt: "2026-09-01T01:00:01Z" },
        { id: "m3", role: "student", content: "我该检查什么？", visibility: "student-and-teacher", conversationId: "logical-code", createdAt: "2026-09-01T01:00:02Z" },
        { id: "m4", role: "agent", content: "检查空值。", visibility: "student-and-teacher", conversationId: "logical-code", createdAt: "2026-09-01T01:00:03Z" },
      ],
    }] as CompanionThread[];
    const audited: AiInteractionEvent[] = [
      { ...base, conversationId: "logical-code", id: "a1", source: "sidebar", eventType: "request", actorRole: "student", content: "如何调试？", createdAt: "2026-09-01T01:00:00Z" },
      { ...base, conversationId: "logical-code", id: "a2", source: "sidebar", eventType: "response", actorRole: "ai", content: "先检查输入。", createdAt: "2026-09-01T01:00:01Z" },
    ];

    const events = mergePracticeAiInteractionEvents(audited, companionPracticeEvents(threads));
    const [turn] = buildStudentAiInteractionTurns(events);

    expect(turn.messages.map(item => item.content)).toEqual(["如何调试？", "先检查输入。", "我该检查什么？", "检查空值。"]);
    expect(events.filter(item => item.id.startsWith("thread:"))).toHaveLength(2);
  });

  it("keeps every contextual sidebar exchange in one conversation turn", () => {
    const events: AiInteractionEvent[] = [
      { ...base, id: "1", source: "sidebar", eventType: "request", actorRole: "student", requestId: "request-1", content: "我们的观察还缺什么？", createdAt: "2026-09-01T01:00:00.000Z" },
      { ...base, id: "2", source: "sidebar", eventType: "response", actorRole: "ai", requestId: "request-1", content: "需要说明观察时段。", createdAt: "2026-09-01T01:00:01.000Z" },
      { ...base, id: "3", source: "sidebar", eventType: "request", actorRole: "student", requestId: "request-2", content: "为什么要固定时段？", createdAt: "2026-09-01T01:01:00.000Z" },
      { ...base, id: "4", source: "sidebar", eventType: "response", actorRole: "ai", requestId: "request-2", content: "这样可以减少时间变量的干扰。", createdAt: "2026-09-01T01:01:01.000Z" },
    ];

    const turns = buildStudentAiInteractionTurns(events);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual(expect.objectContaining({
      conversationId: "conversation-1",
      turn: 1,
      locationLabel: "侧边栏对话",
    }));
    expect(turns[0].messages.map((message) => [message.role, message.content])).toEqual([
      ["student", "我们的观察还缺什么？"],
      ["ai", "需要说明观察时段。"],
      ["student", "为什么要固定时段？"],
      ["ai", "这样可以减少时间变量的干扰。"],
    ]);
  });
  it("orders a delayed offline decision by when the student made it", () => {
    const events: AiInteractionEvent[] = [
      { ...base, id: "question", source: "sidebar", eventType: "request", actorRole: "student", content: "第一问", createdAt: "2026-09-01T01:00:00Z" },
      { ...base, id: "later", source: "sidebar", eventType: "request", actorRole: "student", content: "第二问", createdAt: "2026-09-01T01:10:00Z" },
      { ...base, id: "offline", source: "sidebar", eventType: "comment", actorRole: "student", content: "离线记录", payload: { occurredAt: "2026-09-01T01:05:00Z" }, createdAt: "2026-09-01T01:20:00Z" },
    ];
    expect(buildStudentAiInteractionTurns(events)[0].messages.map(item => item.content)).toEqual(["第一问", "离线记录", "第二问"]);
  });
  it("keeps raw model attempts out of the displayed student conversation", () => {
    const events: AiInteractionEvent[] = [
      { ...base, id: "raw", source: "sidebar", eventType: "response", actorRole: "system", content: "{\"message\":\"草稿\"}", payload: { kind: "model-output" }, createdAt: "2026-09-01T01:00:00Z" },
      { ...base, id: "answer", source: "sidebar", eventType: "response", actorRole: "ai", content: "请先核查数据。", createdAt: "2026-09-01T01:00:01Z" },
    ];
    expect(buildStudentAiInteractionTurns(events)[0].messages.map(item => item.content)).toEqual(["请先核查数据。"]);
  });

  it("keeps an initial paragraph comment and all replies in its own turn", () => {
    const events: AiInteractionEvent[] = [
      { ...base, id: "1", conversationId: "comment-1", source: "proactive-comment", eventType: "comment", actorRole: "ai", content: "这里的结论缺少证据。", payload: { commentThreadId: "comment-1", issueType: "证据缺口", targetText: "方案效果很好" }, createdAt: "2026-09-01T01:00:00.000Z" },
      { ...base, id: "2", conversationId: "comment-1", source: "proactive-comment", eventType: "request", actorRole: "student", content: "我应该补什么证据？", createdAt: "2026-09-01T01:01:00.000Z" },
      { ...base, id: "3", conversationId: "comment-1", source: "proactive-comment", eventType: "response", actorRole: "ai", content: "可以补充两次测试的数据。", createdAt: "2026-09-01T01:01:01.000Z" },
      { ...base, id: "4", conversationId: "comment-2", source: "proactive-comment", eventType: "comment", actorRole: "ai", content: "这个概念需要定义。", createdAt: "2026-09-01T01:02:00.000Z" },
    ];

    const turns = buildStudentAiInteractionTurns(events);
    expect(turns).toHaveLength(2);
    expect(turns[0].context).toEqual(expect.objectContaining({ issueType: "证据缺口", targetText: "方案效果很好" }));
    expect(turns[0].messages).toHaveLength(3);
    expect(turns[1].messages).toHaveLength(1);
  });

  it("expands an old aggregated proactive review into independent comment turns", () => {
    const turns = buildStudentAiInteractionTurns([{
      ...base,
      id: "legacy-review",
      conversationId: undefined,
      source: "proactive-comment",
      eventType: "comment",
      actorRole: "ai",
      content: "旧合并内容",
      payload: { comments: [
        { id: "comment-a", blockIndex: 1, targetText: "甲段", comments: [{ role: "assistant", content: "甲批注" }] },
        { id: "comment-b", blockIndex: 2, targetText: "乙段", comments: [{ role: "assistant", content: "乙批注" }] },
      ] },
      createdAt: "2026-09-01T01:00:00.000Z",
    }]);

    expect(turns.map((turn) => [turn.conversationId, turn.messages[0].content])).toEqual([
      ["comment-a", "甲批注"],
      ["comment-b", "乙批注"],
    ]);
  });

  it("attaches an edit decision and undo to the AI message in that conversation", () => {
    const events: AiInteractionEvent[] = [
      { ...base, id: "1", source: "selection", eventType: "request", actorRole: "student", content: "请写清楚", createdAt: "2026-09-01T01:00:00.000Z" },
      { ...base, id: "2", source: "selection", eventType: "proposal", actorRole: "ai", content: "建议明确时间。", payload: { contributionId: "c-1", suggestion: { title: "明确时间", targetText: "观察几天", replacement: "连续三天观察" } }, createdAt: "2026-09-01T01:00:01.000Z" },
      { ...base, id: "3", source: "selection", eventType: "decision", actorRole: "student", content: "学生确认应用", payload: { contributionId: "c-1", decision: "adopted" }, createdAt: "2026-09-01T01:00:02.000Z" },
      { ...base, id: "4", source: "selection", eventType: "undo", actorRole: "student", content: "学生撤销修改", payload: { contributionId: "c-1" }, createdAt: "2026-09-01T01:00:03.000Z" },
    ];

    const modification = buildStudentAiInteractionTurns(events)[0].messages[1].modification;
    expect(modification).toEqual(expect.objectContaining({
      contributionId: "c-1",
      decision: "adopted",
      undoneAt: "2026-09-01T01:00:03.000Z",
    }));
  });
});
