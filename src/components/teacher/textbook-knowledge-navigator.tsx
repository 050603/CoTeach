"use client";

import { ChevronDown, ChevronRight, LibraryBig, ListCollapse, ListTree } from "lucide-react";
import { useMemo, useState } from "react";
import type { TextbookConcept, TextbookRelation, TextbookSection } from "@/app/teacher/textbooks/textbook-view-types";
import { buildChapterTree, chapterPath } from "@/lib/textbook/browse-model";
import styles from "./textbook-reader.module.css";

export function TextbookKnowledgeNavigator({ sections, concepts, selectedSectionId, onSelectSection, className }: {
  sections: TextbookSection[];
  concepts: TextbookConcept[];
  relations?: TextbookRelation[];
  selectedSectionId: string;
  selectedConceptId?: string | null;
  onSelectSection: (id: string) => void;
  onSelectConcept?: (id: string, sectionId: string) => void;
  className?: string;
}) {
  const tree = useMemo(() => buildChapterTree(sections), [sections]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const ancestors = useMemo(() => new Set(chapterPath(sections, selectedSectionId).map(s => s.id)), [sections, selectedSectionId]);
  const counts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const concept of concepts) {
      if (!concept.sectionId) continue;
      for (const section of chapterPath(sections, concept.sectionId)) counts.set(section.id, (counts.get(section.id) || 0) + 1);
    }
    return counts;
  }, [sections, concepts]);
  const known = useMemo(() => new Set(sections.map(s => s.id)), [sections]);
  const unassigned = concepts.filter(c => !c.sectionId || !known.has(c.sectionId)).length;
  function renderNode(node: (typeof tree)[number], depth: number, number: string) {
    const open = !collapsed.has(node.section.id) && (expanded.has(node.section.id) || ancestors.has(node.section.id));
    return <li key={node.section.id}>
      <div className={styles.chapterRow} data-active={selectedSectionId === node.section.id || undefined} style={{ paddingLeft: Math.min(depth, 5) * 14 + 8 }}>
        {node.children.length ? <button type="button" className={styles.disclosure} aria-label={`${open ? "收起" : "展开"}目录：${node.section.title}`} aria-expanded={open} onClick={() => {
          setExpanded(current => new Set(current).add(node.section.id));
          setCollapsed(current => { const next = new Set(current); if (open) next.add(node.section.id); else next.delete(node.section.id); return next; });
        }}>{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button> : <span className={styles.disclosureDot} />}
        <button type="button" aria-current={selectedSectionId === node.section.id ? "page" : undefined} onClick={() => onSelectSection(node.section.id)} className={styles.chapterLink}>
          <small>{number}</small><span>{node.section.title}</span><em>{counts.get(node.section.id) || 0}</em>
        </button>
      </div>
      {open && node.children.length > 0 && <ol>{node.children.map((child, i) => renderNode(child, depth + 1, `${number}.${i + 1}`))}</ol>}
    </li>;
  }
  return <nav className={`${styles.navigator} ${className || ""}`} aria-label="教材章节目录">
    <div className={styles.navTitle}><LibraryBig size={18} /><h2>章节目录</h2><span>{sections.length} 节</span></div>
    <button type="button" className={styles.overviewLink} aria-current={selectedSectionId === "all" ? "page" : undefined} onClick={() => onSelectSection("all")}>全书概览 <span>{concepts.length} 个知识点</span></button>
    <div className={styles.treeActions}><button type="button" onClick={() => { setExpanded(new Set(sections.map(s => s.id))); setCollapsed(new Set()); }}><ListTree size={14} />展开</button><button type="button" onClick={() => { setExpanded(new Set()); setCollapsed(new Set(sections.map(s => s.id))); }}><ListCollapse size={14} />收起</button></div>
    <ol className={styles.chapterTree}>{tree.map((node, i) => renderNode(node, 0, `${i + 1}`))}</ol>
    {unassigned > 0 && <button type="button" className={styles.overviewLink} aria-current={selectedSectionId === "unassigned" ? "page" : undefined} onClick={() => onSelectSection("unassigned")}>未归类知识 <span>{unassigned}</span></button>}
  </nav>;
}
