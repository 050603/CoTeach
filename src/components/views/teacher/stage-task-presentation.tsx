"use client";

import { useEffect, useState } from "react";
import { Clock3, Pause, Play, RotateCcw } from "lucide-react";
import type { Course } from "@/lib/session/types";
import { getCourseStageRequirements } from "@/lib/resource-package/course-requirements";
import { deriveClassroomTimingSnapshot } from "@/lib/classroom/timing";

function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export type ProjectTimerControls = {
  onTogglePause: () => void;
  onAdjust: (deltaSec: number) => void;
  onReset: () => void;
};

function ProjectPracticeCountdown({ course, controls }: { course: Course; controls?: ProjectTimerControls }) {
  const [now, setNow] = useState<string>();
  const timing = course.uiState?.classroomTiming;

  useEffect(() => {
    const tick = () => setNow(new Date().toISOString());
    tick();
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, []);

  // The course stage can update before its timing state reaches this client.
  const activeStage = now && timing?.activeStageKey === "make"
    ? deriveClassroomTimingSnapshot(timing, now).activeStage
    : undefined;
  const plannedMinutes = activeStage
    ? Math.round(activeStage.plannedSec / 60)
    : course.content.stagePlan?.stages.find((stage) => stage.key === "make")?.durationMin;
  const overtime = (activeStage?.overrunSec ?? 0) > 0;
  const paused = timing?.status === "paused" && Boolean(activeStage);
  const clock = activeStage
    ? `${overtime ? "+" : ""}${formatClock(overtime ? activeStage.overrunSec : activeStage.remainingSec)}`
    : "--:--";
  const status = activeStage ? overtime ? "已超时" : paused ? "已暂停" : "剩余时间" : "时间同步中";

  return <div aria-label="项目制作计时" className={`mt-5 rounded-2xl border px-5 py-4 ${overtime ? "border-rose-300 bg-rose-50 text-rose-900" : "border-amber-200 bg-amber-50 text-stone-900"}`}>
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[clamp(18px,1.8vw,24px)] font-bold"><Clock3 aria-hidden="true" size={24} />项目制作计时</p>
        {plannedMinutes ? <p className="mt-1 text-base">限定制作时间：{plannedMinutes} 分钟</p> : null}
      </div>
      <div className="text-right">
        <p className="text-base font-semibold">{status}</p>
        <p aria-live="off" className="font-mono text-[clamp(36px,4vw,64px)] font-bold leading-none tabular-nums" role="timer">{clock}</p>
      </div>
    </div>
    <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
      <p className="text-[clamp(16px,1.5vw,20px)] font-medium">{overtime ? "制作时间已到，请尽快保存并提交项目成果。" : "请在限定制作时间内完成并提交项目成果。"}</p>
      {activeStage && controls ? <div aria-label="制作计时控制" className="flex flex-wrap items-center gap-1 text-xs text-stone-500">
        <button className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 transition hover:bg-white/80 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-blue-600" onClick={controls.onTogglePause} type="button">{paused ? <Play aria-hidden="true" size={13} /> : <Pause aria-hidden="true" size={13} />}{paused ? "继续" : "暂停"}</button>
        <button className="min-h-9 rounded-lg px-2 transition hover:bg-white/80 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-blue-600" onClick={() => controls.onAdjust(-120)} type="button">-2 分</button>
        <button className="min-h-9 rounded-lg px-2 transition hover:bg-white/80 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-blue-600" onClick={() => controls.onAdjust(120)} type="button">+2 分</button>
        <button className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 transition hover:bg-white/80 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-blue-600" onClick={controls.onReset} type="button"><RotateCcw aria-hidden="true" size={13} />重计</button>
      </div> : null}
    </div>
  </div>;
}

/** Use only the current stage's authored task; teacher-only notes stay private. */
export function StageTaskPresentation({ course, timerControls }: { course: Course; timerControls?: ProjectTimerControls }) {
  const stage = course.stages?.[course.currentStageIndex];
  const requirements = getCourseStageRequirements(course, stage?.key ?? "");
  const sections = (course.content?.teachingOutline ?? []).filter((section) => section.stageKey === stage?.key);
  const drivingQuestion = stage?.key === "make"
    ? requirements?.drivingQuestion?.trim() || course.drivingQuestion?.trim() || ""
    : "";
  const projectTask = stage?.key === "make"
    ? requirements?.projectTask?.trim() || ""
    : "";
  return (
    <section aria-label="当前阶段任务" className="teacher-presentation-task rounded-2xl border border-stone-200 bg-white p-6 text-stone-900">
      <h2 className="text-[clamp(28px,3vw,48px)] font-bold">{stage?.label ?? "当前阶段"}</h2>
      {drivingQuestion ? <div className="mt-5 rounded-2xl border border-blue-200 bg-blue-50 px-6 py-5 text-blue-950">
        <h3 className="text-lg font-bold text-blue-700">任务驱动问题</h3>
        <p className="mt-2 whitespace-pre-wrap text-[clamp(28px,3vw,44px)] font-bold leading-snug">{drivingQuestion}</p>
      </div> : null}
      {stage?.key === "make" ? <ProjectPracticeCountdown controls={timerControls} course={course} /> : null}
      {projectTask && projectTask !== drivingQuestion ? <div className="mt-5 text-[clamp(20px,2vw,28px)] leading-relaxed">
        <h3 className="font-bold">项目任务</h3>
        <p className="mt-2 whitespace-pre-wrap">{projectTask}</p>
      </div> : null}
      {requirements ? <div className="mt-5 space-y-4 text-[clamp(20px,2vw,28px)] leading-relaxed">
        {requirements.requirements ? <p className="whitespace-pre-wrap">{stage?.key === "make" ? "任务要求：" : ""}{requirements.requirements}</p> : null}
        {requirements.outputs ? <p className="whitespace-pre-wrap">交付要求：{requirements.outputs}</p> : null}
        {stage?.key === "reflection" ? requirements.reflectionQuestions.map((item, index) => <p key={index}>{item}</p>) : null}
      </div> : stage?.description ? <p className="mt-5 whitespace-pre-wrap text-[clamp(20px,2vw,28px)] leading-relaxed">{stage.description}</p> : null}
      {!requirements ? sections.map((section) => <article className="mt-6 space-y-3" key={section.id}>
        <h3 className="text-2xl font-bold">{section.title}</h3>
        {section.teachingGoal ? <p className="whitespace-pre-wrap text-xl leading-relaxed">学习目标：{section.teachingGoal}</p> : null}
        {section.studentActivity ? <p className="whitespace-pre-wrap text-xl leading-relaxed">任务与交付：{section.studentActivity}</p> : null}
      </article>) : null}
      {!drivingQuestion && !projectTask && !requirements && !stage?.description && !sections.length ? <p className="mt-5 text-xl text-stone-600">本阶段暂无任务或展示资料。</p> : null}
    </section>
  );
}
