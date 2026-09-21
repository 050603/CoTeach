"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  CircleStop,
  Clock3,
  Copy,
  Eye,
  Maximize2,
  QrCode,
  UserRoundCheck,
  Users,
  X,
} from "lucide-react";
import { DashboardShell, Avatar } from "@/components/dashboard-shell";
import { StageGateDialog } from "@/components/classroom/classroom-chrome";
import { TeacherStageView } from "@/components/views/teacher/stage-dispatcher";
import { RealtimeTeachingActions, TeacherStageDashboard } from "@/components/classroom/teacher-stage-dashboard";
import { TeacherPresentationAnalytics } from "@/components/classroom/teacher-presentation-analytics";
import { TeacherPresentationControls, TeacherPresentationHeader } from "@/components/classroom/teacher-presentation-chrome";
import { TeacherPresentationActionsProvider } from "@/components/classroom/teacher-presentation-actions";
import { PublicDiscussionTeacherWorkspace } from "@/components/views/teacher/public-discussion-workspace";
import presentationStyles from "@/components/classroom/teacher-presentation.module.css";
import { useTeacherPresentation } from "@/hooks/use-teacher-presentation";
import { TeacherClassroomPulse } from "@/components/classroom/teacher-classroom-pulse";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle, Button, Dialog, DialogContent, DialogDescription, DialogTitle, FlowActionBar, SaveStatus } from "@/components/ui";
import { useSession, useCourse, useHydrated } from "@/lib/session/store";
import { cn } from "@/lib/utils";
import { evaluateStageGate } from "@/lib/classroom/stage-gates";
import { makeRecordId } from "@/lib/session/actions";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import { useShowcasePresentation } from "@/hooks/use-showcase-presentation";
import { useCoursePresence } from "@/hooks/use-course-presence";
import { deriveStageReadiness } from "@/lib/learning-evidence/readiness";
import { STAGE_READINESS_LABEL } from "@/lib/learning-evidence/types";
import {
  adjustClassroomStageTiming,
  createClassroomTimingState,
  resolveCourseTimingMinutes,
  deriveClassroomTimingSnapshot,
  pauseClassroomTiming,
  resetActiveClassroomStageTiming,
  resumeClassroomTiming,
  transitionClassroomStageTiming,
  type ClassroomTimingState,
} from "@/lib/classroom/timing";
import { copyTextToClipboard } from "@/lib/browser/copy-text";
import { normalizeInviteCode } from "@/lib/session/invite-code";
import type { TeacherStageFocus } from "@/lib/classroom/teacher-dashboard-metrics";
import {
  ClassroomToolPopover,
  DEFAULT_CLASSROOM_DATA_SIDEBAR_COLLAPSED,
  formatClock,
  shouldShowClassroomDataSidebar,
  TimerPanel,
} from "./classroom-page-parts";

type ToolPanel = "timer" | "invite" | "students" | null;

export default function TeachClassroomPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const session = useSession();
  const { user, endTeaching, updateCourse, flushSaves, retrySave, saveState } = session;
  const course = useCourse(params?.id);
  useRealtimeSync(params?.id);
  const presence = useCoursePresence({
    courseId: course?.id,
    role: "teacher",
    enabled: course?.status === "teaching",
  });
  const hydrated = useHydrated();
  const [nowTick, setNowTick] = useState(0);
  const [toolPanel, setToolPanel] = useState<ToolPanel>(null);
  const [targetStageIndex, setTargetStageIndex] = useState<number | null>(null);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string>();
  const [endDialogOpen, setEndDialogOpen] = useState(false);
  const [dataSidebarCollapsed, setDataSidebarCollapsed] = useState(DEFAULT_CLASSROOM_DATA_SIDEBAR_COLLAPSED);
  const [dashboardFocus, setDashboardFocus] = useState<TeacherStageFocus>();
  const presentation = useTeacherPresentation();
  const [presentationView, setPresentationView] = useState<"teaching" | "analytics">("teaching");
  const [presentationDetails, setPresentationDetails] = useState(false);
  const [presentationDiscussion, setPresentationDiscussion] = useState(false);
  const [stageActionsTarget, setStageActionsTarget] = useState<HTMLDivElement | null>(null);
  const [presentationTool, setPresentationTool] = useState<"timer" | "advice" | "tools" | "invite" | "students" | null>(null);
  const displayScope = `${course?.id}:${course?.currentStageIndex}:${presentation.active}:${presentationView}`;
  const [appliedDisplayScope, setAppliedDisplayScope] = useState(displayScope);
  if (appliedDisplayScope !== displayScope) {
    setAppliedDisplayScope(displayScope);
    setPresentationDetails(false);
    setPresentationDiscussion(false);
    setPresentationTool(null);
  }
  const showcaseController = useShowcasePresentation(
    course?.stages[course.currentStageIndex]?.key === "showcase" ? course.id : undefined,
  );

  useEffect(() => {
    if (!hydrated) return;
    if (course && course.status !== "teaching" && !ending && (course.status !== "finished" || (saveState !== "saving" && saveState !== "error"))) router.replace(course.status === "finished" ? `/teacher/classrooms/${course.id}` : `/teacher/teach/${course.id}/setup`);
  }, [course, hydrated, router, ending, saveState]);

  useEffect(() => {
    if (!course || course.status !== "teaching") return;
    const id = window.setInterval(() => setNowTick((t) => t + 1), 1_000);
    return () => window.clearInterval(id);
  }, [course]);

  useEffect(() => {
    if (
      !course
      || course.status !== "teaching"
      || course.uiState?.classroomTiming
    ) {
      return;
    }
    const classroomTiming = createClassroomTimingState({
      stages: course.stages,
      totalMinutes: resolveCourseTimingMinutes(course),
      projectMainline: course.content.projectMainline,
      moduleTimingPlan: course.content.moduleTimingPlan,
      stagePlan: course.content.stagePlan,
      activeStageKey: course.stages[course.currentStageIndex]?.key,
    });
    updateCourse(course.id, {
      uiState: {
        ...(course.uiState ?? {}),
        classroomTiming,
      },
    });
  }, [course, updateCourse]);

  const onlineCount = course?.students.filter((student) =>
    presence.onlineStudentIds.has(student.id)
  ).length ?? 0;

  const timingSnapshot = useMemo(() => {
    void nowTick;
    const timing = course?.uiState?.classroomTiming;
    return timing
      ? deriveClassroomTimingSnapshot(timing, new Date().toISOString())
      : undefined;
  }, [course?.uiState?.classroomTiming, nowTick]);

  if (!hydrated) {
    return (
      <DashboardShell role="teacher" userName={user.name} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">加载中...</div>
      </DashboardShell>
    );
  }

  if (!course) {
    return (
      <DashboardShell role="teacher" userName={user.name} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">
          未找到课程。
          <Link className="mt-4 text-blue-700 hover:underline" href="/teacher">返回课程列表</Link>
        </div>
      </DashboardShell>
    );
  }

  const currentStage = course.stages[course.currentStageIndex];
  const showDataSidebar = !presentation.active && shouldShowClassroomDataSidebar(currentStage?.key, dataSidebarCollapsed);
  const canPrev = course.currentStageIndex > 0;
  const canNext = course.currentStageIndex < course.stages.length - 1;
  const previousStage = canPrev ? course.stages[course.currentStageIndex - 1] : undefined;
  const nextStage = canNext ? course.stages[course.currentStageIndex + 1] : undefined;
  const timerText = timingSnapshot?.activeStage
    ? timingSnapshot.activeStage.overrunSec > 0
      ? `+${formatClock(timingSnapshot.activeStage.overrunSec)}`
      : formatClock(timingSnapshot.activeStage.remainingSec)
    : "--:--";

  function enterPresentation() {
    setToolPanel(null);
    setDashboardFocus(undefined);
    setPresentationDetails(false);
    setPresentationDiscussion(false);
    setPresentationTool(null);
    setPresentationView("teaching");
    void presentation.enter();
  }

  async function endClass() {
    if (!course || ending) return;
    setEnding(true);
    setEndError(undefined);
    try {
      if (saveState === "error") await retrySave();
      if (!await flushSaves()) throw new Error("课堂数据尚未保存，请重试");
      if (course.status !== "finished") endTeaching(course.id);
      if (!await flushSaves()) throw new Error("结束课堂未保存，请重试");
      setEndDialogOpen(false);
      router.replace(`/teacher/classrooms/${course.id}`);
    } catch (error) { setEndError(error instanceof Error ? error.message : "结束课堂失败"); }
    finally { setEnding(false); }
  }

  function persistClassroomTiming(classroomTiming: ClassroomTimingState) {
    if (!course) return;
    updateCourse(course.id, {
      uiState: {
        ...(course.uiState ?? {}),
        classroomTiming,
      },
    });
  }

  function toggleClassroomTimer() {
    if (!course) return;
    const timing = course.uiState?.classroomTiming;
    if (!timing) return;
    persistClassroomTiming(
      timing.status === "paused"
        ? resumeClassroomTiming(timing)
        : pauseClassroomTiming(timing),
    );
  }

  function adjustActiveStage(deltaSec: number) {
    if (!course) return;
    const timing = course.uiState?.classroomTiming;
    if (!timing?.activeStageKey) return;
    persistClassroomTiming(
      adjustClassroomStageTiming(timing, timing.activeStageKey, deltaSec),
    );
  }

  function resetActiveStageTimer() {
    if (!course) return;
    const timing = course.uiState?.classroomTiming;
    if (!timing) return;
    persistClassroomTiming(resetActiveClassroomStageTiming(timing));
  }


  function requestStage(index: number) {
    if (!course) return;
    if (index < 0 || index >= course.stages.length || index === course.currentStageIndex) return;
    setTargetStageIndex(index);
  }

  function confirmStage() {
    if (!course || targetStageIndex === null) return;
    const gate = evaluateStageGate(course);
    const gateOverridden = targetStageIndex > course.currentStageIndex && !gate.canAdvance;
    const from = course.stages[course.currentStageIndex];
    const to = course.stages[targetStageIndex];
    const transitionAt = new Date().toISOString();
    const classroomTiming = course.uiState?.classroomTiming
      ? transitionClassroomStageTiming(
          course.uiState.classroomTiming,
          to.key,
          transitionAt,
        )
      : undefined;
    updateCourse(course.id, {
      currentStageIndex: targetStageIndex,
      stageTransitions: [...(course.stageTransitions ?? []), {
        id: makeRecordId("transition"),
        fromStageKey: from.key,
        toStageKey: to.key,
        gateStatus: gateOverridden ? "overridden" : "passed",
        blockers: gate.blockers.map((item) => item.message),
        warnings: gate.warnings.map((item) => item.message),
        actor: user.name,
        createdAt: transitionAt,
      }],
      uiState: {
        ...(course.uiState ?? {}),
        teacherResourceProjection: null,
        resourceProjection: null,
        ...(classroomTiming ? { classroomTiming } : {}),
      },
    });
    setTargetStageIndex(null);
    setDashboardFocus(undefined);
  }

  const toolPanelContent = toolPanel === "timer" ? (
    <TimerPanel snapshot={timingSnapshot} onTogglePause={toggleClassroomTimer} onReset={resetActiveStageTimer} onAdjust={adjustActiveStage} />
  ) : toolPanel === "invite" ? (
    <InvitePanel
      code={course.inviteCode}
      onCopy={() => course.inviteCode
        ? copyTextToClipboard(normalizeInviteCode(course.inviteCode)).then(
            () => true,
            () => false,
          )
        : Promise.resolve(false)}
      accessHref={`/teacher/classes/${course.platformContext?.offeringId ?? ""}/access`}
    />
  ) : toolPanel === "students" ? (
    <StudentsPanel course={course} currentStageKey={currentStage?.key} onlineStudentIds={presence.onlineStudentIds} />
  ) : null;

  return (
    <TeacherPresentationActionsProvider target={presentation.active && !presentationDiscussion ? stageActionsTarget : null}>
    <DashboardShell
      role="teacher"
      userName={user.name}
      variant="bare"
      immersive={presentation.active}
      currentCourse={{ id: course.id, name: course.name, status: course.status }}
      currentStage={currentStage ? { index: course.currentStageIndex, total: course.stages.length, label: currentStage.label } : undefined}
      currentTask={currentStage ? `检查${currentStage.label}的阶段产出` : undefined}
      leadRole={currentStage?.key === "ai-learning" ? "AI" : currentStage?.key === "proposal" || currentStage?.key === "make" ? "学生" : "教师"}
      onSelectStage={requestStage}
      stageOptions={course.stages.map((stage, index) => ({ index, label: stage.label }))}
      wide
      headerSlot={
        <div className="hidden items-center gap-1 md:flex">
          <button className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher)] px-3 text-sm font-semibold text-white" data-teacher-presentation-trigger onClick={enterPresentation} type="button"><Maximize2 size={17} />全屏授课</button>
          {/* 计时器 */}
          <div className="relative">
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-xs)] border border-stone-200 bg-white/80 px-2.5 text-[12px] font-semibold text-stone-600 transition hover:border-[var(--pbl-teacher-border)] hover:text-[var(--pbl-teacher)]"
              onClick={() => setToolPanel((value) => value === "timer" ? null : "timer")}
              type="button"
            >
              <Clock3 size={14} />
              <span className="font-mono font-bold text-[var(--pbl-teacher)]">{timerText}</span>
            </button>
            {toolPanel === "timer" ? <ClassroomToolPopover onClose={() => setToolPanel(null)}>{toolPanelContent}</ClassroomToolPopover> : null}
          </div>
          {/* 邀请码 */}
          <div className="relative">
            <button
              className="grid h-8 w-8 place-items-center rounded-[var(--radius-xs)] border border-stone-200 bg-white/80 text-stone-600 transition hover:border-[var(--pbl-teacher-border)] hover:text-[var(--pbl-teacher)]"
              onClick={() => setToolPanel((value) => value === "invite" ? null : "invite")}
              type="button"
              aria-label="学生邀请码"
            >
              <QrCode size={14} />
            </button>
            {toolPanel === "invite" ? <ClassroomToolPopover onClose={() => setToolPanel(null)}>{toolPanelContent}</ClassroomToolPopover> : null}
          </div>
          {/* 在线学生 */}
          <div className="relative">
            <button
              className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-xs)] border border-stone-200 bg-white/80 px-2.5 text-[12px] font-semibold text-stone-600 transition hover:border-[var(--pbl-teacher-border)] hover:text-[var(--pbl-teacher)]"
              onClick={() => setToolPanel((value) => value === "students" ? null : "students")}
              type="button"
              aria-label="在线学生"
            >
              <UserRoundCheck size={14} />
              <span>{onlineCount}/{course.students.length}</span>
              {onlineCount > 0 ? <span className="h-1.5 w-1.5 rounded-full bg-[var(--pbl-success)]" /> : null}
            </button>
            {toolPanel === "students" ? <ClassroomToolPopover align="right" onClose={() => setToolPanel(null)}>{toolPanelContent}</ClassroomToolPopover> : null}
          </div>
          {/* 查看课程 */}
          <Link
            className="grid h-8 w-8 place-items-center rounded-[var(--radius-xs)] border border-stone-200 bg-white/80 text-stone-600 transition hover:border-[var(--pbl-teacher-border)] hover:text-[var(--pbl-teacher)]"
            href={`/teacher/prepare/${course.platformContext?.templateId ?? course.id}/preview`}
            aria-label="查看课程"
          >
            <Eye size={14} />
          </Link>
          {/* 结束授课 */}
          <button
            className="grid h-8 w-8 place-items-center rounded-[var(--radius-xs)] border border-orange-200 bg-white/80 text-[var(--pbl-danger)] transition hover:bg-[var(--pbl-danger-soft)]"
            onClick={() => setEndDialogOpen(true)}
            type="button"
            aria-label="结束授课"
          >
            <CircleStop size={14} />
          </button>
        </div>
      }
    >
      <div className={presentation.active ? cn("teacher-presentation", presentationStyles.shell) : undefined}>
      {presentation.active ? <TeacherPresentationHeader course={course} degraded={presence.degraded} onlineCount={onlineCount} onExit={() => void presentation.exit()} saveStatus={<SaveStatus lastSavedAt={session.lastSavedAt} onRetry={() => void session.retrySave()} state={session.saveState} />} /> : null}
      {/* 移动端工具栏：小屏幕上显示精简版 */}
      <div className={cn("mb-3 flex flex-wrap items-center gap-2 md:hidden", presentation.active && "!hidden")}>
        <button className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[var(--pbl-teacher)] px-3 text-sm font-semibold text-white" data-teacher-presentation-trigger onClick={enterPresentation} type="button"><Maximize2 size={17} />全屏授课</button>
        <label className="order-first w-full"><span className="sr-only">当前教学阶段</span><select aria-label="当前教学阶段" className="h-9 w-full truncate rounded-[var(--radius-sm)] border border-blue-200 bg-blue-50/70 px-2 text-xs font-bold text-blue-800 outline-none focus-visible:ring-2 focus-visible:ring-blue-500" onChange={(event) => requestStage(Number(event.target.value))} value={course.currentStageIndex}>{course.stages.map((stage, index) => <option key={stage.key} value={index}>{index + 1}. {stage.label}</option>)}</select></label>
        <button
          className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border border-stone-200 bg-white px-3 text-[13px] font-semibold text-stone-600"
          onClick={() => setToolPanel("timer")}
          type="button"
        >
          <Clock3 size={15} />
          <span className="font-mono font-bold text-[var(--pbl-teacher)]">{timerText}</span>
        </button>
        <button
          className="grid h-9 w-9 place-items-center rounded-[var(--radius-sm)] border border-stone-200 bg-white text-stone-600"
          onClick={() => setToolPanel("invite")}
          type="button"
          aria-label="邀请码"
        >
          <QrCode size={15} />
        </button>
        <button
          className="inline-flex h-9 items-center gap-1 rounded-[var(--radius-sm)] border border-stone-200 bg-white px-3 text-[13px] font-semibold text-stone-600"
          onClick={() => setToolPanel("students")}
          type="button"
          aria-label="在线学生"
        >
          <UserRoundCheck size={15} /> {onlineCount}/{course.students.length}
        </button>
        <div className="ml-auto flex items-center gap-2">
          <Link
            className="grid h-9 w-9 place-items-center rounded-[var(--radius-sm)] border border-stone-200 bg-white text-stone-600"
            href={`/teacher/prepare/${course.platformContext?.templateId ?? course.id}/preview`}
            aria-label="查看课程"
          >
            <Eye size={15} />
          </Link>
          <button
            className="grid h-9 w-9 place-items-center rounded-[var(--radius-sm)] border border-orange-200 bg-white text-[var(--pbl-danger)]"
            onClick={() => setEndDialogOpen(true)}
            type="button"
            aria-label="结束授课"
          >
            <CircleStop size={15} />
          </button>
        </div>
      </div>

      {/* 主显示区；班级概览按需展开。 */}
      <div className={cn(presentation.active ? presentationStyles.body : "grid gap-3 pb-8", showDataSidebar && "xl:pr-[21.25rem]")}>
        {/* 中间：阶段控制 + 横幅 + 阶段视图 */}
        <div className={presentation.active ? presentationStyles.content : "min-w-0 space-y-3"}>
          {showDataSidebar && course.uiState?.aiAnalysisPending ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-[var(--pbl-warning-soft)] px-3 py-1 text-xs font-semibold text-[var(--pbl-warning)] ring-1 ring-orange-100">
              <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--pbl-warning)]" />
              学生有新更新，请刷新 AI 建议
            </div>
          ) : null}


          {currentStage && !presentation.active ? (
            <TeacherClassroomPulse
              course={course}
              degraded={presence.degraded}
              showcaseData={showcaseController.data}
              stageKey={currentStage.key}
            />
          ) : null}

          {currentStage?.key === "ai-learning" && presentation.active ? (
            <PublicDiscussionTeacherWorkspace course={course} hidden={!presentationDiscussion} />
          ) : null}

          {currentStage && currentStage.key !== "reflection" && presentation.active && !presentationDiscussion && presentationView === "analytics" && !presentationDetails ? <TeacherPresentationAnalytics course={course} stageKey={currentStage.key} showcaseData={showcaseController.data} degraded={presence.degraded} onDetails={() => setPresentationDetails(true)} /> : null}

          {currentStage ? (
            <section
              className={cn(
                "classroom-stage",
                presentation.active ? presentationStyles.stage : cn(
                  "pbl-card rounded-[var(--radius-lg)] p-3 md:p-4",
                  currentStage.key === "make" ? "overflow-visible" : "overflow-hidden",
                ),
              )}
              data-details={presentation.active && presentationDetails}
              hidden={presentationDiscussion || (currentStage.key !== "reflection" && presentation.active && presentationView === "analytics" && !presentationDetails)}
              key={currentStage.key}
            >
              <TeacherStageView
                course={course}
                focus={dashboardFocus}
                showcaseController={showcaseController}
                view={currentStage.view}
                presentation={!presentation.active || presentationDetails ? "workspace" : presentationView}
                immersive={presentation.active}
              />
            </section>
          ) : null}
        </div>

        {showDataSidebar ? (
          <div className="relative max-xl:fixed max-xl:bottom-3 max-xl:left-3 max-xl:right-3 max-xl:z-40 max-xl:h-[min(70dvh,560px)] xl:fixed xl:bottom-[4.5rem] xl:right-0 xl:top-16 xl:z-20 xl:w-[21.25rem] min-[1920px]:right-[4vw]">
            <aside className="flex h-full flex-col overflow-hidden rounded-2xl border border-blue-100 bg-white/95 shadow-[0_18px_50px_rgba(30,64,175,0.10)] backdrop-blur">
              <TeacherStageDashboard
                active={showDataSidebar}
                course={course}
                degraded={presence.degraded}
                onCollapse={() => setDataSidebarCollapsed(true)}
                onFocus={setDashboardFocus}
                onSelectStage={requestStage}
                showcaseData={showcaseController.data}
                stageKey={currentStage?.key ?? "launch"}
              />
            </aside>
          </div>
        ) : null}
      </div>

      {!showDataSidebar && !presentation.active ? (
        <button
          aria-label="显示班级概览"
          aria-expanded="false"
          className="fixed right-0 top-1/2 z-40 grid h-14 w-7 -translate-y-1/2 place-items-center rounded-l-xl border border-r-0 border-blue-200 bg-white/95 text-blue-500 shadow-[-6px_0_18px_rgba(30,64,175,0.12)] backdrop-blur transition hover:w-8 hover:bg-blue-50 hover:text-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          onClick={() => setDataSidebarCollapsed(false)}
          title="展开班级概览"
          type="button"
        >
          <ChevronLeft size={16} strokeWidth={2.4} />
        </button>
      ) : null}


      {!presentation.active ? <FlowActionBar
        back={previousStage ? <Button onClick={() => requestStage(course.currentStageIndex - 1)} variant="text">回退到「{previousStage.label}」</Button> : null}
        persistent
      >
        {nextStage ? <Button onClick={() => requestStage(course.currentStageIndex + 1)}>结束「{currentStage?.label}」并进入「{nextStage.label}」</Button> : <Button onClick={() => setEndDialogOpen(true)}>结束本次课程</Button>}
      </FlowActionBar> : <TeacherPresentationControls
        stageActionsRef={setStageActionsTarget}
        course={course}
        view={presentationView}
        details={presentationDetails}
        discussion={presentationDiscussion}
        discussionAvailable={currentStage?.key === "ai-learning"}
        onView={(view) => { setPresentationDetails(false); setPresentationDiscussion(false); setDashboardFocus(undefined); setPresentationView(view); }}
        onDiscussion={() => { setPresentationDetails(false); setPresentationDiscussion(true); setDashboardFocus(undefined); }}
        onWorkspace={() => { setPresentationDiscussion(false); setPresentationDetails(true); }}
        onDetailsClose={() => { setPresentationDetails(false); setPresentationDiscussion(false); setDashboardFocus(undefined); }}
        onStage={requestStage}
        onTools={() => setPresentationTool("tools")}
        onAdvice={() => setPresentationTool("advice")}
        onEnd={() => setEndDialogOpen(true)}
      />}

      <Dialog open={presentation.active && presentationTool !== null} onOpenChange={(open) => { if (!open) setPresentationTool(null); }}>
        <DialogContent className={presentationStyles.dialog}>
          <DialogTitle>{presentationTool === "timer" ? "课堂计时" : presentationTool === "advice" ? "教学建议" : presentationTool === "invite" ? "学生邀请码" : presentationTool === "students" ? "在线学生" : "课堂工具"}</DialogTitle>
          <DialogDescription>{currentStage?.label} · {course.name}</DialogDescription>
          {presentationTool === "timer" ? <TimerPanel snapshot={timingSnapshot} onTogglePause={toggleClassroomTimer} onReset={resetActiveStageTimer} onAdjust={adjustActiveStage} /> : presentationTool === "advice" ? <div className={presentationStyles.advice}><RealtimeTeachingActions course={course} stageKey={currentStage?.key ?? "launch"} /></div> : null}
          {presentationTool === "tools" ? <div className="grid gap-3 sm:grid-cols-2">
            <Button onClick={() => setPresentationTool("timer")} variant="outline"><Clock3 size={18} />课堂计时</Button>
            <Button onClick={() => setPresentationTool("invite")} variant="outline"><QrCode size={18} />学生邀请码</Button>
            <Button onClick={() => setPresentationTool("students")} variant="outline"><Users size={18} />在线学生</Button>
            <Link className="flex min-h-11 items-center justify-center gap-2 rounded-md border border-stone-300 px-4 text-sm font-semibold text-[var(--pbl-teacher)]" href={`/teacher/prepare/${course.platformContext?.templateId ?? course.id}/preview`} target="_blank" rel="noopener noreferrer"><Eye size={18} />查看课程</Link>
          </div> : null}
          {presentationTool === "invite" ? <InvitePanel code={course.inviteCode} onCopy={() => course.inviteCode ? copyTextToClipboard(normalizeInviteCode(course.inviteCode)).then(() => true, () => false) : Promise.resolve(false)} accessHref={`/teacher/classes/${course.platformContext?.offeringId ?? ""}/access`} /> : null}
          {presentationTool === "students" ? <StudentsPanel course={course} currentStageKey={currentStage?.key} onlineStudentIds={presence.onlineStudentIds} /> : null}
        </DialogContent>
      </Dialog>

      {targetStageIndex !== null ? <StageGateDialog course={course} onConfirm={confirmStage} onOpenChange={(open) => { if (!open) setTargetStageIndex(null); }} open targetIndex={targetStageIndex} /> : null}

      {endError ? <p role="alert" className="text-sm text-red-700">{endError}</p> : null}
      <AlertDialog onOpenChange={setEndDialogOpen} open={endDialogOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>结束本次课堂？</AlertDialogTitle>
          <AlertDialogDescription>课堂结束后学生将进入只读回看。结束前请确认授课资源和项目实践产物已经保存；保存成功后将进入课堂学习记录。</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>继续授课</AlertDialogCancel>
            <Button disabled={ending} onClick={() => void endClass()}>{ending ? "正在结束…" : "结束课堂"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>


      {/* 移动端工具弹窗；桌面端弹层直接锚定在对应顶栏按钮下方。 */}
      {toolPanel && !presentation.active ? (
        <>
          <div className="fixed inset-0 z-[35] md:hidden" onClick={() => setToolPanel(null)} />
          <div className="pbl-glass fixed left-1/2 top-20 z-40 max-h-[calc(100dvh-6rem)] w-[min(360px,calc(100vw-32px))] -translate-x-1/2 overflow-y-auto rounded-[var(--radius-md)] p-4 md:hidden">
            <button
              className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] text-stone-400 transition hover:bg-white hover:text-stone-700"
              onClick={() => setToolPanel(null)}
              type="button"
              aria-label="关闭"
            >
              <X size={15} />
            </button>
            {toolPanelContent}
          </div>
        </>
      ) : null}
      </div>
    </DashboardShell>
    </TeacherPresentationActionsProvider>
  );
}

function InvitePanel({
  code,
  onCopy,
  accessHref,
}: {
  code?: string;
  onCopy: () => Promise<boolean>;
  accessHref: string;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    setCopyState(await onCopy() ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 1800);
  }

  return (
    <div>
      <div className="mb-2.5 pr-8">
        <div className="text-base font-bold text-stone-900">学生邀请码</div>
        <p className="mt-0.5 text-[13px] text-stone-500">学生凭教学班邀请码加入课程，再进入本课堂</p>
      </div>
      {code ? (
        <>
          <div className="text-center">
            <div className="font-mono text-[30px] font-bold tracking-[0.18em] text-stone-900">
              {code.slice(0, 3)} {code.slice(3, 6)}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            <button
              className="inline-flex h-9 items-center justify-center gap-1 rounded-[var(--radius-xs)] bg-[var(--pbl-teacher)] text-xs font-semibold text-white transition hover:bg-[var(--pbl-teacher-hover)]"
              onClick={() => void copy()}
              type="button"
            >
              {copyState === "copied" ? <CheckCircle2 size={13} /> : <Copy size={13} />}
              {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制"}
            </button>
            <Link className="inline-flex h-9 items-center justify-center gap-1 rounded-[var(--radius-xs)] border border-stone-200 bg-white text-xs font-semibold text-stone-600" href={accessHref}>邀请设置</Link>
          </div>
        </>
      ) : (
        <div className="py-6 text-center text-sm text-stone-500">暂未生成邀请码</div>
      )}
    </div>
  );
}

function StudentsPanel({
  course,
  currentStageKey,
  onlineStudentIds,
}: {
  course: NonNullable<ReturnType<typeof useCourse>>;
  currentStageKey?: string;
  onlineStudentIds: ReadonlySet<string>;
}) {
  const total = course.students.length;
  const online = course.students.filter((student) => onlineStudentIds.has(student.id)).length;
  return (
    <div>
      <div className="mb-2.5 flex items-center justify-between gap-2 pr-8">
        <div>
          <div className="text-base font-bold text-stone-900">在线学生</div>
          <p className="mt-0.5 text-[13px] text-stone-500">{online} 在线 / {total} 总数</p>
        </div>
        <span className="inline-flex h-6 items-center gap-1 rounded-full bg-[var(--pbl-success-soft)] px-2 text-[11px] font-bold text-[var(--pbl-success)] ring-1 ring-green-200">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--pbl-success)]" />
          {online} / {total}
        </span>
      </div>
      {total === 0 ? (
        <div className="py-6 text-center text-sm text-stone-500">
          <Users className="mx-auto mb-1 text-stone-300" size={20} />
          暂无学生加入
        </div>
      ) : (
        <ul className="max-h-[300px] space-y-1.5 overflow-auto pr-1">
          {[...course.students]
            .sort((a, b) => {
              const aOnline = onlineStudentIds.has(a.id);
              const bOnline = onlineStudentIds.has(b.id);
              if (aOnline !== bOnline) return aOnline ? -1 : 1;
              return 0;
            })
            .map((s) => {
              const readiness = currentStageKey
                ? deriveStageReadiness(course, s.id, currentStageKey)
                : null;
              const sOnline = onlineStudentIds.has(s.id);
              return (
                <li
                  className="flex items-center gap-2 rounded-[var(--radius-xs)] border border-stone-200 bg-white/70 px-2.5 py-2"
                  key={s.id}
                >
                  <Avatar name={s.name} size={28} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-stone-800">
                    {s.name}
                  </span>
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      sOnline ? "bg-[var(--pbl-success)]" : "bg-stone-300",
                    )}
                    title={sOnline ? "在线" : "离线"}
                  />
                  <span className="shrink-0 text-right text-[11px] font-bold text-stone-600">
                    {readiness ? STAGE_READINESS_LABEL[readiness.status] : "未开始"}
                  </span>
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
}

/* ============================================================
   数据面板卡
   ============================================================ */
