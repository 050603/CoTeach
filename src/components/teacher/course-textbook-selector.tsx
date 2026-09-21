"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BookMarked, ChevronDown, LoaderCircle } from "lucide-react";
import Link from "next/link";
import type { CourseTextbookSelection } from "@/lib/textbook/course-evidence-types";
import styles from "./course-textbook-selector.module.css";

type TextbookOption = {
  id: string;
  title: string;
  author?: string | null;
  currentRevision?: { id: string; version: number; status: string } | null;
};

type SectionOption = { id: string; title: string; level?: number; parentId?: string | null };

function listFromPayload(payload: unknown): TextbookOption[] {
  if (!payload || typeof payload !== "object") return [];
  const value = payload as { textbooks?: unknown };
  return Array.isArray(value.textbooks) ? value.textbooks.filter((item): item is TextbookOption => Boolean(
    item && typeof item === "object" && typeof (item as TextbookOption).id === "string",
  )) : [];
}

export function CourseTextbookSelector({
  value,
  onChange,
  disabled,
}: {
  value: CourseTextbookSelection[];
  onChange: (value: CourseTextbookSelection[]) => void;
  disabled?: boolean;
}) {
  const [books, setBooks] = useState<TextbookOption[]>([]);
  const [sections, setSections] = useState<Record<string, SectionOption[]>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/textbooks?status=READY", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error("无法加载教材库");
        setBooks(listFromPayload(payload));
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法加载教材库");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const byRevision = useMemo(() => new Map(value.map((item) => [item.revisionId, item])), [value]);

  const loadSections = useCallback(async (book: TextbookOption) => {
    const revisionId = book.currentRevision?.id;
    if (!revisionId || sections[revisionId]) return;
    const response = await fetch(`/api/textbooks/${book.id}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as {
      sections?: SectionOption[];
      textbook?: { sections?: SectionOption[]; currentRevision?: { sections?: SectionOption[] } };
    } | null;
    if (!response.ok) throw new Error("无法读取教材章节");
    const items = payload?.sections ?? payload?.textbook?.sections ?? payload?.textbook?.currentRevision?.sections ?? [];
    setSections((current) => ({ ...current, [revisionId]: items }));
  }, [sections]);

  function toggleBook(book: TextbookOption) {
    const revisionId = book.currentRevision?.id;
    if (!revisionId) return;
    const existing = byRevision.get(revisionId);
    if (existing) {
      const next = value.filter((item) => item.revisionId !== revisionId);
      if (existing.primary && next.length) next[0] = { ...next[0], primary: true };
      onChange(next);
      return;
    }
    onChange([...value, { revisionId, primary: value.length === 0, sectionIds: [] }]);
  }

  function setPrimary(revisionId: string) {
    onChange(value.map((item) => ({ ...item, primary: item.revisionId === revisionId })));
  }

  function toggleSection(revisionId: string, sectionId: string) {
    onChange(value.map((item) => item.revisionId !== revisionId ? item : {
      ...item,
      sectionIds: item.sectionIds.includes(sectionId)
        ? item.sectionIds.filter((id) => id !== sectionId)
        : [...item.sectionIds, sectionId],
    }));
  }

  if (loading) return <div className={styles.loading}><LoaderCircle className="animate-spin" size={16} />正在读取教材库…</div>;
  if (error) return <p className={styles.error} role="alert">{error}</p>;

  return <section className={styles.selector} aria-labelledby="course-textbook-heading">
    <header className={styles.header}>
      <span className={styles.headerIcon} aria-hidden="true"><BookMarked size={19} /></span>
      <div className={styles.headerCopy}>
        <h3 id="course-textbook-heading">课程教材</h3>
        <p>选用已解析教材，课程图谱将保留对应版本与原文依据。</p>
      </div>
      <Link className={styles.manageLink} href="/teacher/textbooks">管理教材库</Link>
    </header>
    {books.length === 0 ? <div className={styles.empty}><p>暂无已就绪教材</p><span>先到教材库导入 DOCX，完成解析后即可在这里选用。</span></div> : <ul className={styles.bookList}>
      {books.map((book) => {
        const revision = book.currentRevision;
        const selected = revision ? byRevision.get(revision.id) : undefined;
        const bookSections = revision ? sections[revision.id] ?? [] : [];
        return <li className={styles.bookItem} data-selected={Boolean(selected) || undefined} key={book.id}>
          <div className={styles.bookRow}>
            <label className={styles.bookCheckbox}>
              <input aria-label={`选择教材：${book.title}`} checked={Boolean(selected)} disabled={disabled || !revision || revision.status.toUpperCase() !== "READY"} onChange={() => toggleBook(book)} type="checkbox" />
              <span aria-hidden="true" />
            </label>
            <button aria-expanded={selected ? expanded === revision?.id : undefined} className={styles.bookIdentity} disabled={!selected} onClick={() => {
              if (!revision) return;
              const next = expanded === revision.id ? null : revision.id;
              setExpanded(next);
              if (next) void loadSections(book).catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取教材章节"));
            }} type="button">
              <span><strong>{book.title}</strong><small>{book.author || "作者未填写"} · 版本 {revision?.version ?? "-"}</small></span>
              {selected ? <ChevronDown className={styles.chevron} data-open={expanded === revision?.id || undefined} size={16} /> : null}
            </button>
            {selected ? <label className={styles.primaryChoice}><input checked={selected.primary} disabled={disabled} name="primary-textbook" onChange={() => setPrimary(selected.revisionId)} type="radio"/><span>主教材</span></label> : null}
          </div>
          {selected && expanded === revision?.id ? <div className={styles.sectionPanel}>
            <div className={styles.sectionPanelHeading}><p>选用章节</p><span>{selected.sectionIds.length ? `已选 ${selected.sectionIds.length} 节` : "默认使用全部正文"}</span></div>
            {bookSections.length ? <div className={styles.sectionGrid}>{bookSections.map((section, index) => <label className={styles.sectionChoice} key={section.id} style={{ paddingLeft: `${Math.min(3, section.level ?? 0) * 12 + 8}px` }}><input checked={selected.sectionIds.includes(section.id)} disabled={disabled} onChange={() => toggleSection(selected.revisionId, section.id)} type="checkbox"/><small>{String(index + 1).padStart(2, "0")}</small><span>{section.title}</span></label>)}</div> : <p className={styles.noSections}>本教材尚未返回可选择的正文章节。</p>}
          </div> : null}
        </li>;
      })}
    </ul>}
    {value.length ? <footer className={styles.selectionSummary}><strong>已选 {value.length} 本教材</strong><span>按主教材组织课程图谱，并固定使用当前版本。</span></footer> : null}
  </section>;
}
