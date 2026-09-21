"use client";

import { ChevronRight, Circle, FolderTree, ListCollapse, ListTree } from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";
import type { TextbookConcept, TextbookRelation, TextbookSection } from "@/app/teacher/textbooks/textbook-view-types";
import styles from "./textbook-knowledge-navigator.module.css";

type SectionNode = { section: TextbookSection; children: SectionNode[] };

function conceptName(concept: TextbookConcept) {
  return concept.name || concept.title || "未命名知识点";
}

function normalizedLabel(value: string) {
  return value.trim().replace(/\s+/g, "").toLocaleLowerCase();
}

function buildSectionTree(sections: TextbookSection[]) {
  const knownIds = new Set(sections.map(section => section.id));
  const childMap = new Map<string, TextbookSection[]>();
  const roots: TextbookSection[] = [];
  for (const section of sections) {
    if (section.parentId && knownIds.has(section.parentId)) {
      childMap.set(section.parentId, [...(childMap.get(section.parentId) || []), section]);
    } else {
      roots.push(section);
    }
  }
  const toNode = (section: TextbookSection, visited: Set<string>): SectionNode => {
    if (visited.has(section.id)) return { section, children: [] };
    const nextVisited = new Set(visited).add(section.id);
    return { section, children: (childMap.get(section.id) || []).filter(child => !nextVisited.has(child.id)).map(child => toNode(child, nextVisited)) };
  };
  const nodes = roots.map(section => toNode(section, new Set()));
  const covered = new Set<string>();
  const record = (node: SectionNode) => {
    if (covered.has(node.section.id)) return;
    covered.add(node.section.id);
    node.children.forEach(record);
  };
  nodes.forEach(record);
  for (const section of sections) {
    if (!covered.has(section.id)) {
      const node = toNode(section, new Set());
      nodes.push(node);
      record(node);
    }
  }
  return nodes;
}

export function TextbookKnowledgeNavigator({
  sections,
  concepts,
  selectedSectionId,
  selectedConceptId,
  onSelectSection,
  onSelectConcept,
  className,
}: {
  sections: TextbookSection[];
  concepts: TextbookConcept[];
  relations: TextbookRelation[];
  selectedSectionId: string;
  selectedConceptId: string | null;
  onSelectSection: (sectionId: string) => void;
  onSelectConcept: (conceptId: string, sectionId: string) => void;
  className?: string;
}) {
  const defaultCollapsedSections = () => new Set(sections.filter(section => (section.level || 0) >= 1).map(section => section.id));
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(defaultCollapsedSections);
  const [unassignedCollapsed, setUnassignedCollapsed] = useState(false);
  const sectionTree = useMemo(() => buildSectionTree(sections), [sections]);
  const sectionIds = useMemo(() => new Set(sections.map(section => section.id)), [sections]);
  const directConcepts = useMemo(() => {
    const result = new Map<string, TextbookConcept[]>();
    for (const concept of concepts) {
      if (!concept.sectionId || !sectionIds.has(concept.sectionId)) continue;
      result.set(concept.sectionId, [...(result.get(concept.sectionId) || []), concept]);
    }
    return result;
  }, [concepts, sectionIds]);
  const unassigned = useMemo(() => concepts.filter(concept => !concept.sectionId || !sectionIds.has(concept.sectionId)), [concepts, sectionIds]);
  const descendantCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const visit = (node: SectionNode): number => {
      const count = (directConcepts.get(node.section.id)?.length || 0) + node.children.reduce((sum, child) => sum + visit(child), 0);
      counts.set(node.section.id, count);
      return count;
    };
    sectionTree.forEach(visit);
    return counts;
  }, [directConcepts, sectionTree]);

  function toggled(current: Set<string>, id: string) {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  function renderConcept(concept: TextbookConcept, sectionId: string, depth: number, indexLabel?: string) {
    return <div className={styles.conceptBranch} key={concept.id}>
      <div className={styles.conceptRow} style={{ "--tree-indent": `${Math.min(depth, 5) * 12}px` } as CSSProperties}>
        {indexLabel ? <span className={styles.leafIndex}>{indexLabel}</span> : <span className={styles.leafMarker}><Circle size={5} fill="currentColor" /></span>}
        <button
          aria-current={selectedConceptId === concept.id ? "true" : undefined}
          className={styles.conceptButton}
          data-active={selectedConceptId === concept.id || undefined}
          type="button"
          onClick={() => onSelectConcept(concept.id, sectionId)}
        >{conceptName(concept)}</button>
      </div>
    </div>;
  }

  function renderSection(node: SectionNode, depth: number, indexLabel: string) {
    const sectionConcepts = directConcepts.get(node.section.id) || [];
    const mergedConcept = sectionConcepts.find(concept => normalizedLabel(conceptName(concept)) === normalizedLabel(node.section.title));
    const nestedConcepts = mergedConcept ? sectionConcepts.filter(concept => concept.id !== mergedConcept.id) : sectionConcepts;
    const isKnowledgeLeaf = node.children.length === 0 && sectionConcepts.length > 0;
    if (isKnowledgeLeaf) {
      return <div className={styles.sectionBranch} key={node.section.id}>
        {sectionConcepts.map((concept, index) => renderConcept(concept, node.section.id, depth, index === 0 ? indexLabel : undefined))}
      </div>;
    }
    const hasChildren = node.children.length > 0 || nestedConcepts.length > 0;
    const collapsed = collapsedSections.has(node.section.id);
    return <div className={styles.sectionBranch} key={node.section.id}>
      <div className={styles.sectionRow} style={{ "--tree-indent": `${Math.min(depth, 4) * 12}px` } as CSSProperties}>
        {hasChildren ? <button
          aria-label={`${collapsed ? "展开" : "收起"}目录：${node.section.title}`}
          aria-expanded={!collapsed}
          className={styles.disclosure}
          type="button"
          onClick={() => {
            const next = toggled(collapsedSections, node.section.id);
            setCollapsedSections(next);
          }}
        ><ChevronRight data-expanded={!collapsed || undefined} size={14} /></button> : <span className={styles.leafMarker}><Circle size={5} fill="currentColor" /></span>}
        <button
          aria-current={mergedConcept && selectedConceptId === mergedConcept.id ? "true" : undefined}
          aria-pressed={mergedConcept ? undefined : selectedSectionId === node.section.id}
          className={styles.sectionButton}
          data-active={(mergedConcept ? selectedConceptId === mergedConcept.id : selectedSectionId === node.section.id) || undefined}
          type="button"
          onClick={() => mergedConcept ? onSelectConcept(mergedConcept.id, node.section.id) : onSelectSection(node.section.id)}
        >
          <small>{indexLabel}</small>
          <span><strong>{node.section.title}</strong><small>{descendantCounts.get(node.section.id) || 0} 个知识点</small></span>
        </button>
      </div>
      {hasChildren && !collapsed ? <div className={styles.sectionChildren}>
        {nestedConcepts.map(concept => renderConcept(concept, node.section.id, depth + 1))}
        {node.children.map((child, index) => renderSection(child, depth + 1, `${indexLabel}.${index + 1}`))}
      </div> : null}
    </div>;
  }

  return <nav className={`${styles.navigator} ${className || ""}`} aria-label="教材知识目录">
    <div className={styles.heading}>
      <div><small>KNOWLEDGE INDEX</small><h2><FolderTree size={15} />知识目录</h2></div>
      <span>{sections.length} 节 · {concepts.length} 点</span>
    </div>
    <button className={styles.allButton} data-active={selectedSectionId === "all" || undefined} aria-pressed={selectedSectionId === "all"} type="button" onClick={() => {
      onSelectSection("all");
    }}>
      <span>全部知识图谱</span><small>{concepts.length} 个节点</small>
    </button>
    <div className={styles.treeActions} aria-label="目录层级控制">
      <button type="button" onClick={() => {
        setCollapsedSections(new Set());
        setUnassignedCollapsed(false);
      }}><ListTree size={13} />展开目录</button>
      <button type="button" onClick={() => {
        setCollapsedSections(defaultCollapsedSections());
        setUnassignedCollapsed(true);
      }}><ListCollapse size={13} />收起层级</button>
    </div>
    <div className={styles.treeScroll}>
      {sectionTree.map((node, index) => renderSection(node, 0, String(index + 1).padStart(2, "0")))}
      {unassigned.length ? <div className={styles.unassignedGroup}>
        <div className={styles.sectionRow}>
          <button aria-label={`${unassignedCollapsed ? "展开" : "收起"}未归类知识点`} aria-expanded={!unassignedCollapsed} className={styles.disclosure} type="button" onClick={() => {
            const next = !unassignedCollapsed;
            setUnassignedCollapsed(next);
          }}><ChevronRight data-expanded={!unassignedCollapsed || undefined} size={14} /></button>
          <button aria-pressed={selectedSectionId === "unassigned"} className={styles.sectionButton} data-active={selectedSectionId === "unassigned" || undefined} type="button" onClick={() => onSelectSection("unassigned")}><small>—</small><span><strong>未归类知识点</strong><small>{unassigned.length} 个知识点</small></span></button>
        </div>
        {!unassignedCollapsed ? <div className={styles.sectionChildren}>{unassigned.map(concept => renderConcept(concept, "unassigned", 1))}</div> : null}
      </div> : null}
    </div>
  </nav>;
}
