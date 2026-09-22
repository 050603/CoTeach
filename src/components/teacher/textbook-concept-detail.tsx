"use client";

import { ArrowUpRight, BookOpen, Network, Quote, X } from "lucide-react";
import type { TextbookConcept, TextbookDetailPayload } from "@/app/teacher/textbooks/textbook-view-types";
import { chapterPath, conceptLabel, type BrowseState } from "@/lib/textbook/browse-model";
import { TextbookFigureView } from "./textbook-reading-pane";
import styles from "./textbook-reader.module.css";

const labels: Record<string, string> = { prerequisite: "先修", requires: "依赖", supports: "支持", application: "应用", applies: "应用", comparison: "对比", contrasts: "对比", contains: "包含", parent_of: "包含", part_of: "属于", child_of: "属于", precedes: "先于", related: "相关" };
export function TextbookConceptDetail({ payload, concept, navigate }: { payload: TextbookDetailPayload; concept: TextbookConcept; navigate: (patch: Partial<BrowseState>) => void }) {
  const blocks = new Map((payload.sourceBlocks || []).map(b => [b.id, b]));
  const concepts = new Map((payload.concepts || []).map(c => [c.id, c]));
  const evidence = [...(concept.evidence || []), ...(concept.sourceBlockIds || []).filter(id => !concept.evidence?.some(e => e.sourceBlockId === id)).map(sourceBlockId => ({ sourceBlockId, quote: blocks.get(sourceBlockId)?.content }))];
  const examples = (payload.examples || []).filter(e => e.conceptId === concept.id || e.conceptIds?.includes(concept.id));
  const figures = (payload.figures || []).filter(f => f.conceptId === concept.id || f.conceptIds?.includes(concept.id));
  const relations = (payload.relations || []).flatMap(r => {
    const source = r.sourceConceptId || r.sourceId, target = r.targetConceptId || r.targetId;
    const other = source === concept.id ? concepts.get(target || "") : target === concept.id ? concepts.get(source || "") : undefined;
    return other ? [{ ...r, other, outgoing: source === concept.id }] : [];
  });
  return <aside className={styles.conceptDetail} aria-label="知识点详情">
    <header><span className={styles.detailIcon}><ShapesIcon /></span><div><small>知识点详情</small><h2>{conceptLabel(concept)}</h2></div><button type="button" aria-label="收起知识点详情" onClick={() => navigate({ conceptId: null })}><X size={18} /></button></header>
    <div className={styles.detailBody}>
      <p className={styles.detailPath}>{chapterPath(payload.sections || [], concept.sectionId || "").map(s => s.title).join(" / ") || "未归类知识"}</p>
      <p className={styles.explanation}>{concept.explanation || concept.summary || "这条知识暂未整理说明。"}</p>
      {concept.aliases?.length ? <div className={styles.aliases}>{concept.aliases.map(alias => <span key={alias}>{alias}</span>)}</div> : null}
      <button type="button" className={styles.detailGraphLink} onClick={() => navigate({ view: "graph", sectionId: concept.sectionId || "unassigned", conceptId: concept.id, blockId: null })}><Network size={16} />在图谱中定位<ArrowUpRight size={15} /></button>
      <section><h3><Quote size={16} />教材依据 <span>{evidence.length}</span></h3>{evidence.length ? evidence.map((e, index) => <blockquote key={`${e.sourceBlockId}-${index}`}><p>{e.quote || blocks.get(e.sourceBlockId)?.content || "原文内容暂不可用"}</p>{blocks.has(e.sourceBlockId) && <button type="button" onClick={() => navigate({ view: "read", sectionId: blocks.get(e.sourceBlockId)?.sectionId || "unassigned", blockId: e.sourceBlockId, conceptId: null })}><BookOpen size={14} />查看原文<ArrowUpRight size={13} /></button>}</blockquote>) : <p className={styles.muted}>{concept.sourceExcerpt || "暂无可展示的原文证据。"}</p>}</section>
      {examples.length > 0 && <section><h3>教材案例 <span>{examples.length}</span></h3>{examples.map(e => <div className={styles.example} key={e.id}><h4>{e.title || "教材案例"}</h4><p>{e.content || e.description}</p></div>)}</section>}
      {figures.length > 0 && <section><h3>教材插图 <span>{figures.length}</span></h3>{figures.map(f => <TextbookFigureView key={f.id} figure={f} />)}</section>}
      <section><h3>关联知识 <span>{relations.length}</span></h3>{relations.map((r, i) => <button className={styles.relatedConcept} type="button" key={r.id || i} onClick={() => navigate({ conceptId: r.other.id, sectionId: r.other.sectionId || "unassigned", blockId: null })}><small>{r.outgoing ? "→" : "←"} {labels[(r.relationType || r.type || "related").toLowerCase()] || r.relationType || r.type}{(r.inferred ?? Boolean(r.origin && r.origin !== "TEXTBOOK")) && " · 推断"}</small><strong>{conceptLabel(r.other)}</strong><ArrowUpRight size={14} /></button>)}{!relations.length && <p className={styles.muted}>暂无已记录的关联关系。</p>}</section>
    </div>
  </aside>;
}
function ShapesIcon() { return <Network size={19} />; }
