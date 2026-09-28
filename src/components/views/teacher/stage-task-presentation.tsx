"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Pause, Play, RotateCcw, SlidersHorizontal } from "lucide-react";
import type { Course } from "@/lib/session/types";
import { getCourseStageRequirements } from "@/lib/resource-package/course-requirements";
import { deriveClassroomTimingSnapshot } from "@/lib/classroom/timing";
import styles from "./project-practice-countdown.module.css";

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
  const [controlsOpen, setControlsOpen] = useState(false);
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
  const overtime = (activeStage?.overrunSec ?? 0) > 0;
  const paused = timing?.status === "paused" && Boolean(activeStage);
  const clock = activeStage
    ? `${overtime ? "+" : ""}${formatClock(overtime ? activeStage.overrunSec : activeStage.remainingSec)}`
    : "--:--";
  const clockLabel = activeStage ? `${overtime ? "已超时" : paused ? "已暂停，剩余" : "剩余"} ${clock}` : "时间同步中";

  return <aside aria-label="项目制作计时" className="flex min-w-0 flex-col items-center py-2 text-stone-800">
    <p className="mb-3 text-base font-semibold text-stone-600">制作倒计时{paused ? " · 已暂停" : overtime ? " · 已超时" : ""}</p>
    <div aria-label={clockLabel} aria-live="off" className={`${styles.clock} ${overtime ? styles.overtime : ""}`} role="timer">
      {Array.from(clock).map((character, index) => character === ":" || character === "+"
        ? <span aria-hidden="true" className={styles.separator} key={index}>{character}</span>
        : <span aria-hidden="true" className={styles.tile} key={index}><span className={styles.digit} key={`${index}-${character}`}>{character}</span></span>)}
    </div>
    {activeStage && controls ? <div className="mt-4 flex w-full flex-col items-center">
      <button aria-expanded={controlsOpen} className="project-timer-trigger inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-stone-600 transition hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-blue-600" onClick={() => setControlsOpen((open) => !open)} type="button"><SlidersHorizontal aria-hidden="true" size={16} />计时控制<ChevronDown aria-hidden="true" className={controlsOpen ? "rotate-180" : ""} size={15} /></button>
      {controlsOpen ? <div aria-label="制作计时控制" className="project-timer-controls mt-2 flex flex-wrap items-center justify-center gap-1 text-xs text-stone-500">
        <button className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 transition hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-blue-600" onClick={controls.onTogglePause} type="button">{paused ? <Play aria-hidden="true" size={13} /> : <Pause aria-hidden="true" size={13} />}{paused ? "继续" : "暂停"}</button>
        <button className="min-h-11 rounded-lg px-2 transition hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-blue-600" onClick={() => controls.onAdjust(-120)} type="button">-2 分</button>
        <button className="min-h-11 rounded-lg px-2 transition hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-blue-600" onClick={() => controls.onAdjust(120)} type="button">+2 分</button>
        <button className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 transition hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-blue-600" onClick={controls.onReset} type="button"><RotateCcw aria-hidden="true" size={13} />重计</button>
      </div> : null}
    </div> : null}
  </aside>;
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
  const taskDetails = <>
    {projectTask && projectTask !== drivingQuestion ? <div className="text-[clamp(20px,2vw,28px)] leading-relaxed">
      <h3 className="font-bold">项目任务</h3>
      <p className="mt-2 whitespace-pre-wrap">{projectTask}</p>
    </div> : null}
    {requirements ? <div className="space-y-4 text-[clamp(20px,2vw,28px)] leading-relaxed">
      {requirements.requirements ? <p className="whitespace-pre-wrap">{stage?.key === "make" ? "任务要求：" : ""}{requirements.requirements}</p> : null}
      {requirements.outputs ? <p className="whitespace-pre-wrap">交付要求：{requirements.outputs}</p> : null}
      {stage?.key === "reflection" ? requirements.reflectionQuestions.map((item, index) => <p key={index}>{item}</p>) : null}
    </div> : stage?.description ? <p className="whitespace-pre-wrap text-[clamp(20px,2vw,28px)] leading-relaxed">{stage.description}</p> : null}
    {!requirements ? sections.map((section) => <article className="space-y-3" key={section.id}>
      <h3 className="text-2xl font-bold">{section.title}</h3>
      {section.teachingGoal ? <p className="whitespace-pre-wrap text-xl leading-relaxed">学习目标：{section.teachingGoal}</p> : null}
      {section.studentActivity ? <p className="whitespace-pre-wrap text-xl leading-relaxed">任务与交付：{section.studentActivity}</p> : null}
    </article>) : null}
    {!drivingQuestion && !projectTask && !requirements && !stage?.description && !sections.length ? <p className="text-xl text-stone-600">本阶段暂无任务或展示资料。</p> : null}
  </>;
  return (
    <section aria-label="当前阶段任务" className="teacher-presentation-task rounded-2xl border border-stone-200 bg-white p-6 text-stone-900">
      {stage?.key !== "make" ? <h2 className="text-[clamp(28px,3vw,48px)] font-bold">{stage?.label ?? "当前阶段"}</h2> : null}
      {drivingQuestion ? <div className="project-driving-question rounded-[14px] border border-blue-200 bg-blue-50 px-6 py-5 text-blue-950">
        <h3 className="text-lg font-bold text-blue-700">任务驱动问题</h3>
        <p className="mt-2 whitespace-pre-wrap text-[clamp(28px,3vw,44px)] font-bold leading-snug">{drivingQuestion}</p>
      </div> : null}
      {stage?.key === "make" ? <div className="mt-5 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]">
        <section aria-label="项目任务说明" className="min-w-0 space-y-5">{taskDetails}</section>
        <ProjectPracticeCountdown controls={timerControls} course={course} />
      </div> : <div className="mt-5 space-y-5">{taskDetails}</div>}
    </section>
  );
}
