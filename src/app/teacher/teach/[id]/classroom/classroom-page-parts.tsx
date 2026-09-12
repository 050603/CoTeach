"use client";

import type { ReactNode } from "react";
import { Clock3, Pause, Play, RotateCcw, X } from "lucide-react";
import { ProgressBar } from "@/components/ui";
import type { ClassroomTimingSnapshot } from "@/lib/classroom/timing";
import type { Course } from "@/lib/session/types";
import { userFacingStageLabel } from "@/lib/user-facing-labels";
import { cn } from "@/lib/utils";

export const DEFAULT_CLASSROOM_DATA_SIDEBAR_COLLAPSED = true;

export function shouldShowClassroomDataSidebar(
  _stageKey: string | undefined,
  collapsed: boolean,
): boolean {
  return !collapsed;
}

export function deriveMakeStageLearningMetrics(course: Course) {
  const savedStudentIds = new Set([
    ...(course.submissions ?? []).flatMap((submission) =>
      submission.stageKey === "make"
      && (submission.type === "document" || submission.type === "artifact-brief" || submission.type === "code")
      && submission.studentId
        ? [submission.studentId]
        : [],
    ),
    ...(course.projectPdfVersions ?? [])
      .filter((version) => version.stageKey === "make")
      .map((version) => version.studentId),
  ]);
  const submittedStudentIds = new Set([
    ...(course.projectDocumentVersions ?? [])
      .filter((version) => version.stageKey === "make" && version.status === "submitted")
      .map((version) => version.studentId),
    ...(course.projectPdfVersions ?? [])
      .filter((version) => version.stageKey === "make" && version.status === "submitted")
      .map((version) => version.studentId),
    ...(course.submissions ?? []).flatMap((submission) =>
      submission.stageKey === "make" && submission.studentId && submission.files?.length
        ? [submission.studentId]
        : [],
    ),
  ]);
  const interactionEvents = (course.aiInteractionEvents ?? []).filter((event) =>
    event.stageKey === "make"
    && event.actorRole === "student"
    && event.eventType === "request",
  );
  const proactiveInterventionEvents = (course.aiInteractionEvents ?? []).filter((event) =>
    event.stageKey === "make"
    && event.actorRole === "ai"
    && event.source === "proactive-comment"
    && event.eventType === "comment",
  );
  const studentInitiatedConversationEvents = interactionEvents.filter((event) =>
    event.source !== "proactive-comment",
  );
  const suggestionDecisionEvents = (course.aiInteractionEvents ?? []).filter((event) =>
    event.stageKey === "make"
    && event.actorRole === "student"
    && event.eventType === "decision"
    && (event.payload?.decision === "adopted" || event.payload?.decision === "rejected"),
  );
  const adoptedSuggestionEvents = suggestionDecisionEvents.filter((event) =>
    event.payload?.decision === "adopted",
  );
  const activeStudentIds = new Set(interactionEvents.map((event) => event.studentId));
  const initiatingStudentIds = new Set(studentInitiatedConversationEvents.map((event) => event.studentId));
  const openSignals = (course.learningSignals ?? []).filter((signal) =>
    signal.stageKey === "make" && signal.status === "open",
  );
  const alertedStudentIds = new Set(openSignals.map((signal) => signal.studentId));

  return {
    activeStudentIds,
    adoptedSuggestionEvents,
    alertedStudentIds,
    averageInteractionCount: course.students.length
      ? interactionEvents.length / course.students.length
      : 0,
    averageProactiveInterventionCount: course.students.length
      ? proactiveInterventionEvents.length / course.students.length
      : 0,
    initiatingStudentIds,
    interactionEvents,
    openSignals,
    proactiveInterventionEvents,
    savedStudentIds,
    studentInitiatedConversationEvents,
    submittedStudentIds,
    suggestionAcceptanceRate: suggestionDecisionEvents.length
      ? adoptedSuggestionEvents.length / suggestionDecisionEvents.length * 100
      : null,
    suggestionDecisionEvents,
  };
}

export function formatAverageInteractionCount(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

export function ClassroomToolPopover({
  align = "left",
  children,
  onClose,
}: {
  align?: "left" | "right";
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className={cn("pbl-glass absolute top-[calc(100%+12px)] z-50 max-h-[calc(100dvh-5rem)] w-[360px] overflow-y-auto rounded-[var(--radius-md)] p-4", align === "right" ? "right-0" : "left-0")}>
      <button className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] text-stone-400 transition hover:bg-white hover:text-stone-700" onClick={onClose} type="button" aria-label="关闭">
        <X size={15} />
      </button>
      {children}
    </div>
  );
}

export function formatClock(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(safeSeconds / 3_600);
  const minutes = Math.floor(safeSeconds % 3_600 / 60);
  const seconds = safeSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatMinutes(totalSeconds: number): string {
  if (totalSeconds < 60) return `${Math.max(0, Math.round(totalSeconds))} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

function formatProjectedEnd(value?: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function TimerPanel({
  snapshot,
  onTogglePause,
  onReset,
  onAdjust,
}: {
  snapshot?: ClassroomTimingSnapshot;
  onTogglePause: () => void;
  onReset: () => void;
  onAdjust: (deltaSec: number) => void;
}) {
  if (!snapshot) {
    return (
      <div className="py-8 text-center">
        <Clock3 className="mx-auto text-stone-300" size={26} />
        <div className="mt-2 text-sm font-semibold text-stone-700">正在初始化课堂时间计划</div>
      </div>
    );
  }
  const paused = snapshot.status === "paused";
  const active = snapshot.activeStage;
  const overtime = (active?.overrunSec ?? 0) > 0;
  const timerText = active
    ? overtime
      ? `+${formatClock(active.overrunSec)}`
      : formatClock(active.remainingSec)
    : "--:--";
  const varianceText =
    snapshot.scheduleVarianceSec === 0
      ? "准点"
      : snapshot.scheduleVarianceSec > 0
        ? `超时 ${formatMinutes(snapshot.scheduleVarianceSec)}`
        : `提前 ${formatMinutes(-snapshot.scheduleVarianceSec)}`;
  return (
    <div>
      <div className="mb-2.5 pr-8">
        <div className="flex items-center gap-2">
          <div className="text-base font-bold text-stone-900">课堂时间控制</div>
          <span className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-bold",
            paused ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700",
          )}>
            {paused ? "已暂停" : "实时运行"}
          </span>
        </div>
      </div>
      <div className={cn(
        "rounded-[var(--radius-sm)] border px-3 py-3 text-center",
        overtime ? "border-rose-200 bg-rose-50" : "border-blue-100 bg-blue-50/60",
      )}>
        <div className="text-[11px] font-semibold text-stone-500">
          {active ? userFacingStageLabel(active.stageKey, active.label) : "课程已结束"} · {overtime ? "已超时" : "阶段剩余"}
        </div>
        <div className={cn(
          "mt-1 font-mono text-[38px] font-bold leading-none",
          overtime ? "text-rose-600" : "text-[var(--pbl-teacher)]",
        )}>
          {timerText}
        </div>
        {active ? (
          <div className="mt-2 text-[11px] text-stone-500">
            计划 {formatMinutes(active.plannedSec)} · 已用 {formatMinutes(active.elapsedSec)}
          </div>
        ) : null}
      </div>
      <div className="mt-3 grid grid-cols-4 gap-1.5">
        <button className="inline-flex h-9 items-center justify-center gap-1 rounded-[var(--radius-xs)] border border-stone-200 bg-white text-xs font-semibold text-stone-600 transition hover:bg-stone-50" onClick={onTogglePause} type="button">
          {paused ? <Play size={13} /> : <Pause size={13} />}
          {paused ? "继续" : "暂停"}
        </button>
        <button className="inline-flex h-9 items-center justify-center gap-1 rounded-[var(--radius-xs)] border border-stone-200 bg-white text-xs font-semibold text-stone-600 transition hover:bg-stone-50" onClick={() => onAdjust(-120)} type="button">
          -2 分
        </button>
        <button className="inline-flex h-9 items-center justify-center gap-1 rounded-[var(--radius-xs)] bg-[var(--pbl-teacher)] text-xs font-semibold text-white transition hover:bg-[var(--pbl-teacher-hover)]" onClick={() => onAdjust(120)} type="button">
          +2 分
        </button>
        <button className="inline-flex h-9 items-center justify-center gap-1 rounded-[var(--radius-xs)] border border-stone-200 bg-white text-xs font-semibold text-stone-600 transition hover:bg-stone-50" onClick={onReset} type="button">
          <RotateCcw size={13} /> 重计
        </button>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
        <div className="rounded-[var(--radius-xs)] bg-stone-50 px-1 py-2">
          <div className="text-[10px] text-stone-400">课程已用 / 计划</div>
          <div className="mt-0.5 text-[11px] font-bold text-stone-700">{formatMinutes(snapshot.courseElapsedSec)} / {formatMinutes(snapshot.coursePlannedSec)}</div>
        </div>
        <div className="rounded-[var(--radius-xs)] bg-stone-50 px-1 py-2">
          <div className="text-[10px] text-stone-400">预计结束</div>
          <div className="mt-0.5 text-[11px] font-bold text-stone-700">{formatProjectedEnd(snapshot.projectedEndAt)}</div>
        </div>
        <div className={cn("rounded-[var(--radius-xs)] px-1 py-2", snapshot.scheduleVarianceSec > 0 ? "bg-rose-50" : "bg-stone-50")}>
          <div className="text-[10px] text-stone-400">累计偏差</div>
          <div className={cn("mt-0.5 text-[11px] font-bold", snapshot.scheduleVarianceSec > 0 ? "text-rose-600" : "text-stone-700")}>{varianceText}</div>
        </div>
      </div>

      <div className="mt-3 max-h-48 space-y-2 overflow-y-auto pr-1">
        {snapshot.stages.map((stage) => (
          <div key={stage.stageKey}>
            <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
              <span className={cn("truncate font-semibold", stage.status === "active" ? "text-[var(--pbl-teacher)]" : "text-stone-600")}>
                {stage.status === "completed" ? "✓ " : stage.status === "active" ? "● " : ""}{userFacingStageLabel(stage.stageKey, stage.label)}
              </span>
              <span className={cn("shrink-0 font-mono", stage.overrunSec > 0 ? "text-rose-600" : "text-stone-400")}>
                {formatMinutes(stage.elapsedSec)} / {formatMinutes(stage.plannedSec)}
              </span>
            </div>
            <ProgressBar className="h-1.5" tone={stage.overrunSec > 0 ? "red" : stage.status === "completed" ? "green" : "blue"} value={stage.progressPercent} />
          </div>
        ))}
      </div>
    </div>
  );
}
