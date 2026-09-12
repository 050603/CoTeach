"use client";

import responsiveStyles from "./collaboration-responsive.module.css";

import { useEffect, useRef, useState } from "react";
import {
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  Code2,
  FileDiff,
  LoaderCircle,
  MessageCircleQuestion,
  MessageSquarePlus,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type {
  CodeAiChangeSet,
  CodeSelection,
} from "@/lib/ai-collaboration/code-policy";
import { cn } from "@/lib/utils";
import { AiMemberMarkdown } from "./ai-member-markdown";

export type CodeAiWorkspaceMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  kind?: "discussion" | "review" | "change-proposal" | "boundary";
};

type Props = {
  busy: boolean;
  changeSet: CodeAiChangeSet | null;
  draft: string;
  error: string | null;
  historyLoaded: boolean;
  messages: CodeAiWorkspaceMessage[];
  mode: "discuss" | "task";
  previewChangeIndex: number;
  projectTitle: string;
  selection?: CodeSelection;
  starters: string[];
  onAcceptChangeSet: () => void;
  onChangeDraft: (value: string) => void;
  onClearSelection: () => void;
  onClose: () => void;
  onDeleteMessage: (id: string) => void;
  onDismissError: () => void;
  onModeChange: (mode: "discuss" | "task") => void;
  onNewConversation: () => void;
  onPreviewChange: (index: number) => void;
  onRejectChangeSet: () => void;
  onSubmit: () => void;
};

function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

export function CodeAiMemberWorkspace({
  busy,
  changeSet,
  draft,
  error,
  historyLoaded,
  messages,
  mode,
  previewChangeIndex,
  projectTitle,
  selection,
  starters,
  onAcceptChangeSet,
  onChangeDraft,
  onClearSelection,
  onClose,
  onDeleteMessage,
  onDismissError,
  onModeChange,
  onNewConversation,
  onPreviewChange,
  onRejectChangeSet,
  onSubmit,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [busy, changeSet, messages.length]);

  return (
    <section
      aria-label="AI 代码组员工作区"
      className={`${responsiveStyles.memberPanel} fixed inset-x-3 bottom-2 top-[136px] z-[90] flex min-h-0 flex-col overflow-hidden rounded-xl border border-stone-200/80 bg-white text-stone-950 shadow-[0_16px_48px_-24px_rgba(28,25,23,0.28)] sm:left-auto sm:right-2 sm:w-[min(530px,calc(100vw-32px))]`}
    >
      <header className="relative shrink-0 border-b border-stone-200/80 bg-white px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="relative grid size-8 shrink-0 place-items-center rounded-lg bg-stone-950 text-white">
              <Bot size={15} />
              <span className="absolute -bottom-px -right-px size-2.5 rounded-full border-2 border-white bg-emerald-500" />
            </span>
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
              disabled={busy || Boolean(changeSet)}
              onClick={() => setConfirmReset(true)}
              title="开始新对话"
              type="button"
            >
              <MessageSquarePlus size={15} />
            </button>
            <button aria-label="收起 AI 组员" className="grid size-8 place-items-center rounded-lg text-stone-500 hover:bg-stone-100 hover:text-stone-900" onClick={onClose} type="button">
              <X size={17} />
            </button>
          </div>
        </div>

        {confirmReset ? (
          <div className="absolute right-3 top-11 z-30 w-[min(320px,calc(100vw-40px))] rounded-xl border border-stone-200 bg-white p-3 text-xs leading-5 text-stone-600 shadow-xl">
            <p className="font-semibold text-stone-900">开始一段新对话？</p>
            <p className="mt-0.5">当前消息将从这里清空，不再发送给 AI；系统仍保留过程记录。</p>
            <div className="mt-2 flex justify-end gap-2">
              <button className="rounded-lg px-2.5 py-1.5 font-medium hover:bg-stone-200" onClick={() => setConfirmReset(false)} type="button">取消</button>
              <button className="rounded-lg bg-stone-950 px-2.5 py-1.5 font-semibold text-white" onClick={() => { setConfirmReset(false); onNewConversation(); }} type="button">开始新对话</button>
            </div>
          </div>
        ) : null}

        <div className="mt-2 grid grid-cols-2 gap-1 rounded-lg bg-stone-100 p-1">
          <button
            className={cn("flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition", mode === "discuss" ? "bg-white text-stone-950 shadow-sm ring-1 ring-stone-200/70" : "text-stone-500 hover:bg-white/60")}
            onClick={() => onModeChange("discuss")}
            type="button"
          >
            <MessageCircleQuestion size={14} />
            <span className="truncate">一起讨论</span>
          </button>
          <button
            className={cn("flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition", mode === "task" ? "bg-white text-stone-950 shadow-sm ring-1 ring-stone-200/70" : "text-stone-500 hover:bg-white/60")}
            onClick={() => onModeChange("task")}
            type="button"
          >
            <BriefcaseBusiness size={14} />
            <span className="truncate">安排工作</span>
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-stone-50/60 px-3 py-3" ref={scrollRef} aria-live="polite">
        {!historyLoaded ? (
          <div className="grid min-h-32 place-items-center text-xs text-stone-500"><span className="inline-flex items-center gap-2"><LoaderCircle className="animate-spin" size={14} />加载协作记录…</span></div>
        ) : null}

        {historyLoaded && !messages.length ? (
          <div className="grid min-h-28 place-items-center px-6 text-center">
            <div>
              <span className="mx-auto grid size-8 place-items-center rounded-full bg-stone-100 text-stone-500"><Sparkles size={15} /></span>
              <h3 className="mt-2 text-sm font-semibold">{mode === "task" ? "像组长一样安排一项辅助工作" : "从代码或运行结果开始讨论"}</h3>
              <p className="mt-1 text-xs leading-5 text-stone-500">
                {mode === "task" ? "安排一项辅助工作，修改完成后由你审阅。" : "围绕项目、代码或运行结果说说你的想法。"}
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
                  ? "ml-auto rounded-br-md border-stone-800 bg-stone-900 text-white"
                  : message.kind === "boundary"
                    ? "rounded-bl-md border-amber-200 bg-amber-50 text-amber-950"
                    : "rounded-bl-md border-stone-200 bg-white text-stone-800",
              )}
              key={message.id}
            >
              <div className={cn("mb-1 flex items-center justify-between gap-3 text-[10px] font-medium", message.role === "user" ? "text-stone-300" : "text-stone-500")}>
                <span>{message.role === "user" ? "我" : message.kind === "boundary" ? "AI 组员 · 协作边界" : "AI 组员"}</span>
                <span className="flex items-center gap-1.5"><time>{timeLabel(message.createdAt)}</time><button aria-label="从当前对话移除" className={cn("grid size-5 place-items-center rounded opacity-60 transition hover:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100", message.role === "user" ? "hover:bg-white/15 hover:text-white" : "hover:bg-stone-100 hover:text-stone-900")} onClick={() => onDeleteMessage(message.id)} title="移除后不再发送给 AI，后台仍保留" type="button"><Trash2 size={11} /></button></span>
              </div>
              {message.role === "assistant" ? (
                <AiMemberMarkdown content={message.content} />
              ) : (
                <p className="whitespace-pre-wrap">{message.content}</p>
              )}
            </article>
          ))}

          {busy ? (
            <div className="max-w-[94%] rounded-xl rounded-bl-sm border border-stone-200 bg-white px-3 py-2.5 text-xs text-stone-500">
              <span className="inline-flex items-center gap-2"><LoaderCircle className="animate-spin" size={13} />AI 组员正在思考…</span>
            </div>
          ) : null}

          {changeSet ? (
            <section className="overflow-hidden rounded-xl border border-sky-200 bg-white" aria-label="待确认的代码修改">
              <div className="border-b border-sky-100 bg-sky-50/70 px-3 py-3">
                <div className="flex items-start gap-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-sky-600 text-white"><FileDiff size={15} /></span>
                  <div className="min-w-0"><p className="text-[10px] font-bold text-sky-700">组员交付 · 待你确认</p><h3 className="mt-0.5 text-sm font-bold text-stone-950">{changeSet.title}</h3><p className="mt-0.5 text-xs leading-5 text-stone-600">{changeSet.summary}</p></div>
                </div>
              </div>
              <div className="p-3">
                <p className="text-[10px] font-semibold text-stone-500">涉及 {changeSet.changes.length} 个文件 · 点击切换差异预览</p>
                <div className="mt-1.5 space-y-1.5">
                  {changeSet.changes.map((change, index) => (
                    <button
                      className={cn("flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition", previewChangeIndex === index ? "border-stone-400 bg-stone-100" : "border-stone-200 bg-white hover:bg-stone-50")}
                      key={change.filePath}
                      onClick={() => onPreviewChange(index)}
                      type="button"
                    >
                      <span className="min-w-0"><strong className="block truncate font-mono text-[11px] text-stone-900">{change.filePath}</strong><span className="mt-0.5 block truncate text-[10px] text-stone-500">{change.reason}</span></span>
                      <span className={cn("ml-2 shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold", change.operation === "create" ? "bg-emerald-50 text-emerald-700" : change.operation === "delete" ? "bg-rose-50 text-rose-700" : "bg-sky-50 text-sky-700")}>{change.operation === "create" ? "新增" : change.operation === "delete" ? "删除" : "修改"}</span>
                    </button>
                  ))}
                </div>
                <div className="mt-2.5 grid grid-cols-2 gap-2">
                  <button className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-xs font-semibold text-stone-700 hover:bg-stone-50" onClick={onRejectChangeSet} type="button">保留原代码</button>
                  <button className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-stone-950 px-3 py-2 text-xs font-semibold text-white hover:bg-stone-800" onClick={onAcceptChangeSet} type="button"><CheckCircle2 size={14} />接受全部修改</button>
                </div>
              </div>
            </section>
          ) : null}
        </div>
      </div>

      <form className="shrink-0 border-t border-stone-200/80 bg-white p-2.5" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        {error ? <div className="mb-2 flex items-start justify-between gap-3 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs leading-5 text-amber-800" role="alert"><span>{error}</span><button aria-label="关闭提示" onClick={onDismissError} type="button"><X size={13} /></button></div> : null}

        {selection ? (
          <div className="mb-1.5 flex items-center justify-between gap-3 rounded-md bg-stone-100 px-2.5 py-1.5 text-[10px] text-stone-600">
            <span className="inline-flex min-w-0 items-center gap-1.5"><Code2 className="shrink-0" size={12} /><span className="truncate">正在围绕 {selection.filePath} 第 {selection.startLine}-{selection.endLine} 行协作</span></span>
            <button className="shrink-0 font-medium text-stone-800 hover:underline" onClick={onClearSelection} type="button">取消引用</button>
          </div>
        ) : null}

        {!draft && !changeSet && starters.length ? (
          <div className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5">
            {starters.map((starter) => <button className="shrink-0 rounded-full border border-stone-200 bg-white px-2.5 py-1.5 text-[10px] text-stone-600 hover:bg-stone-50" key={starter} onClick={() => onChangeDraft(starter)} type="button">{starter}</button>)}
          </div>
        ) : null}

        <div className="flex items-end gap-2 rounded-xl border border-stone-300 bg-white p-1.5 shadow-sm transition focus-within:border-stone-500 focus-within:ring-2 focus-within:ring-stone-100">
          <textarea
            className="max-h-28 min-h-12 flex-1 resize-none bg-transparent px-1.5 py-1 text-sm leading-5 text-stone-900 outline-none placeholder:text-stone-400"
            disabled={busy || Boolean(changeSet)}
            maxLength={1600}
            onChange={(event) => onChangeDraft(event.target.value)}
            placeholder={mode === "task" ? "安排一项边界清楚的辅助工作，例如补测试或整理重复逻辑…" : "讨论整体方案、运行错误，或先选中代码再从原生右键菜单发起…"}
            value={draft}
          />
          <button aria-label="发送给 AI 组员" className="grid size-8 shrink-0 place-items-center rounded-lg bg-stone-950 text-white transition hover:bg-stone-800 disabled:opacity-40" disabled={busy || Boolean(changeSet) || !draft.trim()} title="发送" type="submit">{busy ? <LoaderCircle className="animate-spin" size={14} /> : <Send size={14} />}</button>
        </div>
      </form>
    </section>
  );
}
