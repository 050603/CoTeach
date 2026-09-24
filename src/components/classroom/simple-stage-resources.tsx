"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { Avatar } from "@/components/dashboard-shell";
import {
  BookOpen,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Eye,
  FileText,
  LoaderCircle,
  Maximize2,
  MonitorOff,
  MonitorUp,
  Pause,
  Play,
  Search,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Card, Pill, PrimaryButton, toast } from "@/components/ui";
import { resourcesForStage } from "@/lib/classroom/stage-resources";
import { CourseStageRequirements } from "@/components/classroom/course-stage-requirements";
import type { TeacherPresentationMode } from "@/lib/classroom/presentation";
import { TeacherPresentationActions } from "./teacher-presentation-actions";
import type {
  ClassroomResourceProjection,
  ClassroomResourceViewState,
  Course,
  CourseResource,
} from "@/lib/session/types";
import { useSession } from "@/lib/session/store";
import { courseResourceTypeLabel } from "@/lib/user-facing-labels";
import { cn } from "@/lib/utils";
import { StageEmptyState, StagePageHeader, StageSplitLayout } from "@/components/classroom/classroom-ui";
import type { LaunchResourceStatus, TeacherStageFocus } from "@/lib/classroom/teacher-dashboard-metrics";
import { deriveLaunchDashboardMetrics } from "@/lib/classroom/teacher-dashboard-metrics";
import { crossedResourceProgressThresholds, createLearningEvent, postLearningEvents, resourceEventIdempotencyKey } from "@/lib/learning-analytics/telemetry";

const UPLOAD_ACCEPT = [
  ".pdf", ".mp4", ".mov", ".webm", ".docx", ".xlsx",
  ".mp3", ".wav", ".m4a", ".ogg", ".png", ".jpg", ".jpeg",
  ".webp", ".gif", ".txt", ".md", ".csv",
].join(",");
const STREAMED_VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm"];
const VIDEO_PRECACHE_HEAD_BYTES = 2 * 1024 * 1024;
const VIDEO_PRECACHE_TAIL_BYTES = 512 * 1024;
const VIDEO_PRECACHE_STAGGER_MS = 12_000;

type UploadResponse = {
  id?: string;
  message?: string;
  requestId?: string;
  sizeBytes?: number;
  title?: string;
  convertedToPdf?: boolean;
};

function isStreamedVideo(file: File): boolean {
  const lowerName = file.name.toLowerCase();
  return STREAMED_VIDEO_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
}

function uploadVideoWithProgress(
  file: File,
  metadata: { courseId: string; stageKey: string },
  onProgress: (percent: number) => void,
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.responseType = "json";
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("X-OpenPBL-Upload-Mode", "stream");
    xhr.setRequestHeader("X-Upload-File-Name", encodeURIComponent(file.name));
    xhr.setRequestHeader("X-Upload-Title", encodeURIComponent(file.name));
    xhr.setRequestHeader("X-Upload-Course-Id", metadata.courseId);
    xhr.setRequestHeader("X-Upload-Stage-Key", metadata.stageKey);
    xhr.setRequestHeader("X-Upload-Bind-Course-Resource", "true");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(99, Math.round(event.loaded / event.total * 100)));
      }
    };
    xhr.onerror = () => reject(new Error("视频上传中断，请检查网络后重试。"));
    xhr.onabort = () => reject(new Error("视频上传已取消。"));
    xhr.onload = () => {
      const payload = (xhr.response && typeof xhr.response === "object"
        ? xhr.response
        : {}) as UploadResponse;
      if (xhr.status < 200 || xhr.status >= 300) {
        const requestId = payload.requestId || xhr.getResponseHeader("x-request-id");
        reject(new Error(`${payload.message || `上传失败（${xhr.status}）`}${requestId ? `（请求编号：${requestId}）` : ""}`));
        return;
      }
      onProgress(100);
      resolve(payload);
    };
    xhr.send(file);
  });
}

type ViewerMode = "self" | "controller" | "follower";
type ResourceKind = "image" | "video" | "audio" | "text" | "pdf" | "download";
type ViewStatePatch = Partial<Omit<ClassroomResourceViewState, "updatedAt" | "revision">>;
type PdfZoomMode = "scale" | "fit-page" | "fit-width";
type PdfReadingProgress = { page: number; scrollRatio: number; progressRatio?: number; zoom: number; fitWidth?: boolean; zoomMode?: PdfZoomMode; updatedAt: string };

function savedPdfReadingProgress(storageKey?: string): PdfReadingProgress | undefined {
  if (!storageKey || typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return undefined;
    const saved = JSON.parse(raw) as PdfReadingProgress;
    if (!Number.isFinite(saved.page) || !Number.isFinite(saved.scrollRatio)) return undefined;
    if (saved.page <= 1 && saved.scrollRatio < 0.02) return undefined;
    return {
      ...saved,
      page: Math.max(1, saved.page),
      scrollRatio: Math.min(1, Math.max(0, saved.scrollRatio)),
      progressRatio: saved.progressRatio === undefined ? undefined : Math.min(1, Math.max(0, saved.progressRatio)),
      zoom: Number.isFinite(saved.zoom) ? Math.min(1.75, Math.max(0.25, saved.zoom)) : 1,
    };
  } catch {
    return undefined;
  }
}

function persistPdfReadingProgress(storageKey: string | undefined, value: PdfReadingProgress) {
  if (!storageKey) return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // 隐私模式或存储空间不足时，阅读器仍可正常使用。
  }
}

function useAutoHidingControls(enabled: boolean) {
  const [visible, setVisible] = useState(true);
  const hideTimerRef = useRef<number | undefined>(undefined);
  const reveal = useCallback(() => {
    if (!enabled) return;
    setVisible(true);
    if (hideTimerRef.current !== undefined) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setVisible(false), 1_800);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => setVisible(false), 1_800);
    return () => {
      window.clearTimeout(timer);
      if (hideTimerRef.current !== undefined) window.clearTimeout(hideTimerRef.current);
    };
  }, [enabled]);

  return { visible: !enabled || visible, reveal };
}

type PdfViewport = { width: number; height: number };
type PdfPage = {
  getViewport: (options: { scale: number }) => PdfViewport;
  render: (options: {
    canvas?: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewport;
  }) => { promise: Promise<void>; cancel?: () => void };
};
type PdfDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
  destroy?: () => Promise<void>;
};
type PdfJsModule = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (options: { data: ArrayBuffer }) => { promise: Promise<PdfDocument>; destroy?: () => void };
};

function projectionIsActive(course: Course, resource: CourseResource): boolean {
  return course.uiState?.resourceProjection?.resourceId === resource.id;
}

function resourceKind(resource: CourseResource): ResourceKind {
  const type = (resource.previewType ?? resource.type).toUpperCase();
  const extension = resource.previewUrl
    ? (resource.previewType ?? "").toUpperCase()
    : resource.title.split(".").pop()?.toUpperCase() ?? "";
  const value = `${type} ${extension}`;
  if (/\b(PNG|JPG|JPEG|WEBP|GIF)\b/.test(value)) return "image";
  if (/\b(MP4|MOV|WEBM)\b/.test(value)) return "video";
  if (/\b(MP3|WAV|M4A|OGG)\b/.test(value)) return "audio";
  if (/\b(PDF)\b/.test(value)) return "pdf";
  if (/\b(TXT|MD|MARKDOWN|CSV|JSON|PY|JS|TS|HTML|CSS|XML|YAML|YML|SQL|JAVA|C|CPP|H)\b/.test(value)) return "text";
  return "download";
}

function resourceFormatLabel(resource: CourseResource): string {
  if (resource.previewType?.toUpperCase() === "PDF" && resource.type.toUpperCase() === "PPTX") {
    return "PPT · 自动转换版";
  }
  if (resource.type.toUpperCase() === "PDF" && resource.displayMode === "slides") {
    return "PDF · 幻灯片";
  }
  return courseResourceTypeLabel(resource.type);
}

function isConvertedPresentation(resource: CourseResource): boolean {
  return resource.type.toUpperCase() === "PPTX"
    && resource.previewType?.toUpperCase() === "PDF";
}

function isPresentationPdf(resource: CourseResource): boolean {
  return resource.displayMode === "slides" || isConvertedPresentation(resource);
}

function resourcePreviewUrl(resource: CourseResource): string | undefined {
  return resource.previewUrl ?? resource.url;
}

function resourceSizeBytes(resource: CourseResource): number | undefined {
  if (!/^\d+$/.test(resource.size)) return undefined;
  const value = Number(resource.size);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function videoPrecacheRanges(resource: CourseResource): string[] {
  const size = resourceSizeBytes(resource);
  if (!size) return [`bytes=0-${VIDEO_PRECACHE_HEAD_BYTES - 1}`];
  const headEnd = Math.min(size - 1, VIDEO_PRECACHE_HEAD_BYTES - 1);
  const ranges = [`bytes=0-${headEnd}`];
  const tailStart = Math.max(headEnd + 1, size - VIDEO_PRECACHE_TAIL_BYTES);
  if (tailStart < size) ranges.push(`bytes=${tailStart}-${size - 1}`);
  return ranges;
}

export function StudentProjectionPrecache({
  course,
  stageKey,
  active = false,
}: {
  course: Course;
  stageKey: string;
  active?: boolean;
}) {
  const videos = useMemo(() => resourcesForStage(course.resources, stageKey)
    .filter((resource) => resourceKind(resource) === "video" && Boolean(resourcePreviewUrl(resource))), [course.resources, stageKey]);

  useEffect(() => {
    if (active || typeof window === "undefined") return;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData) return;
    const controllers: AbortController[] = [];
    const timers = videos.map((resource, index) => window.setTimeout(() => {
      const previewUrl = resourcePreviewUrl(resource);
      if (!previewUrl) return;
      const url = new URL(previewUrl, window.location.origin);
      if (url.origin !== window.location.origin) return;
      const storageKey = `openpbl:projection-precache:v1:${course.id}:${resource.id}:${url.pathname}`;
      try {
        if (window.sessionStorage.getItem(storageKey) === "ready") return;
      } catch {
        // Session storage may be unavailable in private browsing; pre-caching can continue.
      }
      const controller = new AbortController();
      controllers.push(controller);
      void (async () => {
        for (const range of videoPrecacheRanges(resource)) {
          const response = await fetch(url, {
            cache: "force-cache",
            credentials: "same-origin",
            headers: { Range: range },
            signal: controller.signal,
          });
          // Never accept an origin that ignores Range: that could download the
          // entire video on every student device before it is needed.
          if (response.status !== 206) {
            await response.body?.cancel();
            return;
          }
          await response.arrayBuffer();
        }
        try {
          window.sessionStorage.setItem(storageKey, "ready");
        } catch {
          // Cache warming remains useful even when session storage is unavailable.
        }
      })().catch(() => {
        // Projection remains functional through normal media loading if warming fails.
      });
    }, 1_000 + Math.random() * VIDEO_PRECACHE_STAGGER_MS + index * 350));

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      controllers.forEach((controller) => controller.abort());
    };
  }, [active, course.id, videos]);

  return null;
}

export function SimplifiedTeacherStageView({
  course,
  stageKey,
  focus,
  presentation = "workspace",
}: {
  course: Course;
  stageKey: string;
  focus?: Extract<TeacherStageFocus, { stageKey: "launch" }>;
  presentation?: TeacherPresentationMode;
}) {
  const session = useSession();
  const teaching = presentation !== "workspace";
  const stage = course.stages?.find((item) => item.key === stageKey);
  const resources = resourcesForStage(course.resources, stageKey);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>();
  const [pendingPdf, setPendingPdf] = useState<File>();
  const [deletingId, setDeletingId] = useState<string>();
  const [updatingDisplayMode, setUpdatingDisplayMode] = useState(false);
  const [resourceListOpen, setResourceListOpen] = useState(true);
  const [selectedId, setSelectedId] = useState<string>();
  const [dialogResource, setDialogResource] = useState<CourseResource>();
  if (teaching && dialogResource) setDialogResource(undefined);
  const previewExpanded = Boolean(dialogResource);
  useEffect(() => {
    if (!previewExpanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDialogResource(undefined);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [previewExpanded]);
  const [readingProgressByResource, setReadingProgressByResource] = useState<Record<string, PdfReadingProgress>>({});
  const [teacherTab, setTeacherTab] = useState<"resources" | "follow-up">("resources");
  const projection = course.uiState?.resourceProjection;
  const activeResource = resources.find((resource) => projectionIsActive(course, resource));
  const selected = resources.find((resource) => resource.id === selectedId)
    ?? activeResource
    ?? resources[0];

  const focusKey = JSON.stringify([stageKey, Boolean(focus), focus?.resourceId, focus?.status]);
  const [appliedFocusKey, setAppliedFocusKey] = useState("");
  if (focusKey !== appliedFocusKey) {
    setAppliedFocusKey(focusKey);
    if (stageKey === "launch" && focus) {
      setTeacherTab("follow-up");
      if (focus.resourceId) setSelectedId(focus.resourceId);
    }
  }

  async function uploadResource(
    file: File,
    pdfDisplayMode?: "document" | "slides",
  ) {
    setUploading(true);
    setUploadProgress(isStreamedVideo(file) ? 0 : undefined);
    try {
      let payload: UploadResponse | null;
      if (isStreamedVideo(file)) {
        payload = await uploadVideoWithProgress(file, { courseId: course.id, stageKey }, setUploadProgress);
        if (payload.sizeBytes !== file.size) {
          throw new Error(`视频上传不完整（原文件 ${Math.round(file.size / 1024 / 1024)} MiB，服务器收到 ${Math.round((payload.sizeBytes ?? 0) / 1024 / 1024)} MiB），请重新上传。`);
        }
      } else {
        const form = new FormData();
        form.append("file", file);
        form.append("title", file.name);
        form.append("courseId", course.id);
        form.append("stageKey", stageKey);
        form.append("bindAsCourseResource", "true");
        if (pdfDisplayMode) form.append("pdfDisplayMode", pdfDisplayMode);
        const response = await fetch("/api/uploads", { method: "POST", body: form });
        payload = await response.json().catch(() => null) as UploadResponse | null;
        if (!response.ok) {
          const requestHint = payload?.requestId ? `（请求编号：${payload.requestId}）` : "";
          throw new Error(`${payload?.message || `上传失败（${response.status}）`}${requestHint}`);
        }
      }
      await session.refresh("teacher");
      if (payload?.id) setSelectedId(payload.id);
      toast.success("学习资料上传成功", {
        description: `“${payload?.title || file.name}”已加入本阶段学习资料。`,
        duration: 3_500,
      });
    } catch (error) {
      toast.error("学习资料上传失败", {
        description: error instanceof Error ? error.message : "请稍后重试。",
        duration: 5_000,
      });
    } finally {
      setUploading(false);
      setUploadProgress(undefined);
    }
  }

  async function deleteResource(resource: CourseResource) {
    if (!window.confirm(`确定删除“${resource.title}”吗？`)) return;
    setDeletingId(resource.id);
    if (projectionIsActive(course, resource)) {
      session.setUiState(course.id, { resourceProjection: null });
    }
    try {
      const response = await fetch(`/api/uploads/${resource.id}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(payload?.message || `删除失败（${response.status}）`);
      }
      await session.refresh("teacher");
      toast.success("学习资料已删除", {
        description: `“${resource.title}”已从本阶段移除。`,
        duration: 3_500,
      });
      if (selectedId === resource.id) setSelectedId(undefined);
      if (dialogResource?.id === resource.id) setDialogResource(undefined);
    } catch (error) {
      toast.error("学习资料删除失败", {
        description: error instanceof Error ? error.message : "请稍后重试。",
        duration: 5_000,
      });
    } finally {
      setDeletingId(undefined);
    }
  }

  async function updatePdfDisplayMode(
    resource: CourseResource,
    displayMode: "document" | "slides",
  ) {
    if (resource.displayMode === displayMode) return;
    setUpdatingDisplayMode(true);
    try {
      const response = await fetch(`/api/uploads/${resource.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayMode }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(payload?.message || `切换失败（${response.status}）`);
      }
      await session.refresh("teacher");
      if (projectionIsActive(course, resource) && projection) {
        session.setUiState(course.id, {
          resourceProjection: {
            ...projection,
            viewState: {
              ...(projection.viewState ?? {}),
              page: 1,
              scrollRatio: 0,
              updatedAt: new Date().toISOString(),
              revision: Date.now(),
            },
          },
        });
      }
      toast.success(displayMode === "slides" ? "已切换为逐页演示" : "已切换为连续阅读", {
        description: displayMode === "slides"
          ? "投屏时学生将跟随教师当前页。"
          : "投屏时学生将跟随教师阅读位置。",
        duration: 3_500,
      });
    } catch (error) {
      toast.error("展示方式切换失败", {
        description: error instanceof Error ? error.message : "请稍后重试。",
        duration: 5_000,
      });
    } finally {
      setUpdatingDisplayMode(false);
    }
  }

  const startProjection = useCallback((resource: CourseResource) => {
    setSelectedId(resource.id);
    session.setUiState(course.id, {
      resourceProjection: {
        resourceId: resource.id,
        stageKey,
        title: resource.title,
        startedAt: new Date().toISOString(),
        viewState: {
          page: 1,
          scrollRatio: 0,
          mediaTime: 0,
          mediaPlaying: false,
          mediaPlaybackRate: 1,
          updatedAt: new Date().toISOString(),
          revision: Date.now(),
        },
      },
    });
  }, [course.id, session, stageKey]);

  function stopProjection() {
    session.setUiState(course.id, { resourceProjection: null });
  }

  function syncProjection(patch: ViewStatePatch) {
    if (!projection || projection.resourceId !== selected?.id) return;
    session.setUiState(course.id, {
      resourceProjection: {
        ...projection,
        viewState: {
          ...(projection.viewState ?? {}),
          ...patch,
          updatedAt: new Date().toISOString(),
          revision: Date.now(),
        },
      },
    });
  }

  const uploadControl = (
    <label className="inline-flex h-10 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-sm)] bg-[var(--pbl-teacher)] px-4 text-sm font-semibold text-white transition hover:bg-[var(--pbl-teacher-hover)] has-[:disabled]:cursor-wait has-[:disabled]:opacity-60">
      {uploading ? <LoaderCircle className="animate-spin" size={16} /> : <Upload size={16} />}
      {uploading ? (uploadProgress === undefined ? "上传中…" : `上传 ${uploadProgress}%`) : "上传资料"}
      <input
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        disabled={uploading}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file?.name.toLowerCase().endsWith(".pdf")) {
            setPendingPdf(file);
          } else if (file) {
            void uploadResource(file);
          }
          event.target.value = "";
        }}
        type="file"
      />
    </label>
  );

  const resourceList = (
    <Card className="classroom-panel" compact>
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-bold text-[var(--pbl-text-strong)]">学习资料</h3>
            <div className="flex items-center gap-2">
              <Pill tone="blue">{resources.length} 份</Pill>
              <button
                aria-label="收起学习资料侧栏"
                className="grid size-8 place-items-center rounded-[var(--radius-xs)] text-[var(--pbl-text-muted)] transition hover:bg-[var(--pbl-surface-soft)] hover:text-[var(--pbl-text-strong)]"
                onClick={() => setResourceListOpen(false)}
                title="收起学习资料"
                type="button"
              >
                <ChevronRight size={17} />
              </button>
            </div>
          </div>
          {resources.length ? (
            <div className="mt-3 max-h-[42rem] space-y-2 overflow-y-auto pr-1">
              {resources.map((resource) => {
                const active = projectionIsActive(course, resource);
                const isSelected = selected?.id === resource.id;
                return (
                  <div
                    className={cn(
                      "flex w-full items-stretch overflow-hidden rounded-[var(--radius-sm)] border text-left transition",
                      isSelected
                        ? "border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)]/60"
                        : "border-[var(--pbl-border)] bg-white hover:border-[var(--pbl-teacher-border)]",
                    )}
                    key={resource.id}
                  >
                    <button className="flex min-w-0 flex-1 items-start gap-3 p-3 text-left" onClick={() => setSelectedId(resource.id)} type="button">
                      <span className="grid h-9 min-w-10 shrink-0 place-items-center whitespace-nowrap rounded-[var(--radius-xs)] bg-white px-1.5 text-center text-[10px] font-bold text-[var(--pbl-teacher)] ring-1 ring-[var(--pbl-border)]">{courseResourceTypeLabel(resource.type)}</span>
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-sm text-[var(--pbl-text-strong)]">{resource.title}</strong>
                        <span className="mt-1 flex items-center gap-2 text-xs text-[var(--pbl-text-muted)]">{resource.size}{active ? <span className="font-semibold text-[var(--pbl-success)]">· 投屏中</span> : null}</span>
                      </span>
                    </button>
                    <button
                      aria-label={`删除学习资料 ${resource.title}`}
                      className="grid w-10 shrink-0 place-items-center border-l border-[var(--pbl-border)] text-[var(--pbl-text-subtle)] transition hover:bg-[var(--pbl-danger-soft)] hover:text-[var(--pbl-danger)] disabled:opacity-50"
                      disabled={Boolean(deletingId)}
                      onClick={() => void deleteResource(resource)}
                      title="删除学习资料"
                      type="button"
                    >{deletingId === resource.id ? <LoaderCircle className="animate-spin" size={15} /> : <Trash2 size={15} />}</button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-3 rounded-[var(--radius-sm)] border border-dashed border-[var(--pbl-border-strong)] py-12 text-center text-sm text-[var(--pbl-text-muted)]">尚未上传学习资料</div>
          )}
    </Card>
  );

  const resourcePreview = (
    <Card className={cn("overflow-hidden classroom-panel", (teaching || previewExpanded) && "teacher-resource-preview flex h-full min-h-0 flex-col")} compact>
          {selected ? (
            <>
              <div hidden={teaching} className="shrink-0 border-b border-[var(--pbl-border)] pb-4">
                <div className={cn("flex min-w-0 items-center gap-3", teaching && "flex-wrap")}>
                  <h3 className={cn("min-w-0 flex-1 font-bold leading-7 text-[var(--pbl-text-strong)]", teaching ? "break-words text-[clamp(20px,1.5vw,28px)]" : "truncate")}>{selected.title}</h3>
                  {isConvertedPresentation(selected) && selected.id !== course.content?.resourcePackage?.launchResourceId ? <Pill className="shrink-0 whitespace-nowrap" size="sm" tone="amber">建议改传PDF</Pill> : null}
                  {projectionIsActive(course, selected) ? <Pill className="shrink-0 gap-1.5 whitespace-nowrap" size="sm" tone="green"><MonitorUp size={12} />{teaching ? "学生同步中" : "投屏中"}</Pill> : null}
                  <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
                    {!teaching && !previewExpanded ? <PrimaryButton onClick={() => setDialogResource(selected)} size="sm" tone="slate" variant="outline"><Maximize2 size={14} />全屏预览</PrimaryButton> : null}
                    {previewExpanded ? <><span className="text-sm">{resourceKind(selected) === "video" ? "全屏播放" : "学习资料预览"}</span><button aria-label={resourceKind(selected) === "video" ? "退出全屏播放" : "退出全屏阅读"} className="grid size-11 place-items-center rounded-[6px] border border-stone-300" onClick={() => setDialogResource(undefined)} type="button"><X size={20} /></button></> : null}
                    {projectionIsActive(course, selected) ? (
                      <PrimaryButton onClick={stopProjection} size="sm" tone="red" variant="outline"><MonitorOff size={14} />{teaching ? "停止同步" : "停止投屏"}</PrimaryButton>
                    ) : (
                      <PrimaryButton onClick={() => startProjection(selected)} size="sm"><MonitorUp size={14} />{teaching ? "同步到学生" : "投屏"}</PrimaryButton>
                    )}
                  </div>
                </div>
                <div hidden={teaching} className="mt-1 flex min-w-0 items-center gap-2 whitespace-nowrap text-xs text-[var(--pbl-text-muted)]">
                  <span>{resourceFormatLabel(selected)} · {selected.size}</span>
                  {selected.previewUrl && selected.url ? (
                    <a className="inline-flex shrink-0 items-center gap-1 font-semibold text-[var(--pbl-teacher)] hover:underline" href={selected.url} rel="noreferrer" target="_blank"><ExternalLink size={12} />原始PPT</a>
                  ) : null}
                  {selected.type.toUpperCase() === "PDF" ? (
                    <span aria-label="PDF 展示方式" className="inline-flex shrink-0 items-center rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-[var(--pbl-surface-soft)] p-0.5">
                      <button
                        aria-pressed={selected.displayMode === "slides"}
                        className={cn(
                          "rounded px-2 py-1 font-semibold transition",
                          selected.displayMode === "slides"
                            ? "bg-[var(--pbl-teacher)] text-white shadow-sm"
                            : "text-[var(--pbl-text-muted)] hover:text-[var(--pbl-text-strong)]",
                        )}
                        disabled={updatingDisplayMode}
                        onClick={() => void updatePdfDisplayMode(selected, "slides")}
                        type="button"
                      >逐页演示</button>
                      <button
                        aria-pressed={selected.displayMode !== "slides"}
                        className={cn(
                          "rounded px-2 py-1 font-semibold transition",
                          selected.displayMode !== "slides"
                            ? "bg-white text-[var(--pbl-text-strong)] shadow-sm"
                            : "text-[var(--pbl-text-muted)] hover:text-[var(--pbl-text-strong)]",
                        )}
                        disabled={updatingDisplayMode}
                        onClick={() => void updatePdfDisplayMode(selected, "document")}
                        type="button"
                      >连续阅读</button>
                    </span>
                  ) : null}
                </div>
              </div>
              <div className={cn("min-h-0 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--pbl-border)] bg-[var(--pbl-surface-soft)]", resourceKind(selected) === "video" && "teacher-resource-video-container", !teaching && "mt-3", (teaching || previewExpanded) ? "flex-1" : "h-[32rem]")}>
                  <ResourceViewer
                    fullscreen={teaching || previewExpanded}
                    initialReadingProgress={readingProgressByResource[selected.id]}
                    key={selected.id}
                    mode={projectionIsActive(course, selected) ? "controller" : "self"}
                    onReadingProgressChange={(progress) => setReadingProgressByResource((current) => ({ ...current, [selected.id]: progress }))}
                    onViewStateChange={syncProjection}
                    progressKey={`teacher:${course.id}:${selected.id}`}
                    projection={projectionIsActive(course, selected) ? projection ?? undefined : undefined}
                    resource={selected}
                  />
              </div>
            </>
          ) : (
            <div className="grid min-h-[32rem] place-items-center text-center text-sm text-[var(--pbl-text-muted)]"><div><FileText className="mx-auto text-stone-300" size={36} /><p className="mt-3">上传资源后可在这里预览和投屏</p></div></div>
          )}
    </Card>
  );

  return (
    <div className={cn("classroom-stage", teaching ? "teacher-stage-resources flex h-full min-h-0 flex-col gap-3" : "space-y-4")}>
      <TeacherPresentationActions>
        {activeResource ? <button data-tone="danger" onClick={stopProjection} type="button"><MonitorOff size={20} />结束投屏</button> : null}
      </TeacherPresentationActions>
      <div hidden={teaching}><StagePageHeader
        action={uploadControl}
        description="整理可讲授、可投屏的学习资料；视频支持 MP4、MOV、WebM（最大 500 MiB）并显示上传进度，PPT 请先导出为 PDF。"
        title="学习资料"
      /></div>
      {!teaching ? <CourseStageRequirements course={course} stageKey={stageKey} teacher /> : null}

      {stageKey === "launch" ? <div hidden={teaching} className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--pbl-border)] bg-white p-1" role="tablist" aria-label="启动阶段工作台"><button aria-selected={teacherTab === "resources"} className={cn("rounded-[var(--radius-xs)] px-3 py-2 text-xs font-bold transition", teacherTab === "resources" ? "bg-[var(--pbl-teacher)] text-white" : "text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)]")} onClick={() => setTeacherTab("resources")} role="tab" type="button">资料与投屏</button><button aria-selected={teacherTab === "follow-up"} className={cn("rounded-[var(--radius-xs)] px-3 py-2 text-xs font-bold transition", teacherTab === "follow-up" ? "bg-[var(--pbl-teacher)] text-white" : "text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)]")} onClick={() => setTeacherTab("follow-up")} role="tab" type="button">阅读跟进</button></div> : null}
      {teaching && selected ? <div className="teacher-resource-toolbar flex shrink-0 items-center gap-2">
        <button aria-label="上一份资料" className="grid size-11 place-items-center rounded-[6px] border border-stone-300 bg-white disabled:opacity-40" disabled={resources.indexOf(selected) <= 0} onClick={() => setSelectedId(resources[resources.indexOf(selected) - 1]?.id)} type="button"><ChevronLeft size={22} /></button>
        <select aria-label="选择授课资料" className="min-h-11 min-w-0 flex-1 rounded-[6px] border border-stone-300 bg-white px-3 text-lg font-semibold" onChange={(event) => setSelectedId(event.target.value)} value={selected.id}>{resources.map((resource, index) => <option key={resource.id} value={resource.id}>{index + 1}. {resource.title}</option>)}</select>
        <button aria-label="下一份资料" className="grid size-11 place-items-center rounded-[6px] border border-stone-300 bg-white disabled:opacity-40" disabled={resources.indexOf(selected) >= resources.length - 1} onClick={() => setSelectedId(resources[resources.indexOf(selected) + 1]?.id)} type="button"><ChevronRight size={22} /></button>
        {projectionIsActive(course, selected) ? <PrimaryButton className="shrink-0 whitespace-nowrap" onClick={stopProjection} size="sm" tone="red" variant="outline"><MonitorOff size={18} />停止同步</PrimaryButton> : <PrimaryButton className="shrink-0 whitespace-nowrap" onClick={() => startProjection(selected)} size="sm"><MonitorUp size={18} />同步到学生</PrimaryButton>}
      </div> : null}
      {stageKey === "launch" && teacherTab === "follow-up" && !teaching ? <LaunchReadingFollowUp course={course} focus={focus} /> : null}
      {resources.length ? (
        <div hidden={!teaching && stageKey === "launch" && teacherTab === "follow-up"} className={cn(
          teaching ? "min-h-0 flex-1" : "grid items-start gap-4",
          !teaching && (resourceListOpen
            ? "xl:grid-cols-[minmax(0,1fr)_18rem]"
            : "xl:grid-cols-[minmax(0,1fr)_3.25rem]"),
        )}>
          <div aria-label={previewExpanded ? "学习资料预览" : undefined} aria-modal={previewExpanded ? true : undefined} role={previewExpanded ? "dialog" : undefined} className={cn("min-w-0", teaching && "h-full min-h-0", previewExpanded && "fixed inset-0 z-[140] bg-white p-2")}>{resourcePreview}</div>
          <aside hidden={teaching} className="min-w-0 xl:sticky xl:top-20">
            {resourceListOpen ? resourceList : (
              <button
                aria-label="展开学习资料侧栏"
                aria-expanded="false"
                className="flex h-12 w-full flex-row items-center justify-center gap-3 rounded-[var(--radius-md)] border border-[var(--pbl-border)] bg-white px-4 text-[var(--pbl-teacher)] shadow-[var(--shadow-soft)] transition hover:border-[var(--pbl-teacher-border)] hover:bg-[var(--pbl-teacher-soft)]/40 xl:h-auto xl:min-h-48 xl:flex-col xl:px-0 xl:py-4"
                onClick={() => setResourceListOpen(true)}
                title="展开学习资料"
                type="button"
              >
                <ChevronLeft size={18} />
                <span className="text-xs font-bold [writing-mode:horizontal-tb] xl:[writing-mode:vertical-rl]">学习资料</span>
                <Pill size="sm" tone="blue">{resources.length}</Pill>
              </button>
            )}
          </aside>
        </div>
      ) : teaching ? (
        <div className="flex min-h-0 flex-1 flex-col justify-center overflow-auto rounded-[10px] border border-stone-200 bg-white p-[clamp(20px,4vw,64px)]">
          <h2 className="text-[clamp(28px,3vw,48px)] font-bold text-stone-900">{stage?.label || "本阶段任务"}</h2>
          <p className="mt-6 whitespace-pre-wrap text-[clamp(20px,2vw,28px)] leading-relaxed text-stone-700">{stage?.description?.trim() || "本阶段尚未添加学习资料或任务。"}</p>
        </div>
      ) : (
        <StageEmptyState
          description="上传 PDF、视频、图片或其他学习资料后，学生会在本阶段看到并阅读这些内容。"
          eyebrow="尚未发布资料"
          icon={BookOpen}
          title="先添加本阶段的学习资料"
          tone="teacher"
        />
      )}

      {pendingPdf ? (
        <PdfDisplayModeDialog
          file={pendingPdf}
          onCancel={() => setPendingPdf(undefined)}
          onSelect={(displayMode) => {
            const file = pendingPdf;
            setPendingPdf(undefined);
            void uploadResource(file, displayMode);
          }}
        />
      ) : null}
    </div>
  );
}

function LaunchReadingFollowUp({
  course,
  focus,
}: {
  course: Course;
  focus?: Extract<TeacherStageFocus, { stageKey: "launch" }>;
}) {
  const metrics = useMemo(() => deriveLaunchDashboardMetrics(course), [course]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | LaunchResourceStatus>("all");
  const [resourceFilter, setResourceFilter] = useState("all");
  const focusedStudent = course.students.find((student) => student.id === focus?.studentId);
  const focusKey = JSON.stringify([focus?.resourceId, focus?.status, focus?.studentId, focusedStudent?.name]);
  const [appliedFocusKey, setAppliedFocusKey] = useState("");
  if (focusKey !== appliedFocusKey) {
    setAppliedFocusKey(focusKey);
    if (focus?.resourceId) setResourceFilter(focus.resourceId);
    if (focus?.status) {
      setStatusFilter(focus.status === "opened" ? "in-progress" : focus.status);
      if (focusedStudent) setQuery(focusedStudent.name);
    }
  }
  const stateByKey = useMemo(() => new Map(metrics.states.map((state) => [`${state.studentId}:${state.resourceId}`, state])), [metrics.states]);
  const visibleResources = metrics.resourceCoverage.filter((item) => resourceFilter === "all" || item.resource.id === resourceFilter);
  const rows = metrics.studentRows.filter((row) => row.student.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).filter((row) => {
    if (statusFilter === "all") return true;
    return visibleResources.some((item) => {
      const status = stateByKey.get(`${row.student.id}:${item.resource.id}`)?.status;
      return status === statusFilter || (statusFilter === "in-progress" && status === "opened");
    });
  });
  const statusLabel: Record<LaunchResourceStatus, string> = { "not-opened": "未打开", opened: "浏览中", "in-progress": "浏览中", completed: "已浏览" };
  const statusClass: Record<LaunchResourceStatus, string> = { "not-opened": "border-stone-200 bg-stone-50 text-stone-500", opened: "border-amber-100 bg-amber-50 text-amber-700", "in-progress": "border-amber-100 bg-amber-50 text-amber-700", completed: "border-emerald-100 bg-emerald-50 text-emerald-700" };
  const statusLegend: LaunchResourceStatus[] = ["not-opened", "in-progress", "completed"];
  return (
    <Card className="classroom-panel overflow-hidden" compact>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-bold text-[var(--pbl-text-strong)]">阅读跟进矩阵</h2><p className="mt-1 text-xs leading-5 text-[var(--pbl-text-muted)]">每个格子只表示资料触达状态；历史下载记录仅回退为“已打开”。</p></div><div className="flex items-center gap-2"><label className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" size={13} /><span className="sr-only">搜索学生</span><input aria-label="搜索阅读学生" className="h-9 w-32 rounded-lg border border-stone-200 bg-white pl-8 pr-2 text-xs outline-none focus:border-blue-400" onChange={(event) => setQuery(event.target.value)} placeholder="搜索学生" value={query} /></label><select aria-label="筛选阅读状态" className="h-9 rounded-lg border border-stone-200 bg-white px-2 text-xs font-semibold text-stone-700" onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} value={statusFilter}><option value="all">全部状态</option><option value="not-opened">未打开</option><option value="in-progress">浏览中</option><option value="completed">已浏览</option></select></div></div>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-[10px] text-stone-500" aria-label="阅读状态图例">{statusLegend.map((status) => <span className={cn("rounded-full border px-2 py-1", statusClass[status])} key={status}>{statusLabel[status]}</span>)}{metrics.resourceCoverage.length > 1 ? <select aria-label="筛选资料" className="h-7 rounded-md border border-stone-200 bg-white px-1.5 text-[10px] font-semibold text-stone-600" onChange={(event) => setResourceFilter(event.target.value)} value={resourceFilter}><option value="all">全部资料</option>{metrics.resourceCoverage.map((item) => <option key={item.resource.id} value={item.resource.id}>{item.resource.title}</option>)}</select> : null}</div>
      {rows.length && visibleResources.length ? <div className="mt-4 overflow-x-auto rounded-lg border border-stone-200"><div className="min-w-[520px]"><div className="grid border-b border-stone-200 bg-stone-50 text-[10px] font-bold text-stone-500" style={{ gridTemplateColumns: `minmax(7rem,1fr) repeat(${visibleResources.length}, minmax(7rem,1fr))` }}><div className="px-3 py-2">学生</div>{visibleResources.map((item) => <div className="truncate px-3 py-2" key={item.resource.id} title={item.resource.title}>{item.resource.title}</div>)}</div>{rows.map((row) => <div className="grid border-b border-stone-100 last:border-b-0" key={row.student.id} style={{ gridTemplateColumns: `minmax(7rem,1fr) repeat(${visibleResources.length}, minmax(7rem,1fr))` }}><div className="flex items-center gap-2 px-3 py-2.5 text-xs font-bold text-stone-700"><Avatar name={row.student.name} size={24} /> <span className="truncate">{row.student.name}</span></div>{visibleResources.map((item) => { const state = stateByKey.get(`${row.student.id}:${item.resource.id}`) ?? { status: "not-opened" as const, progressPercent: 0 }; return <div className="px-2 py-2" key={item.resource.id}><div className={cn("rounded-lg border px-2 py-1.5 text-center text-[10px] font-semibold", statusClass[state.status])} title={`${statusLabel[state.status]} · ${state.progressPercent}%`}>{statusLabel[state.status]}<span className="ml-1 tabular-nums opacity-75">{state.progressPercent ? `${state.progressPercent}%` : ""}</span></div></div>; })}</div>)}</div></div> : <div className="mt-5"><EmptyReadingMatrix text={course.students.length ? metrics.resourceCoverage.length ? "没有符合当前筛选的学生" : "尚未发布启动资料" : "暂无学生加入课堂"} /></div>}
    </Card>
  );
}

function EmptyReadingMatrix({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-stone-200 bg-stone-50/70 py-12 text-center text-sm text-stone-500">{text}</div>;
}

export function SimplifiedStudentStageView({
  course,
  stageKey,
}: {
  course: Course;
  stageKey: string;
}) {
  const session = useSession();
  const resources = resourcesForStage(course.resources, stageKey);
  const [selectedId, setSelectedId] = useState<string>();
  const [dialogResource, setDialogResource] = useState<CourseResource>();
  const [viewerRevision, setViewerRevision] = useState(0);
  const [readingProgressByResource, setReadingProgressByResource] = useState<Record<string, PdfReadingProgress>>({});
  const sentResourceEventKeys = useRef<Set<string>>(new Set());
  const reportedProgressByResource = useRef<Record<string, number>>({});
  const selected = resources.find((resource) => resource.id === selectedId) ?? resources[0];

  const sendResourceEvent = useCallback((resource: CourseResource, type: "open" | "progress" | "complete", progressPercent?: number, milestone?: number, source: "student" | "teacher-projection" = "student") => {
    const studentId = session.studentId;
    if (!studentId) return;
    const idempotencyKey = resourceEventIdempotencyKey(course.id, studentId, resource.id, type, milestone, source);
    if (sentResourceEventKeys.current.has(idempotencyKey)) return;
    sentResourceEventKeys.current.add(idempotencyKey);
    const progress = progressPercent === undefined ? undefined : Math.max(0, Math.min(100, Math.round(progressPercent)));
    const event = createLearningEvent(type === "open" ? "resource-open" : type === "complete" ? "resource-complete" : "resource-progress", {
      courseId: course.id,
      studentId,
      stageKey,
      sceneId: resource.id,
      progressMarker: type === "complete" ? "completed" : "in-progress",
      metadata: {
        resourceId: resource.id,
        ...(progress === undefined ? {} : { progressPercent: progress }),
        source,
      },
      idempotencyKey,
    });
    void postLearningEvents({ courseId: course.id, studentId, events: [event] }).catch(() => {
      // Telemetry must never interrupt reading. The next coarse milestone can retry.
      sentResourceEventKeys.current.delete(idempotencyKey);
    });
  }, [course.id, session.studentId, stageKey]);

  function recordResourceProgress(resource: CourseResource, progressPercent: number) {
    const current = Math.max(0, Math.min(100, progressPercent));
    sendResourceEvent(resource, "open");
    const previous = reportedProgressByResource.current[resource.id] ?? 0;
    for (const threshold of crossedResourceProgressThresholds(previous, current)) {
      sendResourceEvent(resource, "progress", threshold, threshold);
    }
    // PDF, audio and video resources use a 90% completion boundary. Keep the
    // completion event separate from the 100% progress milestone so a viewer
    // that ends at 90% still appears as completed without fabricating reading.
    if (current >= 90) sendResourceEvent(resource, "complete", current, 90);
    reportedProgressByResource.current[resource.id] = Math.max(previous, current);
  }

  function openResource(resource: CourseResource) {
    sendResourceEvent(resource, "open");
    session.markResourceDownloaded(course.id, resource.id);
    setSelectedId(resource.id);
  }

  return (
    <div className="classroom-stage space-y-4">
      <StagePageHeader
        description={stageKey === "launch"
          ? "先阅读项目说明和学习资料，明确要解决的问题、阶段目标与协作分工，为下一阶段做好准备。"
          : "按自己的节奏阅读教师发布的学习资料，完成本阶段任务。"}
        title={stageKey === "launch" ? "了解项目任务，完成资料阅读" : "学习资料"}
        variant={stageKey === "launch" ? "student-card" : "plain"}
      />
      <CourseStageRequirements course={course} stageKey={stageKey} expanded={stageKey === "make"} />
      {resources.length ? (
        <StageSplitLayout
          aside={(
            <Card className="classroom-panel" compact>
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-bold text-[var(--pbl-text-strong)]">学习资料</h2>
                <Pill tone="teal">{resources.length} 份</Pill>
              </div>
              <div className="mt-3 space-y-2">
                {resources.map((resource) => {
                  const viewed = Boolean(session.studentId && resource.downloadedBy.includes(session.studentId));
                  const active = selected?.id === resource.id;
                  const readingStatus = active ? "阅读中" : viewed ? "已阅读" : "未阅读";
                  return (
                    <button
                      aria-pressed={active}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-[var(--radius-sm)] border p-3 text-left transition",
                        active
                          ? "border-[var(--pbl-student-border)] bg-[var(--pbl-student-soft)]/70"
                          : "border-[var(--pbl-border)] bg-white hover:border-[var(--pbl-student-border)]",
                      )}
                      key={resource.id}
                      onClick={() => openResource(resource)}
                      type="button"
                    >
                      <span className="grid h-8 min-w-9 shrink-0 place-items-center rounded-[var(--radius-xs)] bg-[var(--pbl-student-soft)] px-1 text-center text-[10px] font-bold text-[var(--pbl-student)]">{courseResourceTypeLabel(resource.type)}</span>
                      <span className="min-w-0 flex-1"><strong className="block truncate text-sm text-[var(--pbl-text-strong)]">{resource.title}</strong><span className="mt-1 block text-xs text-[var(--pbl-text-muted)]">{resource.size} · {readingStatus}</span></span>
                      <Eye className={cn("shrink-0", active ? "text-[var(--pbl-student)]" : "text-[var(--pbl-text-subtle)]")} size={16} />
                    </button>
                  );
                })}
              </div>
            </Card>
          )}
          main={(
            <Card className="classroom-panel overflow-hidden" compact>
              {selected ? (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--pbl-border)] pb-3">
                    <div className="min-w-0"><p className="classroom-eyebrow text-[var(--pbl-student)]">正在阅读</p><h2 className="mt-1 truncate text-lg font-semibold text-[var(--pbl-text-strong)]">{selected.title}</h2><p className="mt-1 text-xs text-[var(--pbl-text-muted)]">{courseResourceTypeLabel(selected.type)} · {selected.size}</p></div>
                    <div className="flex items-center gap-2">
                      <Pill tone="teal">阅读中</Pill>
                      <PrimaryButton onClick={() => setDialogResource(selected)} size="sm" tone="slate" variant="outline"><Maximize2 size={14} />全屏阅读</PrimaryButton>
                    </div>
                  </div>
                  <div className="mt-3 h-[36rem] min-h-0 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--pbl-border)] bg-[var(--pbl-surface-soft)]">
                    <ResourceViewer
                      initialReadingProgress={readingProgressByResource[selected.id]}
                      key={`${selected.id}:${viewerRevision}`}
                      mode="self"
                      onReadingProgressChange={(progress) => { setReadingProgressByResource((current) => ({ ...current, [selected.id]: progress })); recordResourceProgress(selected, (progress.progressRatio ?? progress.scrollRatio) * 100); }}
                      onResourceProgress={(progress) => recordResourceProgress(selected, progress)}
                      progressKey={`student:${session.studentId ?? "guest"}:${course.id}:${selected.id}`}
                      resource={selected}
                    />
                  </div>
                  {selected && ["image", "text", "download"].includes(resourceKind(selected)) ? <button className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--pbl-student-border)] bg-[var(--pbl-student-soft)] px-3 text-xs font-bold text-[var(--pbl-student)] transition hover:brightness-95" onClick={() => recordResourceProgress(selected, 100)} type="button">完成浏览</button> : null}
                </>
              ) : <StageEmptyState description="从学习资料列表选择一份资料开始阅读。" icon={FileText} title="选择一份学习资料" tone="student" />}
            </Card>
          )}
        />
      ) : (
        <StageEmptyState
          description="教师发布资料后会自动出现在这里。当前阶段没有需要你额外操作的内容。"
          eyebrow="等待教师发布"
          icon={FileText}
          title="本阶段暂未发布学习资料"
          tone="student"
        />
      )}
      {dialogResource ? (
        <ResourceDialog
          initialReadingProgress={readingProgressByResource[dialogResource.id]}
          mode="self"
          onClose={() => {
            setDialogResource(undefined);
            setViewerRevision((value) => value + 1);
          }}
          onReadingProgressChange={(progress) => { setReadingProgressByResource((current) => ({ ...current, [dialogResource.id]: progress })); recordResourceProgress(dialogResource, (progress.progressRatio ?? progress.scrollRatio) * 100); }}
          onResourceProgress={(progress) => recordResourceProgress(dialogResource, progress)}
          progressKey={`student:${session.studentId ?? "guest"}:${course.id}:${dialogResource.id}`}
          resource={dialogResource}
          title="全屏阅读"
        />
      ) : null}
    </div>
  );
}

export function StudentResourceProjection({
  course,
  resource,
  projection,
}: {
  course?: Course;
  resource: CourseResource;
  projection: ClassroomResourceProjection;
}) {
  useEffect(() => {
    // A student may already have the same resource open in the stage viewer.
    // Pause media behind the forced projection to prevent two decoders and two
    // audio tracks from running while the teacher controls the foreground copy.
    for (const media of document.querySelectorAll<HTMLMediaElement>("video, audio")) {
      if (!media.closest("[data-teacher-resource-projection]")) media.pause();
    }
  }, [projection.resourceId]);
  // A teacher-forced projection is control traffic, not evidence that a
  // student actively opened or completed the resource. Avoiding those writes
  // also keeps projection actions out of the classroom persistence queue.
  return (
    <div
      className="fixed inset-0 z-[150] bg-slate-100"
      data-teacher-resource-projection
      data-projection-version={course?.uiState?.projectionVersion}
      role="presentation"
    >
      <section aria-label={`教师投屏：${resource.title}`} aria-modal="true" className="relative h-full w-full overflow-hidden bg-[var(--pbl-surface)]" role="dialog">
        <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex items-center justify-between gap-3 px-4">
          <div className="max-w-[70vw] truncate rounded-full bg-slate-950/65 px-3 py-1.5 text-xs font-semibold text-white/90 shadow-lg backdrop-blur"><span className="mr-2 text-white/55">教师投屏</span>{resource.title}</div>
          <Pill className="shrink-0 bg-white/90 shadow-lg" tone="green">同步中</Pill>
        </div>
        <div className="h-full min-h-0"><ResourceViewer fullscreen mode="follower" projection={projection} resource={resource} /></div>
      </section>
    </div>
  );
}

function ResourceDialog({
  resource,
  title,
  onClose,
  progressKey,
  action,
  mode = "self",
  projection,
  onViewStateChange,
  initialReadingProgress,
  onReadingProgressChange,
  onResourceProgress,
}: {
  resource: CourseResource;
  title: string;
  onClose: () => void;
  progressKey?: string;
  action?: ReactNode;
  mode?: ViewerMode;
  projection?: ClassroomResourceProjection;
  onViewStateChange?: (patch: ViewStatePatch) => void;
  initialReadingProgress?: PdfReadingProgress;
  onReadingProgressChange?: (progress: PdfReadingProgress) => void;
  onResourceProgress?: (progressPercent: number) => void;
}) {
  const immersive = ["pdf", "video"].includes(resourceKind(resource));
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className={cn("fixed inset-0 z-[140] bg-slate-950/55 backdrop-blur-sm", !immersive && "p-2 sm:p-4")}>
      <button aria-label="关闭资源预览" className="absolute inset-0" onClick={onClose} type="button" />
      <section aria-label={title} aria-modal="true" className={cn("relative z-10 mx-auto flex h-full w-full flex-col overflow-hidden bg-[var(--pbl-surface)] shadow-2xl", immersive ? "max-w-none" : "max-w-[1400px] rounded-[var(--radius-lg)] border border-white/70")} role="dialog">
        {!immersive ? <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-[var(--pbl-border)] bg-white px-4 sm:px-6">
          <div className="min-w-0"><p className="text-xs font-semibold text-[var(--pbl-teacher)]">{title}</p><h2 className="truncate text-lg font-bold text-[var(--pbl-text-strong)]">{resource.title}</h2></div>
          <div className="flex items-center gap-2">{action}<button aria-label="关闭资源预览" className="grid size-10 place-items-center rounded-full border border-[var(--pbl-border)] text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)]" onClick={onClose} type="button"><X size={18} /></button></div>
        </header> : (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex items-center justify-between px-4">
            <div className="pointer-events-auto max-w-[55vw] rounded-full bg-slate-950/65 px-3 py-1.5 text-xs font-semibold text-white/90 shadow-lg backdrop-blur"><span className="mr-2 text-white/55">{resourceKind(resource) === "video" ? "全屏播放" : title}</span>{resource.title}</div>
            <div className="pointer-events-auto flex items-center gap-2">{action}<button aria-label={resourceKind(resource) === "video" ? "退出全屏播放" : "退出全屏阅读"} className="grid size-10 place-items-center rounded-full border border-white/20 bg-slate-950/65 text-white shadow-lg backdrop-blur transition hover:bg-slate-950/80" onClick={onClose} type="button"><X size={18} /></button></div>
          </div>
        )}
        <div className={cn("min-h-0 flex-1", !immersive && "p-2 sm:p-3")}><ResourceViewer fullscreen={immersive} initialReadingProgress={initialReadingProgress} key={`${resource.id}:${mode}`} mode={mode} onReadingProgressChange={onReadingProgressChange} onResourceProgress={onResourceProgress} onViewStateChange={onViewStateChange} progressKey={progressKey} projection={projection} resource={resource} /></div>
      </section>
    </div>
  );
}

function PdfDisplayModeDialog({
  file,
  onCancel,
  onSelect,
}: {
  file: File;
  onCancel: () => void;
  onSelect: (displayMode: "document" | "slides") => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[145] grid place-items-center bg-slate-950/35 p-4 backdrop-blur-sm">
      <button aria-label="取消上传 PDF" className="absolute inset-0" onClick={onCancel} type="button" />
      <section aria-labelledby="pdf-display-mode-title" aria-modal="true" className="relative z-10 w-full max-w-xl rounded-[var(--radius-lg)] border border-white/70 bg-white p-6 shadow-2xl" role="dialog">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-[var(--pbl-teacher)]">PDF 展示方式</p>
            <h2 className="mt-1 text-xl font-bold text-[var(--pbl-text-strong)]" id="pdf-display-mode-title">这份 PDF 如何用于课堂？</h2>
            <p className="mt-1 truncate text-sm text-[var(--pbl-text-muted)]">{file.name}</p>
          </div>
          <button aria-label="取消上传 PDF" className="grid size-9 shrink-0 place-items-center rounded-full text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)]" onClick={onCancel} type="button"><X size={18} /></button>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button className="rounded-[var(--radius-md)] border-2 border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)] p-4 text-left transition hover:shadow-[var(--shadow-raised)]" onClick={() => onSelect("slides")} type="button">
            <span className="grid size-10 place-items-center rounded-[var(--radius-sm)] bg-[var(--pbl-teacher)] text-white"><MonitorUp size={18} /></span>
            <strong className="mt-3 block text-[var(--pbl-text-strong)]">幻灯片演示</strong>
            <span className="mt-1 block text-sm leading-6 text-[var(--pbl-text-muted)]">逐页播放；教师翻页后，学生同步到同一页且不能自行前后翻页。</span>
            <Pill className="mt-3" size="sm" tone="blue">PPT 导出 PDF 选此项</Pill>
          </button>
          <button className="rounded-[var(--radius-md)] border border-[var(--pbl-border)] bg-white p-4 text-left transition hover:border-[var(--pbl-teacher-border)] hover:shadow-[var(--shadow-raised)]" onClick={() => onSelect("document")} type="button">
            <span className="grid size-10 place-items-center rounded-[var(--radius-sm)] bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-muted)]"><FileText size={18} /></span>
            <strong className="mt-3 block text-[var(--pbl-text-strong)]">连续阅读</strong>
            <span className="mt-1 block text-sm leading-6 text-[var(--pbl-text-muted)]">按普通 PDF 上下滚动；投屏时同步教师当前阅读位置。</span>
          </button>
        </div>
      </section>
    </div>
  );
}

function ResourceViewer({
  resource,
  mode,
  projection,
  onViewStateChange,
  progressKey,
  fullscreen = false,
  initialReadingProgress,
  onReadingProgressChange,
  onResourceProgress,
}: {
  resource: CourseResource;
  mode: ViewerMode;
  projection?: ClassroomResourceProjection;
  onViewStateChange?: (patch: ViewStatePatch) => void;
  progressKey?: string;
  fullscreen?: boolean;
  initialReadingProgress?: PdfReadingProgress;
  onReadingProgressChange?: (progress: PdfReadingProgress) => void;
  onResourceProgress?: (progressPercent: number) => void;
}) {
  const kind = useMemo(() => resourceKind(resource), [resource]);
  const previewUrl = resourcePreviewUrl(resource);
  if (!previewUrl || kind === "download") {
    const isUnconvertedPpt = resource.type.toUpperCase() === "PPTX" && !resource.previewUrl;
    return (
      <DownloadFallback
        message={isUnconvertedPpt
          ? "这份 PPT 尚未生成 PDF 课堂版。为避免版式错位，请教师重新上传或改传 PDF。"
          : undefined}
        resource={resource}
      />
    );
  }
  if (kind === "pdf") return <PdfViewer fullscreen={fullscreen} initialReadingProgress={initialReadingProgress} mode={mode} onReadingProgressChange={onReadingProgressChange} onResourceProgress={onResourceProgress} onViewStateChange={onViewStateChange} progressKey={progressKey} projection={projection} resource={resource} />;
  if (kind === "video") return <VideoViewer fullscreen={fullscreen} mode={mode} onResourceProgress={onResourceProgress} onViewStateChange={onViewStateChange} projection={projection} resource={resource} />;
  if (kind === "text") return <TextViewer resource={resource} />;
  if (kind === "image") return <div className="relative h-full min-h-72 overflow-hidden rounded-[var(--radius-sm)] bg-stone-950 p-3"><Image alt={resource.title} className="object-contain p-3" fill src={previewUrl} unoptimized /></div>;
  if (kind === "audio") return <div className="grid h-full min-h-72 place-items-center rounded-[var(--radius-sm)] bg-white"><audio className="w-[min(640px,90%)]" controls onEnded={() => onResourceProgress?.(100)} onTimeUpdate={(event) => { const audio = event.currentTarget; if (audio.duration > 0) onResourceProgress?.(audio.currentTime / audio.duration * 100); }} src={previewUrl} /></div>;
  return <DownloadFallback resource={resource} />;
}

export function StudentPdfResourceViewer({
  url,
  title,
  progressKey,
  onReady,
}: {
  url: string;
  title: string;
  progressKey: string;
  onReady: () => void;
}) {
  const resource: CourseResource = { id: progressKey, title, type: "PDF", size: "", url, downloadedBy: [] };
  return <PdfViewer fullscreen={false} mode="self" onReady={onReady} progressKey={progressKey} resource={resource} />;
}

function PdfViewer({
  resource,
  mode,
  projection,
  onViewStateChange,
  progressKey,
  fullscreen,
  initialReadingProgress,
  onReadingProgressChange,
  onResourceProgress,
  onReady,
}: {
  resource: CourseResource;
  mode: ViewerMode;
  projection?: ClassroomResourceProjection;
  onViewStateChange?: (patch: ViewStatePatch) => void;
  progressKey?: string;
  fullscreen: boolean;
  initialReadingProgress?: PdfReadingProgress;
  onReadingProgressChange?: (progress: PdfReadingProgress) => void;
  onResourceProgress?: (progressPercent: number) => void;
  onReady?: () => void;
}) {
  const storageKey = progressKey ? `openpbl:pdf-reading:${progressKey}` : undefined;
  const [pdf, setPdf] = useState<PdfDocument>();
  const [error, setError] = useState<string>();
  const [currentPage, setCurrentPage] = useState(1);
  const [readingProgress, setReadingProgress] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [zoomMode, setZoomMode] = useState<PdfZoomMode>("scale");
  const [savedProgress, setSavedProgress] = useState<PdfReadingProgress | undefined>(() => initialReadingProgress ?? savedPdfReadingProgress(storageKey));
  const { visible: controlsVisible, reveal: revealControls } = useAutoHidingControls(fullscreen);
  const scrollRef = useRef<HTMLDivElement>(null);
  const furthestReadRatioRef = useRef(0);
  const syncTimerRef = useRef<number | undefined>(undefined);
  const previewUrl = resourcePreviewUrl(resource);
  const onReadyRef = useRef(onReady);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    const controller = new AbortController();
    let loadedPdf: PdfDocument | undefined;
    void fetch(previewUrl!, { cache: "no-store", signal: controller.signal })
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
        loadedPdf = await pdfjs.getDocument({ data }).promise;
        if (!controller.signal.aborted) {
          setPdf(loadedPdf);
          onReadyRef.current?.();
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "PDF 读取失败");
      });
    return () => {
      controller.abort();
      if (syncTimerRef.current !== undefined) window.clearTimeout(syncTimerRef.current);
      void loadedPdf?.destroy?.();
    };
  }, [previewUrl]);

  useEffect(() => {
    if (mode !== "follower" || !pdf) return;
    const ratio = projection?.viewState?.scrollRatio ?? 0;
    const frame = window.requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (!container) return;
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = maxScroll * Math.min(1, Math.max(0, ratio));
      setReadingProgress((current) => Math.max(current, ratio));
      furthestReadRatioRef.current = Math.max(furthestReadRatioRef.current, ratio);
      setCurrentPage(Math.min(pdf.numPages, Math.max(1, projection?.viewState?.page ?? 1)));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mode, pdf, projection?.viewState?.page, projection?.viewState?.revision, projection?.viewState?.scrollRatio]);

  const scrollToPage = useCallback((page: number, ratio?: number, behavior: ScrollBehavior = "smooth") => {
    if (!pdf) return;
    const safePage = Math.min(pdf.numPages, Math.max(1, page));
    const targetRatio = ratio ?? (pdf.numPages > 1 ? (safePage - 1) / (pdf.numPages - 1) : 0);
    const container = scrollRef.current;
    if (!container) return;
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTo({ top: maxScroll * targetRatio, behavior });
  }, [pdf]);

  useEffect(() => {
    if ((!fullscreen && !initialReadingProgress) || !pdf || !savedProgress || mode === "follower") return;
    const target = savedProgress;
    const frame = window.requestAnimationFrame(() => {
      setZoom(target.zoom);
      setZoomMode(target.zoomMode ?? (target.fitWidth ? "fit-width" : "scale"));
      const restoredProgress = target.progressRatio ?? target.scrollRatio;
      setReadingProgress(restoredProgress);
      furthestReadRatioRef.current = Math.max(furthestReadRatioRef.current, restoredProgress);
    });
    const firstAttempt = window.setTimeout(() => scrollToPage(target.page, target.scrollRatio, "auto"), 120);
    const settledAttempt = window.setTimeout(() => {
      scrollToPage(target.page, target.scrollRatio, "auto");
      setSavedProgress(undefined);
    }, 600);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(firstAttempt);
      window.clearTimeout(settledAttempt);
    };
  }, [fullscreen, initialReadingProgress, mode, pdf, savedProgress, scrollToPage]);

  function readingPosition() {
    const container = scrollRef.current;
    if (!container || !pdf) return { ratio: 0, progressRatio: 0, page: 1 };
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    const remaining = Math.max(0, maxScroll - container.scrollTop);
    const reachedEnd = maxScroll === 0 || remaining <= 2;
    const ratio = reachedEnd ? 1 : Math.min(1, Math.max(0, container.scrollTop / Math.max(1, maxScroll)));
    const visibleEndRatio = reachedEnd ? 1 : Math.min(1, Math.max(0, (container.scrollTop + container.clientHeight) / Math.max(1, container.scrollHeight)));
    const progressRatio = Math.max(furthestReadRatioRef.current, visibleEndRatio);
    furthestReadRatioRef.current = progressRatio;
    const page = Math.min(pdf.numPages, Math.max(1, Math.round(ratio * Math.max(0, pdf.numPages - 1)) + 1));
    return { ratio, progressRatio, page };
  }

  function handleScroll() {
    const position = readingPosition();
    setReadingProgress(position.progressRatio);
    setCurrentPage(position.page);
    if (fullscreen) revealControls();
    onReadingProgressChange?.({
      page: position.page,
      scrollRatio: position.ratio,
      progressRatio: position.progressRatio,
      zoom,
      fitWidth: zoomMode === "fit-width",
      zoomMode,
      updatedAt: new Date().toISOString(),
    });
    onResourceProgress?.(position.progressRatio * 100);
    if (syncTimerRef.current !== undefined) return;
    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = undefined;
      const latest = readingPosition();
      if (mode === "controller") onViewStateChange?.({ scrollRatio: latest.ratio, page: latest.page });
      if (storageKey && mode !== "follower") {
        const value: PdfReadingProgress = {
          page: latest.page,
          scrollRatio: latest.ratio,
          progressRatio: latest.progressRatio,
          zoom,
          fitWidth: zoomMode === "fit-width",
          zoomMode,
          updatedAt: new Date().toISOString(),
        };
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(value));
        } catch {
          // 隐私模式或存储空间不足时，阅读器仍可正常使用。
        }
      }
    }, 100);
  }

  function resumeReading() {
    if (!savedProgress) return;
    setZoom(savedProgress.zoom);
    setZoomMode(savedProgress.zoomMode ?? (savedProgress.fitWidth ? "fit-width" : "scale"));
    const restoredProgress = savedProgress.progressRatio ?? savedProgress.scrollRatio;
    setReadingProgress(restoredProgress);
    furthestReadRatioRef.current = Math.max(furthestReadRatioRef.current, restoredProgress);
    window.requestAnimationFrame(() => scrollToPage(savedProgress.page, savedProgress.scrollRatio));
    setSavedProgress(undefined);
  }

  function changeZoom(nextZoom: number) {
    const next = Math.min(1.75, Math.max(0.25, nextZoom));
    const position = readingPosition();
    setZoom(next);
    setZoomMode("scale");
    const progress: PdfReadingProgress = {
      page: position.page,
      scrollRatio: position.ratio,
      progressRatio: position.progressRatio,
      zoom: next,
      fitWidth: false,
      zoomMode: "scale",
      updatedAt: new Date().toISOString(),
    };
    onReadingProgressChange?.(progress);
    if (mode !== "follower") persistPdfReadingProgress(storageKey, progress);
    window.requestAnimationFrame(() => scrollToPage(currentPage, position.ratio));
  }

  function fitToWidth() {
    const position = readingPosition();
    setZoom(1);
    setZoomMode("fit-width");
    const progress: PdfReadingProgress = {
      page: position.page,
      scrollRatio: position.ratio,
      progressRatio: position.progressRatio,
      zoom: 1,
      fitWidth: true,
      zoomMode: "fit-width",
      updatedAt: new Date().toISOString(),
    };
    onReadingProgressChange?.(progress);
    if (mode !== "follower") persistPdfReadingProgress(storageKey, progress);
    window.requestAnimationFrame(() => scrollToPage(currentPage, position.ratio));
  }

  useEffect(() => {
    if (pdf?.numPages !== 1) return;
    furthestReadRatioRef.current = 1;
    const frame = window.requestAnimationFrame(() => setReadingProgress(1));
    onResourceProgress?.(100);
    return () => window.cancelAnimationFrame(frame);
  }, [onResourceProgress, pdf]);

  async function fitToPage() {
    if (!pdf || !scrollRef.current) return;
    const position = readingPosition();
    const page = await pdf.getPage(position.page);
    const viewport = page.getViewport({ scale: 1 });
    const container = scrollRef.current;
    const availableWidth = Math.max(1, container.clientWidth - (fullscreen ? 64 : 40));
    const availableHeight = Math.max(1, container.clientHeight - (fullscreen ? 96 : 40));
    const pageAspect = viewport.height / Math.max(1, viewport.width);
    const next = Math.min(1.75, Math.max(0.25, availableHeight / (availableWidth * pageAspect)));
    setZoom(next);
    setZoomMode("fit-page");
    const progress: PdfReadingProgress = {
      page: position.page,
      scrollRatio: position.ratio,
      progressRatio: position.progressRatio,
      zoom: next,
      fitWidth: false,
      zoomMode: "fit-page",
      updatedAt: new Date().toISOString(),
    };
    onReadingProgressChange?.(progress);
    if (mode !== "follower") persistPdfReadingProgress(storageKey, progress);
    window.requestAnimationFrame(() => scrollToPage(currentPage, position.ratio));
  }

  if (error) return <DownloadFallback message={error} resource={resource} />;
  if (!pdf) return <LoadingPreview label="正在解析 PDF…" />;
  if (isPresentationPdf(resource)) {
    return (
      <PdfPresentationViewer
        fullscreen={fullscreen}
        mode={mode}
        onReadingProgressChange={onReadingProgressChange}
        onResourceProgress={onResourceProgress}
        onViewStateChange={onViewStateChange}
        pdf={pdf}
        projection={projection}
        restoreImmediately={fullscreen || Boolean(initialReadingProgress)}
        savedProgress={savedProgress}
        setSavedProgress={setSavedProgress}
        storageKey={storageKey}
      />
    );
  }
  return (
    <div className="relative flex h-full min-h-72 flex-col overflow-hidden rounded-[var(--radius-sm)] bg-slate-100" onPointerMove={fullscreen ? revealControls : undefined}>
      {fullscreen ? <div aria-label={`阅读进度 ${Math.round(readingProgress * 100)}%`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={Math.round(readingProgress * 100)} className="absolute inset-x-0 top-0 z-40 h-1 bg-slate-200/70" role="progressbar"><div className="h-full bg-[var(--pbl-student)] transition-[width] duration-150" style={{ width: `${Math.round(readingProgress * 100)}%` }} /></div> : null}
      <div className={cn("shrink-0 border-b border-[var(--pbl-border)] bg-white px-3 py-2.5 shadow-sm sm:px-4", fullscreen && "resource-pdf-controls", fullscreen && "absolute bottom-5 left-1/2 z-20 w-fit max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-full border bg-white/[0.92] px-3 py-2 shadow-2xl backdrop-blur transition duration-200", fullscreen && !controlsVisible && "pointer-events-none translate-y-3 opacity-0")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className={cn("flex items-center gap-2", fullscreen && "hidden")}>
            <span className="grid size-8 place-items-center rounded-[var(--radius-xs)] bg-[var(--pbl-student-soft)] text-[var(--pbl-student)]"><BookOpen size={16} /></span>
            <div>
              <p className="text-xs font-bold text-[var(--pbl-text-strong)]">沉浸阅读</p>
              <p className="text-[11px] text-[var(--pbl-text-muted)]">已阅读 {Math.round(readingProgress * 100)}%</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {savedProgress && !fullscreen ? (
              <button className="mr-1 inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-xs)] bg-[var(--pbl-student-soft)] px-2.5 text-xs font-bold text-[var(--pbl-student)] transition hover:brightness-95" onClick={resumeReading} type="button"><Bookmark size={14} />继续阅读 · 第 {Math.min(pdf.numPages, savedProgress.page)} 页</button>
            ) : null}
            {mode !== "follower" ? (
              <>
                <button aria-label="上一页" className="grid size-8 place-items-center rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-white text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)] disabled:opacity-35" disabled={currentPage <= 1} onClick={() => scrollToPage(currentPage - 1)} type="button"><ChevronLeft size={16} /></button>
                <label className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-white px-2 text-xs font-semibold text-[var(--pbl-text-muted)]">
                  <span className="sr-only">当前页码</span>
                  <input aria-label="跳转页码" className="w-8 bg-transparent text-center font-bold text-[var(--pbl-text-strong)] outline-none" max={pdf.numPages} min={1} onChange={(event) => scrollToPage(Number(event.target.value))} type="number" value={currentPage} />
                  <span>/ {pdf.numPages}</span>
                </label>
                <button aria-label="下一页" className="grid size-8 place-items-center rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-white text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)] disabled:opacity-35" disabled={currentPage >= pdf.numPages} onClick={() => scrollToPage(currentPage + 1)} type="button"><ChevronRight size={16} /></button>
                <span className="mx-1 h-5 w-px bg-[var(--pbl-border)]" />
                <button aria-label="缩小" className="grid size-8 place-items-center rounded-[var(--radius-xs)] text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)] disabled:opacity-35" disabled={zoom <= 0.25} onClick={() => changeZoom(zoom - 0.25)} type="button"><ZoomOut size={16} /></button>
                <select aria-label="显示比例" className="h-8 rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-white px-1.5 text-xs font-bold text-[var(--pbl-text-muted)] outline-none" onChange={(event) => { const value = event.target.value; if (value === "fit-page") void fitToPage(); else if (value === "fit-width") fitToWidth(); else changeZoom(Number(value)); }} value={zoomMode === "scale" ? String(zoom) : zoomMode}>
                  <optgroup label="页面适配">
                    <option value="fit-page">适应整页</option>
                    <option value="fit-width">适应宽度</option>
                  </optgroup>
                  <optgroup label="显示比例">
                    {zoomMode === "scale" && ![0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75].includes(zoom) ? <option value={zoom}>{Math.round(zoom * 100)}%</option> : null}
                    {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75].map((value) => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}
                  </optgroup>
                </select>
                <button aria-label="放大" className="grid size-8 place-items-center rounded-[var(--radius-xs)] text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)] disabled:opacity-35" disabled={zoom >= 1.75} onClick={() => changeZoom(zoom + 0.25)} type="button"><ZoomIn size={16} /></button>
              </>
            ) : <Pill tone="green">第 {currentPage} / {pdf.numPages} 页 · 跟随教师</Pill>}
          </div>
        </div>
        <div aria-label={`阅读进度 ${Math.round(readingProgress * 100)}%`} className={cn("mt-2 h-1 overflow-hidden rounded-full bg-slate-100", fullscreen && "hidden")} role="progressbar" aria-valuemax={100} aria-valuemin={0} aria-valuenow={Math.round(readingProgress * 100)}>
          <div className="h-full rounded-full bg-[var(--pbl-student)] transition-[width] duration-150" style={{ width: `${Math.round(readingProgress * 100)}%` }} />
        </div>
      </div>
      <div className={cn("min-h-0 flex-1 overflow-auto overscroll-contain p-3 sm:p-5", fullscreen && "resource-pdf-viewport", fullscreen && "px-4 pb-20 pt-14 sm:px-8 sm:pb-24 sm:pt-16")} onScroll={handleScroll} ref={scrollRef}>
        <div className="mx-auto space-y-4" style={{ maxWidth: "none", width: `${zoom * 100}%` }}>
          {Array.from({ length: pdf.numPages }, (_, index) => <PdfPageCanvas key={index + 1} pageNumber={index + 1} pdf={pdf} zoom={zoom} />)}
        </div>
      </div>
    </div>
  );
}

function PdfPresentationViewer({
  fullscreen,
  pdf,
  mode,
  projection,
  onViewStateChange,
  onReadingProgressChange,
  onResourceProgress,
  restoreImmediately,
  savedProgress,
  setSavedProgress,
  storageKey,
}: {
  fullscreen: boolean;
  pdf: PdfDocument;
  mode: ViewerMode;
  projection?: ClassroomResourceProjection;
  onViewStateChange?: (patch: ViewStatePatch) => void;
  onReadingProgressChange?: (progress: PdfReadingProgress) => void;
  onResourceProgress?: (progressPercent: number) => void;
  restoreImmediately: boolean;
  savedProgress?: PdfReadingProgress;
  setSavedProgress: (value: PdfReadingProgress | undefined) => void;
  storageKey?: string;
}) {
  const [localPage, setLocalPage] = useState(() => restoreImmediately ? savedProgress?.page ?? 1 : 1);
  const [zoom, setZoom] = useState(() => restoreImmediately ? savedProgress?.zoom ?? 1 : 1);
  const [zoomMode, setZoomMode] = useState<PdfZoomMode>(() => restoreImmediately ? savedProgress?.zoomMode ?? (savedProgress?.fitWidth ? "fit-width" : "scale") : "scale");
  const fitWidth = zoomMode === "fit-width";
  const { visible: controlsVisible, reveal: revealControls } = useAutoHidingControls(fullscreen);
  const projectedPage = projection?.viewState?.page ?? 1;
  const page = mode === "self" ? localPage : projectedPage;
  const safePage = Math.min(pdf.numPages, Math.max(1, page));
  const progressPercent = Math.round((safePage / pdf.numPages) * 100);

  useEffect(() => {
    onResourceProgress?.(progressPercent);
  }, [onResourceProgress, progressPercent]);

  function changePage(nextPage: number) {
    const value = Math.min(pdf.numPages, Math.max(1, nextPage));
    setLocalPage(value);
    if (mode === "controller") onViewStateChange?.({ page: value });
    const progress: PdfReadingProgress = {
      page: value,
      scrollRatio: pdf.numPages > 1 ? (value - 1) / (pdf.numPages - 1) : 1,
      progressRatio: value / pdf.numPages,
      zoom,
      fitWidth,
      zoomMode,
      updatedAt: new Date().toISOString(),
    };
    onReadingProgressChange?.(progress);
    onResourceProgress?.(Math.round(value / pdf.numPages * 100));
    if (mode !== "follower") {
      persistPdfReadingProgress(storageKey, progress);
    }
  }

  function changeZoom(nextZoom: number) {
    const value = Math.min(1.75, Math.max(0.25, nextZoom));
    setZoom(value);
    setZoomMode("scale");
    const progress: PdfReadingProgress = {
      page: safePage,
      scrollRatio: pdf.numPages > 1 ? (safePage - 1) / (pdf.numPages - 1) : 1,
      progressRatio: safePage / pdf.numPages,
      zoom: value,
      fitWidth: false,
      zoomMode: "scale",
      updatedAt: new Date().toISOString(),
    };
    onReadingProgressChange?.(progress);
    if (mode !== "follower") {
      persistPdfReadingProgress(storageKey, progress);
    }
  }

  function fitToWidth() {
    setZoom(1);
    setZoomMode("fit-width");
    const progress: PdfReadingProgress = {
      page: safePage,
      scrollRatio: pdf.numPages > 1 ? (safePage - 1) / (pdf.numPages - 1) : 1,
      progressRatio: safePage / pdf.numPages,
      zoom: 1,
      fitWidth: true,
      zoomMode: "fit-width",
      updatedAt: new Date().toISOString(),
    };
    onReadingProgressChange?.(progress);
    if (mode !== "follower") persistPdfReadingProgress(storageKey, progress);
  }

  function fitToPage() {
    setZoom(1);
    setZoomMode("fit-page");
    const progress: PdfReadingProgress = {
      page: safePage,
      scrollRatio: pdf.numPages > 1 ? (safePage - 1) / (pdf.numPages - 1) : 1,
      progressRatio: safePage / pdf.numPages,
      zoom: 1,
      fitWidth: false,
      zoomMode: "fit-page",
      updatedAt: new Date().toISOString(),
    };
    onReadingProgressChange?.(progress);
    if (mode !== "follower") persistPdfReadingProgress(storageKey, progress);
  }

  function resumeReading() {
    if (!savedProgress) return;
    setZoom(savedProgress.zoom);
    setZoomMode(savedProgress.zoomMode ?? (savedProgress.fitWidth ? "fit-width" : "scale"));
    changePage(savedProgress.page);
    setSavedProgress(undefined);
  }

  return (
    <div className="relative flex h-full min-h-72 flex-col overflow-hidden rounded-[var(--radius-sm)] bg-slate-100" onPointerMove={fullscreen ? revealControls : undefined}>
      {fullscreen ? <div aria-label={`阅读进度 ${progressPercent}%`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={progressPercent} className="absolute inset-x-0 top-0 z-40 h-1 bg-slate-200/70" role="progressbar"><div className="h-full bg-[var(--pbl-student)] transition-[width] duration-150" style={{ width: `${progressPercent}%` }} /></div> : null}
      <div className={cn("shrink-0 border-b border-[var(--pbl-border)] bg-white px-3 py-2.5 shadow-sm sm:px-4", fullscreen && "resource-pdf-controls", fullscreen && "absolute bottom-5 left-1/2 z-20 w-fit max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-full border bg-white/[0.92] px-3 py-2 shadow-2xl backdrop-blur transition duration-200", fullscreen && !controlsVisible && "pointer-events-none translate-y-3 opacity-0")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className={cn("flex items-center gap-2", fullscreen && "hidden")}>
            <span className="grid size-8 place-items-center rounded-[var(--radius-xs)] bg-[var(--pbl-student-soft)] text-[var(--pbl-student)]"><BookOpen size={16} /></span>
            <div>
              <p className="text-xs font-bold text-[var(--pbl-text-strong)]">逐页研读</p>
              <p className="text-[11px] text-[var(--pbl-text-muted)]">已阅读 {progressPercent}%</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {savedProgress && mode !== "follower" && !fullscreen ? (
              <button className="mr-1 inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-xs)] bg-[var(--pbl-student-soft)] px-2.5 text-xs font-bold text-[var(--pbl-student)] transition hover:brightness-95" onClick={resumeReading} type="button"><Bookmark size={14} />继续阅读 · 第 {Math.min(pdf.numPages, savedProgress.page)} 页</button>
            ) : null}
            {mode !== "follower" ? (
              <>
                <button aria-label="上一页" className="grid size-8 place-items-center rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-white text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)] disabled:opacity-35" disabled={safePage <= 1} onClick={() => changePage(safePage - 1)} type="button"><ChevronLeft size={16} /></button>
                <label className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-white px-2 text-xs font-semibold text-[var(--pbl-text-muted)]">
                  <span className="sr-only">当前页码</span>
                  <input aria-label="跳转页码" className="w-8 bg-transparent text-center font-bold text-[var(--pbl-text-strong)] outline-none" max={pdf.numPages} min={1} onChange={(event) => changePage(Number(event.target.value))} type="number" value={safePage} />
                  <span>/ {pdf.numPages}</span>
                </label>
                <button aria-label="下一页" className="grid size-8 place-items-center rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-white text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)] disabled:opacity-35" disabled={safePage >= pdf.numPages} onClick={() => changePage(safePage + 1)} type="button"><ChevronRight size={16} /></button>
                <span className="mx-1 h-5 w-px bg-[var(--pbl-border)]" />
                <button aria-label="缩小" className="grid size-8 place-items-center rounded-[var(--radius-xs)] text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)] disabled:opacity-35" disabled={zoom <= 0.25} onClick={() => changeZoom(zoom - 0.25)} type="button"><ZoomOut size={16} /></button>
                <select aria-label="显示比例" className="h-8 rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-white px-1.5 text-xs font-bold text-[var(--pbl-text-muted)] outline-none" onChange={(event) => { const value = event.target.value; if (value === "fit-page") fitToPage(); else if (value === "fit-width") fitToWidth(); else changeZoom(Number(value)); }} value={zoomMode === "scale" ? String(zoom) : zoomMode}>
                  <optgroup label="页面适配">
                    <option value="fit-page">适应整页</option>
                    <option value="fit-width">适应宽度</option>
                  </optgroup>
                  <optgroup label="显示比例">
                    {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75].map((value) => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}
                  </optgroup>
                </select>
                <button aria-label="放大" className="grid size-8 place-items-center rounded-[var(--radius-xs)] text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)] disabled:opacity-35" disabled={zoom >= 1.75} onClick={() => changeZoom(zoom + 0.25)} type="button"><ZoomIn size={16} /></button>
              </>
            ) : <Pill tone="green">第 {safePage} / {pdf.numPages} 页 · 跟随教师</Pill>}
          </div>
        </div>
        <div aria-label={`阅读进度 ${progressPercent}%`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={progressPercent} className={cn("mt-2 h-1 overflow-hidden rounded-full bg-slate-100", fullscreen && "hidden")} role="progressbar">
          <div className="h-full rounded-full bg-[var(--pbl-student)] transition-[width] duration-150" style={{ width: `${progressPercent}%` }} />
        </div>
      </div>
      <div className={cn("flex min-h-0 flex-1 items-center justify-center overflow-auto p-3 sm:p-5", fullscreen && "resource-pdf-viewport", fullscreen && "px-4 pb-20 pt-14 sm:px-8 sm:pb-24 sm:pt-16")} onScroll={fullscreen ? revealControls : undefined}>
        <PdfSlideCanvas fitWidth={fitWidth} key={`${safePage}:${zoom}:${fitWidth}`} pageNumber={safePage} pdf={pdf} zoom={zoom} />
      </div>
    </div>
  );
}

function PdfSlideCanvas({ pdf, pageNumber, zoom, fitWidth }: { pdf: PdfDocument; pageNumber: number; zoom: number; fitWidth: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { promise: Promise<void>; cancel?: () => void } | undefined;
    void pdf.getPage(pageNumber).then((page) => {
      if (cancelled || !canvasRef.current) return;
      const viewport = page.getViewport({ scale: 1.75 * zoom });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      renderTask = page.render({ canvas, canvasContext: context, viewport });
      return renderTask.promise;
    }).catch(() => {
      if (!cancelled) setError(true);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel?.();
    };
  }, [pageNumber, pdf, zoom]);

  if (error) {
    return <div className="grid aspect-video w-full max-w-6xl place-items-center rounded-[var(--radius-xs)] bg-white text-sm text-[var(--pbl-danger)]">第 {pageNumber} 页加载失败</div>;
  }
  return <canvas aria-label={`PPT 第 ${pageNumber} 页`} className="block rounded-[var(--radius-xs)] bg-white shadow-2xl" ref={canvasRef} style={fitWidth ? { height: "auto", maxHeight: "none", maxWidth: "100%", width: "100%" } : { maxHeight: zoom <= 1 ? "100%" : "none", maxWidth: zoom <= 1 ? "100%" : "none" }} />;
}

function PdfPageCanvas({ pdf, pageNumber, zoom }: { pdf: PdfDocument; pageNumber: number; zoom: number }) {
  const figureRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);
  const [displayWidth, setDisplayWidth] = useState(0);

  useEffect(() => {
    const figure = figureRef.current;
    if (!figure) return;
    const updateWidth = () => {
      const next = Math.round(figure.getBoundingClientRect().width);
      setDisplayWidth((current) => Math.abs(current - next) > 1 ? next : current);
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(figure);
    return () => observer.disconnect();
  }, [zoom]);

  useEffect(() => {
    if (displayWidth <= 0) return;
    let cancelled = false;
    let renderTask: { promise: Promise<void>; cancel?: () => void } | undefined;
    void pdf.getPage(pageNumber).then((page) => {
      if (cancelled || !canvasRef.current) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const targetPixelWidth = Math.min(2_400, Math.max(displayWidth, displayWidth * pixelRatio));
      const renderScale = targetPixelWidth / Math.max(1, baseViewport.width);
      const viewport = page.getViewport({ scale: renderScale });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      renderTask = page.render({ canvas, canvasContext: context, viewport });
      return renderTask.promise;
    }).catch(() => {
      if (!cancelled) setError(true);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel?.();
    };
  }, [displayWidth, pageNumber, pdf]);
  return (
    <figure className="overflow-hidden rounded-[var(--radius-xs)] bg-white shadow-md" ref={figureRef}>
      {error ? <div className="grid aspect-[3/4] place-items-center text-sm text-[var(--pbl-danger)]">第 {pageNumber} 页加载失败</div> : <canvas aria-label={`PDF 第 ${pageNumber} 页`} className="block h-auto w-full" ref={canvasRef} />}
      <figcaption className="border-t border-[var(--pbl-border)] px-3 py-1.5 text-center text-[11px] text-[var(--pbl-text-muted)]">第 {pageNumber} 页</figcaption>
    </figure>
  );
}

function VideoViewer({
  resource,
  mode,
  fullscreen,
  projection,
  onViewStateChange,
  onResourceProgress,
}: {
  resource: CourseResource;
  mode: ViewerMode;
  fullscreen: boolean;
  projection?: ClassroomResourceProjection;
  onViewStateChange?: (patch: ViewStatePatch) => void;
  onResourceProgress?: (progressPercent: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastTimeSyncRef = useRef(0);
  const playbackAttemptRef = useRef(0);
  const [playBlocked, setPlayBlocked] = useState(false);
  // Start followers muted so browser autoplay policy can never delay the
  // projected picture. A student gesture can enable synchronized sound.
  const [soundBlocked, setSoundBlocked] = useState(mode === "follower");
  const [mediaReady, setMediaReady] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const viewState = projection?.viewState;
  const mediaPlaying = viewState?.mediaPlaying;
  const mediaTime = viewState?.mediaTime;
  const mediaPlaybackRate = viewState?.mediaPlaybackRate;
  const mediaUpdatedAt = viewState?.updatedAt;
  const mediaRevision = viewState?.revision;

  const applyProjectedState = useCallback((video: HTMLVideoElement) => {
    if (mode === "self" || !mediaUpdatedAt || video.readyState < 1) return;
    const elapsed = mediaPlaying
      ? Math.max(0, (Date.now() - Date.parse(mediaUpdatedAt)) / 1000)
      : 0;
    const expectedTime = Math.max(0, (mediaTime ?? 0) + elapsed * (mediaPlaybackRate ?? 1));
    if (Number.isFinite(expectedTime) && Math.abs(video.currentTime - expectedTime) > 0.55) {
      video.currentTime = Math.min(expectedTime, Number.isFinite(video.duration) ? video.duration : expectedTime);
    }
    video.playbackRate = mediaPlaybackRate ?? 1;
    const attempt = ++playbackAttemptRef.current;
    if (!mediaPlaying) {
      video.pause();
      setPlayBlocked(false);
      return;
    }
    void video.play().then(() => {
      if (attempt !== playbackAttemptRef.current || mode !== "follower") return;
      setPlayBlocked(false);
      setSoundBlocked(video.muted);
    }).catch(() => {
      if (attempt !== playbackAttemptRef.current || mode !== "follower") return;
      // Browsers commonly reject unmuted autoplay. Keep the projected picture
      // moving immediately in muted mode and offer a small, non-blocking sound
      // control instead of covering the video with an authorization screen.
      video.muted = true;
      void video.play().then(() => {
        if (attempt !== playbackAttemptRef.current) return;
        setPlayBlocked(false);
        setSoundBlocked(true);
      }).catch(() => {
        if (attempt !== playbackAttemptRef.current) return;
        setPlayBlocked(true);
      });
    });
  }, [mediaPlaybackRate, mediaPlaying, mediaTime, mediaUpdatedAt, mode]);

  useEffect(() => {
    if (!videoRef.current) return;
    applyProjectedState(videoRef.current);
  }, [applyProjectedState, mediaRevision]);

  useEffect(() => {
    if (mode !== "follower") return;
    const catchUp = () => {
      if (videoRef.current) applyProjectedState(videoRef.current);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") catchUp();
    };
    window.addEventListener("focus", catchUp);
    window.addEventListener("online", catchUp);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", catchUp);
      window.removeEventListener("online", catchUp);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [applyProjectedState, mode]);

  function emit(playing = !videoRef.current?.paused) {
    const video = videoRef.current;
    if (mode !== "controller" || !video) return;
    onViewStateChange?.({
      mediaTime: video.currentTime,
      mediaPlaying: playing,
      mediaPlaybackRate: video.playbackRate,
    });
  }

  async function authorizeFollowerPlayback() {
    const video = videoRef.current;
    if (!video) return;
    const attempt = ++playbackAttemptRef.current;
    try {
      video.muted = false;
      await video.play();
      if (attempt !== playbackAttemptRef.current) return;
      setSoundBlocked(false);
      setPlayBlocked(false);
      if (!mediaPlaying) video.pause();
      applyProjectedState(video);
    } catch {
      if (attempt !== playbackAttemptRef.current) return;
      video.muted = true;
      setSoundBlocked(true);
      setPlayBlocked(true);
    }
  }

  return (
    <div className={cn("teacher-resource-video relative grid h-full min-h-0 place-items-center overflow-hidden bg-black", !fullscreen && "min-h-72 rounded-[var(--radius-sm)]")}>
      <video
        className="block h-full min-h-0 w-full max-w-full object-contain"
        controls={mode !== "follower"}
        onCanPlay={() => {
          setMediaReady(true);
          setBuffering(false);
          if (videoRef.current) applyProjectedState(videoRef.current);
        }}
        onError={() => {
          setMediaError(true);
          setBuffering(false);
        }}
        onLoadStart={() => {
          setMediaReady(false);
          setMediaError(false);
        }}
        onLoadedMetadata={() => {
          setMediaReady(true);
          if (videoRef.current) applyProjectedState(videoRef.current);
        }}
        onPause={() => emit(false)}
        onPlay={() => {
          setBuffering(false);
          emit(true);
        }}
        onPlaying={() => {
          setBuffering(false);
          if (videoRef.current) applyProjectedState(videoRef.current);
        }}
        onRateChange={() => emit()}
        onSeeked={() => emit()}
        onTimeUpdate={() => {
          const video = videoRef.current;
          if (video && Number.isFinite(video.duration) && video.duration > 0) onResourceProgress?.(video.currentTime / video.duration * 100);
          if (Date.now() - lastTimeSyncRef.current < 750) return;
          lastTimeSyncRef.current = Date.now();
          emit();
        }}
        onEnded={() => {
          onResourceProgress?.(100);
          emit(false);
        }}
        onWaiting={() => setBuffering(true)}
        playsInline
        muted={mode === "follower" && soundBlocked}
        // Loading metadata is enough to establish duration and the first
        // frame. `auto` made every student buffer tens of megabytes as soon as
        // a paused video opened, which could delay later control messages.
        preload="metadata"
        ref={videoRef}
        src={resource.url}
      />
      {!mediaReady && !mediaError ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/45 text-sm font-semibold text-white"><span className="inline-flex items-center gap-2"><LoaderCircle className="animate-spin" size={18} />正在加载视频…</span></div>
      ) : null}
      {buffering && !mediaError ? (
        <div className="pointer-events-none absolute right-3 top-3 inline-flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs font-semibold text-white"><LoaderCircle className="animate-spin" size={14} />缓冲中</div>
      ) : null}
      {mediaError ? (
        <div className="absolute inset-0 grid place-items-center bg-stone-950/90 p-6 text-center text-white"><div><FileText className="mx-auto text-white/45" size={40} /><p className="mt-3 text-sm font-semibold">视频文件无法读取</p><p className="mt-1 text-xs text-white/65">文件可能上传不完整，或编码不受浏览器支持。请先重新上传原文件；若仍失败，建议转换为 H.264/AAC 编码的 MP4。</p><a className="mt-4 inline-flex h-9 items-center gap-2 rounded-[var(--radius-sm)] bg-white px-4 text-xs font-bold text-stone-950" download href={`${resource.url}?download=1`}><ExternalLink size={14} />下载原文件</a></div></div>
      ) : null}
      {mode === "follower" ? (
        <div className="pointer-events-none absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-stone-950/75 px-4 py-2 text-xs font-semibold text-white backdrop-blur">
          {viewState?.mediaPlaying ? <Play size={14} /> : <Pause size={14} />}跟随教师播放
        </div>
      ) : null}
      {mode === "controller" && projection ? (
        <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-emerald-500/90 px-3 py-1.5 text-xs font-bold text-white shadow-lg backdrop-blur">实时投屏控制</div>
      ) : null}
      {mode === "follower" && mediaPlaying && playBlocked ? (
        <button className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 px-6 text-center text-white backdrop-blur-[2px]" onClick={() => void authorizeFollowerPlayback()} type="button"><span className="grid size-16 place-items-center rounded-full bg-white text-stone-950 shadow-xl"><Play className="ml-1" size={28} /></span><span className="mt-4 text-base font-bold">点击继续同步播放</span><span className="mt-1 max-w-md text-xs leading-5 text-white/70">浏览器阻止了自动播放，点击后将立即追上教师进度。</span></button>
      ) : mode === "follower" && mediaPlaying && soundBlocked ? (
        <button className="absolute bottom-14 right-4 z-20 inline-flex items-center gap-2 rounded-full bg-white/95 px-4 py-2 text-xs font-bold text-stone-950 shadow-xl" onClick={() => void authorizeFollowerPlayback()} type="button"><Play size={14} />点击开启同步声音</button>
      ) : null}
    </div>
  );
}

function TextViewer({ resource }: { resource: CourseResource }) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch(resource.url!, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`资源读取失败（${response.status}）`);
        return response.text();
      })
      .then((value) => setText(value))
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "资源读取失败");
      });
    return () => controller.abort();
  }, [resource.url]);
  if (error) return <DownloadFallback message={error} resource={resource} />;
  if (text === undefined) return <LoadingPreview label="正在加载资源…" />;
  return <pre className="h-full min-h-72 overflow-auto rounded-[var(--radius-sm)] bg-slate-950 p-5 font-mono text-sm leading-6 text-slate-100">{text}</pre>;
}

function LoadingPreview({ label }: { label: string }) {
  return <div className="grid h-full min-h-72 place-items-center rounded-[var(--radius-sm)] bg-white text-sm text-[var(--pbl-text-muted)]"><span className="inline-flex items-center gap-2"><LoaderCircle className="animate-spin" size={18} />{label}</span></div>;
}

function DownloadFallback({ resource, message }: { resource: CourseResource; message?: string }) {
  return (
    <div className="grid h-full min-h-72 place-items-center rounded-[var(--radius-sm)] border border-dashed border-[var(--pbl-border-strong)] bg-white p-8 text-center">
      <div><FileText className="mx-auto text-stone-300" size={42} /><h3 className="mt-4 text-lg font-bold text-[var(--pbl-text-strong)]">{resource.title}</h3><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">{message || "此格式需要使用本机应用打开。"}</p>{resource.url ? <a className="mt-5 inline-flex h-10 items-center gap-2 rounded-[var(--radius-sm)] bg-stone-950 px-4 text-sm font-semibold text-white" href={resource.url} rel="noreferrer" target="_blank"><ExternalLink size={15} />打开原文件</a> : null}</div>
    </div>
  );
}
