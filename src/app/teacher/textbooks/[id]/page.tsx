"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { BookOpen, ChevronLeft, List, LoaderCircle, Network, RefreshCw } from "lucide-react";
import { Dialog } from "radix-ui";
import Link from "next/link";
import { PlatformError, PlatformLoading } from "@/components/platform/platform-feedback";
import { TeacherPlatformHeader, TeacherPlatformPage } from "@/components/platform/teacher-shell";
import { TextbookKnowledgeNavigator } from "@/components/teacher/textbook-knowledge-navigator";
import { TextbookReadingPane } from "@/components/teacher/textbook-reading-pane";
import { TextbookConceptDetail } from "@/components/teacher/textbook-concept-detail";
import { TextbookSearch, type TextbookSearchResult } from "@/components/teacher/textbook-search";
import { useTextbookBrowseState } from "@/components/teacher/textbook-browse-state";
import { teacherPlatformFetch } from "@/lib/platform/client";
import type { BrowseState } from "@/lib/textbook/browse-model";
import type { TextbookDetailPayload } from "../textbook-view-types";
import styles from "@/components/teacher/textbook-reader.module.css";

const TextbookGraphExplorer = dynamic(() => import("@/components/teacher/textbook-graph-explorer").then(m => m.TextbookGraphExplorer), { ssr: false, loading: () => <PlatformLoading label="正在打开知识图谱…" /> });
type ResponsePayload = TextbookDetailPayload & { data?: TextbookDetailPayload; message?: string; error?: string };

export default function TeacherTextbookDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [payload, setPayload] = useState<TextbookDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const { state, navigate, rememberBlock } = useTextbookBrowseState(payload);
  const load = useCallback(async (quiet = false) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    if (!quiet) setLoading(true);
    setError("");
    try {
      const response = await teacherPlatformFetch(`/api/textbooks/${encodeURIComponent(id)}`, { cache: "no-store", signal: controller.signal });
      const raw = await response.json() as ResponsePayload;
      if (!response.ok) throw new Error(raw.message || raw.error || "教材暂时无法加载");
      if (!controller.signal.aborted) setPayload(raw.data || raw);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "教材暂时无法加载"); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [id]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => { clearTimeout(timer); requestRef.current?.abort(); }; }, [load]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1199px)");
    const update = () => setNarrow(media.matches); update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const status = (payload?.revision?.status || payload?.textbook.currentRevision?.status || payload?.job?.status || "PENDING").toUpperCase();
  const progress = payload?.job?.progress;
  const progressLabel = typeof progress === "number" && Number.isFinite(progress) ? ` ${Math.max(0, Math.min(100, Math.round(progress)))}%` : "";
  const failed = ["FAILED", "ERROR", "CANCELLED"].includes(status);
  const working = !failed && !["READY", "COMPLETED", "SUCCEEDED"].includes(status);
  useEffect(() => {
    if (!payload || !working) return;
    const timer = setTimeout(() => void load(true), 5000);
    return () => clearTimeout(timer);
  }, [load, payload, working]);
  function go(patch: Partial<BrowseState>) { navigate(patch); setNavOpen(false); }
  function selectSearch(result: TextbookSearchResult) {
    go({ view: result.kind === "原文" || result.kind === "章节" ? "read" : state.view, sectionId: result.sectionId, conceptId: result.conceptId || null, blockId: result.blockId || null });
  }
  async function retry() {
    setRetrying(true);
    try {
      const response = await teacherPlatformFetch(`/api/textbooks/${encodeURIComponent(id)}/retry`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "重新解析失败");
      await load(true);
    } catch (e) { setError(e instanceof Error ? e.message : "重新解析失败"); }
    finally { setRetrying(false); }
  }
  const selected = payload?.concepts?.find(c => c.id === state.conceptId);
  const detail = payload && selected ? <TextbookConceptDetail payload={payload} concept={selected} navigate={go} /> : undefined;
  const nav = payload ? <TextbookKnowledgeNavigator sections={payload.sections || []} concepts={payload.concepts || []} selectedSectionId={state.sectionId} onSelectSection={sectionId => go({ sectionId, conceptId: null, blockId: null })} /> : null;
  return <TeacherPlatformPage>
    <TeacherPlatformHeader compact active="textbooks" backHref="/teacher/textbooks" backLabel="返回教材库" />
    <div className={styles.page}>
      {loading ? <PlatformLoading label="正在打开教材…" /> : !payload ? <PlatformError message={error || "教材不存在"} onRetry={() => void load()} /> : <>
        <header className={styles.bookHeader}>
          <div className={styles.bookIdentity}><Link href="/teacher/textbooks" className={styles.backLink}><ChevronLeft size={14} />教材库</Link><h1>{payload.textbook.title}</h1><p>{payload.textbook.author || payload.textbook.authors || "作者信息待补充"}<span>版本 {payload.revision?.version || payload.textbook.currentRevision?.version || 1}</span><span>{payload.concepts?.length || 0} 个知识点</span>{payload.textbook.archivedAt && <span>已归档</span>}</p></div>
          <TextbookSearch payload={payload} onSelect={selectSearch} />
        </header>
        <div className={styles.viewBar}>
          <div className={styles.tabs} role="tablist" aria-label="教材浏览方式"><button role="tab" aria-selected={state.view === "read"} type="button" onClick={() => go({ view: "read", blockId: null })}><BookOpen size={17} />章节阅读</button><button role="tab" aria-selected={state.view === "graph"} type="button" onClick={() => go({ view: "graph", blockId: null })}><Network size={17} />知识图谱</button></div>
          <button type="button" className={styles.mobileNavButton} onClick={() => setNavOpen(true)}><List size={17} />目录</button>
          <span className={styles.viewHint}>{state.view === "read" ? "阅读教材，连接每一条知识" : "从整书到章节，探索知识之间的联系"}</span>
        </div>
        {error && <PlatformError message={error} onRetry={() => void load(true)} />}
        {(working || failed) && <div className={styles.parseStatus} role="status">{working ? <LoaderCircle size={17} className="animate-spin" /> : <RefreshCw size={17} />}<span>{failed ? payload.job?.error || "解析未完成，可重新尝试。" : status.includes("WAITING") ? "等待检索服务就绪，已解析的章节仍可浏览。" : `正在整理章节与知识${progressLabel}，页面会自动更新。`}</span>{failed && <button type="button" disabled={retrying} onClick={() => void retry()}>{retrying ? "正在重试…" : "重新解析"}</button>}</div>}
        <div className={styles.workbench} data-testid="textbook-workbench" data-view={state.view} data-detail-open={state.view === "read" && selected && !narrow ? "true" : undefined}>
          <div className={styles.desktopNav}>{nav}</div>
          {state.view === "read" ? <><TextbookReadingPane payload={payload} state={state} navigate={go} onVisibleBlock={rememberBlock} />{!narrow && detail}</> : <TextbookGraphExplorer concepts={payload.concepts || []} relations={payload.relations || []} sections={payload.sections || []} focusedSectionId={state.sectionId} selectedId={state.conceptId} onSelectSection={sectionId => go({ sectionId, conceptId: null, blockId: null })} onSelect={conceptId => go({ conceptId, blockId: null })} detail={detail} />}
        </div>
        <Dialog.Root open={navOpen} onOpenChange={setNavOpen}><Dialog.Portal><Dialog.Overlay className={styles.drawerOverlay} /><Dialog.Content className={`${styles.mobileDrawer} ${styles.leftDrawer}`} aria-describedby={undefined}><Dialog.Title className="sr-only">教材章节目录</Dialog.Title><Dialog.Close className={styles.drawerClose}>关闭目录</Dialog.Close>{nav}</Dialog.Content></Dialog.Portal></Dialog.Root>
        <Dialog.Root open={narrow && state.view === "read" && Boolean(selected)} onOpenChange={open => { if (!open) go({ conceptId: null }); }}><Dialog.Portal><Dialog.Overlay className={styles.drawerOverlay} /><Dialog.Content className={styles.mobileDrawer} aria-describedby={undefined}><Dialog.Title className="sr-only">知识点详情</Dialog.Title>{detail}</Dialog.Content></Dialog.Portal></Dialog.Root>
      </>}
    </div>
  </TeacherPlatformPage>;
}
