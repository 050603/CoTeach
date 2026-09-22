"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { BookOpen, FileText, LoaderCircle, Search, Shapes, X } from "lucide-react";
import type { TextbookDetailPayload } from "@/app/teacher/textbooks/textbook-view-types";
import { chapterPath, conceptLabel } from "@/lib/textbook/browse-model";
import { teacherPlatformFetch } from "@/lib/platform/client";
import type { TextbookEvidenceSearchResult } from "@/lib/textbook/types";
import styles from "./textbook-reader.module.css";

export type TextbookSearchResult = { id: string; kind: "章节" | "知识点" | "原文"; title: string; path: string; sectionId: string; conceptId?: string; blockId?: string };
export function TextbookSearch({ payload, onSelect }: { payload: TextbookDetailPayload; onSelect: (result: TextbookSearchResult) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<TextbookSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const listId = useId();
  const normalized = query.trim().toLocaleLowerCase();
  const local = useMemo(() => {
    if (!normalized) return [];
    const sections = payload.sections || [];
    const path = (id: string) => chapterPath(sections, id).map(s => s.title).join(" / ") || "未归类";
    return [
      ...sections.filter(s => s.title.toLocaleLowerCase().includes(normalized)).slice(0, 8).map(s => ({ id: `section-${s.id}`, kind: "章节" as const, title: s.title, path: path(s.id), sectionId: s.id })),
      ...(payload.concepts || []).filter(c => `${conceptLabel(c)} ${(c.aliases || []).join(" ")}`.toLocaleLowerCase().includes(normalized)).slice(0, 12).map(c => ({ id: `concept-${c.id}`, kind: "知识点" as const, title: conceptLabel(c), path: path(c.sectionId || ""), sectionId: c.sectionId || "unassigned", conceptId: c.id })),
    ];
  }, [normalized, payload]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setRemote([]); setMessage("");
      if (!normalized) { setLoading(false); return; }
      setLoading(true);
      try {
        const response = await teacherPlatformFetch(`/api/textbooks/${encodeURIComponent(payload.textbook.id)}/search?q=${encodeURIComponent(query.trim())}&limit=12`, { signal: controller.signal });
        const data = await response.json() as TextbookEvidenceSearchResult & { message?: string };
        if (!response.ok) throw new Error(data.message || "原文检索暂时不可用");
        if (controller.signal.aborted) return;
        setRemote((data.hits || []).map(hit => ({ id: hit.retrievalItemId, kind: "原文", title: hit.content, path: chapterPath(payload.sections || [], hit.sectionId || "").map(s => s.title).join(" / ") || "未归类原文", sectionId: hit.sectionId || "unassigned", blockId: hit.sourceBlockId || undefined, conceptId: hit.conceptId || undefined })));
        if (data.degraded) setMessage(data.degradationReason || "当前仅使用关键词检索");
      } catch (error) {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "原文检索失败，请重试");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [normalized, payload.sections, payload.textbook.id, query, retry]);
  useEffect(() => {
    const close = (e: PointerEvent) => { if (!host.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const results = [...local, ...remote];
  const activeResultId = open && normalized && results[active] ? `${listId}-${active}` : undefined;
  useEffect(() => {
    if (activeResultId) document.getElementById(activeResultId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeResultId]);
  function select(result: TextbookSearchResult) { onSelect(result); setOpen(false); setQuery(""); setRemote([]); inputRef.current?.focus(); }
  return <div ref={host} className={styles.bookSearch}>
    <Search size={18} aria-hidden="true" />
    <input ref={inputRef} role="combobox" aria-label="搜索本书" aria-expanded={open && Boolean(normalized)} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined} placeholder="搜索章节、知识点或原文…" value={query} onFocus={() => setOpen(true)} onChange={e => { setQuery(e.target.value); setRemote([]); setMessage(""); setActive(0); setOpen(true); }} onKeyDown={e => {
      if (e.key === "Escape") setOpen(false);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); setActive(i => Math.max(0, Math.min(results.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))); }
      if (e.key === "Enter" && open && results[active]) { e.preventDefault(); select(results[active]); }
    }} />
    {query && <button aria-label="清空搜索" type="button" onClick={() => { setQuery(""); setRemote([]); inputRef.current?.focus(); }}><X size={16} /></button>}
    {open && normalized && <div className={styles.searchDropdown}>
      <div className={styles.searchCaption}>搜索本书 <span>{loading ? <LoaderCircle size={14} className="animate-spin" /> : `${results.length} 条结果`}</span></div>
      <ul id={listId} role="listbox" aria-label="书内搜索结果">{results.map((result, i) => <li id={`${listId}-${i}`} key={result.id} role="option" aria-selected={active === i} onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => select(result)}>
        {result.kind === "章节" ? <BookOpen size={17} /> : result.kind === "知识点" ? <Shapes size={17} /> : <FileText size={17} />}<div><small>{result.kind} · {result.path}</small><p>{result.title}</p></div>
      </li>)}</ul>
      {!results.length && !loading && <p className={styles.searchMessage}>没有匹配的结果，试试其他关键词。</p>}
      {message && <p className={styles.searchMessage} role="status">{message}<button type="button" onClick={() => setRetry(i => i + 1)}>重试原文检索</button></p>}
    </div>}
  </div>;
}
