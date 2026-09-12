"use client";

import { StudentLeaveButton } from "@/components/student-leave-button";

export function StudentClassroomHeaderStatus({
  currentIndex,
  total,
  stageLabel,
  onlineCount,
}: {
  currentIndex: number;
  total: number;
  stageLabel: string;
  onlineCount: number;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="hidden h-7 min-w-0 items-center gap-1.5 rounded-full bg-[var(--pbl-student-soft)] px-2.5 text-[12px] font-bold text-[var(--pbl-student)] ring-1 ring-[var(--pbl-student-border)] lg:inline-flex">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--pbl-student)]" />
        <span className="truncate" title={stageLabel}>阶段 {currentIndex + 1}/{total} · {stageLabel}</span>
      </span>
      <span className="hidden shrink-0 whitespace-nowrap text-[12px] font-semibold text-stone-400 xl:inline">在线 {onlineCount}</span>
      <StudentLeaveButton className="inline-flex min-h-11 shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--radius-xs)] border border-orange-200 bg-white/80 px-2 text-[12px] font-semibold text-[var(--pbl-danger)] transition hover:bg-[var(--pbl-danger-soft)]" />
    </div>
  );
}
