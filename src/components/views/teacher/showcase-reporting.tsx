"use client";

import { ShowcaseSelectionPanel } from "@/components/showcase/showcase-selection-panel";
import { CourseRubricAssessment } from "@/components/showcase/course-rubric-assessment";
import type { TeacherPresentationMode } from "@/lib/classroom/presentation";
import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Download,
  FileText,
  GripVertical,
  LoaderCircle,
  MonitorOff,
  MonitorUp,
  RotateCcw,
  Square,
  UserCheck,
} from "lucide-react";
import { ShowcaseArtifactViewer, type ShowcaseViewStatePatch } from "@/components/showcase/showcase-artifact-viewer";
import { ShowcaseDrawer, ShowcaseMaterialToolbar, showcaseStyles as styles } from "@/components/showcase/showcase-workspace-controls";
import { Card, Pill, PrimaryButton, TextInput } from "@/components/ui";
import { useShowcasePresentation } from "@/hooks/use-showcase-presentation";
import type { ShowcasePresentationController } from "@/hooks/use-showcase-presentation";
import type { Course, FinalArtifactSummary, ShowcasePresentationSnapshot } from "@/lib/session/types";
import type { ShowcaseQueueItem, ShowcaseQueueItemStatus } from "@/lib/showcase/types";
import { StageEmptyState } from "@/components/classroom/classroom-ui";
import { TeacherPresentationActions } from "@/components/classroom/teacher-presentation-actions";
import { CourseStageRequirements } from "@/components/classroom/course-stage-requirements";
import type { TeacherStageFocus } from "@/lib/classroom/teacher-dashboard-metrics";

function artifactForPresentation(presentation: ShowcasePresentationSnapshot): FinalArtifactSummary {
  return {
    kind: presentation.artifactKind,
    versionId: presentation.artifactVersionId,
    title: presentation.artifactTitle,
    sequence: 0,
    submittedAt: presentation.requestedAt,
    displayModes: presentation.artifactKind === "pdf" ? ["continuous", "slides"] : ["continuous"],
  };
}

const statusLabels: Record<ShowcaseQueueItemStatus, string> = {
  "not-ready": "成果未就绪",
  waiting: "等待汇报",
  called: "已点名",
  "pending-approval": "等待教师发起",
  presenting: "汇报中",
  evaluating: "教师点评中",
  rejected: "等待教师处理",
  completed: "已评价",
};

const statusTones: Record<ShowcaseQueueItemStatus, "gray" | "blue" | "amber" | "green" | "red" | "teal"> = {
  "not-ready": "gray",
  waiting: "gray",
  called: "blue",
  "pending-approval": "amber",
  presenting: "green",
  evaluating: "amber",
  rejected: "red",
  completed: "teal",
};

export function NewShowcaseTeacherView({ course, focus, controller, presentation = "workspace", immersive = false }: { course: Course; presentation?: TeacherPresentationMode; immersive?: boolean; focus?: Extract<TeacherStageFocus, { stageKey: "showcase" }>; controller?: ShowcasePresentationController }) {
  // The classroom shell owns the request when the right rail is visible. The
  // local hook remains as a safe fallback for standalone rendering/tests.
  const localController = useShowcasePresentation(controller ? undefined : course.id);
  const { data, loading, error, runAction, reload } = controller ?? localController;
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [note, setNote] = useState("");
  const [draggingId, setDraggingId] = useState<string>();
  const [minimized, setMinimized] = useState(false);
  const [selectedStudentId, setSelectedStudentId] = useState<string>();
  const [selectedArtifactVersionId, setSelectedArtifactVersionId] = useState<string>();
  const [selectedDisplayMode, setSelectedDisplayMode] = useState<"continuous" | "slides">("continuous");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [requirementsOpen, setRequirementsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [shortViewport, setShortViewport] = useState(false);
  const [managementTab, setManagementTab] = useState<"queue" | "evaluation">("queue");
  const [readingPositions, setReadingPositions] = useState<Record<string, ShowcaseViewStatePatch>>({});
  const [assessmentStudentId, setAssessmentStudentId] = useState("");
  const displayContext = `${course.id}:${course.currentStageIndex}`;
  const [previousContext, setPreviousContext] = useState(displayContext);
  if (previousContext !== displayContext) {
    setPreviousContext(displayContext);
    setSelectedStudentId(undefined);
    setSelectedArtifactVersionId(undefined);
    setSelectedDisplayMode("continuous");
  }
  const inlinePresentation = immersive || presentation !== "workspace";
  const [minutesDraft, setMinutesDraft] = useState(5);

  const queue = data?.queue ?? [];
  const current = data?.currentQueueItem ?? null;
  const next = data?.nextQueueItem ?? null;
  const active = data?.activePresentation ?? null;
  const evaluating = current?.status === "evaluating" && current.presentationId
    ? data?.presentations.find((presentation) => presentation.id === current.presentationId)
    : undefined;
  const requestedStudentId = selectedStudentId ?? current?.studentId;
  const selectedQueueItem = queue.find((item) => item.studentId === requestedStudentId)
    ?? (selectedStudentId ? undefined : current ?? queue[0]);
  const selectedStudent = data?.students.find((student) => student.studentId === requestedStudentId)
    ?? data?.students[0]
    ?? (selectedQueueItem ? { studentId: selectedQueueItem.studentId, name: selectedQueueItem.studentName, artifacts: selectedQueueItem.artifacts } : undefined);
  const selectedArtifact = selectedStudent?.artifacts.find((artifact) => artifact.versionId === selectedArtifactVersionId)
    ?? selectedStudent?.artifacts.find((artifact) => artifact.kind === "document" || artifact.kind === "pdf")
    ?? selectedStudent?.artifacts[0];
  const currentArtifact = current?.studentId === selectedStudent?.studentId
    ? selectedArtifact
    : current?.artifacts.find((artifact) => artifact.kind === "document" || artifact.kind === "pdf");
  const activeStudent = active ? queue.find((item) => item.studentId === active.studentId) : undefined;
  const activeArtifact = active
    ? activeStudent?.artifacts.find((artifact) => artifact.kind === active.artifactKind && artifact.versionId === active.artifactVersionId)
      ?? artifactForPresentation(active)
    : undefined;

  /* eslint-disable react-hooks/set-state-in-effect -- Keep the numeric control aligned with a server-saved queue setting. */
  useEffect(() => {
    if (data?.minutesPerStudent) setMinutesDraft(data.minutesPerStudent);
  }, [data?.minutesPerStudent]);

  useEffect(() => {
    if (focus?.studentId) setSelectedStudentId(focus.studentId);
  }, [focus?.studentId]);

  useEffect(() => {
    if (!current?.studentId) return;
    setSelectedStudentId(current.studentId);
    setSelectedArtifactVersionId(undefined);
    setSelectedDisplayMode("continuous");
  }, [current?.studentId]);
  useEffect(() => {
    if (current?.status === "evaluating") setManagementTab("evaluation");
  }, [current?.status]);
  useEffect(() => {
    const update = () => setShortViewport(window.innerHeight <= 650);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!active || minimized || inlinePresentation) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [active, minimized, inlinePresentation]);

  async function runTeacherAction(action: Parameters<typeof runAction>[0], fallback: string) {
    setBusy(true);
    setLocalError(undefined);
    try {
      await runAction(action);
      return true;
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : fallback);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function assign(item: ShowcaseQueueItem) {
    if (!item.groupId || busy || ["not-ready", "completed", "presenting", "evaluating"].includes(item.status)) return;
    await runTeacherAction({ action: "assign", groupId: item.groupId, studentId: item.studentId }, "设置汇报学生失败");
  }

  async function startQueue() {
    const first = queue.find((item) => item.status === "waiting" && item.groupId);
    if (first) await assign(first);
  }

  async function startPresentation() {
    if (!current || !currentArtifact || currentArtifact.kind === "file" || busy || active) return;
    await runTeacherAction({
      action: "start",
      studentId: current.studentId,
      artifactKind: currentArtifact.kind,
      artifactVersionId: currentArtifact.versionId,
      displayMode: currentArtifact.kind === "pdf" && current.studentId === selectedStudent?.studentId ? selectedDisplayMode : "continuous",
    }, "发起汇报投屏失败");
  }

  async function finishEvaluation() {
    if (!evaluating || !current?.presentationId) return;
    const succeeded = await runTeacherAction({ action: "finish-evaluation", presentationId: current.presentationId, note: note.trim() || undefined }, "结束评价失败");
    if (succeeded) setNote("");
  }

  async function stopPresentation() {
    if (!active || busy) return;
    await runTeacherAction({ action: "end", presentationId: active.id }, "停止投屏失败");
  }

  async function saveOrder(orderedStudentIds: string[], minutes = minutesDraft) {
    await runTeacherAction({ action: "save-queue", orderedStudentIds, minutesPerStudent: Math.min(60, Math.max(1, Math.ceil(minutes))), ...(data?.queueConfig?.schemaVersion === 2 ? { selectionMode: "teacher-selected" as const, selectedStudentIds: data.queueConfig.selectedStudentIds, presentationSec: data.queueConfig.presentationSec, discussionSec: data.queueConfig.discussionSec, transitionSec: data.queueConfig.transitionSec } : {}) }, "保存汇报顺序失败");
  }

  function isLocked(item: ShowcaseQueueItem | undefined): boolean {
    return Boolean(item && ["called", "pending-approval", "presenting", "evaluating", "rejected", "completed"].includes(item.status));
  }

  function reorder(fromId: string, toId: string) {
    if (fromId === toId) return;
    const fromItem = queue.find((item) => item.studentId === fromId);
    const toItem = queue.find((item) => item.studentId === toId);
    if (isLocked(fromItem) || isLocked(toItem)) return;
    const from = queue.findIndex((item) => item.studentId === fromId);
    const to = queue.findIndex((item) => item.studentId === toId);
    if (from < 0 || to < 0) return;
    const nextOrder = [...queue];
    const [moved] = nextOrder.splice(from, 1);
    if (!moved) return;
    nextOrder.splice(to, 0, moved);
    void saveOrder(nextOrder.map((item) => item.studentId));
  }

  function moveItem(item: ShowcaseQueueItem, delta: -1 | 1) {
    const index = queue.findIndex((candidate) => candidate.studentId === item.studentId);
    const target = queue[index + delta];
    if (!target || isLocked(item) || isLocked(target)) return;
    reorder(item.studentId, target.studentId);
  }

  if (loading && !data) {
    return <><TeacherPresentationActions><button disabled type="button"><LoaderCircle className="animate-spin" size={18} />正在读取汇报状态</button></TeacherPresentationActions><Card className="grid min-h-56 place-items-center"><span className="inline-flex items-center gap-2 text-sm text-stone-500"><LoaderCircle className="animate-spin" size={18} />正在读取汇报状态…</span></Card></>;
  }

  const hasPendingWork = queue.some((item) => ["waiting", "called", "pending-approval", "presenting", "evaluating", "rejected"].includes(item.status));
  const stageStatus = active ? "汇报中" : current?.status === "evaluating" ? "教师点评中" : current ? "等待教师投屏" : hasPendingWork ? "等待开始" : queue.some((item) => item.status === "completed") ? "汇报已完成" : "暂无成果";
  const projectArtifact = Boolean(immersive && active && activeArtifact && !minimized);
  const viewingCurrent = Boolean(current && selectedStudent?.studentId === current.studentId);
  const projectedName = currentArtifact?.title ?? current?.primaryArtifactTitle ?? "暂无可投屏成果";

  function flowAction() {
    return active ? <button data-tone="danger" disabled={busy} onClick={() => void stopPresentation()} type="button"><Square size={18} />结束汇报</button>
      : evaluating ? <button data-tone="primary" disabled={busy} onClick={() => void finishEvaluation()} type="button"><Check size={18} />结束点评并点名下一位</button>
      : current && currentArtifact?.kind !== "file" && currentArtifact ? <button data-tone="primary" disabled={busy} onClick={() => void startPresentation()} type="button"><MonitorUp size={18} />教师发起投屏</button>
      : current ? <button disabled type="button">请选择可投屏材料</button>
      : queue.some((item) => item.status === "waiting" && item.groupId) ? <button data-tone="primary" disabled={busy} onClick={() => void startQueue()} type="button"><UserCheck size={18} />开始汇报</button>
      : <button disabled type="button">暂无待汇报成果</button>;
  }

  const queuePanel = <>
    <div className="flex items-center justify-between gap-2"><h2 className="font-bold">汇报队列</h2><button className={styles.toolbarButton} onClick={() => setSettingsOpen(true)} type="button">名单与时间设置</button></div>
    <p className="mt-1 text-xs text-[var(--pbl-text-muted)]">选择学生查看材料；点名使用独立操作。</p>
    <div className={`${styles.queueList} mt-3 space-y-1.5 pr-1`}>
      {queue.length ? queue.map((item, index) => {
        const locked = isLocked(item);
        const isCurrent = current?.studentId === item.studentId;
        const isNext = next?.studentId === item.studentId;
        return <article className={`rounded-[var(--radius-sm)] border ${isCurrent ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)]/70" : isNext ? "border-amber-300 bg-amber-50/60" : "border-[var(--pbl-border)] bg-white"}`} draggable={!locked} key={item.studentId} onDragEnd={() => setDraggingId(undefined)} onDragOver={(event) => event.preventDefault()} onDragStart={() => setDraggingId(item.studentId)} onDrop={() => { if (draggingId) reorder(draggingId, item.studentId); setDraggingId(undefined); }}>
          <div className="flex items-center gap-2 px-2.5 py-2"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-white text-[11px] font-bold">{index + 1}</span><button className="min-w-0 flex-1 text-left" onClick={() => { setSelectedStudentId(item.studentId); setSelectedArtifactVersionId(undefined); setSelectedDisplayMode("continuous"); if (projectArtifact) setMinimized(true); }} type="button"><strong className="block truncate text-sm">{item.studentName}</strong><span className="block truncate text-xs text-[var(--pbl-text-muted)]">{item.primaryArtifactTitle ?? "暂无可投屏成果"}</span></button>{!locked ? <GripVertical aria-hidden="true" className="shrink-0 text-stone-400" size={15} /> : null}<Pill size="sm" tone={statusTones[item.status]}>{statusLabels[item.status]}</Pill></div>
          <div className="flex items-center justify-between border-t border-[var(--pbl-border)] px-2.5 text-[11px] text-[var(--pbl-text-muted)]"><span>{item.estimatedWaitMinutes === undefined ? "—" : item.estimatedWaitMinutes === 0 ? "即将轮到" : `约 ${item.estimatedWaitMinutes} 分钟后`}</span><div className="flex items-center"><button aria-label={`${item.studentName}上移`} className="grid size-11 place-items-center disabled:opacity-30" disabled={locked || index === 0 || isLocked(queue[index - 1])} onClick={() => moveItem(item, -1)} type="button"><ArrowUp size={14} /></button><button aria-label={`${item.studentName}下移`} className="grid size-11 place-items-center disabled:opacity-30" disabled={locked || index === queue.length - 1 || isLocked(queue[index + 1])} onClick={() => moveItem(item, 1)} type="button"><ArrowDown size={14} /></button>{item.status === "waiting" && item.groupId ? <PrimaryButton className="min-h-11" disabled={busy || Boolean(current)} onClick={() => void assign(item)} size="sm" tone="blue">设为当前</PrimaryButton> : null}</div></div>
        </article>;
      }) : <StageEmptyState description={data?.queueConfig?.schemaVersion === 2 ? "学生提交作品后，教师勾选现场汇报者并保存名单。" : "学生提交可投屏成果后将生成队列。"} title="暂无汇报队列" />}
    </div>
  </>;
  const evaluationPanel = <div className="space-y-3">
    {current?.status === "evaluating" && evaluating ? <div className="rounded-[var(--radius-sm)] bg-amber-50 p-3"><h2 className="text-sm font-bold text-amber-900">教师现场点评 · {current.studentName}</h2><p className="mt-1 text-xs text-amber-800">点评文字可选；结束后自动点名下一位。</p><TextInput aria-label="课堂点评记录（可选）" className="mt-2 bg-white" maxLength={2_000} onChange={(event) => setNote(event.target.value)} placeholder="记录亮点或需要关注的内容" value={note} /></div> : null}
    {course.content.stagePlan?.evaluationRubric ? <><label className="block text-sm font-semibold">个人成果评价<select aria-label="选择评分学生" className="mt-2 min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 text-sm" value={assessmentStudentId} onChange={(event) => setAssessmentStudentId(event.target.value)}><option value="">选择学生（含未现场汇报者）</option>{course.students.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}</select></label>{assessmentStudentId ? <CourseRubricAssessment course={course} studentId={assessmentStudentId} /> : null}</> : <p className="text-sm text-[var(--pbl-text-muted)]">本阶段未配置个人成果评分表。</p>}
  </div>;
  const managementPanel = <><div className="flex border-b border-[var(--pbl-border)]"><button aria-selected={managementTab === "queue"} className={`min-h-11 flex-1 text-sm font-semibold ${managementTab === "queue" ? "border-b-2 border-[var(--pbl-teacher)] text-[var(--pbl-teacher)]" : "text-[var(--pbl-text-muted)]"}`} onClick={() => setManagementTab("queue")} role="tab" type="button">汇报队列</button><button aria-selected={managementTab === "evaluation"} className={`min-h-11 flex-1 text-sm font-semibold ${managementTab === "evaluation" ? "border-b-2 border-[var(--pbl-teacher)] text-[var(--pbl-teacher)]" : "text-[var(--pbl-text-muted)]"}`} onClick={() => setManagementTab("evaluation")} role="tab" type="button">评价</button></div><div className={`${styles.managementBody} p-3`}>{managementTab === "queue" ? queuePanel : evaluationPanel}</div></>;
  const activeProjection = active && activeArtifact && !minimized ? <TeacherPresentationOverlay inline={inlinePresentation} artifact={activeArtifact} courseId={course.id} initialViewState={readingPositions[`projection:${active.id}`]} onViewStateChange={(patch) => { setReadingPositions((old) => ({ ...old, [`projection:${active.id}`]: { ...old[`projection:${active.id}`], ...patch } })); }} onEnd={() => void stopPresentation()} onMinimize={() => setMinimized(true)} presentation={active} studentName={active.studentName ?? activeStudent?.studentName} /> : null;

  return <div className={`classroom-stage teacher-presentation-content ${projectArtifact ? "flex h-full min-h-0 flex-col" : ""}`} hidden={presentation === "analytics"}>
    <TeacherPresentationActions>{flowAction()}{localError || error ? <span className="text-sm text-rose-700" role="alert">{localError ?? error}</span> : null}</TeacherPresentationActions>
    <div className={`${styles.workspace} ${immersive ? styles.immersiveWorkspace : ""}`} hidden={projectArtifact}>
      <header className={styles.header}><div className={styles.headerTitle}><h1 className={`text-xl font-bold ${immersive ? "sr-only" : ""}`}>成果汇报与评价</h1><Pill size="sm" tone={active ? "green" : current ? "amber" : "gray"}>{stageStatus}</Pill><span className="min-w-0 truncate text-xs text-[var(--pbl-text-muted)]">当前：{current?.studentName ?? "尚未点名"} · 下一位：{next?.studentName ?? "待安排"}</span></div><div className={styles.headerActions}>{!immersive && shortViewport ? <div className={styles.flowAction} title={`操作对象：${current?.studentName ?? "尚未点名"} · ${projectedName}`}>{flowAction()}</div> : null}<button className={styles.toolbarButton} onClick={() => setRequirementsOpen(true)} type="button">教案要求</button><button className={styles.toolbarButton} onClick={() => setMoreOpen(true)} type="button">更多</button></div></header>
      {error || localError ? <div className="mt-2 flex items-center gap-2 rounded-[var(--radius-sm)] bg-rose-50 p-2 text-sm text-rose-700" role="alert">{localError ?? error}<button className="underline" onClick={() => { setLocalError(undefined); void reload(); }} type="button">重试</button></div> : null}
      <div className={`${styles.layout} ${styles.teacherLayout} ${immersive ? styles.immersiveLayout : ""}`}>
        <main className={`${styles.main} ${immersive ? styles.immersiveMain : ""}`}>
          <ShowcaseMaterialToolbar artifacts={selectedStudent?.artifacts ?? []} displayMode={selectedDisplayMode} onDisplayModeChange={setSelectedDisplayMode} onSelect={(item) => { setSelectedArtifactVersionId(item.versionId); setSelectedDisplayMode("continuous"); }} selected={selectedArtifact} tone="teacher"><select aria-label="选择查看材料的学生" className={styles.toolbarButton} onChange={(event) => { setSelectedStudentId(event.target.value); setSelectedArtifactVersionId(undefined); setSelectedDisplayMode("continuous"); }} value={selectedStudent?.studentId ?? ""}>{data?.students.length ? data.students.map((student) => <option key={student.studentId} value={student.studentId}>{student.name} · {student.artifacts.length} 份</option>) : selectedStudent ? <option value={selectedStudent.studentId}>{selectedStudent.name} · {selectedStudent.artifacts.length} 份</option> : <option value="">暂无学生</option>}</select>{selectedQueueItem ? <Pill size="sm" tone={statusTones[selectedQueueItem.status]}>{statusLabels[selectedQueueItem.status]}</Pill> : null}</ShowcaseMaterialToolbar>
          {!viewingCurrent && current ? <div className="flex items-center justify-between gap-2 border-b border-[var(--pbl-border)] bg-amber-50 px-3 py-1 text-xs"><span>当前汇报者：{current.studentName}；正在查看其他学生的材料</span><button className="min-h-11 font-semibold underline" onClick={() => { setSelectedStudentId(current.studentId); setSelectedArtifactVersionId(undefined); }} type="button">返回当前汇报</button></div> : null}
          <div className={`${styles.preview} ${styles.teacherPreview} ${immersive ? styles.immersivePreview : ""} ${selectedArtifact?.kind === "pdf" && selectedDisplayMode === "slides" ? styles.slidesPreview : ""}`}>
            {!selectedStudent?.artifacts.length ? <StageEmptyState className="h-full border-0" description="选择已上传材料的学生即可预览。" title="该学生尚未上传项目材料" /> : selectedArtifact?.kind === "file" ? <div className="grid h-full place-items-center p-6 text-center"><div><FileText className="mx-auto text-stone-400" size={30} /><p className="mt-2 text-sm font-semibold">此材料暂不支持在线预览</p><p className="mt-1 text-xs text-[var(--pbl-text-muted)]">可下载查看；课堂投屏请选择主文档或 PDF。</p>{selectedArtifact.downloadUrl ? <a className={`${styles.toolbarButton} mt-3`} download href={selectedArtifact.downloadUrl}><Download size={15} />下载资料</a> : null}</div></div> : selectedArtifact ? <ShowcaseArtifactViewer artifact={selectedArtifact} courseId={course.id} displayMode={selectedArtifact.kind === "pdf" ? selectedDisplayMode : "continuous"} initialViewState={readingPositions[selectedArtifact.versionId]} key={`${selectedStudent.studentId}:${selectedArtifact.versionId}`} mode="self" onViewStateChange={(patch) => { setReadingPositions((old) => ({ ...old, [selectedArtifact.versionId]: { ...old[selectedArtifact.versionId], ...patch } })); }} /> : null}
          </div>
          {!immersive && !shortViewport ? <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 border-t border-[var(--pbl-border)] px-3 py-2 text-xs"><span className="min-w-0 truncate">操作对象：{current?.studentName ?? "尚未点名"} · {projectedName}{currentArtifact?.kind === "file" ? " · 此格式仅支持下载" : ""}</span><div className={styles.flowAction}>{flowAction()}</div></div> : null}
        </main>
        {!projectArtifact ? <aside className={`${styles.aside} ${immersive ? styles.immersiveAside : ""}`} data-testid="teacher-showcase-management">{managementPanel}</aside> : null}
      </div>
    </div>
    {projectArtifact ? <div className={`${styles.workspace} ${styles.projectedWorkspace}`}><div className={`${styles.layout} ${styles.teacherLayout} ${styles.projectedLayout}`}>{activeProjection}<aside className={`${styles.aside} ${styles.immersiveAside}`} data-testid="teacher-showcase-management">{managementPanel}</aside></div></div> : activeProjection}
    {active && activeArtifact && minimized ? <button aria-label="恢复汇报投屏" className={`${inlinePresentation ? "relative mt-3" : "fixed bottom-5 right-5 z-[181]"} flex min-h-11 items-center gap-2 rounded-full bg-stone-900 px-4 py-3 text-sm font-semibold text-white shadow-xl`} onClick={() => setMinimized(false)} type="button"><MonitorUp size={16} />恢复“{active.artifactTitle}”</button> : null}
    {settingsOpen ? <ShowcaseDrawer onClose={() => setSettingsOpen(false)} title="名单与时间设置">{data?.queueConfig?.schemaVersion === 2 ? <ShowcaseSelectionPanel key={data.queueConfig.updatedAt} data={data} busy={busy} save={async (action) => { await runTeacherAction(action, "保存汇报名单失败"); }} /> : <div className="flex items-center gap-2 text-sm"><label htmlFor="showcase-minutes">每人预计分钟数</label><input aria-label="每人预计汇报分钟数" className="h-11 w-16 rounded border px-2 text-center" id="showcase-minutes" max={60} min={1} onChange={(event) => setMinutesDraft(Math.min(60, Math.max(1, Number(event.target.value) || 1)))} onBlur={() => { if (minutesDraft !== data?.minutesPerStudent) void saveOrder(queue.map((item) => item.studentId), minutesDraft); }} type="number" value={minutesDraft} /><button aria-label="恢复按成果提交顺序" className={styles.toolbarButton} onClick={() => void saveOrder([], minutesDraft)} type="button"><RotateCcw size={15} /></button></div>}</ShowcaseDrawer> : null}
    {requirementsOpen ? <ShowcaseDrawer onClose={() => setRequirementsOpen(false)} title="教案要求"><CourseStageRequirements course={course} stageKey="showcase" teacher expanded /></ShowcaseDrawer> : null}
    {moreOpen ? <ShowcaseDrawer onClose={() => setMoreOpen(false)} title="更多操作"><a className={styles.toolbarButton} download href={`/api/courses/${encodeURIComponent(course.id)}/showcase/artifacts/export`}><Download size={15} />下载全班成果</a></ShowcaseDrawer> : null}
  </div>;
}

function TeacherPresentationOverlay({ artifact, inline = false, courseId, onEnd, onMinimize, presentation, studentName, initialViewState, onViewStateChange }: {
  artifact: FinalArtifactSummary; inline?: boolean; courseId: string; onEnd: () => void; onMinimize: () => void;
  presentation: ShowcasePresentationSnapshot; studentName?: string; initialViewState?: ShowcaseViewStatePatch;
  onViewStateChange: (patch: ShowcaseViewStatePatch) => void;
}) {
  return <div className={inline ? "teacher-presentation-showcase flex min-h-0 flex-1 flex-col bg-white" : "fixed inset-0 z-[180] flex flex-col bg-slate-950/75 p-2 sm:p-4"} role="presentation">
    <section aria-label={artifact.title} aria-modal={inline ? undefined : true} className={`mx-auto flex h-full w-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--pbl-surface)] ${inline ? "" : "max-w-[1500px] rounded-[var(--radius-lg)] shadow-2xl"}`} role={inline ? "region" : "dialog"}>
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-[var(--pbl-border)] bg-white px-3 text-sm"><strong className="shrink-0 text-[var(--pbl-teacher)]">{studentName ?? "学生"}</strong><span className="min-w-0 flex-1 truncate font-semibold">{artifact.title}</span><span className="hidden text-xs text-[var(--pbl-text-muted)] sm:inline">{presentation.displayMode === "slides" ? "逐页演示" : "连续阅读"}</span><PrimaryButton className="min-h-11" onClick={onMinimize} size="sm" tone="slate" variant="outline"><MonitorOff size={14} />最小化</PrimaryButton>{!inline ? <PrimaryButton className="min-h-11" onClick={onEnd} size="sm" tone="red" variant="outline"><Square size={14} />结束汇报</PrimaryButton> : null}</header>
      <div className="min-h-0 flex-1"><ShowcaseArtifactViewer artifact={artifact} courseId={courseId} initialViewState={initialViewState} key={artifact.versionId} mode="controller" onViewStateChange={onViewStateChange} presentation={presentation} /></div>
    </section>
  </div>;
}
