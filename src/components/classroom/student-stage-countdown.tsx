"use client";

import { useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
import { deriveClassroomTimingSnapshot } from "@/lib/classroom/timing";
import type { Course } from "@/lib/session/types";

function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function StudentStageCountdown({ course }: { course: Course }) {
  const [now, setNow] = useState<string>();
  const stage = course.stages[course.currentStageIndex];
  const timing = course.uiState?.classroomTiming;

  useEffect(() => {
    const tick = () => setNow(new Date().toISOString());
    tick();
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, []);

  if (!stage) return null;

  // A stage change can arrive before its timing update. Never show the previous stage's clock.
  const activeStage = now && timing?.activeStageKey === stage.key
    ? deriveClassroomTimingSnapshot(timing, now).activeStage
    : undefined;
  const presetMinutes = course.content.stagePlan?.stages.find((item) => item.key === stage.key)?.durationMin
    ?? (activeStage ? Math.round(activeStage.plannedSec / 60) : undefined);
  const overtime = (activeStage?.overrunSec ?? 0) > 0;
  const paused = timing?.status === "paused" && Boolean(activeStage);
  const clock = activeStage
    ? `${overtime ? "+" : ""}${formatClock(overtime ? activeStage.overrunSec : activeStage.remainingSec)}`
    : "--:--";
  const status = activeStage ? overtime ? "已超时" : paused ? "已暂停" : "剩余" : "时间同步中";
  const description = `${stage.label} · ${presetMinutes ? `预设 ${presetMinutes} 分钟 · ` : ""}${status} ${clock}`;

  return (
    <div
      aria-label={description}
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-semibold ${overtime ? "border-rose-200 bg-rose-50 text-rose-800" : "border-[var(--pbl-student-border)] bg-[var(--pbl-student-soft)] text-[var(--pbl-student)]"}`}
      title={description}
    >
      <Clock3 aria-hidden="true" className="shrink-0" size={14} />
      {presetMinutes ? <span className="hidden xl:inline">预设 {presetMinutes} 分钟 ·</span> : null}
      <span className="hidden sm:inline">{status}</span>
      <span aria-live="off" className="font-mono text-sm font-bold tabular-nums" role="timer">{clock}</span>
    </div>
  );
}
