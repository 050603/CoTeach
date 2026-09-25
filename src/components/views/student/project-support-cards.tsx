"use client";

import { useState, type MouseEvent } from "react";
import { BookOpen, ChevronDown, ExternalLink, Globe2, Pencil, Save, Target, Trash2, X } from "lucide-react";
import type {
  ProjectMemoryEntry,
  ProjectMemoryKind,
  ProjectReplyBlock,
  ProjectSupportDetails,
} from "@/lib/ai-collaboration/project-support-types";
import { AiMemberMarkdown } from "./ai-member-markdown";
import styles from "./project-citations.module.css";

type CitableSource = { id?: string; title: string };

export function ProjectSourceNumber({ number }: { number: number }) {
  return <span className={styles.number}>{number}</span>;
}

export function projectSourceAnchorId(scope: string, index: number): string {
  return `project-source-${scope.replace(/[^a-zA-Z0-9_-]/g, "-")}-${index + 1}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Convert only source IDs that the server actually returned into local links. */
export function linkedProjectSourceIds(content: string, sources: CitableSource[], scope: string): string {
  const citations = sources.flatMap((source, index) => source.id
    ? [{ id: source.id, link: `[<sup>${index + 1}</sup>](#${projectSourceAnchorId(scope, index)})` }]
    : []).sort((left, right) => right.id.length - left.id.length);
  if (!citations.length) return content;
  return content.split(/(```[\s\S]*?```|\[[^\]]*\]\([^)]+\))/g).map((part) => {
    if (part.startsWith("```")) return part;
    if (/^\[[^\]]*\]\([^)]+\)$/.test(part)) return part;
    let linked = part;
    for (const citation of citations) {
      const id = escapeRegExp(citation.id);
      linked = linked
        .replaceAll(`[${citation.id}]`, citation.link)
        .replaceAll(`\`${citation.id}\``, citation.link)
        .replace(new RegExp(`${id}(?![\\w:-])`, "g"), citation.link);
    }
    return linked;
  }).join("");
}

function revealProjectSource(event: MouseEvent<HTMLElement>, scope: string, sources: CitableSource[]) {
  const element = event.target as HTMLElement;
  const link = element.closest("a");
  const href = link?.getAttribute("href");
  const button = element.closest('button[data-streamdown="link"]');
  const numberedButton = button?.querySelector("sup")?.textContent?.match(/^\d+$/);
  const targetId = href?.startsWith("#")
    ? href.slice(1)
    : numberedButton ? projectSourceAnchorId(scope, Number(numberedButton[0]) - 1) : undefined;
  if (!targetId || !sources.some((_, index) => projectSourceAnchorId(scope, index) === targetId)) return;
  const target = document.getElementById(targetId);
  const details = target?.closest("details");
  if (details) details.open = true;
  if (target) {
    event.preventDefault();
    if (button) event.stopPropagation();
    target.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    target.focus({ preventScroll: true });
  }
}

export function ProjectCitedMarkdown({ content, sources = [], citationScope }: {
  content: string;
  sources?: CitableSource[];
  citationScope: string;
}) {
  return (
    <div className={styles.markdown} onClickCapture={(event) => revealProjectSource(event, citationScope, sources)}>
      <AiMemberMarkdown content={linkedProjectSourceIds(content, sources, citationScope)} />
    </div>
  );
}

function SourceCitationLinks({ content, sourceIds, sources, scope }: {
  content: string;
  sourceIds: string[];
  sources: CitableSource[];
  scope: string;
}) {
  const ids = sourceIds.filter((id) => !content.includes(id));
  if (!ids.length) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-stone-500">
      <BookOpen aria-hidden="true" className="text-stone-400" size={12} />
      <span className="mr-0.5">参考来源</span>
      {ids.flatMap((id) => {
        const index = sources.findIndex((source) => source.id === id);
        if (index < 0) return [];
        return [<a
          aria-label={`查看参考 ${index + 1}：${sources[index].title}`}
          className={`${styles.number} ${styles.numberLink}`}
          href={`#${projectSourceAnchorId(scope, index)}`}
          key={id}
          onClick={(event) => revealProjectSource(event, scope, sources)}
          title={sources[index].title}
        >{index + 1}</a>];
      })}
    </div>
  );
}

const MEMORY_LABEL: Record<ProjectMemoryKind, string> = {
  "project-goal": "项目目标",
  "student-decision": "我的决定",
  "attempt-result": "尝试与结果",
  "open-question": "待解决问题",
};

const BLOCK_LABEL: Record<ProjectReplyBlock["type"], string> = {
  answer: "",
  analysis: "现状分析",
  reason: "为什么",
  suggestion: "建议做法",
  "next-step": "下一步",
};

/** Only split old messages when they clearly contain several template headings. */
export function projectReplyBlocksForDisplay(content: string, support?: ProjectSupportDetails): ProjectReplyBlock[] | undefined {
  if (support?.replyBlocks?.length) return support.replyBlocks;
  if (content.includes("```")) return undefined;
  const matches = [...content.matchAll(/(^|\n)[ \t]*(观察|具体观察|为什么重要|可执行支架|建议|下一步验证)[ \t]*[：:][ \t]*/gm)];
  if (matches.length < 2) return undefined;
  const typeFor = (label: string): ProjectReplyBlock["type"] => {
    if (label === "为什么重要") return "reason";
    if (label === "可执行支架" || label === "建议") return "suggestion";
    if (label === "下一步验证") return "next-step";
    return "analysis";
  };
  const blocks: ProjectReplyBlock[] = [];
  const prefix = content.slice(0, matches[0].index).trim();
  if (prefix) blocks.push({ type: "answer", content: prefix, sourceIds: [] });
  matches.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const body = content.slice(start, matches[index + 1]?.index ?? content.length).trim();
    if (body) blocks.push({ type: typeFor(match[2]), content: body, sourceIds: [] });
  });
  return blocks.length ? blocks : undefined;
}

export function ProjectReplyContent({ content, support, citationScope = "reply" }: {
  content: string;
  support?: ProjectSupportDetails;
  citationScope?: string;
}) {
  const blocks = projectReplyBlocksForDisplay(content, support);
  const sources = support?.sources ?? [];
  if (!blocks?.length) return <>
    <ProjectCitedMarkdown citationScope={citationScope} content={content} sources={sources} />
    <SourceCitationLinks content={content} scope={citationScope} sourceIds={sources.map((source) => source.id)} sources={sources} />
  </>;
  const blockSourceIds = new Set(blocks.flatMap((block) => block.sourceIds));
  return (
    <div className="min-w-0 space-y-3">
      {blocks.map((block, index) => (
        <section className={index ? "border-t border-stone-100 pt-2.5" : ""} key={`${block.type}-${index}`}>
          {BLOCK_LABEL[block.type] ? <h4 className="mb-1 text-[11px] font-semibold text-slate-600">{BLOCK_LABEL[block.type]}</h4> : null}
          <ProjectCitedMarkdown citationScope={citationScope} content={block.content} sources={sources} />
          <SourceCitationLinks content={block.content} scope={citationScope} sourceIds={block.sourceIds} sources={sources} />
        </section>
      ))}
      <SourceCitationLinks content={blocks.map((block) => block.content).join("\n")} scope={citationScope} sourceIds={sources.map((source) => source.id).filter((id) => !blockSourceIds.has(id))} sources={sources} />
    </div>
  );
}

export function ProjectSupportCard({ support, replyContent, citationScope = "reply" }: {
  support?: ProjectSupportDetails;
  replyContent?: string;
  citationScope?: string;
}) {
  if (!support) return null;
  const knowledgePoints = support.knowledgePoints ?? (support.knowledgePointIds ?? []).map((id) => ({ id, label: id }));
  const hasNextStepBlock = projectReplyBlocksForDisplay(replyContent ?? "", support)?.some((block) => block.type === "next-step") ?? false;
  const hasDetails = support.sources.length > 0 || knowledgePoints.length > 0 || (!hasNextStepBlock && support.nextStep);
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
              {textbookCount ? `${textbookCount} 条教材参考` : ""}
              {textbookCount && webCount ? " · " : ""}
              {webCount ? `${webCount} 条网页来源` : ""}
            </span>
            <ChevronDown className="ml-auto text-stone-400" size={13} />
          </summary>
          <div className="mt-2 space-y-2">
            {support.sources.map((source, index) => (
              <div className="scroll-mt-24 rounded-md bg-white px-2.5 py-2 ring-1 ring-stone-200" id={projectSourceAnchorId(citationScope, index)} key={source.id} tabIndex={-1}>
                <div className="flex items-start gap-1.5 font-semibold text-stone-800">
                  {source.type === "textbook" ? <BookOpen className="mt-0.5 shrink-0 text-blue-700" size={12} /> : <Globe2 className="mt-0.5 shrink-0 text-emerald-700" size={12} />}
                  <span className="min-w-0 flex-1">
                    <span className="mr-1.5 inline-flex align-middle"><ProjectSourceNumber number={index + 1} /></span>
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
      {knowledgePoints.length ? (
        <div className="rounded-lg bg-violet-50 px-2.5 py-2 text-violet-950">
          <p className="font-semibold">本轮关联知识</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {knowledgePoints.map((point) => <span className="rounded-full bg-white px-2 py-0.5 ring-1 ring-violet-200" key={point.id}>{point.label}</span>)}
          </div>
          <p className="mt-1 text-[10px] text-violet-700">如果这个关联不符合你当前的困难，可以在下一条消息中直接纠正 AI 组员。</p>
        </div>
      ) : null}
      {support.nextStep && !hasNextStepBlock ? (
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
