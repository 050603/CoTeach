"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, ChevronRight, Network, Shapes } from "lucide-react";
import type { TextbookConcept, TextbookDetailPayload, TextbookFigure } from "@/app/teacher/textbooks/textbook-view-types";
import { buildChapterTree, chapterPath, conceptLabel, type BrowseState } from "@/lib/textbook/browse-model";
import { ResilientImage } from "@/components/resilient-image";
import styles from "./textbook-reader.module.css";

const tones = ["#3875df", "#15978a", "#a27712", "#8860d0", "#ce6479", "#258cae"];
export function TextbookFigureView({ figure }: { figure: TextbookFigure }) {
  const src = figure.url || (figure.fileAssetId || figure.assetId ? `/api/uploads/${figure.fileAssetId || figure.assetId}` : "");
  if (!src) return null;
  return <figure className={styles.figure}><ResilientImage src={src} width={figure.width || 800} height={figure.height || 500} alt={figure.alt || figure.caption || "教材插图"} unoptimized /><figcaption>{figure.caption || "教材插图"}</figcaption></figure>;
}
export function TextbookReadingPane({ payload, state, navigate, onVisibleBlock }: { payload: TextbookDetailPayload; state: BrowseState; navigate: (patch: Partial<BrowseState>) => void; onVisibleBlock: (id: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const sections = useMemo(() => payload.sections || [], [payload.sections]);
  const concepts = payload.concepts || [];
  const tree = useMemo(() => buildChapterTree(sections), [sections]);
  const ordered = useMemo(() => {
    const result: typeof sections = [];
    const visit = (nodes: typeof tree) => { for (const node of nodes) { result.push(node.section); visit(node.children); } };
    visit(tree); return result;
  }, [tree]);
  const selected = sections.find(s => s.id === state.sectionId);
  const sectionIds = new Set(sections.map(s => s.id));
  const inSection = (sectionId?: string | null) => state.sectionId === "unassigned" ? !sectionId || !sectionIds.has(sectionId) : sectionId === state.sectionId;
  const sectionConcepts = concepts.filter(c => inSection(c.sectionId));
  const blocks = (payload.sourceBlocks || []).filter(b => inSection(b.sectionId) && b.metadata?.isDirectory !== true).sort((a, b) => (a.position || 0) - (b.position || 0));
  const figures = (payload.figures || []).filter(f => inSection(f.sectionId)).sort((a, b) => (a.position || 0) - (b.position || 0));
  const figureByBlock = new Map<string, TextbookFigure[]>();
  for (const f of figures) if (f.sourceBlockId) figureByBlock.set(f.sourceBlockId, [...(figureByBlock.get(f.sourceBlockId) || []), f]);
  const children = sections.filter(s => s.parentId === state.sectionId);
  const at = ordered.findIndex(s => s.id === state.sectionId);
  const path = chapterPath(sections, state.sectionId);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const target = state.blockId ? document.getElementById(`source-${state.blockId}`) : null;
      if (target) target.scrollIntoView?.({ block: "center", behavior: "instant" });
      else if (window.matchMedia("(max-width: 900px)").matches) {
        if (state.sectionId === "all") window.scrollTo({ top: 0, behavior: "instant" });
        else host.current?.scrollIntoView?.({ block: "start", behavior: "instant" });
      }
      else host.current?.scrollTo?.({ top: 0 });
    });
    return () => cancelAnimationFrame(frame);
  }, [state.sectionId, state.blockId]);
  useEffect(() => {
    const container = host.current;
    if (!container || typeof IntersectionObserver === "undefined") return;
    const media = window.matchMedia("(max-width: 900px)");
    let observer: IntersectionObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    const observe = () => {
      observer?.disconnect();
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      // Wait until chapter/evidence scrolling has settled before recording position.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          const visible = new Set<HTMLElement>();
          let restored = state.blockId ? document.getElementById(`source-${state.blockId}`) : null;
          let restoredSeen = false;
          observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
              const element = entry.target as HTMLElement;
              if (entry.isIntersecting) visible.add(element); else visible.delete(element);
            }
            if (restored && visible.has(restored)) restoredSeen = true;
            if (restored && restoredSeen && !visible.has(restored)) restored = null;
            clearTimeout(timer);
            // The first callback must not replace a restored target with the chapter start.
            if (restored && !restoredSeen) return;
            const current = restored || [...visible].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
            if (current) timer = setTimeout(() => onVisibleBlock(current.dataset.blockId!), 400);
          }, { root: media.matches ? null : container, rootMargin: "0px 0px -20% 0px", threshold: 0 });
          container.querySelectorAll("[data-block-id]").forEach(el => observer?.observe(el));
        });
      });
    };
    observe();
    media.addEventListener("change", observe);
    return () => { media.removeEventListener("change", observe); cancelAnimationFrame(frame); observer?.disconnect(); clearTimeout(timer); };
  }, [onVisibleBlock, state.sectionId, state.blockId, payload.sourceBlocks]);
  function selectSection(id: string) { navigate({ sectionId: id, conceptId: null, blockId: null }); }
  return <div className={styles.readingPane} ref={host} aria-label="教材阅读区">
    <div className={styles.breadcrumb}><button type="button" onClick={() => selectSection("all")}>全书</button>{path.map(s => <span key={s.id}><ChevronRight size={13} /><button type="button" onClick={() => selectSection(s.id)}>{s.title}</button></span>)}</div>
    {state.sectionId === "all" ? <>
      <header className={styles.overviewHeading}><span className={styles.kicker}>全书导览</span><h2>从一个章节开始探索</h2><p>{sections.length} 个章节 · {concepts.length} 个知识点 · {payload.figures?.length || 0} 幅教材插图</p></header>
      <div className={styles.chapterCards}>{tree.map((node, index) => {
        const ids = new Set<string>(); const visit = (n: typeof node) => { ids.add(n.section.id); n.children.forEach(visit); }; visit(node);
        const count = concepts.filter(c => ids.has(c.sectionId || "")).length;
        return <button type="button" key={node.section.id} className={styles.chapterCard} onClick={() => selectSection(node.section.id)} style={{ "--chapter-color": tones[index % tones.length] } as React.CSSProperties}>
          <span className={styles.chapterNumber}>{String(index + 1).padStart(2, "0")}</span><div><h3>{node.section.title}</h3><p>{node.children.length ? `${node.children.length} 个子章节 · ` : ""}{count} 个知识点</p>{node.children.length > 0 && <small>{node.children.slice(0, 3).map(child => child.section.title).join(" / ")}</small>}</div><ArrowRight size={18} />
        </button>;
      })}</div>
      {!tree.length && <div className={styles.emptyState}><BookOpen size={30} /><h3>章节目录尚未就绪</h3><p>结构解析完成后，可在这里阅读教材。</p></div>}
      <button type="button" className={styles.graphInvitation} onClick={() => navigate({ view: "graph", sectionId: "all", blockId: null })}><span><Network size={24} /></span><div><strong>换个角度，看看知识之间的联系</strong><p>按章节探索知识图谱，追踪先修与应用关系。</p></div><ArrowRight size={20} /></button>
    </> : <>
      <header className={styles.readingHeading}><span className={styles.kicker}>{state.sectionId === "unassigned" ? "未归类内容" : "章节阅读"}</span><h2>{selected?.title || "未归类知识与原文"}</h2><p>{sectionConcepts.length} 个知识点 · {blocks.length} 段原文</p></header>
      {children.length > 0 && <div className={styles.childChapters} aria-label="子章节">{children.map(s => <button type="button" key={s.id} onClick={() => selectSection(s.id)}><BookOpen size={16} /><span>{s.title}</span><ChevronRight size={16} /></button>)}</div>}
      {sectionConcepts.length > 0 && <SectionKnowledgeChips key={state.sectionId} concepts={sectionConcepts} selectedId={state.conceptId} navigate={navigate} />}
      <article className={styles.prose}>{blocks.map(block => {
        const type = (block.blockType || "PARAGRAPH").toUpperCase();
        return <section key={block.id} id={`source-${block.id}`} data-block-id={block.id} className={styles.sourceBlock} data-highlighted={state.blockId === block.id || undefined}>
          {type === "HEADING" || type === "TITLE" ? <h3>{block.content}</h3> : type === "TABLE" ? <pre aria-label="教材表格文本">{block.content}</pre> : type === "LIST_ITEM" ? <div className={styles.listBlock}><span aria-hidden="true">•</span><p>{block.content}</p></div> : type === "CAPTION" ? <small>{block.content}</small> : <p>{block.content}</p>}
          {figureByBlock.get(block.id)?.map(f => <TextbookFigureView key={f.id} figure={f} />)}
        </section>;
      })}</article>
      {figures.filter(f => !f.sourceBlockId || !blocks.some(b => b.id === f.sourceBlockId)).map(f => <TextbookFigureView key={f.id} figure={f} />)}
      {!blocks.length && !children.length && <p className={styles.muted}>本节暂时没有可展示的原文。可以先查看已整理的知识点。</p>}
      <footer className={styles.readingPagination}>{at > 0 ? <button type="button" onClick={() => selectSection(ordered[at - 1].id)}><ArrowLeft size={17} /><span><small>上一节</small>{ordered[at - 1].title}</span></button> : <span />}{at >= 0 && at < ordered.length - 1 && <button type="button" onClick={() => selectSection(ordered[at + 1].id)}><span><small>下一节</small>{ordered[at + 1].title}</span><ArrowRight size={17} /></button>}</footer>
    </>}
  </div>;
}

function SectionKnowledgeChips({ concepts, selectedId, navigate }: { concepts: TextbookConcept[]; selectedId: string | null; navigate: (patch: Partial<BrowseState>) => void }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? concepts : concepts.filter((concept, index) => index < 8 || concept.id === selectedId);
  return <section className={styles.knowledgeStrip} aria-label="本节知识点">
    <h3><Shapes size={16} />本节知识</h3>
    <div>{visible.map(concept => <button type="button" key={concept.id} aria-pressed={selectedId === concept.id} onClick={() => navigate({ conceptId: concept.id, blockId: null })}>{conceptLabel(concept)}<ChevronRight size={13} /></button>)}</div>
    {concepts.length > 8 && <button type="button" aria-expanded={expanded} style={{ minHeight: 44, color: "#3768d8", fontSize: 12 }} onClick={() => setExpanded(value => !value)}>{expanded ? "收起知识点" : `展开全部 ${concepts.length} 个知识点`}</button>}
  </section>;
}
