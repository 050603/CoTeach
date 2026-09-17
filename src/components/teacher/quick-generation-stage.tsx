"use client";

import {
  ArrowRight,
  BookOpenCheck,
  BrainCircuit,
  Check,
  CheckCircle2,
  Clock3,
  AlertTriangle,
  GitBranch,
  Eye,
  Image as ImageIcon,
  Layers3,
  Link2,
  Mic2,
  Network,
  Route,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CourseDesignGenerationArtifact } from "@/lib/session/types";
import { cn } from "@/lib/utils";
import { userFacingStageLabel } from "@/lib/user-facing-labels";

const ICONS: Record<CourseDesignGenerationArtifact["kind"], typeof Sparkles> = {
  facts: BookOpenCheck,
  graph: Network,
  outcome: Layers3,
  rubric: ShieldCheck,
  timeline: GitBranch,
  pages: BookOpenCheck,
  branches: Route,
  audit: CheckCircle2,
};

const STAGE_LABELS: Record<string, string> = {
  launch: "项目启动",
  "ai-learning": "知识讲授",
  proposal: "方案构思",
  make: "项目实现",
  showcase: "成果汇报",
  reflection: "总结反思",
};

const MIN_CARD_DISPLAY_MS = 8_000;

export function QuickGenerationStage({
  activeArtifactId,
  artifacts,
  brief,
  message,
  progress,
  remainingLabel,
  startedAt,
  tokenUsage = 0,
  paused,
  reviewAvailable,
  reviewAvailableUntil,
  reviewKind,
  backgroundEnabled,
  cancelling,
  confirmCancel,
  completed,
  recovering = false,
  failed = false,
  failureMessage,
  retrying = false,
  previewScenesCount = 0,
  onCancel,
  onOpenCourse,
  onPreviewGenerated,
  onRetry,
  onReview,
}: {
  activeArtifactId?: string;
  artifacts: CourseDesignGenerationArtifact[];
  brief: string;
  message: string;
  progress: number;
  remainingLabel: string;
  startedAt: string | null;
  tokenUsage?: number;
  paused: boolean;
  reviewAvailable: boolean;
  reviewAvailableUntil?: string | null;
  reviewKind?: "knowledge" | "outline" | null;
  backgroundEnabled: boolean | null;
  cancelling: boolean;
  confirmCancel: boolean;
  completed: boolean;
  recovering?: boolean;
  failed?: boolean;
  failureMessage?: string;
  retrying?: boolean;
  onCancel: () => void;
  onOpenCourse: () => void;
  onPreviewGenerated?: () => void;
  previewScenesCount?: number;
  onRetry?: () => void;
  onReview: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const artifactIds = artifacts.map((item) => item.id).join("|");
  const [activeIndex, setActiveIndex] = useState(() => artifacts.length - 1);
  const [now, setNow] = useState(() => Date.now());
  const cardShownAt = useRef<number | null>(null);

  useEffect(() => {
    cardShownAt.current ??= Date.now();
  }, []);

  useEffect(() => {
    if (!activeArtifactId) return;
    const preferredIndex = artifacts.findIndex((item) => item.id === activeArtifactId);
    if (preferredIndex < 0) return;
    cardShownAt.current = Date.now();
    queueMicrotask(() => setActiveIndex(preferredIndex));
  }, [activeArtifactId, artifactIds, artifacts]);

  useEffect(() => {
    if (!artifacts.length) {
      queueMicrotask(() => setActiveIndex(-1));
      return;
    }
    if (activeIndex >= artifacts.length) {
      queueMicrotask(() => setActiveIndex(artifacts.length - 1));
    }
  }, [activeIndex, artifactIds, artifacts.length]);

  useEffect(() => {
    if (!artifacts.length || activeIndex >= artifacts.length - 1) return;
    if (activeArtifactId && artifacts[activeIndex]?.id === activeArtifactId) return;
    const visibleFor = cardShownAt.current === null ? 0 : Date.now() - cardShownAt.current;
    const delay = activeIndex < 0 || reducedMotion
      ? 100
      : Math.max(900, MIN_CARD_DISPLAY_MS - visibleFor);
    const timer = window.setTimeout(() => {
      cardShownAt.current = Date.now();
      setActiveIndex((current) => Math.min(current + 1, artifacts.length - 1));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [activeArtifactId, activeIndex, artifactIds, artifacts, artifacts.length, reducedMotion]);

  useEffect(() => {
    if (!startedAt && !reviewAvailableUntil) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [reviewAvailableUntil, startedAt]);

  const safeActiveIndex = artifacts.length > 0
    ? Math.min(Math.max(activeIndex, 0), artifacts.length - 1)
    : -1;
  const current = artifacts[safeActiveIndex];
  const displayed: CourseDesignGenerationArtifact = current ?? {
    id: "new-system-base",
    kind: "facts",
    eyebrow: "课程生成 · 课程定位",
    title: "正在确认课程定位",
    summary: message || "正在识别课程主题、学习对象、课时边界与生成要求。",
    accent: "orange",
    items: [{ label: "教师要求", value: brief || "按已确认的课程资料开始生成" }],
  };
  const elapsedSeconds = startedAt
    ? Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1_000))
    : 0;
  const previousArtifact = safeActiveIndex > 0 ? artifacts[safeActiveIndex - 1] : null;
  const nextArtifact = safeActiveIndex >= 0 && safeActiveIndex < artifacts.length - 1 ? artifacts[safeActiveIndex + 1] : null;
  const activeReviewKind = reviewKind ?? "outline";
  const reviewMatchesCard = activeReviewKind === "knowledge"
    ? displayed.kind === "graph"
    : displayed.kind === "pages";
  const reviewCountdown = reviewAvailableUntil
    ? Math.max(0, Math.ceil((new Date(reviewAvailableUntil).getTime() - now) / 1_000))
    : null;
  const reviewButtonLabel = activeReviewKind === "knowledge"
    ? "查看知识图谱并确认"
    : "查看课程大纲并确认";

  return (
    <div className="fixed inset-0 z-[70] overflow-y-auto bg-[var(--pbl-bg)] text-[var(--pbl-text-strong)]">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_50%_-20%,rgba(29,78,216,.09),transparent_68%)]" />
        <motion.div className="absolute -top-28 left-[12%] h-72 w-[520px] rounded-full bg-[linear-gradient(100deg,rgba(59,130,246,.10),rgba(139,92,246,.05),transparent)] blur-[72px]" animate={reducedMotion ? undefined : { x: [-80, 180, -80], y: [0, 46, 0], scale: [1, 1.12, 1] }} transition={{ duration: 14, repeat: Infinity, ease: "easeInOut" }} />
        <motion.div className="absolute -bottom-20 right-[8%] h-64 w-[460px] rounded-full bg-[linear-gradient(100deg,transparent,rgba(249,115,22,.08),rgba(59,130,246,.07))] blur-[78px]" animate={reducedMotion ? undefined : { x: [90, -140, 90], y: [20, -36, 20], scale: [1.05, .92, 1.05] }} transition={{ duration: 17, repeat: Infinity, ease: "easeInOut" }} />
      </div>

      <div className="relative flex min-h-full flex-col px-5 py-5 sm:px-8 sm:py-7">
        <header className="mx-auto flex w-full max-w-[1120px] justify-end" data-testid="quick-generation-command-bar">
          <div className="inline-flex flex-wrap items-center gap-1.5 rounded-[var(--radius-lg)] border border-stone-200/90 bg-white/88 p-1.5 shadow-[0_14px_34px_-25px_rgba(15,23,42,.42)] backdrop-blur-xl">
              <span
                aria-label={tokenUsage > 0
                  ? `本次课程生成约使用 ${Math.round(tokenUsage)} tokens`
                  : completed
                    ? "本次课程生成未产生新的 token 用量"
                    : "正在统计本次课程生成 token 用量"}
                className="inline-flex h-10 shrink-0 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--pbl-surface-soft)] px-3 text-[10px] text-[var(--pbl-text-muted)]"
                data-testid="course-generation-token-usage"
                title="基于模型回传数据与文本长度估算，仅供参考"
              >
                <span className="grid size-6 place-items-center rounded-full bg-white text-violet-600 shadow-sm"><Sparkles className="size-3" /></span>
                <span className="leading-tight"><span className="block text-[8px] font-semibold tracking-[.08em] text-[var(--pbl-text-subtle)]">AI 用量</span><strong className="mt-0.5 block font-semibold tabular-nums text-[var(--pbl-text)]">{formatTokenUsage(tokenUsage, completed)}</strong></span>
              </span>
              {!completed && !failed ? (
                <button
                  className="inline-flex h-10 shrink-0 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] px-3.5 text-[11px] font-semibold text-[var(--pbl-teacher)] transition hover:border-blue-300 hover:bg-blue-100/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-default disabled:border-[var(--pbl-border-soft)] disabled:bg-white disabled:text-[var(--pbl-text-subtle)] disabled:opacity-70"
                  disabled={previewScenesCount <= 0 || !onPreviewGenerated}
                  onClick={onPreviewGenerated}
                  type="button"
                >
                  <Eye className="size-3.5" />{previewScenesCount > 0 ? `预览已生成 ${previewScenesCount} 页` : "预览生成"}
                </button>
              ) : null}
              {failed ? (
                <button
                  className="inline-flex h-10 shrink-0 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--pbl-teacher)] px-3.5 text-[11px] font-semibold text-white shadow-sm transition hover:bg-[var(--pbl-teacher-hover)] disabled:cursor-wait disabled:opacity-60"
                  disabled={retrying || !onRetry}
                  onClick={onRetry}
                  type="button"
                >
                  <RotateCcw className="size-3.5" />{retrying ? "正在继续" : "从已完成页面继续"}
                </button>
              ) : completed ? (
                <button className="inline-flex h-10 shrink-0 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--pbl-teacher)] px-3.5 text-[11px] font-semibold text-white shadow-sm transition hover:bg-[var(--pbl-teacher-hover)]" onClick={onOpenCourse} type="button">
                  查看生成课程 <ArrowRight className="size-3.5" />
                </button>
              ) : (
                <button
                  className={cn(
                    "inline-flex h-10 shrink-0 items-center gap-2 rounded-[var(--radius-md)] border px-3.5 text-[11px] font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2",
                    confirmCancel
                      ? "border-red-600 bg-red-600 text-white focus-visible:outline-red-500"
                      : "border-[var(--pbl-border)] bg-white text-[var(--pbl-text-muted)] hover:border-red-200 hover:bg-red-50 hover:text-red-700 focus-visible:outline-red-400",
                  )}
                  disabled={cancelling}
                  onClick={onCancel}
                  type="button"
                >
                  <Square className="size-3" fill="currentColor" />
                  {cancelling ? "正在中断" : confirmCancel ? "确认中断" : "中断生成"}
                </button>
              )}
          </div>
        </header>

        <main className="mx-auto grid w-full max-w-[1120px] flex-1 place-items-center py-7 sm:py-9">
          <div className="w-full max-w-[820px]">
            <div className="relative isolate mx-auto h-[min(520px,calc(100vh-250px))] min-h-[430px] [perspective:1800px]">
              <motion.div
                aria-hidden
                animate={reducedMotion ? undefined : { opacity: [.42, .65, .42], scaleX: [.92, 1.04, .92] }}
                className="absolute -bottom-7 left-[9%] right-[9%] h-20 rounded-[50%] bg-[radial-gradient(ellipse,rgba(30,64,175,.18),rgba(15,23,42,.06)_48%,transparent_72%)] blur-xl"
                transition={{ duration: 5.8, repeat: Infinity, ease: "easeInOut" }}
              />
              <motion.div
                aria-hidden
                animate={reducedMotion ? undefined : { opacity: [.72, .9, .72], x: [-14, 3, -14], y: [11, -5, 11], rotate: [-4.2, -2, -4.2], scale: [.94, .955, .94] }}
                className="absolute -left-14 top-8 z-0 h-[calc(100%-50px)] w-[95%] overflow-hidden rounded-[var(--radius-xl)] border border-orange-200/80 bg-[linear-gradient(145deg,#fff7ed,#fff_72%)] shadow-[0_26px_58px_-42px_rgba(124,45,18,.46)]"
                transition={{ duration: 6.2, repeat: Infinity, ease: "easeInOut" }}
              >
                <span className="absolute inset-y-8 right-2 w-px bg-gradient-to-b from-transparent via-orange-200 to-transparent" />
                <span className="absolute bottom-5 left-3 max-h-36 overflow-hidden text-[8px] font-semibold tracking-[.12em] text-[var(--pbl-accent)] [writing-mode:vertical-rl]">{compactSideTitle(previousArtifact?.title, "课程轮廓")}</span>
              </motion.div>
              <motion.div
                aria-hidden
                animate={reducedMotion ? undefined : { opacity: [.76, .94, .76], x: [1, 17, 1], y: [-9, 8, -9], rotate: [4, 1.6, 4], scale: [.945, .96, .945] }}
                className="absolute -right-14 top-5 z-[1] h-[calc(100%-34px)] w-[95%] overflow-hidden rounded-[var(--radius-xl)] border border-blue-200/80 bg-[linear-gradient(145deg,#fff_28%,#eff6ff)] shadow-[0_28px_62px_-42px_rgba(30,64,175,.45)]"
                transition={{ duration: 7.1, repeat: Infinity, ease: "easeInOut" }}
              >
                <span className="absolute inset-y-8 left-2 w-px bg-gradient-to-b from-transparent via-blue-200 to-transparent" />
                <span className="absolute right-3 top-5 max-h-36 overflow-hidden text-[8px] font-semibold tracking-[.12em] text-[var(--pbl-teacher)] [writing-mode:vertical-rl]">{compactSideTitle(nextArtifact?.title, "继续生成")}</span>
              </motion.div>
              <div className="absolute inset-0 z-10" data-testid="quick-generation-main-card-stage">
                <AnimatePresence initial={false} mode="sync">
                  <motion.article
                    animate={{ opacity: 1, scale: 1, x: 0 }}
                    className="absolute inset-0 overflow-hidden rounded-[var(--radius-xl)] border border-stone-200/90 bg-[var(--pbl-surface)] p-5 shadow-[0_38px_86px_-40px_rgba(15,23,42,.38),0_17px_36px_-27px_rgba(37,99,235,.28),inset_0_1px_0_rgba(255,255,255,.98)] [backface-visibility:hidden] sm:p-7"
                    exit={{ opacity: 0, scale: .985, x: -96 }}
                    initial={reducedMotion ? false : { opacity: 0, scale: .985, x: 96 }}
                    key={displayed.id}
                    transition={reducedMotion ? { duration: 0 } : { duration: .5, ease: [.22, 1, .36, 1] }}
                  >
                    <span aria-hidden className="absolute inset-x-12 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent" />
                    {!paused && !completed && !failed && !recovering && !cancelling ? <span aria-hidden className="quick-card-scan absolute left-0 top-0 h-px w-28 bg-gradient-to-r from-transparent via-[var(--pbl-teacher)] to-transparent motion-reduce:hidden" /> : null}
                    <ArtifactCard
                      artifact={displayed}
                      active={!paused && !completed && !failed && !recovering && !cancelling}
                      suspendedLabel={failed ? "等待重试" : recovering ? "正在恢复" : cancelling ? "正在中断" : paused ? "已暂停" : undefined}
                    />
                    {recovering && !failed ? (
                      <div className="absolute inset-x-5 bottom-5 z-30 flex items-start gap-3 rounded-[var(--radius-md)] border border-amber-200 bg-amber-50/95 px-4 py-3 text-amber-950 shadow-sm backdrop-blur sm:inset-x-7" role="status">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700" />
                        <div><p className="text-xs font-semibold">正在自动恢复</p><p className="mt-1 text-[11px] leading-5 text-amber-800">任务心跳暂时中断，系统正在重新连接后台生成任务。已完成内容已经保存。</p></div>
                      </div>
                    ) : null}
                    {failed ? (
                      <div className="absolute inset-x-5 bottom-5 z-30 flex items-start gap-3 rounded-[var(--radius-md)] border border-amber-200 bg-amber-50/95 px-4 py-3 text-amber-950 shadow-sm backdrop-blur sm:inset-x-7">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700" />
                        <div><p className="text-xs font-semibold">课程生成未完成</p><p className="mt-1 text-[11px] leading-5 text-amber-800">{failureMessage || "已完成页面均已保留，可以从断点继续生成。"}</p></div>
                      </div>
                    ) : null}
                    {reviewAvailable && reviewMatchesCard ? (
                      <div className="absolute bottom-5 left-5 z-20 flex items-center gap-3 sm:left-7">
                        <button className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-xs)] bg-[var(--pbl-teacher)] px-4 text-xs font-semibold text-white shadow-[var(--shadow-raised)] transition hover:bg-[var(--pbl-teacher-hover)]" onClick={onReview} type="button">
                          {reviewButtonLabel} <ArrowRight className="size-3.5" />
                        </button>
                        {!paused && reviewCountdown !== null ? (
                          <span className="rounded-full border border-blue-100 bg-white/95 px-3 py-1.5 text-[11px] font-semibold text-stone-500 shadow-sm">
                            {reviewCountdown > 0 ? `${reviewCountdown} 秒后自动继续` : "正在自动继续"}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </motion.article>
                </AnimatePresence>
              </div>
            </div>

            <div className="mx-auto mt-7 flex max-w-[760px] items-center gap-4">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--pbl-border)]">
                <motion.div
                  animate={{ width: `${progress}%` }}
                  className={cn("quick-progress-current relative h-full rounded-full bg-[linear-gradient(90deg,#1d4ed8_0%,#2563eb_48%,#60a5fa_58%,#2563eb_68%,#1d4ed8_100%)] [background-size:220%_100%]", recovering && "!bg-amber-400", (recovering || paused || completed || failed || cancelling) && "[animation:none!important]")}
                  data-testid="quick-generation-progress-flow"
                  transition={{ duration: .7, ease: "easeOut" }}
                >
                  {!recovering && !paused && !completed && !failed && !cancelling ? <span aria-hidden className="quick-progress-tip absolute -right-0.5 top-1/2 size-2 -translate-y-1/2 rounded-full bg-blue-200 shadow-[0_0_8px_rgba(96,165,250,.75)]" /> : null}
                </motion.div>
              </div>
              <span className="w-11 text-right text-xs font-black tabular-nums text-blue-800">{progress}%</span>
            </div>
            <div className="mx-auto mt-3 flex max-w-[760px] flex-wrap items-center justify-between gap-x-5 gap-y-2 text-[11px] font-semibold text-stone-500">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <span className="inline-flex items-center gap-1.5"><Clock3 className="size-3.5" />已用时 {formatElapsed(elapsedSeconds)}</span>
                <span>{recovering ? "正在重新连接后台生成任务" : paused ? "预计剩余时间将在继续后更新" : remainingLabel}</span>
              </div>
              <span>{backgroundEnabled ? "可以离开，任务会继续生成" : "当前环境请保持页面打开"}</span>
            </div>
          </div>
        </main>
      </div>

      <style>{`
        @keyframes quick-progress-current { from { background-position: 100% 50% } to { background-position: 0% 50% } }
        @keyframes quick-progress-tip { 0%, 100% { opacity: .45; transform: translateY(-50%) scale(.72) } 50% { opacity: 1; transform: translateY(-50%) scale(1) } }
        @keyframes quick-card-scan { from { transform: translateX(-120px) } to { transform: translateX(860px) } }
        @keyframes quick-plan-shimmer { from { transform: translateX(-90px) skewX(-12deg) } to { transform: translateX(270px) skewX(-12deg) } }
        .quick-progress-current { animation: quick-progress-current 3.6s ease-in-out infinite alternate; }
        .quick-progress-tip { animation: quick-progress-tip 2.2s ease-in-out infinite; }
        .quick-card-scan { animation: quick-card-scan 4.8s ease-in-out infinite; }
        .quick-plan-shimmer { animation: quick-plan-shimmer 4.5s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .quick-progress-current, .quick-progress-tip, .quick-card-scan, .quick-plan-shimmer { animation: none; } }
      `}</style>
    </div>
  );
}

function formatTokenUsage(tokens: number, completed: boolean): string {
  const safeTokens = Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 0;
  if (safeTokens === 0) return completed ? "≈ 0 tokens" : "统计中";
  if (safeTokens < 1_000) return `≈ ${safeTokens} tokens`;
  if (safeTokens < 1_000_000) {
    const value = safeTokens >= 100_000
      ? Math.round(safeTokens / 1_000)
      : (safeTokens / 1_000).toFixed(1).replace(/\.0$/, "");
    return `≈ ${value}k tokens`;
  }
  return `≈ ${(safeTokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m tokens`;
}

function ArtifactCard({ artifact, active, suspendedLabel }: { artifact: CourseDesignGenerationArtifact; active: boolean; suspendedLabel?: string }) {
  const reducedMotion = useReducedMotion();
  const Icon = artifact.visualization?.generationPlan ? BrainCircuit : ICONS[artifact.kind];
  const isPageProduction = artifact.id === "ai-learning-page-production";
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const [hasOverflow, setHasOverflow] = useState(artifact.items.length > 3);
  const [atBottom, setAtBottom] = useState(false);

  useEffect(() => {
    if (isPageProduction) return;
    const area = scrollAreaRef.current;
    if (!area) return;
    const measure = () => {
      const overflow = area.scrollHeight > area.clientHeight + 6;
      setHasOverflow(overflow);
      setAtBottom(!overflow || area.scrollTop + area.clientHeight >= area.scrollHeight - 8);
    };
    if (typeof ResizeObserver === "undefined") return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    if (area.firstElementChild) observer.observe(area.firstElementChild);
    return () => observer.disconnect();
  }, [artifact.id, artifact.items.length, isPageProduction]);

  const showFade = !isPageProduction && hasOverflow && !atBottom;

  return (
    <div className={cn("flex h-full min-h-0 flex-col", isPageProduction ? "pb-0" : "pb-10")}>
      <div className={cn("flex shrink-0 items-start justify-between gap-5 border-b border-[var(--pbl-border-soft)]", isPageProduction ? "pb-3" : "pb-4")}>
        <div className="min-w-0">
          <p className={cn("text-[10px] font-semibold tracking-[.15em]", accentText(artifact.accent))}>{artifact.eyebrow}</p>
          <h1 className={cn("line-clamp-2 font-editorial font-semibold leading-tight text-[var(--pbl-text-strong)]", isPageProduction ? "mt-1.5 text-[24px] sm:text-[27px]" : "mt-2 text-[26px] sm:text-[30px]")}>{artifact.title}</h1>
          <p className={cn("max-w-[650px] text-[12px] leading-5 text-[var(--pbl-text-muted)]", isPageProduction ? "mt-1 line-clamp-1" : "mt-1.5 line-clamp-2")}>{artifact.summary}</p>
        </div>
        <motion.span
          animate={active && !reducedMotion ? { rotate: [0, -10, 8, 0], scale: [1, 1.13, 1] } : undefined}
          className={cn("grid size-10 shrink-0 place-items-center rounded-[var(--radius-md)] border", accentSurface(artifact.accent))}
          transition={{ duration: 3.2, repeat: Infinity, repeatDelay: .8, ease: "easeInOut" }}
        ><Icon className="size-5" /></motion.span>
      </div>

      <div className={cn("relative min-h-0 flex-1", isPageProduction ? "mt-3" : "mt-4")}>
        <div
          className={cn(
            "absolute inset-0",
            isPageProduction
              ? "overflow-hidden"
              : "overflow-y-auto overscroll-contain pr-2 [scrollbar-gutter:stable]",
          )}
          data-testid="quick-generation-card-scroll"
          aria-label="课程生成内容详情"
          tabIndex={isPageProduction ? undefined : 0}
          ref={scrollAreaRef}
          onScroll={(event) => {
            const target = event.currentTarget;
            setAtBottom(target.scrollTop + target.clientHeight >= target.scrollHeight - 8);
          }}
        >
          <ArtifactBody artifact={artifact} active={active} suspendedLabel={suspendedLabel} />
        </div>
        {showFade ? (
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-white/0 via-white/80 to-white" />
        ) : null}
      </div>
      {active ? <span aria-hidden className="absolute bottom-0 left-0 h-1 w-full bg-gradient-to-r from-transparent via-blue-500/55 to-transparent motion-safe:animate-pulse" /> : null}
    </div>
  );
}

function ArtifactBody({ artifact, active, suspendedLabel }: { artifact: CourseDesignGenerationArtifact; active: boolean; suspendedLabel?: string }) {
  if (artifact.visualization?.generationPlan) return <AiLearningPageProductionPreview artifact={artifact} active={active} suspendedLabel={suspendedLabel} />;
  if (artifact.visualization?.resourcePlan) return <AiLearningResourcePreview artifact={artifact} active={active} />;
  if (artifact.id.startsWith("classroom-pages-")) return <PageProductionPreview artifact={artifact} />;
  if (artifact.id === "classroom-media-assets") return <ResourceProductionPreview artifact={artifact} />;
  if (artifact.id === "classroom-tts-assets") return <TtsProductionPreview artifact={artifact} />;
  if (artifact.kind === "pages") return <OutlinePreview artifact={artifact} />;
  if (artifact.kind === "timeline") return <TimelinePreview artifact={artifact} />;
  if (artifact.kind === "rubric") return <RubricPreview artifact={artifact} />;
  if (artifact.kind === "graph") return <GraphPreview artifact={artifact} />;
  if (artifact.kind === "outcome") return <OutcomePreview artifact={artifact} />;
  if (artifact.kind === "branches") return <BranchPreview artifact={artifact} />;
  if (artifact.kind === "audit") return <AuditPreview artifact={artifact} />;
  return <FactsPreview artifact={artifact} />;
}

const PAGE_TASK_LABELS: Record<string, string> = {
  restoring: "恢复断点",
  content: "制作页面正文",
  "reviewed-content": "检查版式与知识覆盖",
  actions: "生成讲稿与教学动作",
  narration: "校验课堂口语",
  assembling: "组装并保存页面",
};

const PAGE_TASK_STAGES = [
  "restoring",
  "content",
  "reviewed-content",
  "actions",
  "narration",
  "assembling",
] as const;

const PAGE_TASK_SHORT_LABELS: Record<typeof PAGE_TASK_STAGES[number], string> = {
  restoring: "恢复",
  content: "正文",
  "reviewed-content": "检查",
  actions: "讲稿动作",
  narration: "口语",
  assembling: "保存",
};

function AiLearningPageProductionPreview({ artifact, active, suspendedLabel }: { artifact: CourseDesignGenerationArtifact; active: boolean; suspendedLabel?: string }) {
  const reducedMotion = useReducedMotion();
  const plan = artifact.visualization?.generationPlan;
  if (!plan) return <TimelinePreview artifact={artifact} />;

  const sceneCounts = plan.scenes.reduce<Record<string, number>>((counts, scene) => {
    counts[scene.type] = (counts[scene.type] ?? 0) + 1;
    return counts;
  }, {});
  const statusLabels = { queued: "等待开始", running: "正在生成", recovering: "正在恢复", cancelling: "正在中断", cancelled: "已中断", completed: "已完成", failed: "等待重试" };
  const statusLabel = suspendedLabel ?? statusLabels[plan.status];
  const isRunning = active && plan.status === "running";
  const pageProgress = plan.totalScenes > 0 ? Math.min(100, (plan.completedScenes / plan.totalScenes) * 100) : 0;
  const activePages = (plan.activePages ?? []).slice(0, 4);
  const nextScene = plan.scenes[Math.min(plan.completedScenes, Math.max(0, plan.scenes.length - 1))];

  return (
    <div className="grid h-full min-h-0 sm:grid-cols-[200px_minmax(0,1fr)]">
      <motion.section
        animate={{ opacity: 1, x: 0 }}
        className="relative isolate min-h-0 overflow-hidden border-l-2 border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)]/55 px-4 py-3.5 text-[var(--pbl-text)]"
        initial={false}
      >
        {isRunning ? <span aria-hidden className="quick-plan-shimmer absolute inset-y-0 w-20 bg-gradient-to-r from-transparent via-white/80 to-transparent motion-reduce:hidden" data-testid="ai-plan-shimmer" /> : null}
        <div className="relative flex h-full flex-col">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--pbl-teacher-border)] bg-white px-2.5 py-1 text-[9px] font-semibold tracking-[.12em] text-[var(--pbl-teacher)]">
              <BookOpenCheck className="size-3" />页面制作
            </span>
            <span className="text-[10px] font-medium text-[var(--pbl-text-subtle)]">并行任务</span>
          </div>

          <div className="mt-3 flex items-end gap-2 sm:mt-4">
            <strong className="font-editorial text-[40px] font-semibold leading-none tabular-nums sm:text-[46px]">{plan.completedScenes}</strong>
            <span className="pb-1 text-[13px] font-semibold tabular-nums text-[var(--pbl-text-muted)]">/ {plan.totalScenes || "—"} 页已完成</span>
          </div>
          <div aria-label="课堂页面制作进度" aria-valuemax={plan.totalScenes || 100} aria-valuemin={0} aria-valuenow={plan.completedScenes} aria-valuetext={plan.totalScenes > 0 ? `已完成 ${plan.completedScenes} / ${plan.totalScenes} 页` : "等待页面计划"} className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--pbl-border)]" role="progressbar">
            <motion.div animate={{ width: `${pageProgress}%` }} className="h-full rounded-full bg-[var(--pbl-teacher)]" initial={false} transition={{ duration: reducedMotion ? 0 : .5 }} />
          </div>
          <p className="mt-2 text-[11px] leading-4 text-[var(--pbl-text-muted)]">
            预计授课 {formatPlanDuration(plan.estimatedDuration)}
          </p>

          <div className="mt-auto grid grid-cols-3 gap-1.5 pt-3">
            {[
              { label: "讲解", value: sceneCounts.slide ?? 0 },
              { label: "互动", value: sceneCounts.interactive ?? 0 },
              { label: "检测", value: sceneCounts.quiz ?? 0 },
            ].map((stat) => (
              <div className="border-l border-[var(--pbl-border)] px-2 py-1.5 text-center first:border-l-0" key={stat.label}>
                <strong className="block text-[15px] leading-none tabular-nums">{stat.value}</strong>
                <span className="mt-1 block text-[10px] text-[var(--pbl-text-muted)]">{stat.label}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-center text-[10px] text-[var(--pbl-text-subtle)]">按已确认大纲统计</p>
        </div>
      </motion.section>

      <section className="min-w-0 border-t border-[var(--pbl-border)] px-4 py-3 sm:border-l sm:border-t-0 sm:pl-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold tracking-[.06em] text-[var(--pbl-teacher)]">当前页面任务</p>
          <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold", suspendedLabel || ["failed", "cancelled", "cancelling", "recovering"].includes(plan.status) ? "bg-amber-50 text-amber-800" : "bg-blue-50 text-blue-700")}>
            <span className={cn("size-1.5 rounded-full bg-current", isRunning && "motion-safe:animate-pulse")} />{statusLabel}
          </span>
        </div>

        <div className="mt-2.5 divide-y divide-[var(--pbl-border-soft)] border-y border-[var(--pbl-border)]" aria-label="当前并行页面任务">
          {activePages.map((page, index) => {
            const currentStageIndex = PAGE_TASK_STAGES.indexOf(page.stage as typeof PAGE_TASK_STAGES[number]);
            const progressValue = Math.max(0, currentStageIndex + 1);
            return (
              <motion.section
                animate={{ opacity: 1, x: 0 }}
                className="py-2"
                initial={false}
                key={`${page.index}-${page.stage}`}
                transition={{ delay: index * .06 }}
              >
                <div className="grid grid-cols-[54px_minmax(0,1fr)_auto] items-center gap-3">
                  <span className="text-[10px] font-semibold tabular-nums text-[var(--pbl-text-subtle)]">第 {String(page.index).padStart(2, "0")} 页</span>
                  <span className="min-w-0">
                    <span className="block truncate text-[11px] font-semibold text-[var(--pbl-text)]" title={page.title}>{page.title}</span>
                    <span className="mt-0.5 block text-[9px] text-[var(--pbl-text-subtle)]">{pageTaskRuntime(page)}</span>
                  </span>
                  <span className="max-w-28 text-right text-[10px] font-semibold leading-4 text-[var(--pbl-teacher)]">{PAGE_TASK_LABELS[page.stage] ?? "处理页面内容"}</span>
                </div>

                <div
                  aria-label={`第 ${page.index} 页制作进度`}
                  aria-valuemax={PAGE_TASK_STAGES.length}
                  aria-valuemin={0}
                  aria-valuenow={progressValue}
                  aria-valuetext={PAGE_TASK_LABELS[page.stage] ?? "处理页面内容"}
                  className="mt-1.5 pl-[66px]"
                  role="progressbar"
                >
                  <div className="grid grid-cols-6 gap-1" aria-hidden>
                    {PAGE_TASK_STAGES.map((stage, stageIndex) => (
                      <motion.span
                        animate={stageIndex === currentStageIndex && isRunning && !reducedMotion ? { opacity: [.55, 1, .55] } : undefined}
                        className={cn(
                          "h-1 rounded-full",
                          stageIndex < currentStageIndex && "bg-blue-400",
                          stageIndex === currentStageIndex && "bg-[var(--pbl-teacher)] shadow-[0_0_0_2px_var(--pbl-teacher-soft)]",
                          stageIndex > currentStageIndex && "bg-[var(--pbl-border)]",
                        )}
                        key={stage}
                        transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
                      />
                    ))}
                  </div>
                  <div className="mt-1 grid grid-cols-6 gap-1" aria-hidden>
                    {PAGE_TASK_STAGES.map((stage, stageIndex) => (
                      <span
                        className={cn(
                          "truncate text-center text-[7px] font-medium leading-none",
                          stageIndex <= currentStageIndex ? "text-[var(--pbl-text-muted)]" : "text-[var(--pbl-text-subtle)]",
                        )}
                        key={stage}
                      >
                        {PAGE_TASK_SHORT_LABELS[stage]}
                      </span>
                    ))}
                  </div>
                </div>
              </motion.section>
            );
          })}
          {activePages.length === 0 ? (
            <div className="px-3 py-4 text-center">
              <p className="text-[11px] font-semibold text-[var(--pbl-text)]">{plan.message || statusLabel}</p>
              {nextScene ? <p className="mt-1 text-[10px] text-[var(--pbl-text-muted)]">下一页：{nextScene.title}</p> : null}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function pageTaskRuntime(page: NonNullable<NonNullable<NonNullable<CourseDesignGenerationArtifact["visualization"]>["generationPlan"]>["activePages"]>[number]): string {
  const details: string[] = [];
  if ((page.queueMs ?? 0) >= 1_000) details.push(`排队 ${Math.ceil(page.queueMs! / 1_000)} 秒`);
  if ((page.executionMs ?? 0) >= 1_000) details.push(`已处理 ${Math.ceil(page.executionMs! / 1_000)} 秒`);
  if ((page.retryCount ?? 0) > 0) details.push(`已重试 ${page.retryCount} 次`);
  return details.join(" · ") || "任务正在执行";
}

function AiLearningResourcePreview({ artifact, active }: { artifact: CourseDesignGenerationArtifact; active: boolean }) {
  const plan = artifact.visualization?.resourcePlan;
  if (!plan) return <FactsPreview artifact={artifact} />;
  const icons = { routing: Link2, adaptive: Route, media: ImageIcon, tts: Mic2 };
  const statusText = { pending: "等待开始", running: "正在处理", completed: "已完成", warning: "部分待处理", skipped: "无需生成" };
  return (
    <div className="grid min-h-[250px] content-center gap-x-6 sm:grid-cols-2">
      {plan.lanes.map((lane, index) => {
        const Icon = icons[lane.id];
        const percentage = lane.total && lane.total > 0 ? Math.min(100, ((lane.completed ?? 0) / lane.total) * 100) : null;
        return (
          <motion.section
            animate={{ opacity: 1, y: 0 }}
            className="border-t border-[var(--pbl-border)] py-4"
            initial={false}
            key={lane.id}
            transition={{ delay: index * .07 }}
          >
            <div className="flex items-start gap-3">
              <span className={cn(
                "relative grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)] border",
                lane.status === "completed" && "border-emerald-200 bg-emerald-50 text-emerald-700",
                lane.status === "warning" && "border-amber-200 bg-amber-50 text-amber-800",
                !["completed", "warning"].includes(lane.status) && "border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]",
              )}>
                <Icon className="size-4" />
                {active && lane.status === "running" ? <span aria-hidden className="absolute -bottom-1 -right-1 size-2 rounded-full bg-emerald-500 ring-2 ring-white motion-safe:animate-pulse" /> : null}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[11px] font-semibold text-[var(--pbl-text)]">{lane.label}</p>
                  <span className="shrink-0 text-[9px] font-semibold text-[var(--pbl-text-subtle)]">{statusText[lane.status]}</span>
                </div>
                <p className="mt-1 text-[9px] leading-[15px] text-[var(--pbl-text-muted)]">{lane.message}</p>
                {percentage !== null ? (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--pbl-border-soft)]"><motion.span animate={{ width: `${percentage}%` }} className="block h-full bg-[var(--pbl-teacher)]" initial={false} /></div>
                    <span className="text-[9px] tabular-nums text-[var(--pbl-text-subtle)]">{lane.completed ?? 0}/{lane.total}</span>
                  </div>
                ) : null}
              </div>
            </div>
          </motion.section>
        );
      })}
    </div>
  );
}

function FactsPreview({ artifact }: { artifact: CourseDesignGenerationArtifact }) {
  const [lead, ...rest] = artifact.items;
  return (
    <div className="grid min-h-[250px] gap-6 sm:grid-cols-[1.05fr_.95fr] sm:items-stretch">
      <motion.section className="relative flex flex-col justify-between overflow-hidden border-l-2 border-[var(--pbl-teacher)] bg-[linear-gradient(90deg,var(--pbl-teacher-soft),transparent_82%)] px-5 py-4" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}>
        <motion.span aria-hidden className="absolute inset-y-0 w-24 -skew-x-12 bg-gradient-to-r from-transparent via-white/75 to-transparent" animate={{ x: [-140, 480] }} transition={{ duration: 3.6, repeat: Infinity, repeatDelay: 1.4, ease: "easeInOut" }} />
        <div className="relative">
          <p className="text-[9px] font-semibold tracking-[.14em] text-[var(--pbl-text-subtle)]">{lead?.label ?? "课程信息"}</p>
          <p className="mt-3 font-editorial text-[24px] font-semibold leading-tight text-[var(--pbl-text-strong)]">{lead?.value ?? artifact.title}</p>
        </div>
        {lead?.meta ? <p className="relative mt-4 line-clamp-4 max-w-md text-[11px] leading-[18px] text-[var(--pbl-text-muted)]">{lead.meta}</p> : null}
      </motion.section>
      <dl className="flex flex-col divide-y divide-[var(--pbl-border)]">
        {rest.map((item, index) => (
          <motion.div className="grid flex-1 grid-cols-[74px_1fr] items-center gap-4 py-3" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: index * .07 }} key={`${item.label}-${index}`}>
            <dt className="text-[9px] font-semibold tracking-[.08em] text-[var(--pbl-text-subtle)]">{item.label}</dt>
            <dd className="min-w-0"><p className="line-clamp-2 text-[12px] font-semibold leading-[18px] text-[var(--pbl-text)]">{item.value}</p>{item.meta ? <p className="mt-0.5 line-clamp-1 text-[9px] text-[var(--pbl-text-subtle)]">{item.meta}</p> : null}</dd>
          </motion.div>
        ))}
      </dl>
    </div>
  );
}

function GraphPreview({ artifact }: { artifact: CourseDesignGenerationArtifact }) {
  if (artifact.visualization?.knowledgeGraph) {
    const levelOrder = ["foundation", "core", "application", "extension"] as const;
    const levelLabel = { foundation: "基础", core: "核心", application: "应用", extension: "拓展" };
    const pointById = new Map((artifact.visualization.knowledgePoints ?? []).map((point) => [point.id, point]));
    const groups = levelOrder.map((level) => ({
      level,
      points: artifact.visualization!.knowledgeGraph!.nodes.filter((node) => (node.level ?? pointById.get(node.id)?.level ?? "core") === level),
    })).filter((group) => group.points.length > 0);
    return (
      <div className="flex min-h-[250px] flex-col">
        <div className="grid flex-1 divide-y divide-[var(--pbl-border)] sm:grid-cols-4 sm:divide-x sm:divide-y-0">
          {groups.map((group, groupIndex) => (
            <motion.section className="relative px-4 py-3 first:pl-0 last:pr-0" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: groupIndex * .08 }} key={group.level}>
              <div className="flex items-center gap-2">
                <span className="grid size-5 place-items-center rounded-full bg-[var(--pbl-teacher-soft)] text-[9px] font-bold text-[var(--pbl-teacher)]">{groupIndex + 1}</span>
                <p className="text-[9px] font-semibold tracking-[.13em] text-[var(--pbl-text-subtle)]">{levelLabel[group.level]}</p>
              </div>
              <div className="mt-4 space-y-4">
                {group.points.slice(0, 3).map((node) => {
                  const point = pointById.get(node.id);
                  return (
                    <div className="border-l border-[var(--pbl-teacher-border)] pl-3" key={node.id}>
                      <p className="text-[12px] font-semibold leading-[18px] text-[var(--pbl-text)]">{node.label}</p>
                      {(node.description || point?.description) ? <p className="mt-1 line-clamp-2 text-[9px] leading-[15px] text-[var(--pbl-text-subtle)]">{node.description || point?.description}</p> : null}
                    </div>
                  );
                })}
              </div>
              {groupIndex < groups.length - 1 ? <motion.span className="absolute -right-2.5 top-3.5 z-10 hidden bg-white sm:block" animate={{ x: [0, 5, 0], opacity: [.45, 1, .45] }} transition={{ delay: groupIndex * .3, duration: 1.8, repeat: Infinity }}><ArrowRight className="size-4 text-[var(--pbl-teacher-border)]" /></motion.span> : null}
            </motion.section>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3 border-t border-[var(--pbl-border-soft)] pt-3 text-[9px] text-[var(--pbl-text-subtle)]">
          <span className="font-semibold text-[var(--pbl-teacher)]">学习逻辑</span>
          <span className="truncate">{artifact.visualization.knowledgeGraph.edges.slice(0, 4).map((edge) => edge.label).filter(Boolean).join(" · ") || `${artifact.visualization.knowledgeGraph.edges.length} 条知识关联`}</span>
        </div>
      </div>
    );
  }
  if (artifact.id === "knowledge-relations") {
    return (
      <div className="divide-y divide-[var(--pbl-border)] border-y border-[var(--pbl-border)]">
        {artifact.items.map((item, index) => {
          const [source, target] = item.value.split("→").map((value) => value.trim());
          return (
            <motion.div className="grid grid-cols-[1fr_68px_1fr] items-center gap-3 py-3" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * .07 }} key={`${item.value}-${index}`}>
              <p className="text-right text-[11px] font-semibold text-[var(--pbl-text)]">{source}</p>
              <div className="flex items-center gap-1"><span className="h-px flex-1 bg-[var(--pbl-ai-border)]" /><span className="text-[8px] text-[var(--pbl-ai)]">{item.label}</span><ArrowRight className="size-3 text-[var(--pbl-ai)]" /></div>
              <p className="text-[11px] font-semibold text-[var(--pbl-text)]">{target}</p>
            </motion.div>
          );
        })}
      </div>
    );
  }
  return (
    <div className="grid min-h-[250px] content-center gap-x-7 gap-y-3 sm:grid-cols-2">
      {artifact.items.map((item, index) => (
        <motion.div className="grid grid-cols-[24px_1fr] gap-3 border-b border-[var(--pbl-border)] py-3" initial={{ opacity: 0, x: index % 2 ? 8 : -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: index * .07 }} key={`${item.value}-${index}`}>
          <span className="grid size-5 place-items-center rounded-full bg-[var(--pbl-teacher-soft)] text-[8px] font-semibold text-[var(--pbl-teacher)]">{index + 1}</span><div><p className="text-[8px] text-[var(--pbl-text-subtle)]">{item.label}</p><p className="mt-1 line-clamp-2 text-[10px] font-semibold leading-[16px] text-[var(--pbl-text)]">{item.value}</p></div>
        </motion.div>
      ))}
    </div>
  );
}

function RubricPreview({ artifact }: { artifact: CourseDesignGenerationArtifact }) {
  const colors = ["#2563eb", "#f97316", "#16a34a", "#8b5cf6", "#0891b2", "#db2777", "#65a30d", "#d97706"];
  const ruleRadius = 50;
  const ruleCircumference = 2 * Math.PI * ruleRadius;
  const evaluatorRadius = 62;
  const evaluatorCircumference = 2 * Math.PI * evaluatorRadius;
  const weightedItems = artifact.items.map((item, index) => ({
    ...item,
    color: colors[index % colors.length],
    evaluator: resolveEvaluationRole(item, index),
    weight: Number(item.label.match(/(\d+(?:\.\d+)?)\s*%/)?.[1] ?? 1),
  }));
  const totalWeight = weightedItems.reduce((total, item) => total + item.weight, 0) || 1;
  const segments = weightedItems.reduce<Array<(typeof weightedItems)[number] & { angle: number; startAngle: number }>>((result, item) => {
    const previous = result.at(-1);
    const startAngle = previous ? previous.startAngle + previous.angle : 0;
    const angle = (item.weight / totalWeight) * 360;
    return [...result, { ...item, angle, startAngle }];
  }, []);
  const teacherWeight = weightedItems.filter((item) => item.evaluator === "teacher").reduce((total, item) => total + item.weight, 0);
  const aiWeight = weightedItems.filter((item) => item.evaluator === "ai").reduce((total, item) => total + item.weight, 0);
  const evaluatorSegments = [
    { color: "#dbeafe", label: "教师评", startWeight: 0, weight: teacherWeight },
    { color: "#ede9fe", label: "AI 评", startWeight: teacherWeight, weight: aiWeight },
  ].filter((item) => item.weight > 0);

  return (
    <div className="grid min-h-[250px] gap-6 sm:grid-cols-[236px_1fr] sm:items-center">
      <div className="relative mx-auto grid size-[226px] place-items-center" data-testid="rubric-evaluation-ring">
        <motion.span aria-hidden animate={{ scale: [1, 1.055, 1], opacity: [.28, .5, .28] }} className="absolute inset-8 rounded-full bg-[radial-gradient(circle,rgba(59,130,246,.12),transparent_68%)] blur-lg" transition={{ duration: 4.8, repeat: Infinity, ease: "easeInOut" }} />
        <svg aria-label="评价规则权重与评价主体" className="relative size-full overflow-visible" role="img" viewBox="0 0 180 180">
          <circle cx="90" cy="90" fill="none" r={evaluatorRadius} stroke="#f1f5f9" strokeWidth="28" />
          {evaluatorSegments.map((item, index) => {
            const segmentLength = (item.weight / totalWeight) * evaluatorCircumference;
            const offset = (item.startWeight / totalWeight) * evaluatorCircumference;
            return (
              <motion.circle
                animate={{ strokeDashoffset: -offset }}
                cx="90"
                cy="90"
                fill="none"
                initial={{ strokeDashoffset: evaluatorCircumference - offset }}
                key={item.label}
                r={evaluatorRadius}
                stroke={item.color}
                strokeDasharray={`${segmentLength} ${Math.max(1, evaluatorCircumference - segmentLength)}`}
                strokeLinecap="butt"
                strokeWidth="28"
                transform="rotate(-90 90 90)"
                transition={{ delay: .08 + index * .12, duration: 1.05, ease: [.22, 1, .36, 1] }}
              />
            );
          })}
          <circle cx="90" cy="90" fill="none" r={ruleRadius} stroke="rgba(255,255,255,.9)" strokeWidth="19" />
          {segments.map((item, index) => {
            const segmentLength = (item.angle / 360) * ruleCircumference;
            const offset = (item.startAngle / 360) * ruleCircumference;
            return (
              <motion.circle
                animate={{ strokeDashoffset: -offset }}
                cx="90"
                cy="90"
                fill="none"
                initial={{ strokeDashoffset: ruleCircumference - offset }}
                key={`${item.value}-weight`}
                r={ruleRadius}
                stroke={item.color}
                strokeDasharray={`${Math.max(1, segmentLength - 3.5)} ${Math.max(1, ruleCircumference - segmentLength + 3.5)}`}
                strokeLinecap="round"
                strokeWidth="13"
                transform="rotate(-90 90 90)"
                transition={{ delay: .12 + index * .11, duration: .9, ease: "easeOut" }}
              />
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-content-center text-center">
          <span className="text-[8px] font-semibold tracking-[.16em] text-[var(--pbl-text-subtle)]">评价规则</span>
          <strong className="mt-1 font-editorial text-[28px] font-semibold leading-none text-[var(--pbl-text-strong)]">{artifact.items.length}</strong>
          <span className="mt-1 text-[8px] text-[var(--pbl-text-subtle)]">项已对齐目标</span>
        </div>
        <div className="absolute -bottom-1 left-1/2 flex -translate-x-1/2 items-center gap-4 whitespace-nowrap text-[8px] font-semibold text-[var(--pbl-text-muted)]">
          <span className="inline-flex items-center gap-1.5"><i className="h-2 w-5 rounded-full bg-blue-100 ring-1 ring-blue-200" />教师评 {Math.round((teacherWeight / totalWeight) * 100)}%</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-2 w-5 rounded-full bg-violet-100 ring-1 ring-violet-200" />AI 评 {Math.round((aiWeight / totalWeight) * 100)}%</span>
        </div>
      </div>
      <div className="grid content-center divide-y divide-[var(--pbl-border-soft)] sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        {segments.map((item, index) => (
          <motion.div
            animate={{ opacity: 1, x: 0, y: 0 }}
            className="relative min-h-[92px] border-b border-[var(--pbl-border-soft)] px-3 py-2.5 sm:[&:nth-last-child(-n+2)]:border-b-0"
            initial={{ opacity: 0, x: index % 2 ? 10 : -10, y: 5 }}
            key={`${item.value}-rule`}
            transition={{ delay: .28 + index * .08, duration: .42 }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                <p className="line-clamp-1 text-[11px] font-semibold text-[var(--pbl-text-strong)]">{item.value}</p>
              </div>
              <span className="shrink-0 text-[9px] font-bold tabular-nums" style={{ color: item.color }}>{item.weight}%</span>
            </div>
            {item.meta ? <p className="mt-2 line-clamp-2 pl-4 text-[9px] leading-[15px] text-[var(--pbl-text-muted)]">{item.meta}</p> : null}
            <span className={cn("mt-2 ml-4 inline-flex items-center gap-1.5 text-[8px] font-semibold", item.evaluator === "ai" ? "text-violet-700" : "text-blue-700")}><i className={cn("h-1.5 w-3 rounded-full", item.evaluator === "ai" ? "bg-violet-100 ring-1 ring-violet-200" : "bg-blue-100 ring-1 ring-blue-200")} />{item.evaluator === "ai" ? "AI 评" : "教师评"}</span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function TimelinePreview({ artifact }: { artifact: CourseDesignGenerationArtifact }) {
  const roleLayout = artifact.id === "teaching-roles";
  if (!roleLayout) {
    const durations = artifact.items.map((item) => Number(item.label.match(/(\d+)/)?.[1] ?? 1));
    const total = durations.reduce((sum, value) => sum + value, 0) || 1;
    return (
      <div className="flex min-h-[250px] flex-col justify-center">
        <div className="mb-3 flex items-baseline justify-between"><span className="text-[9px] font-semibold tracking-[.12em] text-[var(--pbl-text-subtle)]">课堂时间分配</span><span className="font-editorial text-2xl text-[var(--pbl-text-strong)]">{total} 分钟</span></div>
        <div className="relative flex h-10 overflow-hidden rounded-[var(--radius-sm)] bg-[var(--pbl-surface-soft)]">
          {artifact.items.map((item, index) => (
            <motion.div className={cn("relative flex min-w-[42px] items-center justify-center overflow-hidden border-r border-white/70 px-1.5 text-center text-[8px] font-semibold last:border-r-0", index % 3 === 0 ? "bg-orange-100 text-orange-900" : index % 3 === 1 ? "bg-blue-100 text-blue-900" : "bg-amber-50 text-amber-900")} initial={{ width: 0 }} animate={{ width: `${(durations[index] / total) * 100}%` }} transition={{ delay: index * .07, duration: .65 }} key={`${item.value}-${index}`}>
              <span className="line-clamp-1">{item.value}</span>
            </motion.div>
          ))}
          <motion.span aria-hidden className="absolute inset-y-0 w-8 -skew-x-12 bg-gradient-to-r from-transparent via-white/80 to-transparent" animate={{ x: [-60, 760] }} transition={{ duration: 3.4, repeat: Infinity, repeatDelay: 1, ease: "easeInOut" }} />
        </div>
        <div className="relative mt-7 grid grid-cols-3 gap-x-4 gap-y-4 sm:grid-cols-6">
          <span aria-hidden className="absolute left-5 right-5 top-1.5 h-px bg-[var(--pbl-border)]" />
          {artifact.items.map((item, index) => (
            <motion.div className="relative pt-4 text-center" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .3 + index * .06 }} key={`${item.label}-${index}`}>
              <span className={cn("absolute left-1/2 top-0 size-3 -translate-x-1/2 rounded-full border-[3px] border-white", index % 2 ? "bg-blue-600" : "bg-orange-500")} />
              <p className="line-clamp-2 text-[10px] font-semibold leading-[15px] text-[var(--pbl-text)]">{item.value}</p><p className="mt-1 text-[8px] text-[var(--pbl-text-subtle)]">{item.label}</p>
            </motion.div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-[250px] divide-y divide-[var(--pbl-border)] border-y border-[var(--pbl-border)]">
      <div className="hidden grid-cols-[92px_1fr_24px_1fr] gap-3 bg-[var(--pbl-surface-soft)] px-3 py-2 text-[8px] font-semibold tracking-[.12em] text-[var(--pbl-text-subtle)] sm:grid"><span>阶段</span><span>教师组织</span><span /><span>AI 协作</span></div>
      {artifact.items.map((item, index) => (
        <motion.div className="grid gap-2 px-3 py-3 sm:grid-cols-[92px_1fr_24px_1fr] sm:items-start sm:gap-3" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * .06 }} key={`${item.label}-${index}`}>
          <p className="text-[9px] font-semibold text-[var(--pbl-teacher)]"><span className="mr-2 text-[var(--pbl-text-subtle)]">{String(index + 1).padStart(2, "0")}</span>{item.label}</p>
          <p className="line-clamp-2 text-[10px] font-medium leading-[16px] text-[var(--pbl-text)]">{item.value}</p>
          <motion.span className="mt-0.5 hidden sm:block" animate={{ x: [0, 4, 0], opacity: [.45, 1, .45] }} transition={{ delay: index * .18, duration: 1.7, repeat: Infinity }}><ArrowRight className="size-3 text-[var(--pbl-teacher-border)]" /></motion.span>
          <p className="line-clamp-2 text-[10px] leading-[16px] text-[var(--pbl-text-muted)]">{item.meta?.replace(/^AI：/, "")}</p>
        </motion.div>
      ))}
    </div>
  );
}

function OutcomePreview({ artifact }: { artifact: CourseDesignGenerationArtifact }) {
  const [primary, ...evidence] = artifact.items;
  return (
    <div className="grid min-h-[250px] gap-7 sm:grid-cols-[.82fr_1.18fr] sm:items-stretch">
      <motion.div className="relative flex flex-col justify-between overflow-hidden border-t-2 border-orange-500 bg-[linear-gradient(180deg,var(--pbl-accent-soft),transparent)] px-4 py-4" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <motion.span aria-hidden className="absolute -right-8 top-1/2 size-28 -translate-y-1/2 rounded-full border-[14px] border-orange-100/80" animate={{ rotate: 360, scale: [1, 1.1, 1] }} transition={{ rotate: { duration: 15, repeat: Infinity, ease: "linear" }, scale: { duration: 4, repeat: Infinity } }} />
        <div className="relative"><p className="text-[9px] font-semibold tracking-[.14em] text-[var(--pbl-accent)]">核心产出</p><p className="mt-3 font-editorial text-[25px] font-semibold leading-tight text-[var(--pbl-text-strong)]">{primary?.value ?? artifact.title}</p></div>
        <p className="relative mt-5 line-clamp-3 text-[10px] leading-[17px] text-[var(--pbl-text-muted)]">{primary?.meta ?? artifact.summary}</p>
      </motion.div>
      <div className="grid divide-y divide-[var(--pbl-border)] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {evidence.map((item, index) => (
          <motion.div className="flex min-h-28 flex-col justify-between px-4 py-3 first:pl-0 last:pr-0" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .08 + index * .07 }} key={`${item.label}-${index}`}>
            <p className="text-[9px] font-semibold tracking-[.1em] text-[var(--pbl-text-subtle)]">{item.label}</p>
            <p className="mt-3 line-clamp-4 text-[11px] font-medium leading-[18px] text-[var(--pbl-text)]">{item.value}</p>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function OutlinePreview({ artifact }: { artifact: CourseDesignGenerationArtifact }) {
  const groups = useMemo(() => {
    const ordered = new Map<string, CourseDesignGenerationArtifact["items"]>();
    for (const item of artifact.items) ordered.set(item.label, [...(ordered.get(item.label) ?? []), item]);
    return [...ordered.entries()];
  }, [artifact.items]);
  return (
    <div className="divide-y divide-[var(--pbl-border)] border-y border-[var(--pbl-border)]">
      {groups.map(([stage, items], groupIndex) => (
        <section className="grid gap-2 py-3 sm:grid-cols-[104px_1fr]" key={stage}>
          <div className="flex items-start justify-between gap-2 sm:block"><p className="text-[10px] font-semibold text-[var(--pbl-teacher)]">{STAGE_LABELS[stage] ?? userFacingStageLabel(stage)}</p><span className="mt-1 text-[8px] text-[var(--pbl-text-subtle)]">{items.length} 项资源</span></div>
          <div className="divide-y divide-[var(--pbl-border-soft)] border-l border-[var(--pbl-teacher-border)] pl-3">
            {items.map((item, index) => (
              <motion.div className="relative grid grid-cols-[1fr_auto] items-center gap-3 py-2" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min((groupIndex + index) * .04, .32) }} key={`${item.value}-${index}`}>
                <span className="absolute -left-[15.5px] top-3.5 size-1.5 rounded-full bg-[var(--pbl-teacher)] ring-[3px] ring-white" />
                <p className="line-clamp-1 text-[10px] font-medium text-[var(--pbl-text)]">{item.value}</p><p className="whitespace-nowrap text-[8px] text-[var(--pbl-text-subtle)]">{item.meta}</p>
              </motion.div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function PageProductionPreview({ artifact }: { artifact: CourseDesignGenerationArtifact }) {
  const current = artifact.items.at(-1);
  return (
    <div className="grid min-h-[250px] gap-6 sm:grid-cols-[1fr_220px]">
      <motion.div className="relative flex flex-col justify-between overflow-hidden border border-[var(--pbl-teacher-border)] bg-[linear-gradient(135deg,var(--pbl-teacher-soft),#fff_62%,var(--pbl-accent-soft))] p-5" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}>
        <div className="flex items-center justify-between border-b border-blue-100 pb-3"><p className="text-[9px] font-semibold tracking-[.13em] text-[var(--pbl-teacher)]">{current?.label ?? "课堂页面"}</p><span className="inline-flex items-center gap-1 text-[8px] text-[var(--pbl-text-subtle)]"><span className="size-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse" />正在编排</span></div>
        <div><h3 className="max-w-[520px] font-editorial text-[25px] font-semibold leading-tight text-[var(--pbl-text-strong)]">{current?.value ?? artifact.title}</h3><p className="mt-3 text-[10px] text-[var(--pbl-text-subtle)]">{current?.meta}</p></div>
        <div className="grid grid-cols-[1.4fr_.9fr_.6fr] gap-2"><span className="h-0.5 bg-[var(--pbl-teacher)]" /><span className="h-0.5 bg-orange-400" /><span className="h-0.5 bg-[var(--pbl-border)]" /></div>
      </motion.div>
      <div className="flex flex-col justify-center divide-y divide-[var(--pbl-border)] border-y border-[var(--pbl-border)]">
        {artifact.items.map((item, index) => (
          <motion.div className={cn("grid grid-cols-[22px_1fr] gap-2 py-3", index === artifact.items.length - 1 && "text-[var(--pbl-teacher)]")} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: index * .08 }} key={`${item.value}-${index}`}><span className={cn("grid size-5 place-items-center rounded-full text-[8px] font-semibold", index === artifact.items.length - 1 ? "bg-[var(--pbl-teacher)] text-white" : "bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-subtle)]")}>{index + 1}</span><div><p className="line-clamp-2 text-[10px] font-semibold leading-[15px] text-[var(--pbl-text)]">{item.value}</p><p className="mt-1 text-[8px] text-[var(--pbl-text-subtle)]">{item.label}</p></div></motion.div>
        ))}
      </div>
    </div>
  );
}

function ResourceProductionPreview({ artifact }: { artifact: CourseDesignGenerationArtifact }) {
  return (
    <div className="grid min-h-[250px] gap-8 sm:grid-cols-2">
      {artifact.items.map((item, index) => (
        <motion.section className={cn("flex flex-col border-t-2 px-1 pt-3", index % 2 ? "border-orange-400" : "border-blue-500")} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * .1 }} key={`${item.label}-${index}`}>
          <div className="flex items-start gap-3"><span className={cn("relative grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)] border", index % 2 ? "border-orange-200 bg-orange-50 text-orange-700" : "border-blue-200 bg-blue-50 text-blue-700")}><Layers3 className="size-4" /><motion.span aria-hidden className="absolute -bottom-1 -right-1 size-2 rounded-full bg-emerald-500 ring-2 ring-white" animate={{ opacity: [.35, 1, .35] }} transition={{ duration: 1.6, repeat: Infinity }} /></span><div><p className="text-[11px] font-semibold text-[var(--pbl-text)]">{item.label}</p><p className="mt-1 line-clamp-2 text-[9px] leading-[15px] text-[var(--pbl-text-subtle)]">{item.value}</p></div></div>
          <div className={cn("relative mt-4 grid flex-1 grid-cols-[1.4fr_.8fr] grid-rows-2 gap-2 overflow-hidden bg-gradient-to-br p-2", index % 2 ? "from-orange-50 to-rose-50/30" : "from-blue-50 to-sky-50/30")}>
            <span className="row-span-2 border border-white bg-white/80" />
            <span className="border border-white bg-white/80" />
            <span className="border border-white bg-white/80" />
            <motion.span aria-hidden className="absolute inset-y-0 w-20 -skew-x-12 bg-gradient-to-r from-transparent via-white/80 to-transparent" animate={{ x: [-100, 420] }} transition={{ duration: 2.4 + index * .3, repeat: Infinity, repeatDelay: .7, ease: "easeInOut" }} />
            <span className="absolute bottom-3 left-4 text-[8px] font-semibold text-[var(--pbl-text-subtle)]">{index % 2 ? "视频片段与页面绑定" : "配图候选正在校验"}</span>
          </div>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-[var(--pbl-border-soft)]"><motion.span className={cn("block h-full rounded-full", index % 2 ? "bg-orange-500" : "bg-[var(--pbl-teacher)]")} animate={{ x: ["-100%", "260%"] }} transition={{ duration: 1.9 + index * .2, repeat: Infinity, ease: "easeInOut" }} style={{ width: "38%" }} /></div>
        </motion.section>
      ))}
    </div>
  );
}

function TtsProductionPreview({ artifact }: { artifact: CourseDesignGenerationArtifact }) {
  const bars = [18, 38, 62, 34, 74, 48, 28, 68, 88, 46, 72, 30, 58, 82, 40, 64, 24, 52, 78, 36, 66, 42, 84, 56];
  return (
    <div className="grid min-h-[250px] items-center gap-7 sm:grid-cols-[1.1fr_.9fr]">
      <div className="relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--pbl-teacher-border)] bg-[linear-gradient(135deg,#eff6ff,#f8f7ff_56%,#fff7ed)] px-5 py-6">
        <motion.span aria-hidden className="absolute -left-16 top-1/2 h-20 w-28 -translate-y-1/2 rounded-full bg-blue-300/25 blur-2xl" animate={{ x: [0, 360, 0] }} transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }} />
        <div className="relative flex h-24 items-center justify-center gap-1.5">
          {bars.map((height, index) => <motion.span className="w-1 rounded-full bg-gradient-to-t from-blue-700 to-blue-300" animate={{ height: [`${height * .4}%`, `${height}%`, `${height * .55}%`] }} transition={{ duration: .9 + (index % 5) * .13, repeat: Infinity, ease: "easeInOut" }} key={index} />)}
        </div>
        <div className="relative mt-5 flex items-center justify-between text-[8px] font-semibold tracking-[.1em] text-[var(--pbl-teacher)]"><span>课堂讲稿</span><span>语音合成</span><span>页面音轨</span></div>
      </div>
      <div className="divide-y divide-[var(--pbl-border)] border-y border-[var(--pbl-border)]">
        {artifact.items.map((item, index) => <motion.div className="grid grid-cols-[28px_1fr] gap-3 py-3" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: index * .1 }} key={`${item.label}-${index}`}><span className="grid size-6 place-items-center rounded-full bg-[var(--pbl-teacher-soft)] text-[9px] font-semibold text-[var(--pbl-teacher)]">{index + 1}</span><div><p className="text-[10px] font-semibold text-[var(--pbl-text)]">{item.label}</p><p className="mt-1 line-clamp-2 text-[9px] leading-[15px] text-[var(--pbl-text-subtle)]">{item.value}</p></div></motion.div>)}
      </div>
    </div>
  );
}

function BranchPreview({ artifact }: { artifact: CourseDesignGenerationArtifact }) {
  return (
    <div className="relative min-h-[250px] py-2 sm:pl-24">
      <div className="absolute left-0 top-1/2 hidden -translate-y-1/2 items-center sm:flex"><span className="grid size-14 place-items-center rounded-full border border-[var(--pbl-ai-border)] bg-[var(--pbl-ai-soft)] text-center text-[9px] font-semibold leading-3 text-[var(--pbl-ai)]">学习<br />诊断</span><span className="h-px w-10 bg-[var(--pbl-ai-border)]" /></div>
      <div className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
        {artifact.items.map((item, index) => (
          <motion.div className={cn("relative min-h-24 border-l-2 py-2 pl-4", index % 2 ? "border-violet-300" : "border-blue-300")} initial={{ opacity: 0, x: -8, y: index % 2 ? 8 : 0 }} animate={{ opacity: 1, x: 0, y: index % 2 ? 12 : 0 }} transition={{ delay: index * .08 }} key={`${item.label}-${index}`}>
            <span className="absolute -left-[5px] top-3 size-2 rounded-full bg-white ring-2 ring-[var(--pbl-ai)]" />
            <p className="text-[8px] font-semibold tracking-[.1em] text-[var(--pbl-ai)]">{item.label}</p>
            <p className="mt-2 text-[11px] font-semibold text-[var(--pbl-text)]">{item.value}</p>
            {item.meta ? <p className="mt-1.5 line-clamp-2 text-[9px] leading-[15px] text-[var(--pbl-text-subtle)]">{item.meta}</p> : null}
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function AuditPreview({ artifact }: { artifact: CourseDesignGenerationArtifact }) {
  return <div className="relative min-h-[250px] overflow-hidden border-y border-[var(--pbl-success-border)] bg-[linear-gradient(90deg,var(--pbl-success-soft),white_45%,var(--pbl-success-soft))] px-5 py-4"><motion.div aria-hidden className="absolute -right-10 -top-10 size-36 rounded-full border-[22px] border-emerald-200/30" animate={{ scale: [1, 1.08, 1], opacity: [.35, .7, .35] }} transition={{ duration: 4.5, repeat: Infinity }} /><div className="relative grid gap-x-7 sm:grid-cols-2">{artifact.items.map((item, index) => <motion.div className="flex items-start gap-3 border-b border-emerald-100 py-3" initial={{ opacity: 0, x: index % 2 ? 8 : -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: index * .07 }} key={`${item.label}-${index}`}><span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-700"><Check className="size-3.5" /></span><div><p className="text-[8px] font-semibold tracking-[.1em] text-emerald-700">{item.label}</p><p className="mt-1 line-clamp-3 text-[10px] font-medium leading-[16px] text-[var(--pbl-text)]">{item.value}</p></div></motion.div>)}</div></div>;
}

function resolveEvaluationRole(
  item: CourseDesignGenerationArtifact["items"][number],
  index: number,
): "ai" | "teacher" {
  if (item.evaluator) return item.evaluator;
  if (/AI/i.test(item.label)) return "ai";
  if (/教师/.test(item.label)) return "teacher";
  return index % 2 === 0 ? "ai" : "teacher";
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes} 分 ${remainder.toString().padStart(2, "0")} 秒` : `${remainder} 秒`;
}

function compactSideTitle(title: string | undefined, fallback: string): string {
  const normalized = (title || fallback).replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  return characters.length > 11 ? `${characters.slice(0, 11).join("")}…` : normalized;
}

function formatPlanDuration(seconds: number): string {
  if (seconds <= 0) return "动态时长";
  return `约 ${Math.max(1, Math.round(seconds / 60))} 分钟`;
}

function accentText(accent: CourseDesignGenerationArtifact["accent"]): string {
  return { orange: "text-orange-700", blue: "text-blue-700", violet: "text-violet-700", green: "text-emerald-700" }[accent];
}

function accentSurface(accent: CourseDesignGenerationArtifact["accent"]): string {
  return { orange: "border-orange-200 bg-orange-50 text-orange-700", blue: "border-blue-200 bg-blue-50 text-blue-700", violet: "border-violet-200 bg-violet-50 text-violet-700", green: "border-emerald-200 bg-emerald-50 text-emerald-700" }[accent];
}
