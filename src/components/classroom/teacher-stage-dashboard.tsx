"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileText,
  Footprints,
  Gauge,
  Loader2,
  MessageSquareText,
  MonitorUp,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui";
import type { Course } from "@/lib/session/types";
import type { ShowcaseData } from "@/lib/showcase/types";
import { ReflectionSummarySidebar } from "@/components/views/teacher/reflection-summary-sidebar";
import { buildTeacherDashboardAdvice, type TeacherDashboardAdvice } from "@/lib/teaching-ai/client-api";
import {
  deriveKnowledgeDashboardMetrics,
  deriveLaunchDashboardMetrics,
  deriveMakeDashboardMetrics,
  deriveReflectionDashboardMetrics,
  deriveShowcaseDashboardMetrics,
  type TeacherDashboardMetric,
  type TeacherDashboardTone,
  type TeacherStageFocus,
} from "@/lib/classroom/teacher-dashboard-metrics";

type TeacherStageDashboardProps = {
  course: Course;
  stageKey: string;
  degraded?: boolean;
  showcaseData?: ShowcaseData;
  onFocus: (focus: TeacherStageFocus) => void;
  onSelectStage: (index: number) => void;
  onCollapse: () => void;
};

const TONE_TEXT: Record<TeacherDashboardTone, string> = {
  neutral: "text-stone-700",
  info: "text-blue-700",
  success: "text-emerald-700",
  warning: "text-amber-700",
  danger: "text-rose-700",
};

const TONE_BORDER: Record<TeacherDashboardTone, string> = {
  neutral: "border-stone-200 bg-stone-50",
  info: "border-blue-100 bg-blue-50/65",
  success: "border-emerald-100 bg-emerald-50/65",
  warning: "border-amber-200 bg-amber-50/75",
  danger: "border-rose-200 bg-rose-50/75",
};

function toneText(tone?: TeacherDashboardTone): string {
  return TONE_TEXT[tone ?? "neutral"];
}

function toneBorder(tone?: TeacherDashboardTone): string {
  return TONE_BORDER[tone ?? "neutral"];
}

function metricValue(metric: TeacherDashboardMetric): string {
  return metric.value === "—" ? "暂无" : metric.value;
}

function StageProgress({ course, onSelectStage }: { course: Course; onSelectStage: (index: number) => void }) {
  const shortLabels: Record<string, string> = { launch: "启动", "ai-learning": "讲授", make: "实践", showcase: "汇报", reflection: "反思" };
  return (
    <div className="relative mt-2.5">
      <ol aria-label="课堂阶段进度" className="grid grid-cols-5 gap-1">
        {course.stages.map((stage, index) => {
          const current = index === course.currentStageIndex;
          const done = index < course.currentStageIndex;
          return (
            <li className="min-w-0" key={stage.key}>
              <button
                aria-current={current ? "step" : undefined}
                aria-label={`第 ${index + 1} 阶段：${stage.label}`}
                className={cn(
                  "flex w-full flex-col items-center gap-1 rounded-lg px-0.5 py-1 transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700",
                  current ? "bg-blue-100 text-blue-800" : done ? "text-emerald-700 hover:bg-emerald-50" : "text-stone-400 hover:bg-stone-100",
                )}
                onClick={() => onSelectStage(index)}
                title={stage.label}
                type="button"
              >
                <span className={cn("grid size-5 place-items-center rounded-full text-[9px] font-black", current ? "bg-blue-700 text-white" : done ? "bg-emerald-500 text-white" : "bg-stone-200 text-stone-500")}>{index + 1}</span>
                <span className="text-[9px] font-bold leading-3">{shortLabels[stage.key] ?? stage.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function DashboardMetricStrip({ metrics }: { metrics: TeacherDashboardMetric[] }) {
  return (
    <div className={cn("grid gap-2 px-3 py-2.5", metrics.length === 2 ? "grid-cols-2" : "grid-cols-3")}>
      {metrics.map((metric) => (
        <div className={cn("min-w-0 rounded-lg border px-2 py-2", toneBorder(metric.tone))} key={metric.metricId} title={metric.helper}>
          <div className={cn("break-words text-base font-black tabular-nums", toneText(metric.tone))}>{metricValue(metric)}</div>
          <div className="mt-0.5 text-[9px] font-bold leading-3 text-stone-500">{metric.label}</div>
        </div>
      ))}
    </div>
  );
}

function CompactSection({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-stone-100 bg-white/75 px-3 py-2.5">
      <header className="mb-2 flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-blue-50 text-blue-700">{icon ?? <Gauge size={13} />}</span>
        <h3 className="text-xs font-black text-stone-900">{title}</h3>
      </header>
      {children}
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-stone-200 bg-stone-50/70 px-3 py-2 text-center text-[10px] leading-4 text-stone-500">{text}</div>;
}

function AlertBanner({ children, tone = "warning", onClick, ariaLabel }: { children: ReactNode; tone?: "warning" | "success" | "neutral"; onClick?: () => void; ariaLabel?: string }) {
  const className = cn(
    "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[10px] font-semibold leading-4",
    tone === "warning" ? "border-amber-200 bg-amber-50/70 text-amber-900" : tone === "success" ? "border-emerald-100 bg-emerald-50/70 text-emerald-800" : "border-stone-200 bg-stone-50 text-stone-600",
  );
  const icon = tone === "warning" ? <AlertTriangle className="shrink-0" size={13} /> : tone === "success" ? <CheckCircle2 className="shrink-0" size={13} /> : <Gauge className="shrink-0" size={13} />;
  if (!onClick) return <div className={className}>{icon}<span>{children}</span></div>;
  return <button aria-label={ariaLabel} className={className} onClick={onClick} type="button">{icon}<span className="min-w-0 flex-1">{children}</span><ChevronRight className="shrink-0 opacity-50" size={13} /></button>;
}

function SegmentedBar({ segments, total, label }: { segments: Array<{ label: string; count: number; className: string }>; total: number; label: string }) {
  return (
    <>
      <div aria-label={label} className="flex h-2.5 overflow-hidden rounded-full bg-stone-100" role="img">
        {segments.map((segment) => <div className={segment.className} key={segment.label} style={{ width: `${segment.count / Math.max(1, total) * 100}%` }} />)}
      </div>
      <div className={cn("mt-2 grid gap-1", segments.length === 3 ? "grid-cols-3" : "grid-cols-2")}>
        {segments.map((segment) => <div className="flex items-center gap-1 text-[9px] text-stone-500" key={segment.label}><span className={cn("size-1.5 shrink-0 rounded-full", segment.className)} /><span>{segment.label}</span><strong className="ml-auto text-stone-700">{segment.count}</strong></div>)}
      </div>
    </>
  );
}

function StatusCards({ items, total }: { items: Array<{ label: string; count: number; className: string; textClassName: string }>; total: number }) {
  return (
    <div aria-label={items.map((item) => `${item.label}${item.count}人`).join("、")} className="grid grid-cols-3 gap-2" role="group">
      {items.map((item) => {
        const percentage = total ? Math.round(item.count / total * 100) : 0;
        return <div className="rounded-lg border border-stone-200 bg-stone-50/75 px-2 py-2 text-center" key={item.label}><div className="flex items-center justify-center gap-1"><span className={cn("size-2 rounded-full", item.className)} /><strong className={cn("text-base tabular-nums", item.textClassName)}>{item.count}</strong><span className="text-[9px] text-stone-400">人</span></div><p className="mt-0.5 text-[10px] font-bold text-stone-700">{item.label}</p><p className="text-[9px] tabular-nums text-stone-400">{percentage}%</p></div>;
      })}
    </div>
  );
}

type PatrolStudent = {
  id: string;
  name: string;
  reason: string;
  onClick?: () => void;
};

function dashboardAdviceRevision(course: Course, stageKey: string): string {
  const lastSignal = (course.learningSignals ?? []).filter((item) => item.stageKey === stageKey).sort((left, right) => Date.parse(right.lastDetectedAt) - Date.parse(left.lastDetectedAt))[0];
  const lastEvent = (course.learningEvents ?? []).filter((item) => item.stageKey === stageKey).sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))[0];
  return [course.id, stageKey, course.updatedAt, lastSignal?.lastDetectedAt, lastEvent?.occurredAt, course.reflections?.length, course.showcasePresentations?.length, course.projectDocumentVersions?.length, course.projectPdfVersions?.length].join(":");
}

function RealtimeTeachingActions({ course, stageKey }: { course: Course; stageKey: string }) {
  const courseRef = useRef(course);
  const requestSequence = useRef(0);
  const [advice, setAdvice] = useState<TeacherDashboardAdvice>();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [adviceError, setAdviceError] = useState("生成暂不可用");
  const revision = dashboardAdviceRevision(course, stageKey);
  useEffect(() => {
    courseRef.current = course;
  }, [course]);
  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setStatus("loading");
    try {
      const result = await buildTeacherDashboardAdvice(courseRef.current.id, stageKey);
      if (sequence !== requestSequence.current) return;
      setAdvice(result);
      setStatus("ready");
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      setAdviceError(error && typeof error === "object" && "code" in error && error.code === "AI_NOT_CONFIGURED" ? "请先在 AI 设置中配置模型服务" : "生成暂不可用");
      setAdvice(undefined);
      setStatus("error");
    }
  }, [stageKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 500);
    return () => window.clearTimeout(timer);
  }, [refresh, revision]);

  const statusText = status === "loading" ? "正在分析本阶段数据" : status === "error" ? adviceError : advice ? `${new Date(advice.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 更新` : "";
  const visibleActions = advice?.actions.slice(0, 2) ?? [];
  const hiddenActionCount = Math.max(0, (advice?.actions.length ?? 0) - visibleActions.length);
  const stageLabel = course.stages.find((stage) => stage.key === stageKey)?.label ?? "当前阶段";
  const actionKindLabel = (kind: TeacherDashboardAdvice["actions"][number]["kind"]) => kind === "patrol" ? "巡场" : kind === "offline-task" ? "线下" : "下一步";
  const renderAction = (action: TeacherDashboardAdvice["actions"][number], index: number, inDialog = false) => {
    const studentNames = action.studentIds.map((id) => course.students.find((student) => student.id === id)?.name).filter((name): name is string => Boolean(name));
    const shownNames = inDialog ? studentNames : studentNames.slice(0, 4);
    const hiddenNameCount = studentNames.length - shownNames.length;
    return (
      <div className={cn("flex items-start gap-2 rounded-lg border", inDialog ? "px-3 py-3" : "px-2.5 py-2", action.kind === "patrol" ? "border-amber-200 bg-amber-50/65" : "border-blue-100 bg-blue-50/45")} key={`${action.title}:${index}`}>
        <span className={cn("mt-0.5 grid h-4 shrink-0 place-items-center rounded px-1 text-[8px] font-black", action.kind === "patrol" ? "bg-amber-500 text-white" : "bg-blue-600 text-white")}>{actionKindLabel(action.kind)}</span>
        <div className="min-w-0 flex-1 break-words">
          <strong className={cn("block text-stone-800", inDialog ? "text-sm" : "text-[10px]")}>{action.title}</strong>
          <p className={cn("whitespace-pre-wrap text-stone-600", inDialog ? "mt-1 text-xs leading-5" : "text-[9px] leading-3.5")}>{action.detail}</p>
          {shownNames.length ? <p className={cn("mt-1 break-words font-semibold text-amber-700", inDialog ? "text-[11px]" : "text-[8px]")}>涉及同学：{shownNames.join("、")}{hiddenNameCount ? `；另有 ${hiddenNameCount} 人，请在完整分析中查看` : ""}</p> : null}
        </div>
      </div>
    );
  };
  return (
    <section className="border-t border-stone-100 bg-white/75 px-3 py-2.5">
      <header className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2"><span className="grid size-6 shrink-0 place-items-center rounded-md bg-violet-50 text-violet-700"><Sparkles size={13} /></span><div className="min-w-0"><h3 className="text-xs font-black text-stone-900">AI 实时教学建议</h3><p className="text-[9px] leading-3 text-stone-400">{statusText}</p></div></div>
        <button aria-label="刷新 AI 实时教学建议" className="grid size-6 shrink-0 place-items-center rounded-md border border-stone-200 text-stone-500 hover:border-violet-300 hover:text-violet-700 disabled:cursor-wait disabled:opacity-50" disabled={status === "loading"} onClick={() => void refresh()} type="button"><RefreshCw className={status === "loading" ? "animate-spin" : undefined} size={12} /></button>
      </header>
      {status === "loading" && !advice ? <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-violet-100 bg-violet-50/40 px-3 py-3 text-[10px] text-violet-700"><Loader2 className="animate-spin" size={13} />正在读取本课程实时学情</div> : null}
      {status === "error" ? <EmptyState text="AI 实时建议暂不可用，可稍后刷新" /> : null}
      {advice ? <div className="space-y-1.5">
        {visibleActions.length ? visibleActions.map((action, index) => renderAction(action, index)) : <EmptyState text="暂无建议" />}
        <button className="flex w-full items-center justify-center gap-1 rounded-lg border border-violet-100 bg-violet-50/50 px-2.5 py-1.5 text-[9px] font-bold leading-4 text-violet-700 transition hover:border-violet-300 hover:bg-violet-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600" onClick={() => setDetailsOpen(true)} type="button">
          {hiddenActionCount ? `还有 ${hiddenActionCount} 条建议，查看全部` : "查看完整分析"}<ChevronRight size={11} />
        </button>
      </div> : null}
      <Dialog onOpenChange={setDetailsOpen} open={detailsOpen}>
        <DialogContent className="max-h-[88vh] w-[min(720px,calc(100vw-24px))] max-w-none overflow-y-auto">
          <DialogHeader>
            <DialogTitle>AI 实时教学建议 · {stageLabel}</DialogTitle>
            <DialogDescription>基于“{course.name}”当前课堂记录生成，建议会随本阶段数据更新。</DialogDescription>
          </DialogHeader>
          {advice ? <div className="space-y-4">
            <div className="rounded-xl border border-violet-100 bg-violet-50/65 px-4 py-3">
              <h4 className="text-xs font-black text-violet-900">实时分析摘要</h4>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-violet-950">{advice.summary}</p>
              <p className="mt-2 text-[11px] text-violet-700">生成时间：{new Date(advice.generatedAt).toLocaleString("zh-CN")}</p>
            </div>
            <div className="space-y-2">
              <h4 className="text-xs font-black text-stone-900">全部建议（{advice.actions.length}）</h4>
              {advice.actions.length ? advice.actions.map((action, index) => renderAction(action, index, true)) : <EmptyState text="暂无建议" />}
            </div>
          </div> : <EmptyState text="建议内容正在生成，请稍后重试" />}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function PatrolQueue({ students, emptyText = "当前无须优先巡场的学生", title = "优先巡场" }: { students: PatrolStudent[]; emptyText?: string; title?: string }) {
  return (
    <CompactSection icon={<Footprints size={13} />} title={title}>
      {students.length ? (
        <div className="grid gap-1.5">
          {students.slice(0, 2).map((student) => {
            const content = <><span className="min-w-0 flex-1 break-words"><span className="block text-[10px] font-bold text-stone-800">{student.name}</span><span className="mt-0.5 block text-[9px] leading-3.5 text-amber-700">{student.reason}</span></span>{student.onClick ? <ChevronRight className="shrink-0 text-stone-300" size={12} /> : null}</>;
            const className = "flex items-start gap-2 rounded-lg border border-amber-100 bg-amber-50/55 px-2.5 py-1.5 text-left";
            return student.onClick ? <button aria-label={`查看${student.name}的关注证据`} className={className} key={student.id} onClick={student.onClick} type="button">{content}</button> : <div className={className} key={student.id}>{content}</div>;
          })}
          {students.length > 2 ? <p className="text-center text-[9px] leading-4 text-stone-500">还有 {students.length - 2} 名学生需要关注，请在主区域查看</p> : null}
        </div>
      ) : <AlertBanner tone="success">{emptyText}</AlertBanner>}
    </CompactSection>
  );
}

function ProjectionBanner({ active, title }: { active: boolean; title?: string }) {
  return (
    <div className={cn("mx-3 mt-2.5 rounded-lg border px-2.5 py-2", active ? "border-emerald-200 bg-emerald-50" : "border-stone-200 bg-stone-50")}>
      <div className="flex items-center gap-2">
        <span className={cn("grid size-7 shrink-0 place-items-center rounded-md", active ? "bg-emerald-600 text-white" : "bg-stone-200 text-stone-500")}><MonitorUp size={14} /></span>
        <div className="min-w-0"><p className={cn("text-[11px] font-black", active ? "text-emerald-900" : "text-stone-700")}>{active ? "正在投屏" : "尚未投屏"}</p><p className="break-words text-[9px] leading-3.5 text-stone-500">{title ?? (active ? "资料正在同步给学生" : "当前没有同步投屏资料")}</p></div>
      </div>
    </div>
  );
}

function LaunchDashboard({ course, onFocus }: { course: Course; onFocus: (focus: TeacherStageFocus) => void }) {
  const metrics = deriveLaunchDashboardMetrics(course);
  const totalStates = metrics.states.length;
  const completed = metrics.states.filter((state) => state.status === "completed").length;
  const browsing = metrics.states.filter((state) => state.status === "opened" || state.status === "in-progress").length;
  const notOpened = metrics.states.filter((state) => state.status === "not-opened").length;
  const patrolStudents = metrics.studentRows
    .filter((row) => row.status !== "completed")
    .sort((left, right) => (left.status === "not-started" ? -1 : 1) - (right.status === "not-started" ? -1 : 1))
    .map((row) => ({
      id: row.student.id,
      name: row.student.name,
      reason: row.status === "not-started" ? "尚未打开资料" : "阅读尚未完成",
      onClick: () => onFocus({ stageKey: "launch", target: "reading", studentId: row.student.id, status: row.status === "not-started" ? "not-opened" : "in-progress" }),
    }));
  return (
    <div className="flex h-full flex-col">
      <ProjectionBanner active={metrics.projection.active} title={metrics.projection.title} />
      <DashboardMetricStrip metrics={metrics.headlines.filter((metric) => metric.metricId !== "launch-projection")} />
      <CompactSection icon={<FileText size={13} />} title="全班阅读状态">
        {metrics.resourceCoverage.length && course.students.length ? <SegmentedBar label={`已完成${completed}项、浏览中${browsing}项、未打开${notOpened}项`} segments={[{ label: "已完成", count: completed, className: "bg-emerald-500" }, { label: "浏览中", count: browsing, className: "bg-blue-500" }, { label: "未打开", count: notOpened, className: "bg-stone-300" }]} total={totalStates} /> : <EmptyState text="发布资料并产生浏览记录后显示" />}
      </CompactSection>
      <RealtimeTeachingActions course={course} stageKey="launch" />
      <PatrolQueue students={patrolStudents} />
    </div>
  );
}

function KnowledgeDashboard({ course, onFocus }: { course: Course; onFocus: (focus: TeacherStageFocus) => void }) {
  const metrics = deriveKnowledgeDashboardMetrics(course);
  const states = [
    { label: "未开始", count: metrics.stateCounts.notStarted, className: "bg-stone-400", textClassName: "text-stone-700" },
    { label: "学习中", count: metrics.stateCounts.learning, className: "bg-blue-500", textClassName: "text-blue-700" },
    { label: "已完成", count: metrics.stateCounts.completed, className: "bg-emerald-500", textClassName: "text-emerald-700" },
  ];
  const patrolStudents = metrics.attentionRows.map((row) => ({
    id: row.student.id,
    name: row.student.name,
    reason: row.signals[0]?.title ?? "存在学习信号",
    onClick: () => onFocus({ stageKey: "ai-learning", target: "student", studentId: row.student.id, tab: "trajectory" }),
  }));
  return (
    <div className="flex h-full flex-col">
      <DashboardMetricStrip metrics={metrics.headlines} />
      <CompactSection title="全班学习状态">
        {course.students.length ? <StatusCards items={states} total={course.students.length} /> : <EmptyState text="暂无学生数据" />}
      </CompactSection>
      <RealtimeTeachingActions course={course} stageKey="ai-learning" />
      <PatrolQueue students={patrolStudents} />
    </div>
  );
}

function MakeDashboard({ course, onFocus }: { course: Course; onFocus: (focus: TeacherStageFocus) => void }) {
  const metrics = deriveMakeDashboardMetrics(course);
  const decisionTotal = metrics.decisionCounts.adopted + metrics.decisionCounts.rejected;
  const decisionSegments = [
    { label: "采纳", count: metrics.decisionCounts.adopted, className: "bg-emerald-500" },
    { label: "拒绝", count: metrics.decisionCounts.rejected, className: "bg-stone-400" },
  ];
  const patrolStudents = metrics.attentionRows.map((row) => ({
    id: row.student.id,
    name: row.student.name,
    reason: row.reasons[0] ?? "成果需要复核",
    onClick: () => onFocus({ stageKey: "make", target: "student", studentId: row.student.id, section: row.severity === "high" ? "signal" : "artifact" }),
  }));
  return (
    <div className="flex h-full flex-col">
      <DashboardMetricStrip metrics={metrics.headlines} />
      <CompactSection icon={<MessageSquareText size={13} />} title="AI 协作概览">
        {decisionTotal ? <SegmentedBar label={`已采纳${metrics.decisionCounts.adopted}条、已拒绝${metrics.decisionCounts.rejected}条`} segments={decisionSegments} total={decisionTotal} /> : <EmptyState text="尚无已处理的 AI 建议" />}
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-blue-100 bg-blue-50/60 px-2 py-1.5"><strong className="block text-sm text-blue-700">{metrics.collaborationStudentIds.size}</strong><span className="text-[9px] text-stone-500">主动协作学生</span></div>
          <div className="rounded-lg border border-amber-100 bg-amber-50/60 px-2 py-1.5"><strong className="block text-sm text-amber-700">{metrics.boundaryTriggerCount}</strong><span className="text-[9px] text-stone-500">协作边界触发</span></div>
        </div>
      </CompactSection>
      <RealtimeTeachingActions course={course} stageKey="make" />
      <PatrolQueue students={patrolStudents} />
    </div>
  );
}

function ShowcaseDashboard({ course, data, onFocus }: { course: Course; data?: ShowcaseData; onFocus: (focus: TeacherStageFocus) => void }) {
  const metrics = deriveShowcaseDashboardMetrics(course, data);
  const plannedMinutes = metrics.actualDurations[0]?.plannedMinutes ?? data?.minutesPerStudent ?? 5;
  const averageActual = metrics.actualDurations.length ? metrics.actualDurations.reduce((sum, item) => sum + item.actualMinutes, 0) / metrics.actualDurations.length : undefined;
  const eta = metrics.headlines.find((item) => item.metricId === "showcase-eta")?.value ?? "—";
  const patrolStudents = metrics.queue
    .filter((item) => ["pending-approval", "rejected", "presenting"].includes(item.status))
    .map((item) => ({
      id: item.studentId,
      name: item.studentName,
      reason: item.status === "pending-approval" ? "汇报申请待审批" : item.status === "rejected" ? "需要重新准备" : "正在汇报",
      onClick: () => onFocus({ stageKey: "showcase", target: "student", studentId: item.studentId }),
    }));
  return (
    <div className="flex h-full flex-col">
      <section className="mx-3 mt-2.5 rounded-lg border border-indigo-100 bg-indigo-50/75 px-2.5 py-2.5">
        <div className="flex items-center gap-2"><span className="grid size-8 shrink-0 place-items-center rounded-md bg-indigo-600 text-white"><Clock3 size={15} /></span><div className="min-w-0"><p className="text-[9px] font-bold uppercase tracking-[0.12em] text-indigo-700">预计剩余</p><p className="text-xl font-black tabular-nums text-indigo-950">{eta === "—" ? "暂无" : eta}</p><p className="text-[9px] leading-3.5 text-indigo-700">{metrics.expectedEndAt ? `约 ${new Date(metrics.expectedEndAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 结束` : "等待可汇报队列"}</p></div></div>
      </section>
      <DashboardMetricStrip metrics={metrics.headlines.filter((item) => item.metricId !== "showcase-eta")} />
      <CompactSection icon={<Clock3 size={13} />} title="汇报提醒">
        <div className="mb-2 flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-2 text-[10px] text-stone-600"><span>计划 / 已完成平均</span><strong className="tabular-nums text-stone-900">{plannedMinutes} / {averageActual === undefined ? "—" : averageActual.toFixed(1)} 分钟</strong></div>
        {metrics.pendingApprovals.length ? <AlertBanner tone="warning">有 {metrics.pendingApprovals.length} 项汇报申请待审批</AlertBanner> : metrics.current ? <AlertBanner tone="neutral">当前汇报流程正在进行，请留意计时与评价</AlertBanner> : metrics.next ? <AlertBanner tone="neutral">下一位汇报者已经就绪，可按队列推进</AlertBanner> : <AlertBanner tone="success">当前没有待处理的汇报动作</AlertBanner>}
      </CompactSection>
      <RealtimeTeachingActions course={course} stageKey="showcase" />
      <PatrolQueue emptyText="当前没有需要现场优先处理的汇报者" students={patrolStudents} title="现场关注" />
    </div>
  );
}

function ReflectionDashboard({ course, onFocus }: { course: Course; onFocus: (focus: TeacherStageFocus) => void }) {
  const metrics = deriveReflectionDashboardMetrics(course);
  const completion = course.students.length ? Math.round(metrics.submittedCount / course.students.length * 100) : 0;
  const averages = metrics.headlines.filter((metric) => metric.metricId !== "reflection-coverage");
  const needsAttention = metrics.pendingStudents.length > 0 || metrics.lowScoreRows.length > 0;
  const patrolStudents: PatrolStudent[] = [
    ...metrics.pendingStudents.map((student) => ({
      id: `pending:${student.id}`,
      name: student.name,
      reason: "反思尚未提交",
      onClick: () => onFocus({ stageKey: "reflection", target: "student-list", filter: "pending", studentId: student.id }),
    })),
    ...metrics.lowScoreRows.map((row) => ({
      id: `low:${row.student.id}`,
      name: row.student.name,
      reason: row.dimensions[0] ?? "低分体验",
      onClick: () => onFocus({ stageKey: "reflection", target: "student-list", filter: "low-score", studentId: row.student.id }),
    })),
  ];
  return (
    <div className="flex h-full flex-col">
      <section className="mx-3 mt-2.5 flex items-center gap-3 rounded-lg border border-violet-100 bg-violet-50/70 px-2.5 py-2.5">
        <div className="grid size-11 shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(#7c3aed ${completion}%, #ede9fe 0)` }}><div className="grid size-8 place-items-center rounded-full bg-violet-50 text-[10px] font-black text-violet-800">{course.students.length ? `${completion}%` : "—"}</div></div>
        <div><p className="text-[11px] font-black text-violet-950">反思提交进度</p><p className="mt-0.5 text-[9px] text-violet-700">{metrics.submittedCount}/{course.students.length || "—"} 名学生已提交有效问卷</p></div>
      </section>
      <DashboardMetricStrip metrics={averages} />
      <CompactSection icon={<MessageSquareText size={13} />} title="需要跟进">
        {needsAttention ? <AlertBanner ariaLabel="在主区域查看待跟进学生" onClick={() => onFocus({ stageKey: "reflection", target: "student-list", filter: metrics.pendingStudents.length ? "pending" : "low-score" })} tone="warning">待提交 {metrics.pendingStudents.length} 人 · 低分体验 {metrics.lowScoreRows.length} 人，点击查看明细</AlertBanner> : <AlertBanner tone="success">反思已全部提交，暂无低分体验</AlertBanner>}
      </CompactSection>
      <ReflectionSummarySidebar compact course={course} />
      <PatrolQueue emptyText="当前没有需要单独跟进的学生" students={patrolStudents} title="个别跟进" />
    </div>
  );
}

export function TeacherStageDashboard({ course, stageKey, degraded, showcaseData, onFocus, onSelectStage, onCollapse }: TeacherStageDashboardProps) {
  const currentStage = course.stages[course.currentStageIndex];
  const body = stageKey === "launch"
    ? <LaunchDashboard course={course} onFocus={onFocus} />
    : stageKey === "ai-learning"
      ? <KnowledgeDashboard course={course} onFocus={onFocus} />
      : stageKey === "make"
        ? <MakeDashboard course={course} onFocus={onFocus} />
        : stageKey === "showcase"
          ? <ShowcaseDashboard course={course} data={showcaseData} onFocus={onFocus} />
          : <ReflectionDashboard course={course} onFocus={onFocus} />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="relative shrink-0 overflow-hidden border-b border-blue-100 bg-[linear-gradient(145deg,#eff6ff_0%,#ffffff_60%,#f5f3ff_100%)] px-3 pb-2.5 pt-3">
        <div className="absolute -right-8 -top-10 size-28 rounded-full bg-blue-100/60 blur-2xl" />
        <div className="relative flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            <button aria-label="收起班级概览" aria-expanded="true" className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border border-blue-200 bg-white/85 text-blue-600 shadow-sm transition hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600" onClick={onCollapse} type="button"><ChevronRight size={15} strokeWidth={2.4} /></button>
            <div className="min-w-0"><div className="text-[9px] font-bold uppercase tracking-[0.16em] text-blue-600">课堂实时监控</div><h2 className="mt-0.5 break-words text-sm font-black leading-5 text-stone-950">{currentStage?.label ?? "当前阶段"}</h2></div>
          </div>
          {degraded ? <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50/90 px-2 py-1 text-[9px] font-bold text-amber-700" title="课堂数据同步延迟"><AlertTriangle size={10} />同步延迟</span> : null}
        </div>
        <StageProgress course={course} onSelectStage={onSelectStage} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{body}</div>
    </div>
  );
}

export type { TeacherStageFocus };
