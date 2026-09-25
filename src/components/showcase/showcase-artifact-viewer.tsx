"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, LoaderCircle } from "lucide-react";
import { RichDocumentPreview } from "@/components/teacher/rich-document-preview";
import type { FinalArtifactSummary, ShowcaseDisplayMode, ShowcasePresentationSnapshot } from "@/lib/session/types";

export type ShowcaseViewerMode = "self" | "controller" | "follower" | "teacher";
export type ShowcaseViewStatePatch = { page?: number; scrollRatio?: number };

export function ShowcaseArtifactViewer({
  courseId,
  artifact,
  mode,
  presentation,
  displayMode,
  teacherFollowing = true,
  onViewStateChange,
}: {
  courseId: string;
  artifact: FinalArtifactSummary;
  mode: ShowcaseViewerMode;
  presentation?: ShowcasePresentationSnapshot;
  displayMode?: ShowcaseDisplayMode;
  teacherFollowing?: boolean;
  onViewStateChange?: (patch: ShowcaseViewStatePatch) => void;
}) {
  const canScroll = mode === "self" || mode === "controller" || (mode === "teacher" && !teacherFollowing);
  const follow = mode === "follower" || (mode === "teacher" && teacherFollowing);
  const [documentHtml, setDocumentHtml] = useState<{ url: string; html: string }>();
  const [error, setError] = useState<{ url: string; message: string }>();
  const contentUrl = `/api/courses/${encodeURIComponent(courseId)}/showcase/artifacts/${encodeURIComponent(artifact.versionId)}`;

  useEffect(() => {
    const controller = new AbortController();
    if (artifact.kind !== "document") return () => controller.abort();
    void fetch(contentUrl, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { html?: string; message?: string } | null;
        if (!response.ok || typeof payload?.html !== "string") throw new Error(payload?.message ?? "文档成果读取失败");
        if (!controller.signal.aborted) setDocumentHtml({ url: contentUrl, html: payload.html });
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError({ url: contentUrl, message: caught instanceof Error ? caught.message : "文档成果读取失败" });
      });
    return () => controller.abort();
  }, [artifact.kind, artifact.versionId, contentUrl]);

  if (error?.url === contentUrl) return <ViewerError message={error.message} />;
  if (artifact.kind === "document") {
    if (!documentHtml || documentHtml.url !== contentUrl) return <ViewerLoading label="正在打开最终文档…" />;
    return (
      <DocumentArtifactViewer
        canScroll={canScroll}
        follow={follow}
        html={documentHtml.html}
        mode={mode}
        onViewStateChange={onViewStateChange}
        presentation={presentation}
      />
    );
  }
  return (
      <PdfArtifactViewer
        canScroll={canScroll}
      contentUrl={contentUrl}
      displayMode={displayMode}
      follow={follow}
      mode={mode}
      onViewStateChange={onViewStateChange}
      presentation={presentation}
    />
  );
}

function DocumentArtifactViewer({
  html,
  mode,
  presentation,
  follow,
  canScroll,
  onViewStateChange,
}: {
  html: string;
  mode: ShowcaseViewerMode;
  presentation?: ShowcasePresentationSnapshot;
  follow: boolean;
  canScroll: boolean;
  onViewStateChange?: (patch: ShowcaseViewStatePatch) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
  }, []);
  useEffect(() => {
    if (!follow) return;
    const ratio = presentation?.viewState?.scrollRatio ?? 0;
    const applyRatio = () => {
      const container = scrollRef.current;
      if (!container) return;
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = maxScroll * Math.min(1, Math.max(0, ratio));
    };
    const frame = window.requestAnimationFrame(applyRatio);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(applyRatio);
    if (observer && scrollRef.current) observer.observe(scrollRef.current.firstElementChild ?? scrollRef.current);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [follow, html, presentation?.viewState?.revision, presentation?.viewState?.scrollRatio]);

  function queueSync() {
    if (mode !== "controller" || !onViewStateChange || timerRef.current !== undefined) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      const container = scrollRef.current;
      if (!container) return;
      const maxScroll = Math.max(1, container.scrollHeight - container.clientHeight);
      onViewStateChange({ scrollRatio: Math.min(1, Math.max(0, container.scrollTop / maxScroll)) });
    }, 140);
  }

  return (
    <div className="relative h-full min-h-72 overflow-hidden rounded-lg bg-stone-100">
      <div className="absolute right-3 top-3 z-10 rounded-full bg-stone-900/75 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur">
        富文档 · 连续阅读{follow ? " · 跟随汇报" : ""}
      </div>
      <div
        aria-label={follow ? "跟随汇报学生的文档" : "最终文档预览"}
        className={`h-full overflow-y-auto p-4 sm:p-7 ${canScroll ? "" : "pointer-events-none overscroll-none"}`}
        onScroll={queueSync}
        ref={scrollRef}
      >
        <div className="mx-auto min-h-full max-w-4xl rounded-lg bg-white p-5 shadow-sm sm:p-8">
          <RichDocumentPreview html={html} minHeight={280} />
        </div>
      </div>
    </div>
  );
}

function PdfArtifactViewer({
  contentUrl,
  mode,
  presentation,
  displayMode,
  follow,
  canScroll,
  onViewStateChange,
}: {
  contentUrl: string;
  mode: ShowcaseViewerMode;
  presentation?: ShowcasePresentationSnapshot;
  displayMode?: ShowcaseDisplayMode;
  follow: boolean;
  canScroll: boolean;
  onViewStateChange?: (patch: ShowcaseViewStatePatch) => void;
}) {
  const [pdf, setPdf] = useState<PdfDocument>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let loaded: PdfDocument | undefined;
    void fetch(contentUrl, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`PDF 读取失败（${response.status}）`);
        const data = await response.arrayBuffer();
        const pdfModuleUrl = "/vendor/pdfjs/pdf.min.mjs";
        const pdfjs = await import(
          /* webpackIgnore: true */
          /* @vite-ignore */
          pdfModuleUrl
        ) as unknown as PdfJsModule;
        pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
        loaded = await pdfjs.getDocument({ data }).promise;
        if (!controller.signal.aborted) setPdf(loaded);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "PDF 读取失败");
      });
    return () => {
      controller.abort();
      void loaded?.destroy?.();
    };
  }, [contentUrl]);
  if (error) return <ViewerError message={error} />;
  if (!pdf) return <ViewerLoading label="正在解析最终 PDF…" />;
  const slides = (presentation?.displayMode ?? displayMode) === "slides";
  return slides ? (
    <PdfSlidesViewer
      canScroll={canScroll}
      follow={follow}
      mode={mode}
      onViewStateChange={onViewStateChange}
      pdf={pdf}
      presentation={presentation}
    />
  ) : (
    <PdfContinuousViewer
      canScroll={canScroll}
      follow={follow}
      mode={mode}
      onViewStateChange={onViewStateChange}
      pdf={pdf}
      presentation={presentation}
    />
  );
}

function PdfContinuousViewer({
  pdf,
  mode,
  presentation,
  follow,
  canScroll,
  onViewStateChange,
}: {
  pdf: PdfDocument;
  mode: ShowcaseViewerMode;
  presentation?: ShowcasePresentationSnapshot;
  follow: boolean;
  canScroll: boolean;
  onViewStateChange?: (patch: ShowcaseViewStatePatch) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
  }, []);
  useEffect(() => {
    if (!follow) return;
    const ratio = presentation?.viewState?.scrollRatio ?? 0;
    const applyRatio = () => {
      const container = scrollRef.current;
      if (!container) return;
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = maxScroll * Math.min(1, Math.max(0, ratio));
    };
    const frame = window.requestAnimationFrame(applyRatio);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(applyRatio);
    if (observer && scrollRef.current) observer.observe(scrollRef.current.firstElementChild ?? scrollRef.current);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [follow, pdf, presentation?.viewState?.revision, presentation?.viewState?.scrollRatio]);
  function queueSync() {
    if (mode !== "controller" || !onViewStateChange || timerRef.current !== undefined) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      const container = scrollRef.current;
      if (!container) return;
      const maxScroll = Math.max(1, container.scrollHeight - container.clientHeight);
      onViewStateChange({ scrollRatio: Math.min(1, Math.max(0, container.scrollTop / maxScroll)) });
    }, 140);
  }
  return (
    <div className="relative h-full min-h-72 overflow-hidden rounded-lg bg-stone-200">
      <div className="absolute right-3 top-3 z-10 rounded-full bg-stone-900/75 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur">
        PDF · 连续阅读{follow ? " · 跟随汇报" : ""}
      </div>
      <div className={`h-full overflow-y-auto p-3 sm:p-5 ${canScroll ? "" : "pointer-events-none overscroll-none"}`} onScroll={queueSync} ref={scrollRef}>
        <div className="mx-auto max-w-5xl space-y-4">
          {Array.from({ length: pdf.numPages }, (_, index) => <PdfPageCanvas key={index + 1} pageNumber={index + 1} pdf={pdf} />)}
        </div>
      </div>
    </div>
  );
}

function PdfSlidesViewer({
  pdf,
  mode,
  presentation,
  follow,
  canScroll,
  onViewStateChange,
}: {
  pdf: PdfDocument;
  mode: ShowcaseViewerMode;
  presentation?: ShowcasePresentationSnapshot;
  follow: boolean;
  canScroll: boolean;
  onViewStateChange?: (patch: ShowcaseViewStatePatch) => void;
}) {
  const [localPage, setLocalPage] = useState(() => presentation?.viewState?.page ?? 1);
  const projectedPage = presentation?.viewState?.page ?? 1;
  const page = follow ? projectedPage : localPage;
  const safePage = Math.min(pdf.numPages, Math.max(1, page));
  function changePage(next: number) {
    const value = Math.min(pdf.numPages, Math.max(1, next));
    setLocalPage(value);
    if (mode === "controller") onViewStateChange?.({ page: value });
  }
  return (
    <div className="flex h-full min-h-72 flex-col overflow-hidden rounded-lg bg-stone-950">
      <div className={`min-h-0 flex-1 items-center justify-center p-3 sm:p-5 ${canScroll ? "flex" : "pointer-events-none flex"}`}>
        <PdfSlideCanvas key={safePage} pageNumber={safePage} pdf={pdf} />
      </div>
      <div className="flex h-14 shrink-0 items-center justify-center gap-4 border-t border-white/10 bg-stone-900 px-4 text-white">
        {canScroll ? <button aria-label="上一页" className="grid size-9 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30" disabled={safePage <= 1} onClick={() => changePage(safePage - 1)} type="button"><ChevronLeft size={19} /></button> : null}
        <span className="min-w-32 text-center text-sm font-semibold">{safePage} / {pdf.numPages}{follow ? " · 跟随汇报" : ""}</span>
        {canScroll ? <button aria-label="下一页" className="grid size-9 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30" disabled={safePage >= pdf.numPages} onClick={() => changePage(safePage + 1)} type="button"><ChevronRight size={19} /></button> : null}
      </div>
    </div>
  );
}

function PdfSlideCanvas({ pdf, pageNumber }: { pdf: PdfDocument; pageNumber: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let task: { promise: Promise<void>; cancel?: () => void } | undefined;
    void pdf.getPage(pageNumber).then((page) => {
      if (cancelled || !canvasRef.current) return;
      const viewport = page.getViewport({ scale: 1.75 });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      task = page.render({ canvas, canvasContext: context, viewport });
      return task.promise;
    }).catch(() => {
      if (!cancelled) setError(true);
    });
    return () => {
      cancelled = true;
      task?.cancel?.();
    };
  }, [pageNumber, pdf]);
  if (error) return <div className="grid aspect-video w-full max-w-6xl place-items-center rounded bg-white text-sm text-rose-700">第 {pageNumber} 页加载失败</div>;
  return <canvas aria-label={`PDF 第 ${pageNumber} 页`} className="block max-h-full max-w-full rounded bg-white shadow-2xl" ref={canvasRef} />;
}

function PdfPageCanvas({ pdf, pageNumber }: { pdf: PdfDocument; pageNumber: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let task: { promise: Promise<void>; cancel?: () => void } | undefined;
    void pdf.getPage(pageNumber).then((page) => {
      if (cancelled || !canvasRef.current) return;
      const viewport = page.getViewport({ scale: 1.55 });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      task = page.render({ canvas, canvasContext: context, viewport });
      return task.promise;
    }).catch(() => {
      if (!cancelled) setError(true);
    });
    return () => {
      cancelled = true;
      task?.cancel?.();
    };
  }, [pageNumber, pdf]);
  if (error) return <div className="grid min-h-40 place-items-center rounded bg-white text-sm text-rose-700">第 {pageNumber} 页加载失败</div>;
  return <canvas aria-label={`PDF 第 ${pageNumber} 页`} className="block w-full rounded bg-white shadow-sm" ref={canvasRef} />;
}

function ViewerLoading({ label }: { label: string }) {
  return <div className="grid h-full min-h-72 place-items-center rounded-lg border border-stone-200 bg-stone-50 text-sm text-stone-500"><span className="inline-flex items-center gap-2"><LoaderCircle className="animate-spin" size={18} />{label}</span></div>;
}

function ViewerError({ message }: { message: string }) {
  return <div className="grid h-full min-h-72 place-items-center rounded-lg border border-rose-200 bg-rose-50 px-5 text-center text-sm text-rose-700"><div><FileText className="mx-auto" size={24} /><p className="mt-2">{message}</p></div></div>;
}

type PdfPage = { getViewport: (input: { scale: number }) => { width: number; height: number }; render: (input: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void>; cancel?: () => void } };
type PdfDocument = { numPages: number; getPage: (pageNumber: number) => Promise<PdfPage>; destroy?: () => Promise<void> };
type PdfJsModule = { GlobalWorkerOptions: { workerSrc: string }; getDocument: (input: { data: ArrayBuffer }) => { promise: Promise<PdfDocument> } };
