"use client";

import { useState } from "react";
import { BookOpen, ChevronDown, ExternalLink, Globe2, Pencil, Save, Target, Trash2, X } from "lucide-react";
import type {
  ProjectMemoryEntry,
  ProjectMemoryKind,
  ProjectSupportDetails,
} from "@/lib/ai-collaboration/project-support-types";

const MEMORY_LABEL: Record<ProjectMemoryKind, string> = {
  "project-goal": "项目目标",
  "student-decision": "我的决定",
  "attempt-result": "尝试与结果",
  "open-question": "待解决问题",
};

export function ProjectSupportCard({ support }: { support?: ProjectSupportDetails }) {
  if (!support) return null;
  const knowledgePoints = support.knowledgePoints ?? (support.knowledgePointIds ?? []).map((id) => ({ id, label: id }));
  const hasDetails = support.sources.length > 0 || knowledgePoints.length > 0 || support.nextStep || support.retrievalStatus === "unavailable";
  if (!hasDetails) return null;
  const textbookCount = support.sources.filter((source) => source.type === "textbook").length;
  const webCount = support.sources.filter((source) => source.type === "web").length;
  return (
    <div className="mt-2 space-y-1.5 border-t border-stone-100 pt-2 text-[11px] leading-4">
      {support.sources.length ? (
        <details className="rounded-lg border border-stone-200 bg-stone-50/80 px-2.5 py-2">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 font-semibold text-stone-700">
            {textbookCount ? <BookOpen size={13} /> : <Globe2 size={13} />}
            <span>
              {textbookCount ? `${textbookCount} 条教材依据` : ""}
              {textbookCount && webCount ? " · " : ""}
              {webCount ? `${webCount} 条网页来源` : ""}
            </span>
            <ChevronDown className="ml-auto text-stone-400" size={13} />
          </summary>
          <div className="mt-2 space-y-2">
            {support.sources.map((source) => (
              <div className="rounded-md bg-white px-2.5 py-2 ring-1 ring-stone-200" key={source.id}>
                <div className="flex items-start gap-1.5 font-semibold text-stone-800">
                  {source.type === "textbook" ? <BookOpen className="mt-0.5 shrink-0 text-blue-700" size={12} /> : <Globe2 className="mt-0.5 shrink-0 text-emerald-700" size={12} />}
                  <span className="min-w-0 flex-1">
                    {source.url ? (
                      <a className="inline-flex items-center gap-1 hover:underline" href={source.url} rel="noreferrer" target="_blank">
                        {source.title}<ExternalLink size={10} />
                      </a>
                    ) : source.title}
                    {source.locator ? <span className="mt-0.5 block font-normal text-stone-500">{source.locator}</span> : null}
                  </span>
                </div>
                <p className="mt-1 text-stone-600">{source.excerpt}</p>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {support.retrievalStatus === "unavailable" && support.retrievalNote ? (
        <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-amber-800">{support.retrievalNote}</p>
      ) : null}
      {knowledgePoints.length ? (
        <div className="rounded-lg bg-violet-50 px-2.5 py-2 text-violet-950">
          <p className="font-semibold">本轮关联知识</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {knowledgePoints.map((point) => <span className="rounded-full bg-white px-2 py-0.5 ring-1 ring-violet-200" key={point.id}>{point.label}</span>)}
          </div>
          <p className="mt-1 text-[10px] text-violet-700">如果这个关联不符合你当前的困难，可以在下一条消息中直接纠正 AI 组员。</p>
        </div>
      ) : null}
      {support.nextStep ? (
        <div className="flex items-start gap-1.5 rounded-lg bg-blue-50 px-2.5 py-2 text-blue-900">
          <Target className="mt-0.5 shrink-0" size={12} />
          <span><strong className="font-semibold">下一步验证：</strong>{support.nextStep}</span>
        </div>
      ) : null}
    </div>
  );
}

export function ProjectMemoryPanel({
  memories,
  continuation,
  onUpdate,
  onDelete,
  onClear,
}: {
  memories: ProjectMemoryEntry[];
  continuation?: string;
  onUpdate: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  const activeEditingId = editingId && memories.some((memory) => memory.id === editingId)
    ? editingId
    : null;

  return (
    <details className="mt-2 rounded-lg border border-stone-200 bg-stone-50/70 text-xs text-stone-700">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-2 font-semibold">
        <Target className="text-blue-700" size={13} />
        <span>项目记忆</span>
        <span className="font-normal text-stone-400">{memories.length ? `${memories.length} 条` : "暂无"}</span>
        <ChevronDown className="ml-auto text-stone-400" size={13} />
      </summary>
      <div className="max-h-64 overflow-y-auto border-t border-stone-200 px-2.5 py-2.5">
        {continuation ? <p className="mb-2 rounded-md bg-blue-50 px-2.5 py-2 leading-5 text-blue-900">{continuation}</p> : null}
        {!memories.length ? (
          <p className="leading-5 text-stone-500">后续对话中明确的目标、决定、尝试结果和待解决问题会出现在这里。AI 的建议不会自动变成你的决定。</p>
        ) : (
          <div className="space-y-2">
            {memories.map((memory) => (
              <div className="rounded-md bg-white px-2.5 py-2 ring-1 ring-stone-200" key={memory.id}>
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-[10px] text-stone-500">{MEMORY_LABEL[memory.kind]}</strong>
                  <span className="flex items-center gap-0.5">
                    <button aria-label="修改这条项目记忆" className="grid size-6 place-items-center rounded hover:bg-stone-100" onClick={() => { setEditingId(memory.id); setDraft(memory.content); }} type="button"><Pencil size={11} /></button>
                    <button aria-label="删除这条项目记忆" className="grid size-6 place-items-center rounded hover:bg-rose-50 hover:text-rose-700" onClick={() => onDelete(memory.id)} type="button"><Trash2 size={11} /></button>
                  </span>
                </div>
                {activeEditingId === memory.id ? (
                  <div className="mt-1.5">
                    <textarea className="min-h-16 w-full resize-y rounded-md border border-stone-300 px-2 py-1.5 text-xs leading-5 outline-none focus:border-blue-500" maxLength={500} onChange={(event) => setDraft(event.target.value)} value={draft} />
                    <div className="mt-1 flex justify-end gap-1">
                      <button className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-stone-100" onClick={() => setEditingId(null)} type="button"><X size={11} />取消</button>
                      <button className="inline-flex items-center gap-1 rounded bg-stone-900 px-2 py-1 text-white disabled:opacity-40" disabled={!draft.trim()} onClick={() => { onUpdate(memory.id, draft.trim()); setEditingId(null); }} type="button"><Save size={11} />保存</button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-1 whitespace-pre-wrap leading-5 text-stone-800">{memory.content}</p>
                )}
                {memory.sourceMessageIds.length ? (
                  <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-stone-500">
                    <span>依据：</span>
                    {memory.sourceMessageIds.map((id, index) => <a className="hover:underline" href={`#${id}`} key={id}>对话 {index + 1}</a>)}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {memories.length ? (
          <div className="mt-2 flex justify-end">
            {confirmClear ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="text-[10px] text-stone-500">清除全部项目记忆？</span>
                <button className="rounded px-2 py-1 hover:bg-stone-100" onClick={() => setConfirmClear(false)} type="button">取消</button>
                <button className="rounded bg-rose-600 px-2 py-1 text-white" onClick={() => { setConfirmClear(false); onClear(); }} type="button">清除</button>
              </span>
            ) : (
              <button className="text-[10px] text-stone-500 hover:text-rose-700" onClick={() => setConfirmClear(true)} type="button">清除全部项目记忆</button>
            )}
          </div>
        ) : null}
      </div>
    </details>
  );
}
