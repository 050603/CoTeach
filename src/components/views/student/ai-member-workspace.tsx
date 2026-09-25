"use client";

import responsiveStyles from "./collaboration-responsive.module.css";

import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  FileInput,
  FilePenLine,
  LoaderCircle,
  MessageSquarePlus,
  Send,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type {
  DelegatedWorkDocumentAction,
  DelegatedWorkSource,
  DocumentCollaborationIntent,
  DocumentCollaborationResponse,
} from "@/lib/ai-collaboration/document-policy";
import { cn } from "@/lib/utils";
import type { ProjectMemoryEntry, ProjectSupportDetails } from "@/lib/ai-collaboration/project-support-types";
import { ProjectCitedMarkdown, ProjectMemoryPanel, ProjectReplyContent, ProjectSourceNumber, ProjectSupportCard, projectSourceAnchorId } from "./project-support-cards";

export type AiMemberWorkspaceMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  kind?: DocumentCollaborationResponse["kind"];
  support?: ProjectSupportDetails;
  requestId?: string;
  requestStatus?: "sending" | "processing" | "recovering" | "failed" | "cancelled";
  requestError?: string;
  retryable?: boolean;
};

export type AiMemberPendingChange = {
  title: string;
  reason: string;
  operation: "replace" | "insert";
  presentation: "inline" | "blocks";
  error?: string | null;
};

export type AiMemberPendingDelivery = {
  title: string;
  summary: string;
  content: string;
  documentActions: DelegatedWorkDocumentAction[];
  sources: DelegatedWorkSource[];
  researchMode: "web" | "textbook" | "model" | "none";
  error?: string | null;
};

type AiMemberWorkspaceProps = {
  busy: boolean;
  draft: string;
  error: string | null;
  historyLoaded: boolean;
  messages: AiMemberWorkspaceMessage[];
  pendingChange: AiMemberPendingChange | null;
  pendingDelivery: AiMemberPendingDelivery | null;
  projectTitle: string;
  memories: ProjectMemoryEntry[];
  memoryContinuation?: string;
  onAcceptChange: () => void;
  onAdoptDelivery: () => void;
  onChangeDraft: (value: string) => void;
  onClose: () => void;
  onDismissError: () => void;
  onDeleteMessage: (messageId: string) => void;
  onRetryMessage: (requestId: string) => void;
  onEditMessage: (messageId: string) => void;
  onCancelMessage: (requestId: string) => void;
  onQuickAction: (intent: DocumentCollaborationIntent, prompt: string) => void;
  onNewConversation: () => void;
  onRejectDelivery: () => void;
  onRejectChange: () => void;
  onReviseDelivery: () => void;
  onSubmit: () => void;
  onUpdateMemory: (id: string, content: string) => void;
  onDeleteMemory: (id: string) => void;
  onClearMemories: () => void;
  /** Label for the editable proxy ("文档" for document mode). */
  workspaceLabel?: string;
};

const QUICK_ACTIONS: Array<{ label: string; intent: DocumentCollaborationIntent; prompt: string }> = [
  { label: "讨论思路", intent: "discuss", prompt: "请结合项目要求和当前文稿，帮我梳理可比较的思路和判断依据。" },
  { label: "安排辅助工作", intent: "delegate", prompt: "请把当前项目要求整理成一份可核对的清单，保留需要我自己决定的事项。" },
  { label: "整理当前进展", intent: "summarize", prompt: "请概括当前已经完成的内容、未解决的问题和可以执行的下一步。" },
];

function formatMessageTime(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(time);
}

export function AiMemberWorkspace({
  busy,
  draft,
  error,
  historyLoaded,
  messages,
  pendingChange,
  pendingDelivery,
  projectTitle,
  memories,
  memoryContinuation,
  onAcceptChange,
  onAdoptDelivery,
  onChangeDraft,
  onClose,
  onDismissError,
  onDeleteMessage,
  onRetryMessage,
  onEditMessage,
  onCancelMessage,
  onQuickAction,
  onNewConversation,
  onRejectDelivery,
  onRejectChange,
  onReviseDelivery,
  onSubmit,
  onUpdateMemory,
  onDeleteMemory,
  onClearMemories,
  workspaceLabel = "文档",
}: AiMemberWorkspaceProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const previousMessageCountRef = useRef(0);
  const [confirmNewConversation, setConfirmNewConversation] = useState(false);
  const [showNewMessages, setShowNewMessages] = useState(false);
  const [showCheckOptions, setShowCheckOptions] = useState(false);
  const deliveryChangesDocument = pendingDelivery?.documentActions
    .some((action) => action.operation !== "none") ?? false;

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    if (!historyLoaded) return;
    if (wasNearBottomRef.current) {
      container.scrollTop = container.scrollHeight;
      setShowNewMessages(false);
    } else if (messages.length > previousMessageCountRef.current) {
      setShowNewMessages(true);
    }
    previousMessageCountRef.current = messages.length;
  }, [historyLoaded, messages.length, pendingChange, pendingDelivery]);

  function handleScroll() {
    const container = scrollRef.current;
    if (!container) return;
    wasNearBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 72;
    if (wasNearBottomRef.current) setShowNewMessages(false);
  }

  function jumpToLatest() {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    wasNearBottomRef.current = true;
    setShowNewMessages(false);
  }

  return (
    <section
      aria-label="AI 组员工作区"
      className={`${responsiveStyles.memberPanel} fixed inset-x-3 bottom-2 top-[136px] z-[80] flex min-h-0 flex-col overflow-hidden rounded-xl border border-stone-200/80 bg-white text-stone-950 shadow-[0_16px_48px_-24px_rgba(28,25,23,0.28)] sm:left-auto sm:right-2 sm:w-[min(500px,calc(100vw-32px))]`}
    >
      <header className="relative shrink-0 border-b border-stone-200/80 bg-white px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--pbl-ai)] text-[11px] font-semibold text-white">AI</span>
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="shrink-0 text-sm font-semibold">AI 组员</h2>
              <span aria-hidden="true" className="text-stone-300">·</span>
              <p className="truncate text-[11px] text-stone-500">{projectTitle}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              aria-label="开始新对话"
              className="grid size-8 place-items-center rounded-lg text-stone-500 transition hover:bg-stone-100 hover:text-stone-900 disabled:opacity-40"
              disabled={busy || Boolean(pendingChange) || Boolean(pendingDelivery)}
              onClick={() => setConfirmNewConversation(true)}
              title="开始新对话"
              type="button"
            >
              <MessageSquarePlus size={15} />
            </button>
            <button
              aria-label="收起 AI 组员"
              className="grid size-8 place-items-center rounded-lg text-stone-500 transition hover:bg-stone-100 hover:text-stone-900"
              onClick={onClose}
              type="button"
            >
              <X size={17} />
            </button>
          </div>
        </div>

        {confirmNewConversation ? (
          <div className="absolute right-3 top-11 z-30 w-[min(320px,calc(100vw-40px))] rounded-xl border border-stone-200 bg-white p-3 text-xs leading-5 text-stone-600 shadow-xl">
            <p className="font-semibold text-stone-900">开始一段新对话？</p>
            <p className="mt-0.5">当前消息将从这里清空，不再发送给 AI；项目记忆会继续保留，可在记忆面板中修改或清除。</p>
            <div className="mt-2 flex justify-end gap-2">
              <button className="rounded-lg px-2.5 py-1.5 font-medium hover:bg-stone-200" onClick={() => setConfirmNewConversation(false)} type="button">取消</button>
              <button className="rounded-lg bg-stone-950 px-2.5 py-1.5 font-semibold text-white hover:bg-stone-800" onClick={() => { setConfirmNewConversation(false); onNewConversation(); }} type="button">开始新对话</button>
            </div>
          </div>
        ) : null}

        {memories.length > 0 ? (
          <ProjectMemoryPanel
            continuation={memoryContinuation}
            memories={memories}
            onClear={onClearMemories}
            onDelete={onDeleteMemory}
            onUpdate={onUpdateMemory}
          />
        ) : null}

      </header>

      <div aria-label="协作消息" className="relative min-h-0 flex-1 overflow-y-auto bg-stone-50/60 px-3 py-3" onScroll={handleScroll} ref={scrollRef} role="log" aria-live="polite">
        {!historyLoaded ? (
          <div className="grid min-h-32 place-items-center text-xs text-stone-500">
            <span className="inline-flex items-center gap-2"><LoaderCircle className="animate-spin" size={14} />加载协作记录…</span>
          </div>
        ) : null}

        {historyLoaded && !messages.length ? (
          <div className="grid min-h-28 place-items-center px-6 text-center">
            <div>
            <h3 className="mt-2 text-sm font-semibold">
              从正在形成的想法开始协作
            </h3>
            <p className="mt-1 text-xs leading-5 text-stone-500">
              “围绕项目和当前文稿提问，也可以直接说明一项非核心辅助工作。”
            </p>
            </div>
          </div>
        ) : null}

        <div className="space-y-2.5">
          {messages.slice(-30).map((message) => (
            <article
              className={cn(
                "group max-w-[94%] rounded-xl border px-3 py-2.5 text-[13px] leading-5",
                message.role === "user"
                  ? "ml-auto rounded-br-md border-stone-200 bg-stone-900 text-white"
                  : message.kind === "boundary"
                    ? "rounded-bl-md border-amber-200 bg-amber-50 text-amber-950"
                    : "rounded-bl-md border-stone-200 bg-white text-stone-800",
              )}
              key={message.id}
              id={message.id}
            >
              <div className={cn(
                "mb-1 flex items-center justify-between gap-3 text-[10px] font-medium",
                message.role === "user" ? "text-stone-300" : message.kind === "boundary" ? "text-amber-700" : "text-stone-500",
              )}>
                <span>{message.role === "user" ? "我" : message.kind === "boundary" ? "AI 组员 · 协作边界" : "AI 组员"}</span>
                <span className="flex items-center gap-1.5">
                  <time>{formatMessageTime(message.createdAt)}</time>
                  <button
                    aria-label="从当前对话中移除这条消息"
                    className={cn(
                      "grid size-5 place-items-center rounded opacity-60 transition hover:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100",
                      message.role === "user" ? "hover:bg-white/15 hover:text-white" : "hover:bg-stone-100 hover:text-stone-800",
                    )}
                    onClick={() => onDeleteMessage(message.id)}
                    title="移除后不再发送给 AI，后台仍保留记录"
                    type="button"
                  >
                    <Trash2 size={11} />
                  </button>
                </span>
              </div>
              {message.role === "assistant" ? (
                <><ProjectReplyContent citationScope={`document-${message.id}`} content={message.content} formatDocumentReply support={message.support} /><ProjectSupportCard citationScope={`document-${message.id}`} replyContent={message.content} support={message.support} /></>
              ) : (
                <>
                  <p className="whitespace-pre-wrap">{message.content}</p>
                  {message.requestStatus ? (
                    <div className="mt-2 border-t border-white/20 pt-2 text-[11px] text-stone-200">
                      {message.requestStatus === "sending" ? "正在发送…" : null}
                      {message.requestStatus === "processing" ? "正在整理你提供的材料…" : null}
                      {message.requestStatus === "recovering" ? "正在恢复这次回答…" : null}
                      {message.requestStatus === "cancelled" ? "已取消" : null}
                      {message.requestStatus === "failed" ? (
                        <>
                          <p role="alert">{message.requestError || "这次回答没能完成，你的消息已保留。可以重新尝试。"}</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {message.retryable && message.requestId ? <button className="rounded-md border border-white/40 px-2 py-1 font-medium text-white hover:bg-white/15" onClick={() => onRetryMessage(message.requestId!)} type="button">重新尝试</button> : null}
                            <button className="rounded-md border border-white/40 px-2 py-1 font-medium text-white hover:bg-white/15" onClick={() => onEditMessage(message.id)} type="button">编辑后发送</button>
                          </div>
                        </>
                      ) : null}
                      {message.requestStatus === "processing" || message.requestStatus === "recovering" ? (
                        <button className="mt-2 rounded-md border border-white/40 px-2 py-1 font-medium text-white hover:bg-white/15" onClick={() => message.requestId && onCancelMessage(message.requestId)} type="button">取消这次请求</button>
                      ) : null}
                    </div>
                  ) : null}
                </>
              )}
            </article>
          ))}

          {pendingChange ? (
            <section className="rounded-xl border border-stone-200 bg-white p-3" aria-label="待确认的 AI 修改">
              <div className="flex items-start gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-stone-900 text-white"><FilePenLine size={14} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-semibold text-stone-500">待确认的修改</p>
                  <h3 className="mt-0.5 text-sm font-semibold text-stone-950">{pendingChange.title}</h3>
                  <p className="mt-0.5 text-xs leading-5 text-stone-500">{pendingChange.reason}</p>
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-stone-50 px-2.5 py-2 text-[10px] text-stone-600">
                <p className="font-medium text-stone-700">
                  {pendingChange.operation === "insert"
                    ? "新增内容已在正文中标出"
                    : pendingChange.presentation === "blocks"
                      ? "较大修改已按段落在正文中标出"
                      : "局部修改已按字词在正文中标出"}
                </p>
                <span className="inline-flex items-center gap-1"><i className="size-2 rounded-sm bg-red-200 ring-1 ring-red-300" />拟删除</span>
                <span className="inline-flex items-center gap-1"><i className="size-2 rounded-sm bg-emerald-200 ring-1 ring-emerald-300" />拟新增</span>
              </div>

              {pendingChange.error ? (
                <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700" role="alert">{pendingChange.error}</p>
              ) : null}

              <div className="mt-2.5 grid grid-cols-2 gap-2">
                <button className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-50" onClick={onRejectChange} type="button">保留原文</button>
                <button className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-stone-950 px-3 py-2 text-xs font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-40" disabled={Boolean(pendingChange.error)} onClick={onAcceptChange} type="button"><CheckCircle2 size={14} />接受并写入</button>
              </div>
            </section>
          ) : null}

          {pendingDelivery ? (
            <section className="overflow-hidden rounded-xl border border-sky-200 bg-white" aria-label="待审阅的 AI 组员交付物">
              <div className="border-b border-sky-100 bg-sky-50/70 px-3 py-3">
                <div className="flex items-start gap-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-sky-600 text-white"><ClipboardCheck size={15} /></span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-bold text-sky-700">组员交付 · 待你审阅</p>
                    <h3 className="mt-0.5 text-sm font-bold text-stone-950">{pendingDelivery.title}</h3>
                    <p className="mt-0.5 text-xs leading-5 text-stone-600">{pendingDelivery.summary}</p>
                  </div>
                </div>
              </div>

              <div className="space-y-2.5 p-3">
                <div className="max-h-72 overflow-y-auto rounded-lg border border-stone-200 bg-stone-50 px-3 py-2.5">
                  <div className="prose prose-sm max-w-none text-stone-800 prose-headings:mb-2 prose-headings:mt-3 prose-p:my-2 prose-li:my-0.5 prose-table:text-xs prose-th:bg-stone-100 prose-th:p-2 prose-td:p-2">
                    <ProjectCitedMarkdown citationScope="document-pending-delivery" content={pendingDelivery.content} sources={pendingDelivery.sources} />
                  </div>
                </div>

                {pendingDelivery.sources.length ? (
                  <div className="rounded-lg border border-stone-200 bg-white p-2.5">
                    <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-stone-500"><ExternalLink size={12} />使用的资料来源</p>
                    <div className="mt-2 space-y-2">
                      {pendingDelivery.sources.map((source, index) => {
                        const sourceContent = <>
                          <span className="font-semibold text-sky-700">{source.title}</span>
                          {source.locator ? <span className="ml-1 text-[10px] text-stone-500">{source.locator}</span> : null}
                          {source.note ? <span className="mt-0.5 block line-clamp-2 text-[10px] leading-4 text-stone-500">{source.note}</span> : null}
                        </>;
                        return source.url
                          ? <a className="flex scroll-mt-24 items-start gap-2 rounded-lg bg-stone-50 px-2.5 py-2 text-xs text-stone-700 transition hover:bg-stone-100" href={source.url} id={projectSourceAnchorId("document-pending-delivery", index)} key={source.id ?? source.url} rel="noreferrer" target="_blank"><ProjectSourceNumber number={index + 1} /><span className="min-w-0 flex-1">{sourceContent}</span></a>
                          : <div className="flex scroll-mt-24 items-start gap-2 rounded-lg bg-stone-50 px-2.5 py-2 text-xs text-stone-700" id={projectSourceAnchorId("document-pending-delivery", index)} key={source.id ?? index} tabIndex={-1}><ProjectSourceNumber number={index + 1} /><span className="min-w-0 flex-1">{sourceContent}</span></div>;
                      })}
                    </div>
                  </div>
                ) : null}

                <div className="rounded-lg border border-stone-200 bg-stone-50/80 p-2.5">
                <p className="flex items-center gap-1.5 text-[10px] font-bold text-stone-600"><FileInput size={12} />计划应用到{workspaceLabel}</p>
                  <div className="mt-1.5 space-y-1.5">
                    {pendingDelivery.documentActions.map((action, index) => (
                      <div className="rounded-md border border-stone-200 bg-white px-2.5 py-1.5" key={`${action.operation}-${index}`}>
                        <p className="text-xs font-semibold leading-5 text-stone-800">{action.description}</p>
                        {action.targetText ? (
                          <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-stone-500">定位段落：{action.targetText}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[10px] leading-4 text-stone-500">
                    {deliveryChangesDocument
                      ? "位置和内容已经由 AI 确定；确认后会一次性应用，仍可撤销。"
                      : `这次交付只提供资料，不会修改当前${workspaceLabel}。`}
                  </p>
                </div>
                {pendingDelivery.error ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700" role="alert">{pendingDelivery.error}</p> : null}

                <div className="grid grid-cols-2 gap-2">
                  <button className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-50" onClick={onRejectDelivery} type="button">暂不采用</button>
                  <button className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-50" onClick={onReviseDelivery} type="button"><Undo2 size={13} />退回修改</button>
                  <button className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-stone-950 px-3 py-2.5 text-xs font-semibold text-white transition hover:bg-stone-800" onClick={onAdoptDelivery} type="button"><CheckCircle2 size={14} />{deliveryChangesDocument ? `确认并应用到${workspaceLabel}` : "完成审阅"}</button>
                </div>
              </div>
            </section>
          ) : null}
        </div>
        {showNewMessages ? <button className="sticky bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-stone-900 px-3 py-1.5 text-xs font-medium text-white shadow-md" onClick={jumpToLatest} type="button">查看新消息</button> : null}
      </div>

      <form
        className="shrink-0 border-t border-stone-200/80 bg-white p-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {error ? (
          <div className="mb-2 flex items-start justify-between gap-3 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs leading-5 text-amber-800" role="alert">
            <span>{error}</span>
            <button aria-label="关闭提示" className="mt-0.5 shrink-0" onClick={onDismissError} type="button"><X size={13} /></button>
          </div>
        ) : null}

        <div className="mb-1.5 grid grid-cols-4 gap-1" aria-label="协作入口">
          {QUICK_ACTIONS.map((action) => (
            <button className="min-h-9 min-w-0 whitespace-nowrap rounded-md border border-stone-200 px-1 py-1.5 text-[10px] text-stone-700 hover:border-stone-400 hover:bg-stone-50 disabled:opacity-40 sm:text-[11px]" disabled={busy || (action.intent === "delegate" && Boolean(pendingChange || pendingDelivery))} key={action.label} onClick={() => { setShowCheckOptions(false); onQuickAction(action.intent, action.prompt); }} type="button">{action.label}</button>
          ))}
          <button className="min-h-9 min-w-0 whitespace-nowrap rounded-md border border-stone-200 px-1 py-1.5 text-[10px] text-stone-700 hover:border-stone-400 hover:bg-stone-50 disabled:opacity-40 sm:text-[11px]" disabled={busy} onClick={() => setShowCheckOptions((current) => !current)} type="button">检查文稿</button>
        </div>
        {showCheckOptions ? (
          <div className="mb-2 flex items-center gap-1.5 text-[11px] text-stone-600">
            <span>检查侧重：</span>
            <button className="rounded-md border border-stone-200 px-2 py-1 hover:bg-stone-50" onClick={() => { onQuickAction("check", "请检查当前文稿的项目逻辑、关键证据和前后矛盾，说明具体依据和下一步。暂不处理普通措辞问题。"); setShowCheckOptions(false); }} type="button">项目逻辑</button>
            <button className="rounded-md border border-stone-200 px-2 py-1 hover:bg-stone-50" onClick={() => { onQuickAction("check", "请按需检查当前文稿的语言表达、结构和可读性。指出具体位置及可操作的修改建议，不直接替我决定项目结论。"); setShowCheckOptions(false); }} type="button">语言表达</button>
          </div>
        ) : null}
        <div className="flex items-end gap-2 rounded-xl border border-stone-300 bg-white p-1.5 shadow-sm transition focus-within:border-stone-500 focus-within:ring-2 focus-within:ring-stone-100">
          <textarea
            className="max-h-28 min-h-12 flex-1 resize-none bg-transparent px-1.5 py-1 text-sm leading-5 text-stone-900 outline-none placeholder:text-stone-400"
            disabled={busy}
            maxLength={1200}
            onChange={(event) => onChangeDraft(event.target.value)}
            placeholder="把你的判断、疑问或希望 AI 组员协助的非核心工作告诉它…"
            value={draft}
          />
          <button
            aria-label="发送给 AI 组员"
            className="grid size-8 shrink-0 place-items-center rounded-lg bg-stone-950 text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={busy || !draft.trim()}
            title="发送"
            type="submit"
          >
            {busy ? <LoaderCircle className="animate-spin" size={14} /> : <Send size={14} />}
          </button>
        </div>
      </form>
    </section>
  );
}
