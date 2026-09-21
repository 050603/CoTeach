"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { BookMarked, BookOpen, ImageIcon, Layers3, LoaderCircle, Network, Quote, RefreshCw, Route } from "lucide-react";
import { PlatformError, PlatformLoading } from "@/components/platform/platform-feedback";
import { TeacherPlatformHeader, TeacherPlatformPage } from "@/components/platform/teacher-shell";
import { ResilientImage } from "@/components/resilient-image";
import { TextbookGraphExplorer } from "@/components/teacher/textbook-graph-explorer";
import { DialogDescription, DialogTitle, Drawer, DrawerContent } from "@/components/ui";
import { teacherPlatformFetch } from "@/lib/platform/client";
import type {
  TextbookConcept,
  TextbookDetailPayload,
  TextbookRelation,
  TextbookSection,
  TextbookSourceBlock,
} from "../textbook-view-types";
import styles from "../textbooks.module.css";

type DetailResponse = TextbookDetailPayload & { data?: TextbookDetailPayload; message?: string; error?: string };

function conceptName(concept: TextbookConcept) {
  return concept.name || concept.title || "未命名知识点";
}

function relationEnds(relation: TextbookRelation) {
  return {
    source: relation.sourceConceptId || relation.sourceId || "",
    target: relation.targetConceptId || relation.targetId || "",
  };
}

function relationLabel(relation: TextbookRelation) {
  const value = (relation.relationType || relation.type || "related").toLocaleLowerCase();
  const labels: Record<string, string> = {
    prerequisite: "先修",
    requires: "依赖",
    supports: "支持",
    application: "应用",
    applies: "应用",
    comparison: "对比",
    contrasts: "对比",
    contains: "包含",
    part_of: "属于",
    related: "相关",
  };
  return labels[value] || relation.relationType || relation.type || "相关";
}

function relationIsInferred(relation: TextbookRelation) {
  return relation.inferred ?? (Boolean(relation.origin) && relation.origin !== "TEXTBOOK");
}

function sectionDisplay(section: TextbookSection | undefined) {
  if (!section) return "章节位置待整理";
  if (Array.isArray(section.path) && section.path.length) return section.path.join(" / ");
  if (typeof section.path === "string" && section.path) return section.path;
  return section.title;
}

function revisionStatus(payload: TextbookDetailPayload) {
  const status = (payload.job?.status || payload.revision?.status || payload.textbook.currentRevision?.status || payload.textbook.status || "PENDING").toUpperCase();
  if (["READY", "COMPLETED", "SUCCEEDED"].includes(status)) return { label: "解析完成", tone: "ready" as const };
  if (status.includes("WAITING") || status.includes("CONFIG")) return { label: "等待向量服务", tone: "waiting" as const };
  if (["FAILED", "ERROR", "CANCELLED"].some(value => status.includes(value))) return { label: "解析失败", tone: "failed" as const };
  return { label: "正在解析", tone: "working" as const };
}

function directAndDescendantSectionIds(sections: TextbookSection[], selectedId: string) {
  if (selectedId === "all") return new Set(sections.map(section => section.id));
  const ids = new Set([selectedId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const section of sections) {
      if (section.parentId && ids.has(section.parentId) && !ids.has(section.id)) {
        ids.add(section.id);
        changed = true;
      }
    }
  }
  return ids;
}

function evidenceQuotes(concept: TextbookConcept, blocks: TextbookSourceBlock[]) {
  const blockMap = new Map(blocks.map(block => [block.id, block]));
  const evidence = concept.evidence || [];
  const results: Array<{ text: string; block?: TextbookSourceBlock }> = [];
  const used = new Set<string>();
  for (const item of evidence) {
    const block = blockMap.get(item.sourceBlockId);
    const text = item.quote?.trim() || block?.content?.trim();
    if (!text || used.has(`${item.sourceBlockId}:${text}`)) continue;
    used.add(`${item.sourceBlockId}:${text}`);
    results.push({ text, block });
  }
  for (const blockId of concept.sourceBlockIds || []) {
    const block = blockMap.get(blockId);
    const text = block?.content?.trim();
    if (!text || used.has(`${blockId}:${text}`)) continue;
    used.add(`${blockId}:${text}`);
    results.push({ text, block });
  }
  if (!results.length && concept.sourceExcerpt?.trim()) results.push({ text: concept.sourceExcerpt.trim() });
  return results;
}

function exampleText(item: { content?: string; description?: string }) {
  return item.content || item.description || "案例内容待整理";
}

export default function TeacherTextbookDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [payload, setPayload] = useState<TextbookDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [selectedSectionId, setSelectedSectionId] = useState("all");
  const [selectedConceptId, setSelectedConceptId] = useState<string | null>(null);

  const load = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (!id) return;
    if (!quiet) setLoading(true);
    setError("");
    try {
      const response = await teacherPlatformFetch(`/api/textbooks/${encodeURIComponent(id)}`, { cache: "no-store" });
      const raw = await response.json().catch(() => ({})) as DetailResponse;
      if (!response.ok) throw new Error(raw.message || raw.error || "教材详情暂时无法加载");
      const data = raw.data || raw;
      setPayload(data);
      const concepts = data.concepts || [];
      const sections = data.sections || [];
      const firstSectionId = sections.find(section => concepts.some(concept => concept.sectionId === section.id))?.id || "all";
      setSelectedSectionId(current => current === "all" ? firstSectionId : current);
      setSelectedConceptId(current => concepts.some(concept => concept.id === current) ? current : null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "教材详情暂时无法加载");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const status = useMemo(() => payload ? revisionStatus(payload) : null, [payload]);
  useEffect(() => {
    if (!payload || !status || !["working", "waiting"].includes(status.tone)) return;
    const timer = window.setTimeout(() => {
      void teacherPlatformFetch(`/api/textbooks/${encodeURIComponent(id)}/job`, { cache: "no-store" })
        .then(async response => {
          const data = await response.json().catch(() => ({})) as { job?: TextbookDetailPayload["job"]; status?: string; progress?: number; message?: string; error?: string };
          if (!response.ok) throw new Error(data.message || data.error || "解析进度暂时无法更新");
          const job = data.job || (data.status ? { status: data.status, progress: data.progress, message: data.message } : null);
          if (!job) return;
          const jobStatus = (job.status || "").toUpperCase();
          if (["READY", "COMPLETED", "SUCCEEDED", "FAILED", "ERROR", "CANCELLED"].some(value => jobStatus.includes(value))) {
            await load({ quiet: true });
            return;
          }
          setPayload(current => current ? { ...current, job } : current);
        })
        .catch(reason => setError(reason instanceof Error ? reason.message : "解析进度暂时无法更新"));
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [id, load, payload, status]);

  const sections = useMemo(() => payload?.sections || [], [payload?.sections]);
  const concepts = useMemo(() => payload?.concepts || [], [payload?.concepts]);
  const relations = useMemo(() => payload?.relations || [], [payload?.relations]);
  const allowedSections = useMemo(() => directAndDescendantSectionIds(sections, selectedSectionId), [sections, selectedSectionId]);
  const sectionConcepts = useMemo(() => concepts.filter(concept => selectedSectionId === "all" || concept.sectionId && allowedSections.has(concept.sectionId)).slice(0, 24), [allowedSections, concepts, selectedSectionId]);
  const graphConceptIds = useMemo(() => new Set(sectionConcepts.map(concept => concept.id)), [sectionConcepts]);
  const sectionRelations = useMemo(() => relations.filter(relation => {
    const ends = relationEnds(relation);
    return graphConceptIds.has(ends.source) && graphConceptIds.has(ends.target);
  }), [graphConceptIds, relations]);
  const sectionConceptCounts = useMemo(() => new Map(sections.map(section => {
    const ids = directAndDescendantSectionIds(sections, section.id);
    return [section.id, concepts.filter(concept => concept.sectionId && ids.has(concept.sectionId)).length];
  })), [concepts, sections]);
  const selectedConcept = concepts.find(concept => concept.id === selectedConceptId) || null;
  const selectedSection = sections.find(section => section.id === selectedConcept?.sectionId);
  const filteredSection = sections.find(section => section.id === selectedSectionId);
  const quotes = selectedConcept ? evidenceQuotes(selectedConcept, payload?.sourceBlocks || []) : [];
  const examples = selectedConcept ? (payload?.examples || []).filter(item => item.conceptId === selectedConcept.id || item.conceptIds?.includes(selectedConcept.id)) : [];
  const figures = selectedConcept ? (payload?.figures || []).filter(item => item.conceptId === selectedConcept.id || item.conceptIds?.includes(selectedConcept.id)) : [];
  const related = selectedConcept ? relations.flatMap(relation => {
    const ends = relationEnds(relation);
    if (ends.source === selectedConcept.id) {
      const concept = concepts.find(item => item.id === ends.target);
      return concept ? [{ concept, label: relationLabel(relation), inferred: relationIsInferred(relation) }] : [];
    }
    if (ends.target === selectedConcept.id) {
      const concept = concepts.find(item => item.id === ends.source);
      return concept ? [{ concept, label: relationLabel(relation), inferred: relationIsInferred(relation) }] : [];
    }
    return [];
  }) : [];

  function selectSection(sectionId: string) {
    setSelectedSectionId(sectionId);
    setSelectedConceptId(null);
  }

  async function retry() {
    if (!id) return;
    setRetrying(true);
    setError("");
    try {
      const response = await teacherPlatformFetch(`/api/textbooks/${encodeURIComponent(id)}/retry`, { method: "POST" });
      const data = await response.json().catch(() => ({})) as { message?: string; error?: string };
      if (!response.ok) throw new Error(data.message || data.error || "重新解析任务启动失败");
      await load({ quiet: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重新解析任务启动失败");
    } finally {
      setRetrying(false);
    }
  }

  if (loading) return <TeacherPlatformPage><TeacherPlatformHeader compact active="textbooks" backHref="/teacher/textbooks" backLabel="返回教材库" /><div className="pbl-workspace-content"><PlatformLoading label="正在打开教材…" /></div></TeacherPlatformPage>;
  if (!payload) return <TeacherPlatformPage><TeacherPlatformHeader compact active="textbooks" backHref="/teacher/textbooks" backLabel="返回教材库" /><div className="pbl-workspace-content"><PlatformError message={error || "教材不存在或您没有访问权限"} onRetry={() => void load()} /></div></TeacherPlatformPage>;

  return <TeacherPlatformPage>
    <TeacherPlatformHeader compact active="textbooks" backHref="/teacher/textbooks" backLabel="返回教材库" />
    <div className={`pbl-workspace-content ${styles.page} ${styles.detailPage}`}>
      <header className={styles.detailHeading}>
        <div className={styles.detailIdentity}>
          <span className={styles.detailBookIcon} aria-hidden="true"><BookMarked size={24} strokeWidth={1.6} /></span>
          <div>
          <p className={styles.eyebrow}>教材知识工作台</p>
          <h1>{payload.textbook.title}</h1>
          {payload.textbook.description ? <p className={styles.detailDescription}>{payload.textbook.description}</p> : null}
          <div className={styles.detailMeta}>
            <span>{payload.textbook.author || payload.textbook.authors || "作者信息待补充"}</span>
            <span>教材版本 {payload.revision?.version ?? payload.textbook.currentRevision?.version ?? 1}</span>
            {status ? <span className={styles.statusBadge} data-tone={status.tone}>{status.label}{status.tone !== "ready" && payload.job?.progress != null ? ` ${Math.max(0, Math.min(100, Math.round(payload.job.progress <= 1 ? payload.job.progress * 100 : payload.job.progress)))}%` : ""}</span> : null}
            {payload.textbook.archivedAt ? <span className={styles.statusBadge}>已归档</span> : null}
          </div>
          </div>
        </div>
        <dl className={styles.detailStats} aria-label="教材解析概况">
          <div><dt>章节</dt><dd>{sections.length}</dd></div>
          <div><dt>知识点</dt><dd>{concepts.length}</dd></div>
          <div><dt>关系</dt><dd>{relations.length}</dd></div>
          <div><dt>原图</dt><dd>{payload.figures?.length || 0}</dd></div>
        </dl>
      </header>

      {error ? <PlatformError message={error} onRetry={() => void load()} /> : null}
      {status?.tone === "failed" ? <div className={styles.inlineError}>
        <span className="flex-1">{payload.job?.error || payload.job?.message || "教材解析未完成，可从失败阶段重新开始。"}</span>
        <button className={styles.secondaryButton} disabled={retrying} type="button" onClick={() => void retry()}>{retrying ? <LoaderCircle className="animate-spin" size={15} /> : <RefreshCw size={15} />}{retrying ? "正在重试…" : "重新解析"}</button>
      </div> : null}

      <div className={styles.detailLayout}>
        <nav className={styles.chapterNav} aria-label="教材章节">
          <div className={styles.sectionTitle}><h2><Layers3 size={15} />章节目录</h2><span>{sections.length} 节</span></div>
          <div className={styles.chapterList}>
            <button className={styles.chapterButton} aria-pressed={selectedSectionId === "all"} data-active={selectedSectionId === "all"} type="button" onClick={() => selectSection("all")}>
              <small>ALL</small><span className={styles.chapterCopy}><span>全部已解析知识</span><small>{concepts.length} 个知识点</small></span>
            </button>
            {sections.map((section, index) => <button
              className={styles.chapterButton}
              aria-pressed={selectedSectionId === section.id}
              data-active={selectedSectionId === section.id}
              key={section.id}
              type="button"
              style={{ paddingLeft: `${8 + Math.min(section.level || 0, 3) * 10}px` }}
              onClick={() => selectSection(section.id)}
            ><small>{String(index + 1).padStart(2, "0")}</small><span className={styles.chapterCopy}><span>{section.title}</span><small>{sectionConceptCounts.get(section.id) || 0} 个知识点</small></span></button>)}
          </div>
        </nav>

        <section className={styles.graphPanel} aria-labelledby="textbook-graph-heading">
          <div className={styles.sectionTitle}><h2 id="textbook-graph-heading"><Network size={15} />知识图谱</h2><span>{sectionConcepts.length} 个当前节点</span></div>
          <div className={styles.graphToolbar}>
            <div><small>当前范围</small><strong>{filteredSection?.title || "全部章节"}</strong></div>
            <span className={styles.graphToolbarHint}>点击知识点查看教材依据与关联内容</span>
          </div>
          <TextbookGraphExplorer concepts={sectionConcepts} relations={sectionRelations} selectedId={selectedConceptId} onSelect={setSelectedConceptId} />
          <p className={styles.graphHint}><Route size={13} />关系按知识方向从左向右排列，选择节点后会突出直接关联；当前范围最多展示 24 个节点。</p>
        </section>
      </div>

      <Drawer open={Boolean(selectedConcept)} onOpenChange={open => { if (!open) setSelectedConceptId(null); }}>
        <DrawerContent className={`pbl-platform-theme ${styles.conceptDrawer}`}>
          {selectedConcept ? <>
            <header className={styles.drawerHeader}>
              <span className={styles.drawerIcon} aria-hidden="true"><BookOpen size={18} /></span>
              <div>
                <DialogTitle className={styles.drawerTitle}>{conceptName(selectedConcept)}</DialogTitle>
                <DialogDescription className={styles.drawerDescription}>{sectionDisplay(selectedSection)}</DialogDescription>
              </div>
            </header>
            <div className={styles.drawerBody}>
            <div className={styles.evidenceBody}>
            <div className={styles.conceptHeader}>
              <span className={styles.conceptEyebrow}>知识点说明</span>
              <p>{selectedConcept.explanation || selectedConcept.summary || "这条知识的整理说明仍在处理中。"}</p>
              {selectedConcept.aliases?.length ? <div className={styles.aliasList} aria-label="知识点别名">{selectedConcept.aliases.map(alias => <span key={alias}>{alias}</span>)}</div> : null}
            </div>

            <section className={styles.evidenceGroup}>
              <h4><Quote size={14} />教材原文 <span>{quotes.length}</span></h4>
              {quotes.length ? quotes.map((quote, index) => <blockquote className={styles.quote} key={`${quote.block?.id || "excerpt"}-${index}`}>
                {quote.text}
                <cite>{sectionDisplay(sections.find(section => section.id === quote.block?.sectionId))}{quote.block?.blockKey ? ` · ${quote.block.blockKey}` : ""}</cite>
              </blockquote>) : <p className={styles.graphHint}>当前节点还没有可展示的原文证据。</p>}
            </section>

            {examples.length ? <section className={styles.evidenceGroup}>
              <h4>教材案例 <span>{examples.length}</span></h4>
              {examples.map(item => <div className={styles.example} key={item.id}><strong>{item.title || "教材原例"}</strong>{exampleText(item)}</div>)}
            </section> : null}

            {figures.length ? <section className={styles.evidenceGroup}>
              <h4><ImageIcon size={14} />教材插图 <span>{figures.length}</span></h4>
              <div className={styles.figureGrid}>{figures.map(figure => {
                const src = figure.url || (figure.fileAssetId || figure.assetId ? `/api/uploads/${figure.fileAssetId || figure.assetId}` : "");
                if (!src) return null;
                const caption = figure.caption || figure.alt || "教材插图";
                return <figure className={styles.figure} key={figure.id}>
                  <ResilientImage alt={caption} src={src} width={480} height={360} sizes="(max-width: 1180px) 45vw, 300px" unoptimized />
                  <figcaption>{caption}</figcaption>
                </figure>;
              })}</div>
            </section> : null}

            {related.length ? <section className={styles.evidenceGroup}>
              <h4>知识关系 <span>{related.length}</span></h4>
              <div className={styles.relationList}>{related.map(({ concept, label, inferred }, index) => <button className={styles.relationButton} key={`${concept.id}-${index}`} type="button" onClick={() => setSelectedConceptId(concept.id)}><span>{label}{inferred ? " · 推断" : ""}</span><strong>{conceptName(concept)}</strong></button>)}</div>
            </section> : null}
            </div>
            </div>
          </> : null}
        </DrawerContent>
      </Drawer>
    </div>
  </TeacherPlatformPage>;
}
