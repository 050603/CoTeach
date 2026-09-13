"use client";

import type { ReactNode, Ref } from "react";
import { BarChart3, ChevronLeft, ChevronRight, Clock3, Lightbulb, Minimize2, MonitorUp, PanelTop, Users, Wrench } from "lucide-react";
import type { Course } from "@/lib/session/types";
import styles from "./teacher-presentation.module.css";

export function TeacherPresentationHeader({ course, timerText, paused, degraded, onlineCount, onExit }: {
  course: Course; timerText: string; paused: boolean; degraded: boolean; onlineCount: number; onExit: () => void;
}) {
  const stage = course.stages[course.currentStageIndex];
  return <header className={styles.heading}>
    <div className={styles.identity}>
      <p>全屏授课 <span>· {course.name}</span></p>
      <h1>{stage?.label ?? "当前课堂"}</h1>
      <div className={styles.progress} aria-label={`教学进度：第 ${course.currentStageIndex + 1} 阶段，共 ${course.stages.length} 阶段`}>
        {course.stages.map((item, index) => <i key={item.key} data-state={index < course.currentStageIndex ? "complete" : index === course.currentStageIndex ? "current" : "pending"} />)}
        <span>{course.currentStageIndex + 1} / {course.stages.length}</span>
      </div>
    </div>
    <div className={styles.status}>
      <div><span>{paused ? "计时已暂停" : timerText.startsWith("+") ? "阶段已超时" : "阶段剩余"}</span><strong className={timerText.startsWith("+") ? styles.overrun : undefined}>{timerText}</strong></div>
      <p><Users size={18} /> 在线 {onlineCount} / {course.students.length}{degraded ? <em>同步延迟</em> : null}</p>
    </div>
    <button className={styles.exit} onClick={onExit} type="button"><Minimize2 size={20} /><span>退出全屏</span></button>
  </header>;
}

export function TeacherPresentationControls({ course, view, details, onView, onWorkspace, onDetailsClose, onStage, onTimer, onTools, onAdvice, onEnd, saveStatus, stageActionsRef }: {
  course: Course; view: "teaching" | "analytics"; details: boolean;
  onView: (view: "teaching" | "analytics") => void; onWorkspace: () => void; onDetailsClose: () => void;
  onStage: (index: number) => void; onTimer: () => void; onTools: () => void; onAdvice: () => void; onEnd: () => void; saveStatus: ReactNode;
  stageActionsRef?: Ref<HTMLDivElement>;
}) {
  return <footer className={styles.controls}>
    <div className={styles.views} aria-label="大屏视图">
      <button aria-pressed={view === "teaching"} onClick={() => onView("teaching")} type="button"><MonitorUp size={20} />授课展示</button>
      <button aria-pressed={view === "analytics"} onClick={() => onView("analytics")} type="button"><BarChart3 size={20} />班级学情</button>
    </div>
    <div className={styles.stageActions} ref={stageActionsRef} role="group" aria-label="当前阶段常用操作" />
    {details ? <button onClick={onDetailsClose} type="button"><ChevronLeft size={18} />{view === "teaching" ? "返回展示" : "返回汇总"}</button> : <button onClick={onWorkspace} type="button"><PanelTop size={20} />课堂操作</button>}
    <div className={styles.stageControls}>
      <button aria-label="上一教学阶段" disabled={course.currentStageIndex === 0} onClick={() => onStage(course.currentStageIndex - 1)} type="button"><ChevronLeft size={20} /></button>
      <select aria-label="全屏教学阶段" onChange={(event) => onStage(Number(event.target.value))} value={course.currentStageIndex}>
        {course.stages.map((stage, index) => <option key={stage.key} value={index}>{index + 1}. {stage.label}</option>)}
      </select>
      <button aria-label="下一教学阶段" disabled={course.currentStageIndex === course.stages.length - 1} onClick={() => onStage(course.currentStageIndex + 1)} type="button"><ChevronRight size={20} /></button>
    </div>
    <button onClick={onTimer} type="button"><Clock3 size={20} />计时</button>
    <button onClick={onTools} type="button"><Wrench size={20} />工具</button>
    <button onClick={onAdvice} type="button"><Lightbulb size={20} />教学建议</button>
    <div className={styles.save}>{saveStatus}</div>
    <button className={styles.end} onClick={onEnd} type="button">结束课堂</button>
  </footer>;
}
