"use client";

import { StudentLeaveButton } from "@/components/student-leave-button";
import { StudentStageCountdown } from "@/components/classroom/student-stage-countdown";
import type { Course } from "@/lib/session/types";

export function StudentClassroomHeaderStatus({ course }: { course: Course }) {
  const currentIndex = course.currentStageIndex;
  const total = course.stages.length;
  const stageLabel = course.stages[currentIndex]?.label ?? "";
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="hidden h-7 min-w-0 items-center gap-1.5 rounded-full bg-[var(--pbl-student-soft)] px-2.5 text-[12px] font-bold text-[var(--pbl-student)] ring-1 ring-[var(--pbl-student-border)] lg:inline-flex">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--pbl-student)]" />
        <span className="truncate" title={stageLabel}>阶段 {currentIndex + 1}/{total} · {stageLabel}</span>
      </span>
      {currentIndex === 2 && course.stages[currentIndex]?.key === "make" ? <StudentStageCountdown course={course} /> : null}
      <StudentLeaveButton className="inline-flex min-h-11 shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--radius-xs)] border border-orange-200 bg-white/80 px-2 text-[12px] font-semibold text-[var(--pbl-danger)] transition hover:bg-[var(--pbl-danger-soft)]" label="离开" />
    </div>
  );
}
