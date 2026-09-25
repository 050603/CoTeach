"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Download, X } from "lucide-react";
import type { FinalArtifactSummary, ShowcaseDisplayMode } from "@/lib/session/types";
import styles from "./showcase-workspace.module.css";

export function artifactLabel(artifact: FinalArtifactSummary): string {
  if (artifact.kind === "pdf") return "PDF / 演示稿";
  if (artifact.kind === "document") return "Word 文档";
  if (artifact.mimeType?.includes("zip") || artifact.mimeType?.includes("compressed")) return "压缩包";
  if (artifact.mimeType?.startsWith("text/") || artifact.mimeType?.includes("javascript") || artifact.mimeType?.includes("json")) return "代码或文本";
  return "额外成果";
}

export function ShowcaseMaterialToolbar({ artifacts, selected, onSelect, displayMode, onDisplayModeChange, tone, children }: {
  artifacts: FinalArtifactSummary[];
  selected?: FinalArtifactSummary;
  onSelect: (artifact: FinalArtifactSummary) => void;
  displayMode: ShowcaseDisplayMode;
  onDisplayModeChange: (mode: ShowcaseDisplayMode) => void;
  tone: "student" | "teacher";
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const filtered = artifacts.filter((artifact) => `${artifact.title} ${artifactLabel(artifact)} ${artifact.sequence}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  return <div className={`${styles.toolbar} ${tone === "student" ? styles.student : ""}`}>
    {children}
    <div className={styles.picker} ref={rootRef}>
      <button aria-controls={listId} aria-expanded={open} aria-haspopup="listbox" aria-label={tone === "student" ? "选择主汇报资料" : "选择学生汇报材料"} className={styles.pickerButton} disabled={!artifacts.length} onClick={() => { setOpen((value) => !value); setQuery(""); }} ref={triggerRef} type="button"><span>{selected?.title ?? "暂无材料"}</span><ChevronDown className="ml-auto shrink-0" size={16} /></button>
      {open ? <div className={styles.pickerMenu} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); triggerRef.current?.focus(); } }}>
        <input aria-label="搜索材料" className={styles.pickerSearch} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名称或类型" ref={searchRef} type="search" value={query} />
        <div aria-label="材料列表" id={listId} role="listbox">{filtered.length ? filtered.map((artifact) => <button aria-selected={artifact.versionId === selected?.versionId} className={styles.pickerOption} key={artifact.versionId} onClick={() => { onSelect(artifact); setOpen(false); triggerRef.current?.focus(); }} role="option" type="button"><span className="block text-[11px] text-[var(--pbl-text-muted)]">{artifactLabel(artifact)} · 第 {artifact.sequence} 版</span><strong className="block font-semibold">{artifact.title}</strong></button>) : <p className="p-3 text-sm text-[var(--pbl-text-muted)]">没有匹配的材料</p>}</div>
      </div> : null}
    </div>
    <div className={styles.toolbarActions}>
      {selected?.kind === "pdf" ? <div aria-label={tone === "student" ? "PDF 预览方式" : "PDF 投屏方式"} className="flex gap-1"><button aria-pressed={displayMode === "continuous"} className={styles.toolbarButton} onClick={() => onDisplayModeChange("continuous")} type="button">连续阅读</button><button aria-pressed={displayMode === "slides"} className={styles.toolbarButton} onClick={() => onDisplayModeChange("slides")} type="button">逐页演示</button></div> : null}
      {selected?.downloadUrl && selected.kind !== "file" ? <a className={styles.toolbarButton} download href={selected.downloadUrl}><Download size={15} />下载</a> : null}
    </div>
  </div>;
}

export function ShowcaseDrawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); }
      if (event.key === "Tab" && dialogRef.current) {
        const controls = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled)")];
        if (!controls.length) return;
        const first = controls[0]!;
        const last = controls[controls.length - 1]!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previousFocus.current?.focus(); };
  }, []);
  return <div className={styles.drawerBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section aria-label={title} aria-modal="true" className={styles.drawer} ref={dialogRef} role="dialog">
      <header className={styles.drawerHeader}><h2 className="text-base font-bold">{title}</h2><button aria-label={`关闭${title}`} className={styles.toolbarButton} onClick={onClose} ref={closeRef} type="button"><X size={18} /></button></header>
      <div className={styles.drawerBody}>{children}</div>
    </section>
  </div>;
}

export { styles as showcaseStyles };
