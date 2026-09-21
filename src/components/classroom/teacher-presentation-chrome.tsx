"use client";

import type { ReactNode, Ref } from "react";
import { BarChart3, ChevronLeft, ChevronRight, Lightbulb, MessagesSquare, Minimize2, MonitorUp, PanelTop, Users, Wrench } from "lucide-react";
import type { Course } from "@/lib/session/types";
import styles from "./teacher-presentation.module.css";

export function TeacherPresentationHeader({ course, degraded, onlineCount, onExit, saveStatus }: {
  course: Course; degraded: boolean; onlineCount: number; onExit: () => void; saveStatus: ReactNode;
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
      <div className={styles.save}>{saveStatus}</div>
      <p><Users size={18} /> 在线 {onlineCount} / {course.students.length}{degraded ? <em>同步延迟</em> : null}</p>
    </div>
    <button className={styles.exit} onClick={onExit} type="button"><Minimize2 size={20} /><span>退出全屏</span></button>
  </header>;
}

export function TeacherPresentationControls({ course, view, details, discussion, discussionAvailable, onView, onDiscussion, onWorkspace, onDetailsClose, onStage, onTools, onAdvice, onEnd, stageActionsRef }: {
  course: Course; view: "teaching" | "analytics"; details: boolean; discussion: boolean; discussionAvailable: boolean;
  onView: (view: "teaching" | "analytics") => void; onWorkspace: () => void; onDetailsClose: () => void;
  onDiscussion: () => void;
  onStage: (index: number) => void; onTools: () => void; onAdvice: () => void; onEnd: () => void;
  stageActionsRef?: Ref<HTMLDivElement>;
}) {
  const isReflection = course.stages[course.currentStageIndex]?.key === "reflection";
  return <footer aria-label="全屏课堂操作栏" className={styles.controls} data-layout="single-row">
    <div className={styles.controlsLeft} role="group" aria-label="左侧展示操作">
      {!isReflection ? <div className={styles.views} aria-label="大屏视图">
        <button aria-pressed={!discussion && view === "teaching"} onClick={() => onView("teaching")} type="button"><MonitorUp size={20} />授课展示</button>
        <button aria-pressed={!discussion && view === "analytics"} onClick={() => onView("analytics")} type="button"><BarChart3 size={20} />班级学情</button>
        {discussionAvailable ? <button aria-pressed={discussion} className={styles.discussionEntry} onClick={onDiscussion} type="button"><MessagesSquare size={20} />AI 公开讨论</button> : null}
      </div> : null}
      <div className={styles.stageActions} ref={stageActionsRef} role="group" aria-label="当前阶段常用操作" />
    </div>
    <div className={styles.controlsRight} role="group" aria-label="右侧课堂操作">
      {details ? <button onClick={onDetailsClose} type="button"><ChevronLeft size={18} />{view === "teaching" ? "返回展示" : "返回汇总"}</button> : <button onClick={onWorkspace} type="button"><PanelTop size={20} />课堂操作</button>}
      <div className={styles.stageControls}>
        <button aria-label="上一教学阶段" disabled={course.currentStageIndex === 0} onClick={() => onStage(course.currentStageIndex - 1)} type="button"><ChevronLeft size={20} /></button>
        <select aria-label="全屏教学阶段" onChange={(event) => onStage(Number(event.target.value))} value={course.currentStageIndex}>
          {course.stages.map((stage, index) => <option key={stage.key} value={index}>{index + 1}. {stage.label}</option>)}
        </select>
        <button aria-label="下一教学阶段" disabled={course.currentStageIndex === course.stages.length - 1} onClick={() => onStage(course.currentStageIndex + 1)} type="button"><ChevronRight size={20} /></button>
      </div>
      <button onClick={onTools} type="button"><Wrench size={20} />工具</button>
      <button onClick={onAdvice} type="button"><Lightbulb size={20} />教学建议</button>
      <button className={styles.end} onClick={onEnd} type="button">结束课堂</button>
    </div>
  </footer>;
}
