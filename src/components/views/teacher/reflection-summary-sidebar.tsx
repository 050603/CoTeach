"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, RefreshCw, Sparkles } from "lucide-react";
import { buildReflectionClassSummary } from "@/lib/teaching-ai/client-api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui";
import type { AiSupportRecord, Course } from "@/lib/session/types";
import {
  normalizeReflectionClassSummary,
  reflectionClassSummaryIsStale,
  reflectionSummaryAutoTrigger,
  reflectionSummaryCoverage,
  reflectionSummaryMinimumSampleSize,
  type ReflectionSummaryTrigger,
} from "@/lib/reflection-summary";
import { cn } from "@/lib/utils";

type Props = { course: Course; compact?: boolean };

function latestSummarySupport(course: Course): AiSupportRecord | undefined {
  return (course.aiSupports ?? [])
    .filter((support) => support.kind === "reflection-class-summary" && support.targetType === "course")
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

export function ReflectionSummarySidebar({ course, compact = false }: Props) {
  const storedSupport = useMemo(() => latestSummarySupport(course), [course]);
  const [localSupport, setLocalSupport] = useState<AiSupportRecord>();
  const [status, setStatus] = useState<"idle" | "generating" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const attemptedKey = useRef<string | undefined>(undefined);
  const support = useMemo(
    () => [localSupport, storedSupport]
      .filter((item): item is AiSupportRecord => Boolean(item))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0],
    [localSupport, storedSupport],
  );
  const summary = useMemo(
    () => normalizeReflectionClassSummary(support?.structuredPayload, new Set(course.students.map((student) => student.id))),
    [course.students, support?.structuredPayload],
  );
  const coverage = useMemo(() => reflectionSummaryCoverage(course), [course]);
  const minimumSampleSize = reflectionSummaryMinimumSampleSize(course.students.length);
  const stale = reflectionClassSummaryIsStale(summary, course);

  const refresh = useCallback(async (trigger: ReflectionSummaryTrigger) => {
    setStatus("generating");
    setErrorMessage(undefined);
    try {
      const nextSupport = await buildReflectionClassSummary(course.id, trigger);
      setLocalSupport(nextSupport);
      window.dispatchEvent(new CustomEvent("openpbl:reflection-summary-updated", { detail: { courseId: course.id, support: nextSupport } }));
      setStatus("idle");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
      if (code === "INSUFFICIENT_REFLECTIONS") {
        setErrorMessage(undefined);
        setStatus("idle");
      } else {
        setErrorMessage(error instanceof Error ? error.message : "AI 课程总结生成失败，请稍后重试。");
        setStatus("error");
      }
    }
  }, [course.id]);

  useEffect(() => {
    if (coverage.responseCount < minimumSampleSize) return;
    const trigger = reflectionSummaryAutoTrigger(course, summary);
    if (!trigger) return;
    const key = `${course.id}:${trigger}:${coverage.coverageBucket}:${summary?.coverageBucket ?? 0}`;
    if (attemptedKey.current === key) return;
    attemptedKey.current = key;
    void refresh(trigger);
  }, [course, course.id, course.status, coverage.coverageBucket, coverage.responseCount, minimumSampleSize, refresh, stale, summary]);

  const statusText = status === "generating"
    ? "AI 课程总结生成中…"
    : errorMessage
      ? "生成失败，上一版内容仍保留"
      : !summary && coverage.responseCount < minimumSampleSize
        ? `达到 ${minimumSampleSize} 份有效反思后自动生成`
        : !summary
          ? "达到 20% 提交后自动生成"
          : stale
            ? "有新反思待更新，可手动刷新"
            : `基于 ${summary.responseCount} 份反思 · 第 ${summary.coverageBucket}% 档`;

  return (
    <section className={cn("border-b border-stone-100 bg-white/70", compact ? "px-3 py-2.5" : "px-4 py-4")}>
      <header className={cn("flex items-start justify-between gap-3", compact ? "mb-2" : "mb-3")}>
        <div className="flex items-center gap-2">
          <span className={cn("grid size-7 place-items-center rounded-lg", status === "error" ? "bg-amber-100 text-amber-700" : "bg-violet-100 text-violet-700")}><Bot size={14} /></span>
          <div>
            <h3 className={cn("font-black text-stone-900", compact ? "text-xs" : "text-[13px]")}>{compact ? "AI 实时教学建议" : "AI 课程总结"}</h3>
            <p className={cn("mt-0.5 font-semibold leading-4 text-stone-400", compact ? "text-[9px]" : "text-[10px]")}>{statusText}</p>
          </div>
        </div>
        <button
          aria-label="刷新 AI 课程总结"
          className="grid size-7 place-items-center rounded-lg border border-stone-200 text-stone-500 transition hover:border-violet-300 hover:text-violet-700 disabled:cursor-wait disabled:opacity-50"
          disabled={status === "generating" || coverage.responseCount < minimumSampleSize}
          onClick={() => void refresh(course.status === "finished" ? "course-finished" : "manual")}
          title="手动刷新"
          type="button"
        >
          <RefreshCw className={status === "generating" ? "animate-spin" : undefined} size={13} />
        </button>
      </header>

      {summary ? (
        compact ? <>
          {summary.teachingRecommendations[0] ? (
            <div className="flex items-start gap-2 rounded-lg border border-violet-100 bg-violet-50/60 px-2.5 py-2 text-[9px] leading-4 text-stone-700">
              <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-violet-600 text-[8px] font-black text-white">1</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{summary.teachingRecommendations[0]}</span>
            </div>
          ) : <div className="rounded-lg border border-dashed border-stone-200 bg-stone-50/70 px-2.5 py-2 text-center text-[9px] leading-4 text-stone-500">暂无建议</div>}
          <button className="mt-2 flex w-full items-center justify-center rounded-lg border border-violet-100 bg-violet-50/50 px-2.5 py-1.5 text-[9px] font-bold leading-4 text-violet-700 transition hover:border-violet-300 hover:bg-violet-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600" onClick={() => setDetailsOpen(true)} type="button">
            {summary.teachingRecommendations.length > 1 ? `还有 ${summary.teachingRecommendations.length - 1} 条建议，查看完整总结` : "查看完整课程总结"}
          </button>
          {errorMessage ? <p className="mt-2 text-[9px] leading-4 text-amber-700">{errorMessage}</p> : null}
        </> : <>
          <div className={cn("rounded-xl border border-violet-100 bg-violet-50/60 text-violet-950", compact ? "px-2.5 py-2 text-[10px] leading-4" : "px-3 py-3 text-xs leading-5")}>
            <div className="mb-1 flex items-start gap-1.5 font-bold"><Sparkles className="mt-0.5 shrink-0" size={13} /><span>{summary.courseSummary}</span></div>
            <p className={cn("text-violet-700/80", compact ? "text-[9px]" : "text-[10px]")}>覆盖 {summary.responseCount}/{summary.totalStudentCount} 人 · {new Date(summary.generatedAt).toLocaleString("zh-CN")}</p>
          </div>
          <div className={cn("space-y-2", compact ? "mt-2" : "mt-3")}>
            {summary.teachingRecommendations.slice(0, compact ? 1 : 3).map((recommendation, index) => (
              <div className={cn("flex gap-2 text-stone-600", compact ? "text-[9px] leading-4" : "text-[11px] leading-5")} key={`${recommendation}-${index}`}>
                <span className="grid size-4 shrink-0 place-items-center rounded-full bg-violet-100 text-[9px] font-bold text-violet-700">{index + 1}</span>
                <span>{recommendation}</span>
              </div>
            ))}
          </div>
          {errorMessage ? <p className="mt-3 text-[11px] leading-5 text-amber-700">{errorMessage}</p> : null}
        </>
      ) : (
        <div className={cn("rounded-xl border border-dashed border-stone-200 bg-stone-50/60 text-stone-500", compact ? "px-2.5 py-2 text-[9px] leading-4" : "px-3 py-3 text-xs leading-5")}>
          {errorMessage ?? "提交率达到档位并满足样本要求后，这里会自动生成全班课程总结与教学改进建议。"}
        </div>
      )}
      <Dialog onOpenChange={setDetailsOpen} open={detailsOpen}>
        <DialogContent className="max-h-[88vh] w-[min(720px,calc(100vw-24px))] max-w-none overflow-y-auto">
          <DialogHeader>
            <DialogTitle>AI 课程总结与教学建议</DialogTitle>
            <DialogDescription>基于“{course.name}”当前已提交的有效学习反思生成。</DialogDescription>
          </DialogHeader>
          {summary ? <div className="space-y-4">
            <div className="rounded-xl border border-violet-100 bg-violet-50/65 px-4 py-3 text-violet-950">
              <div className="flex items-start gap-2"><Sparkles className="mt-1 shrink-0 text-violet-700" size={15} /><p className="whitespace-pre-wrap break-words text-sm font-semibold leading-6">{summary.courseSummary}</p></div>
              <p className="mt-2 text-[11px] text-violet-700">覆盖 {summary.responseCount}/{summary.totalStudentCount} 人 · {new Date(summary.generatedAt).toLocaleString("zh-CN")}</p>
            </div>
            <div className="space-y-2">
              <h4 className="text-xs font-black text-stone-900">全部教学建议（{summary.teachingRecommendations.length}）</h4>
              {summary.teachingRecommendations.length ? summary.teachingRecommendations.map((recommendation, index) => <div className="flex items-start gap-2 rounded-lg border border-stone-200 bg-white px-3 py-3" key={`${recommendation}-${index}`}><span className="grid size-5 shrink-0 place-items-center rounded-full bg-violet-100 text-[10px] font-black text-violet-700">{index + 1}</span><p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-5 text-stone-700">{recommendation}</p></div>) : <div className="rounded-lg border border-dashed border-stone-200 bg-stone-50/70 px-3 py-3 text-center text-xs text-stone-500">暂无建议</div>}
            </div>
          </div> : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
