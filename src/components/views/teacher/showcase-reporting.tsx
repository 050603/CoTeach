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
import { ShowcaseArtifactViewer } from "@/components/showcase/showcase-artifact-viewer";
import { Card, Pill, PrimaryButton, TextInput } from "@/components/ui";
import { useShowcasePresentation } from "@/hooks/use-showcase-presentation";
import type { ShowcasePresentationController } from "@/hooks/use-showcase-presentation";
import type { Course, FinalArtifactSummary, ShowcasePresentationSnapshot } from "@/lib/session/types";
import type { ShowcaseQueueItem, ShowcaseQueueItemStatus } from "@/lib/showcase/types";
import { StageEmptyState, StagePageHeader, StageSplitLayout } from "@/components/classroom/classroom-ui";
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

function artifactLabel(artifact: FinalArtifactSummary): string {
  if (artifact.kind === "document") return "Word 文档";
  if (artifact.kind === "pdf") return "PDF 成果";
  return "额外成果";
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
  const [showQueue, setShowQueue] = useState(false);
  const [assessmentStudentId, setAssessmentStudentId] = useState("");
  const displayContext = `${course.id}:${course.currentStageIndex}:${presentation}`;
  const [previousPresentation, setPreviousPresentation] = useState(displayContext);
  if (previousPresentation !== displayContext) {
    setPreviousPresentation(displayContext);
    setSelectedStudentId(undefined);
    setSelectedArtifactVersionId(undefined);
    setSelectedDisplayMode("continuous");
    setShowQueue(false);
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
    if (presentation === "workspace" && focus?.studentId) setSelectedStudentId(focus.studentId);
  }, [focus?.studentId, presentation]);

  useEffect(() => {
    if (!current?.studentId) return;
    setSelectedStudentId(current.studentId);
    setSelectedArtifactVersionId(undefined);
    setSelectedDisplayMode("continuous");
  }, [current?.studentId]);
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

  const projectArtifact = presentation === "teaching" && Boolean(active && activeArtifact) && !minimized;

  return (
    <div className={`classroom-stage teacher-presentation-content ${projectArtifact ? "flex min-h-0 flex-col overflow-auto" : "space-y-5"}`} hidden={presentation === "analytics"}>
      <TeacherPresentationActions>
        {active ? <button data-tone="danger" disabled={busy} onClick={() => void stopPresentation()} type="button"><Square size={18} />结束汇报</button>
          : evaluating ? <button data-tone="primary" disabled={busy} onClick={() => void finishEvaluation()} type="button"><Check size={18} />结束点评并点名下一位</button>
          : current && currentArtifact && currentArtifact.kind !== "file" ? <button data-tone="primary" disabled={busy} onClick={() => void startPresentation()} type="button"><MonitorUp size={18} />教师发起投屏</button>
          : current ? <button disabled type="button">{current.status === "completed" ? "汇报已完成" : "请选择可投屏材料"}</button>
          : queue.some((item) => item.status === "waiting" && item.groupId) ? <button data-tone="primary" disabled={busy} onClick={() => void startQueue()} type="button"><UserCheck size={18} />开始汇报</button>
          : <button disabled type="button">暂无待汇报成果</button>}
        {(localError || error) ? <span className="text-sm text-rose-700" role="alert">{localError ?? error}</span> : null}
      </TeacherPresentationActions>
      <div hidden={projectArtifact}>
      <StagePageHeader
        action={<div className="flex flex-wrap gap-2"><a className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--pbl-teacher)] bg-white px-3.5 text-[13px] font-semibold text-[var(--pbl-teacher)] transition hover:bg-[var(--pbl-teacher-soft)]" download href={`/api/courses/${encodeURIComponent(course.id)}/showcase/artifacts/export`}><Download size={14} />下载全班成果</a>{!current && queue.some((item) => item.status === "waiting" && item.groupId) ? <PrimaryButton disabled={busy} onClick={() => void startQueue()} tone="blue"><UserCheck size={14} />按提交顺序开始</PrimaryButton> : null}</div>}
        description="教师查看每位学生上传的项目材料；轮到该生时，由教师端打开材料并发起投屏，学生到讲台操作教师机演示。"
        status={<Pill tone={active || current?.status === "completed" ? "green" : current ? "amber" : "gray"}>{stageStatus}</Pill>}
        title="成果汇报与评价"
      />
      <CourseStageRequirements course={course} stageKey="showcase" teacher={presentation === "workspace"} expanded={presentation === "teaching"} />
      {presentation === "workspace" && course.content.stagePlan?.evaluationRubric && <section className="mt-4 space-y-3">
        <label className="flex flex-wrap items-center gap-3 text-sm font-semibold">个人成果评价
          <select aria-label="选择评分学生" className="min-h-11 rounded-lg border border-stone-300 bg-white px-3" value={assessmentStudentId} onChange={(event) => setAssessmentStudentId(event.target.value)}>
            <option value="">选择学生（包含未入选现场汇报者）</option>
            {course.students.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}
          </select>
        </label>
        {assessmentStudentId && <CourseRubricAssessment course={course} studentId={assessmentStudentId} />}
      </section>}
      </div>

      {(error || localError) ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert"><span>{localError ?? error}</span><button aria-label="重试读取汇报状态" className="inline-flex min-h-11 items-center rounded-[var(--radius-xs)] border border-rose-300 px-3 font-semibold text-rose-800 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700" onClick={() => { setLocalError(undefined); void reload(); }} type="button">重试</button></div> : null}

      {presentation === "teaching" && !projectArtifact ? <button aria-expanded={showQueue} className="min-h-11 rounded-lg border border-blue-300 bg-white px-4 py-2 text-xl font-semibold text-blue-800" onClick={() => setShowQueue((value) => !value)} type="button">{showQueue ? "收起汇报队列" : "查看汇报队列与成果"}</button> : null}
      <div hidden={projectArtifact}>
      <StageSplitLayout
        className={presentation !== "workspace" && !showQueue ? "!grid-cols-1" : undefined}
        asideClassName={presentation !== "workspace" && !showQueue ? "hidden" : undefined}
        aside={presentation === "workspace" || showQueue ? (
          <Card className="classroom-panel" compact>
            <div className="flex items-start justify-between gap-3"><div><h2 className="font-bold text-[var(--pbl-text-strong)]">汇报队列</h2><p className="mt-1 text-xs text-[var(--pbl-text-muted)]">拖动或使用箭头调整尚未开始的学生。</p></div><Pill size="sm" tone="blue">按队列推进</Pill></div>
            {data?.queueConfig?.schemaVersion === 2 ? <ShowcaseSelectionPanel key={data.queueConfig.updatedAt} data={data} busy={busy} save={async (action) => { await runTeacherAction(action, "保存汇报名单失败"); }} /> : <div className="mt-3 flex items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--pbl-surface-soft)] px-3 py-2"><label className="flex flex-1 items-center gap-2 text-xs font-semibold text-[var(--pbl-text-muted)]" htmlFor="showcase-minutes">每人预计</label><input aria-label="每人预计汇报分钟数" className="h-11 w-16 rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-white px-2 text-center text-sm font-semibold" id="showcase-minutes" max={60} min={1} onChange={(event) => setMinutesDraft(Math.min(60, Math.max(1, Number(event.target.value) || 1)))} onBlur={() => { if (minutesDraft !== data?.minutesPerStudent) void saveOrder(queue.map((item) => item.studentId), minutesDraft); }} type="number" value={minutesDraft} /><span className="text-xs text-[var(--pbl-text-muted)]">分钟</span><button aria-label="恢复按成果提交顺序" className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-xs)] text-[var(--pbl-text-muted)] hover:bg-white hover:text-[var(--pbl-teacher)]" onClick={() => void saveOrder([], minutesDraft)} title="恢复按成果提交顺序" type="button"><RotateCcw size={15} /></button></div>}
            <div className="mt-3 max-h-[44rem] space-y-1.5 overflow-y-auto pr-1" onDragOver={(event) => event.preventDefault()}>
              {queue.length ? queue.map((item, index) => {
                const locked = isLocked(item);
                const isCurrent = current?.studentId === item.studentId;
                const isNext = next?.studentId === item.studentId;
                return (
                  <article
                    className={`rounded-[var(--radius-sm)] border transition ${isCurrent ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)]/70" : isNext ? "border-amber-300 bg-amber-50/60" : "border-[var(--pbl-border)] bg-white"}`}
                    draggable={!locked}
                    key={item.studentId}
                    onDragEnd={() => setDraggingId(undefined)}
                    onDragOver={(event) => event.preventDefault()}
                    onDragStart={() => setDraggingId(item.studentId)}
                    onDrop={() => { if (draggingId) reorder(draggingId, item.studentId); setDraggingId(undefined); }}
                  >
                    <div className="flex items-center gap-2 px-2.5 py-2">
                      <span className={`grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-bold ${isCurrent ? "bg-[var(--pbl-teacher)] text-white" : "bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-muted)]"}`}>{index + 1}</span>
                      <button className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pbl-teacher)]" onClick={() => { setSelectedStudentId(item.studentId); setSelectedArtifactVersionId(undefined); setSelectedDisplayMode("continuous"); }} type="button"><strong className="block truncate text-sm text-[var(--pbl-text-strong)]">{item.studentName}</strong><span className="mt-0.5 block truncate text-[11px] text-[var(--pbl-text-muted)]">{item.primaryArtifactTitle ?? "暂无可投屏成果"}</span></button>
                      {!locked ? <GripVertical aria-hidden="true" className="shrink-0 text-stone-400" size={15} /> : null}
                      <Pill size="sm" tone={statusTones[item.status]}>{statusLabels[item.status]}</Pill>
                    </div>
                    <div className="flex items-center justify-between gap-2 border-t border-[var(--pbl-border)]/70 px-2.5 py-1.5 text-[11px] text-[var(--pbl-text-muted)]"><span>{item.estimatedWaitMinutes === undefined ? "—" : item.estimatedWaitMinutes === 0 ? "即将轮到" : `约 ${item.estimatedWaitMinutes} 分钟后`}</span><span className="flex items-center gap-1"><button aria-label={`${item.studentName}上移`} className="grid size-11 place-items-center rounded hover:bg-[var(--pbl-surface-soft)] disabled:opacity-30" disabled={locked || index === 0 || isLocked(queue[index - 1])} onClick={() => moveItem(item, -1)} type="button"><ArrowUp size={13} /></button><button aria-label={`${item.studentName}下移`} className="grid size-11 place-items-center rounded hover:bg-[var(--pbl-surface-soft)] disabled:opacity-30" disabled={locked || index === queue.length - 1 || isLocked(queue[index + 1])} onClick={() => moveItem(item, 1)} type="button"><ArrowDown size={13} /></button>{item.status === "waiting" && item.groupId ? <PrimaryButton disabled={busy || Boolean(current)} onClick={() => void assign(item)} tone="blue">设为当前</PrimaryButton> : null}</span></div>
                  </article>
                );
              }) : <StageEmptyState description={data?.queueConfig?.schemaVersion === 2 ? "学生均需提交作品；教师勾选现场汇报者并保存后生成队列。" : "学生加入课堂并提交可投屏成果后，队列会自动生成。"} title="暂无汇报队列" />}
            </div>
          </Card>
        ) : null}
        main={(
          <div className="space-y-4">
            <Card className="classroom-panel border-[var(--pbl-teacher-border)]" compact>
              <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="classroom-eyebrow text-[var(--pbl-teacher)]">当前汇报</p><h2 className="mt-1 text-xl font-bold text-[var(--pbl-text-strong)]">{current ? current.studentName : "尚未点名"}</h2><p className="mt-1 text-sm text-[var(--pbl-text-muted)]">{current?.primaryArtifactTitle ?? "教师可按成果提交顺序开始课堂汇报"}</p></div><Pill tone={current ? statusTones[current.status] : "gray"}>{current ? statusLabels[current.status] : "等待开始"}</Pill></div>
              {current ? <div className="mt-4 grid gap-3 rounded-[var(--radius-sm)] bg-[var(--pbl-surface-soft)] p-3 text-sm sm:grid-cols-[1fr_auto]"><div><p className="font-semibold text-[var(--pbl-text-strong)]">{current.status === "presenting" ? "教师端正在投屏，汇报学生可在教师机操作演示" : current.status === "evaluating" ? "请完成课堂点评，再点名下一位" : current.status === "completed" ? "该学生已完成评价" : "请在下方查看并选择该生材料，然后由教师端发起投屏"}</p><p className="mt-1 text-xs text-[var(--pbl-text-muted)]">下一位：{next?.studentName ?? "暂无可投屏学生"}{next?.estimatedWaitMinutes ? ` · 约 ${next.estimatedWaitMinutes} 分钟后` : ""}</p></div>{!["presenting", "evaluating", "completed"].includes(current.status) && currentArtifact?.kind !== "file" ? <PrimaryButton disabled={busy} onClick={() => void startPresentation()} size="sm" tone="green"><MonitorUp size={14} />教师发起投屏</PrimaryButton> : null}</div> : <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-dashed border-[var(--pbl-border)] p-4"><p className="text-sm text-[var(--pbl-text-muted)]">下一步：按成果提交顺序点名，教师检查该生材料后直接发起投屏。</p>{queue.some((item) => item.status === "waiting" && item.groupId) ? <PrimaryButton disabled={busy} onClick={() => void startQueue()} size="sm" tone="blue"><UserCheck size={14} />开始汇报流程</PrimaryButton> : null}</div>}
              {current?.status === "evaluating" && evaluating ? <div className="mt-4 rounded-[var(--radius-sm)] border border-amber-200 bg-amber-50 p-4"><div className="flex items-center gap-2 text-sm font-semibold text-amber-900"><MonitorUp size={16} />教师现场点评</div><p className="mt-1 text-xs leading-5 text-amber-800">可记录课堂口头点评，文本不是必填；结束评价后系统会自动点名下一位。</p><TextInput aria-label="课堂点评记录（可选）" className="mt-3 bg-white" maxLength={2_000} onChange={(event) => setNote(event.target.value)} placeholder="记录亮点、追问或需要后续关注的内容（可选）" value={note} /><PrimaryButton className="mt-3" disabled={busy} onClick={() => void finishEvaluation()} size="sm" tone="blue"><Check size={14} />结束评价并点名下一位</PrimaryButton></div> : null}
            </Card>

            {presentation === "workspace" || showQueue ? <Card className="classroom-panel" compact>
              <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="classroom-eyebrow text-[var(--pbl-teacher)]">学生材料预览</p><h2 className="mt-1 font-bold text-[var(--pbl-text-strong)]">{selectedStudent?.name ?? "选择一名学生"}</h2><p className="mt-1 text-xs text-[var(--pbl-text-muted)]">查看每位学生上传的全部项目材料，并为当前汇报选择投屏内容。</p></div><div className="flex flex-wrap items-center gap-2">{data?.students.length ? <select aria-label="选择查看材料的学生" className="min-h-10 rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-white px-3 text-sm font-semibold" onChange={(event) => { setSelectedStudentId(event.target.value); setSelectedArtifactVersionId(undefined); setSelectedDisplayMode("continuous"); }} value={selectedStudent?.studentId ?? ""}>{data.students.map((student) => <option key={student.studentId} value={student.studentId}>{student.name} · {student.artifacts.length} 份</option>)}</select> : null}{selectedQueueItem ? <Pill size="sm" tone={statusTones[selectedQueueItem.status]}>{statusLabels[selectedQueueItem.status]}</Pill> : selectedStudent ? <Pill size="sm" tone={selectedStudent.artifacts.length ? "blue" : "gray"}>{selectedStudent.artifacts.length ? "已上传" : "未上传"}</Pill> : null}</div></div>
              {selectedStudent?.artifacts.length ? <>
                <div aria-label="选择学生汇报材料" className="mt-3 flex gap-1 overflow-x-auto border-b border-[var(--pbl-border)]" role="tablist">{selectedStudent.artifacts.map((artifact) => {
                  const chosen = selectedArtifact?.versionId === artifact.versionId;
                  return <button aria-selected={chosen} className={`min-h-11 min-w-[10rem] max-w-[16rem] shrink-0 border-b-2 px-3 py-2 text-left ${chosen ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-text-strong)]" : "border-transparent text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)]"}`} key={artifact.versionId} onClick={() => { setSelectedArtifactVersionId(artifact.versionId); setSelectedDisplayMode("continuous"); }} role="tab" type="button"><span className="block truncate text-[11px] font-semibold">{artifactLabel(artifact)} · 第 {artifact.sequence} 版</span><strong className="mt-0.5 block truncate text-sm">{artifact.title}</strong></button>;
                })}</div>
                {selectedArtifact ? <div className="mt-3 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--pbl-border)] bg-[var(--pbl-surface-soft)]">
                  <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 border-b border-[var(--pbl-border)] bg-white px-3 py-2"><div className="min-w-0"><strong className="block truncate text-sm text-[var(--pbl-text-strong)]">{selectedArtifact.title}</strong><span className="text-xs text-[var(--pbl-text-muted)]">{selectedArtifact.kind === "file" ? "该格式仅支持下载" : "可在教师端预览和投屏"}</span></div><div className="flex flex-wrap items-center gap-2">{selectedArtifact.kind === "pdf" ? <div aria-label="PDF 投屏方式" className="inline-flex rounded-[var(--radius-xs)] border border-[var(--pbl-border)] p-0.5 text-xs font-semibold"><button aria-pressed={selectedDisplayMode === "continuous"} className={`min-h-9 rounded px-2.5 ${selectedDisplayMode === "continuous" ? "bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]" : "text-[var(--pbl-text-muted)]"}`} onClick={() => setSelectedDisplayMode("continuous")} type="button">连续阅读</button><button aria-pressed={selectedDisplayMode === "slides"} className={`min-h-9 rounded px-2.5 ${selectedDisplayMode === "slides" ? "bg-[var(--pbl-teacher)] text-white" : "text-[var(--pbl-text-muted)]"}`} onClick={() => setSelectedDisplayMode("slides")} type="button">逐页演示</button></div> : null}{selectedArtifact.downloadUrl ? <a className="inline-flex min-h-9 items-center gap-1 rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-white px-3 text-xs font-semibold" download href={selectedArtifact.downloadUrl}><Download size={13} />下载</a> : null}{current?.studentId === selectedStudent.studentId && selectedArtifact.kind !== "file" && !active && current.status !== "evaluating" ? <PrimaryButton disabled={busy} onClick={() => void startPresentation()} size="sm" tone="green"><MonitorUp size={14} />投屏此材料</PrimaryButton> : null}</div></div>
                  {selectedArtifact.kind === "file" ? <div className="grid min-h-64 place-items-center p-6 text-center"><div><FileText className="mx-auto text-stone-400" size={30} /><p className="mt-2 text-sm font-semibold text-[var(--pbl-text-strong)]">此材料暂不支持在线预览</p><p className="mt-1 text-xs text-[var(--pbl-text-muted)]">可下载后使用对应应用打开；课堂投屏请选择主文档或 PDF。</p></div></div> : <div className="h-[min(56dvh,40rem)] min-h-[28rem] p-2"><ShowcaseArtifactViewer artifact={selectedArtifact} courseId={course.id} displayMode={selectedArtifact.kind === "pdf" ? selectedDisplayMode : "continuous"} key={`${selectedStudent.studentId}:${selectedArtifact.versionId}`} mode="self" /></div>}
                </div> : null}
              </> : <p className="mt-3 text-sm text-[var(--pbl-text-muted)]">该学生尚未上传项目材料。</p>}
            </Card> : null}
          </div>
        )}
      />
      </div>

      {active && activeArtifact && !minimized ? <TeacherPresentationOverlay inline={inlinePresentation} artifact={activeArtifact} courseId={course.id} onEnd={() => void stopPresentation()} onMinimize={() => setMinimized(true)} presentation={active} studentName={active.studentName ?? activeStudent?.studentName} /> : null}
      {active && activeArtifact && minimized ? <button aria-label="恢复汇报投屏" className={`${inlinePresentation ? "relative" : "fixed bottom-5 right-5 z-[181]"} flex min-h-11 items-center gap-2 rounded-full bg-stone-900 px-4 py-3 text-sm font-semibold text-white shadow-xl`} onClick={() => setMinimized(false)} type="button"><MonitorUp size={16} />恢复“{active.artifactTitle}”</button> : null}
    </div>
  );
}

function TeacherPresentationOverlay({
  artifact,
  inline = false,
  courseId,
  onEnd,
  onMinimize,
  presentation,
  studentName,
}: {
  artifact: FinalArtifactSummary;
  inline?: boolean;
  courseId: string;
  onEnd: () => void;
  onMinimize: () => void;
  presentation: ShowcasePresentationSnapshot;
  studentName?: string;
}) {
  return (
    <div className={inline ? "teacher-presentation-showcase flex min-h-[240px] flex-1 flex-col bg-white" : "fixed inset-0 z-[180] flex flex-col bg-slate-950/75 p-2 backdrop-blur-sm sm:p-4"} role="presentation">
      <section aria-labelledby="teacher-showcase-title" aria-modal={inline ? undefined : true} className={`mx-auto flex h-full w-full flex-1 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-white/70 bg-[var(--pbl-surface)] ${inline ? "min-h-[240px]" : "max-w-[1500px] shadow-2xl"}`} role={inline ? "region" : "dialog"}>
        <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-3 border-b border-[var(--pbl-border)] bg-white px-4 sm:px-6"><span className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[var(--pbl-teacher)] text-white"><MonitorUp size={18} /></span><div className="min-w-0 flex-1"><p className="text-xs font-semibold text-[var(--pbl-teacher)]">教师端投屏 · {studentName ?? "学生"} · 学生在教师机操作</p><h2 className="break-words text-lg font-bold text-[var(--pbl-text-strong)]" id="teacher-showcase-title">{artifact.title}</h2></div><Pill tone="green">教师机控制</Pill><PrimaryButton onClick={onMinimize} size="sm" tone="slate" variant="outline"><MonitorOff size={14} />{inline ? "汇报管理" : "最小化"}</PrimaryButton><PrimaryButton onClick={onEnd} size="sm" tone="red" variant="outline"><Square size={14} />结束汇报</PrimaryButton></header>
        <div className="min-h-0 flex-1 p-2 sm:p-3"><ShowcaseArtifactViewer key={artifact.versionId} artifact={artifact} courseId={courseId} mode="controller" presentation={presentation} /></div>
        <footer className="shrink-0 border-t border-[var(--pbl-border)] bg-white px-4 py-2 text-center text-xs text-[var(--pbl-text-muted)]">请汇报学生在教师机上滚动或翻页；全班观看教师投屏。结束后进入教师点评。</footer>
      </section>
    </div>
  );
}
