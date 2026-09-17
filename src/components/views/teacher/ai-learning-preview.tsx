"use client";

import { useState } from "react";
import { ChevronDown, Eye, Network, PanelLeft, ShieldCheck } from "lucide-react";
import { StudentStageHost } from "@/components/openmaic-bridge/student-stage-host";
import type { Course } from "@/lib/session/types";
import type { TeacherPresentationMode } from "@/lib/classroom/presentation";
import { cn } from "@/lib/utils";
import { TeacherPresentationActions } from "@/components/classroom/teacher-presentation-actions";

export function AiLearningTeacherPreview({ course, presentation = "workspace", workspacePreviewEnabled = true }: { course: Course; presentation?: TeacherPresentationMode; workspacePreviewEnabled?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [teachingVisited, setTeachingVisited] = useState(presentation === "teaching");
  const [teachingDirectoryOpen, setTeachingDirectoryOpen] = useState(false);
  const teaching = presentation === "teaching";
  if (presentation === "teaching" && !teachingVisited) setTeachingVisited(true);
  const workspace = presentation === "workspace";
  const workspacePreviewVisible = workspace && workspacePreviewEnabled && expanded;
  const visible = teaching || workspacePreviewVisible;

  if (!course.aiLearningClassroomId) return null;

  return (
    <section className={cn("overflow-hidden rounded-[var(--radius-lg)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)]", teaching && "teacher-course-preview flex h-full min-h-0 flex-col")} hidden={presentation === "analytics" || (workspace && !workspacePreviewEnabled)}>
      {presentation !== "analytics" && (teaching || workspacePreviewEnabled) ? <TeacherPresentationActions>
        <button aria-expanded={teaching ? teachingDirectoryOpen : expanded} data-tone="primary" onClick={() => { if (teaching) setTeachingDirectoryOpen((value) => !value); else setExpanded((value) => !value); }} type="button">
          <PanelLeft size={20} />{teaching ? teachingDirectoryOpen ? "收起课程目录" : "课程目录" : expanded ? "收起课程预览" : "打开课程预览"}
        </button>
      </TeacherPresentationActions> : null}
      {workspace && workspacePreviewEnabled ? <button
        aria-controls={`ai-learning-teacher-preview-${course.id}`}
        aria-expanded={expanded}
        className={cn(
          "flex w-full items-center justify-between gap-4 bg-stone-50/80 px-4 py-3 text-left transition hover:bg-stone-100/80",
          expanded && "border-b border-stone-200",
        )}
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]"><Eye size={18} /></span>
          <span className="min-w-0">
            <span className="block text-base font-bold text-stone-900">学生知识讲授课程预览</span>
            <span className="mt-0.5 block text-xs text-stone-500">{expanded ? (teachingVisited ? "正在预览 · 保留授课位置" : "正在预览 · 收起后自动停止播放") : "默认收起 · 点击展开课程"}</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs font-bold text-stone-500">
          <span className="hidden items-center gap-1.5 sm:inline-flex"><PanelLeft size={14} /> 页面导航<span className="text-stone-300">·</span><Network size={14} /> 知识图谱</span>
          <ChevronDown className={cn("transition-transform", expanded && "rotate-180")} size={18} />
        </span>
      </button> : null}

      {teaching ? <div className="flex shrink-0 justify-end border-b border-stone-200 p-2"><button aria-expanded={teachingDirectoryOpen} className="inline-flex min-h-11 items-center gap-2 rounded-[6px] border border-stone-300 bg-white px-4 text-lg font-semibold" onClick={() => setTeachingDirectoryOpen((value) => !value)} type="button"><PanelLeft size={20} />{teachingDirectoryOpen ? "收起课程目录" : "课程目录"}</button></div> : null}
      {expanded || teachingVisited || teaching ? <div hidden={!visible} className={cn("p-3", teaching && "min-h-0 flex-1 !p-0")} id={`ai-learning-teacher-preview-${course.id}`}>
        {workspacePreviewEnabled ? <div hidden={teaching} className="mb-3 flex items-center gap-2 rounded-[6px] bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-100"><ShieldCheck size={15} />预览操作不会写入学生进度；可通过左侧缩略页快速切换课程内容。</div> : null}
        <StudentStageHost
          backHref="#"
          className={teaching ? "h-full min-h-[240px]" : "h-[min(780px,calc(100dvh-170px))] min-h-[640px] max-h-[860px]"}
          classroomId={course.aiLearningClassroomId}
          courseId={course.id}
          knowledgeGraph={course.content.knowledgeGraph}
          knowledgePoints={course.content.knowledgePoints}
          mode="teacher-preview"
          onSidebarCollapsedChange={teaching ? (collapsed) => setTeachingDirectoryOpen(!collapsed) : setSidebarCollapsed}
          sidebarCollapsed={teaching ? !teachingDirectoryOpen : sidebarCollapsed}
          variant="embedded"
        />
      </div> : null}
    </section>
  );
}
