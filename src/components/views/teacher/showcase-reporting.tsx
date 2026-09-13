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
  GripVertical,
  LoaderCircle,
  MonitorOff,
  MonitorUp,
  Pause,
  Play,
  RotateCcw,
  Square,
  UserCheck,
  X,
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
  "pending-approval": "等待批准",
  presenting: "汇报中",
  evaluating: "教师点评中",
  rejected: "可重新申请",
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
  const [rejectionReason, setRejectionReason] = useState("");
  const [draggingId, setDraggingId] = useState<string>();
  const [teacherFollowing, setTeacherFollowing] = useState(true);
  const [minimized, setMinimized] = useState(false);
  const [selectedStudentId, setSelectedStudentId] = useState<string>();
  const [showQueue, setShowQueue] = useState(false);
  const [assessmentStudentId, setAssessmentStudentId] = useState("");
  const displayContext = `${course.id}:${course.currentStageIndex}:${presentation}`;
  const [previousPresentation, setPreviousPresentation] = useState(displayContext);
  if (previousPresentation !== displayContext) {
    setPreviousPresentation(displayContext);
    setSelectedStudentId(undefined);
    setShowQueue(false);
  }
  const inlinePresentation = immersive || presentation !== "workspace";
  const [minutesDraft, setMinutesDraft] = useState(5);

  const queue = data?.queue ?? [];
  const current = data?.currentQueueItem ?? null;
  const next = data?.nextQueueItem ?? null;
  const active = data?.activePresentation ?? null;
  const pending = current?.presentationId
    ? data?.presentations.find((presentation) => presentation.id === current.presentationId && presentation.status === "pending")
    : data?.presentations.find((presentation) => presentation.status === "pending");
  const evaluating = current?.status === "evaluating" && current.presentationId
    ? data?.presentations.find((presentation) => presentation.id === current.presentationId)
    : undefined;
  const selected = queue.find((item) => item.studentId === selectedStudentId) ?? current ?? queue[0];
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

  async function review(decision: "approve" | "reject") {
    if (!pending) return;
    const succeeded = await runTeacherAction({ action: "review", presentationId: pending.id, decision, reason: rejectionReason.trim() || undefined }, "审批汇报申请失败");
    if (succeeded) setRejectionReason("");
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
  const stageStatus = active ? "汇报中" : current?.status === "evaluating" ? "教师点评中" : pending ? "待审批" : current ? "流程进行中" : hasPendingWork ? "等待开始" : queue.some((item) => item.status === "completed") ? "汇报已完成" : "暂无成果";

  const projectArtifact = presentation === "teaching" && Boolean(active && activeArtifact) && !minimized;

  return (
    <div className={`classroom-stage teacher-presentation-content ${projectArtifact ? "flex min-h-0 flex-col overflow-auto" : "space-y-5"}`} hidden={presentation === "analytics"}>
      <TeacherPresentationActions>
        {active ? <button data-tone="danger" disabled={busy} onClick={() => void stopPresentation()} type="button"><Square size={18} />结束汇报</button>
          : pending ? <button data-tone="primary" disabled={busy} onClick={() => void review("approve")} type="button"><Check size={18} />批准汇报</button>
          : evaluating ? <button data-tone="primary" disabled={busy} onClick={() => void finishEvaluation()} type="button"><Check size={18} />结束点评并点名下一位</button>
          : current ? <button disabled type="button">{current.status === "called" || current.status === "pending-approval" ? "等待学生申请" : current.status === "rejected" ? "等待学生重新申请" : current.status === "completed" ? "汇报已完成" : "正在同步汇报状态"}</button>
          : queue.some((item) => item.status === "waiting" && item.groupId) ? <button data-tone="primary" disabled={busy} onClick={() => void startQueue()} type="button"><UserCheck size={18} />开始汇报</button>
          : <button disabled type="button">暂无待汇报成果</button>}
        {(localError || error) ? <span className="text-sm text-rose-700" role="alert">{localError ?? error}</span> : null}
      </TeacherPresentationActions>
      <div hidden={projectArtifact}>
      <StagePageHeader
        action={<div className="flex flex-wrap gap-2"><a className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--pbl-teacher)] bg-white px-3.5 text-[13px] font-semibold text-[var(--pbl-teacher)] transition hover:bg-[var(--pbl-teacher-soft)]" download href={`/api/courses/${encodeURIComponent(course.id)}/showcase/artifacts/export`}><Download size={14} />下载全班成果</a>{!current && queue.some((item) => item.status === "waiting" && item.groupId) ? <PrimaryButton disabled={busy} onClick={() => void startQueue()} tone="blue"><UserCheck size={14} />按提交顺序开始</PrimaryButton> : null}</div>}
        description="按统一队列组织个人成果汇报，教师点评后自动点名下一位。预计时间为近似值，不含审批、切换与现场点评。"
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
                      <button className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pbl-teacher)]" onClick={() => setSelectedStudentId(item.studentId)} type="button"><strong className="block truncate text-sm text-[var(--pbl-text-strong)]">{item.studentName}</strong><span className="mt-0.5 block truncate text-[11px] text-[var(--pbl-text-muted)]">{item.primaryArtifactTitle ?? "暂无可投屏成果"}</span></button>
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
              {current ? <div className="mt-4 grid gap-3 rounded-[var(--radius-sm)] bg-[var(--pbl-surface-soft)] p-3 text-sm sm:grid-cols-[1fr_auto]"><div><p className="font-semibold text-[var(--pbl-text-strong)]">{current.status === "called" ? "等待该学生申请投屏" : current.status === "pending-approval" ? "学生已申请，请确认后开始汇报" : current.status === "presenting" ? "学生正在汇报，教师可跟随投屏" : current.status === "evaluating" ? "请完成课堂点评，再点名下一位" : current.status === "rejected" ? "申请已退回，等待学生重新申请" : "该学生已完成评价"}</p><p className="mt-1 text-xs text-[var(--pbl-text-muted)]">下一位：{next?.studentName ?? "暂无可投屏学生"}{next?.estimatedWaitMinutes ? ` · 约 ${next.estimatedWaitMinutes} 分钟后` : ""}</p></div>{pending ? <div className="flex flex-wrap gap-2 sm:justify-end"><PrimaryButton disabled={busy} onClick={() => void review("reject")} size="sm" tone="red" variant="outline"><X size={14} />退回申请</PrimaryButton><PrimaryButton disabled={busy} onClick={() => void review("approve")} size="sm" tone="green"><Check size={14} />批准并开始</PrimaryButton></div> : null}{current.status === "called" ? <Pill size="sm" tone="blue">学生端可申请投屏</Pill> : null}</div> : <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-dashed border-[var(--pbl-border)] p-4"><p className="text-sm text-[var(--pbl-text-muted)]">下一步：按成果提交顺序开始，学生会在自己的页面看到点名并申请投屏。</p>{queue.some((item) => item.status === "waiting" && item.groupId) ? <PrimaryButton disabled={busy} onClick={() => void startQueue()} size="sm" tone="blue"><UserCheck size={14} />开始汇报流程</PrimaryButton> : null}</div>}
              {current?.status === "evaluating" && evaluating ? <div className="mt-4 rounded-[var(--radius-sm)] border border-amber-200 bg-amber-50 p-4"><div className="flex items-center gap-2 text-sm font-semibold text-amber-900"><MonitorUp size={16} />教师现场点评</div><p className="mt-1 text-xs leading-5 text-amber-800">可记录课堂口头点评，文本不是必填；结束评价后系统会自动点名下一位。</p><TextInput aria-label="课堂点评记录（可选）" className="mt-3 bg-white" maxLength={2_000} onChange={(event) => setNote(event.target.value)} placeholder="记录亮点、追问或需要后续关注的内容（可选）" value={note} /><PrimaryButton className="mt-3" disabled={busy} onClick={() => void finishEvaluation()} size="sm" tone="blue"><Check size={14} />结束评价并点名下一位</PrimaryButton></div> : null}
            </Card>

            {presentation === "workspace" || showQueue ? <Card className="classroom-panel" compact>
              <div className="flex items-start justify-between gap-3"><div><p className="classroom-eyebrow text-[var(--pbl-teacher)]">成果查看</p><h2 className="mt-1 font-bold text-[var(--pbl-text-strong)]">{selected?.studentName ?? "选择一名学生"}</h2><p className="mt-1 text-xs text-[var(--pbl-text-muted)]">{selected?.primaryArtifactTitle ?? "队列会显示每位学生的可投屏成果"}</p></div>{selected ? <Pill size="sm" tone={statusTones[selected.status]}>{statusLabels[selected.status]}</Pill> : null}</div>
              {selected?.artifacts.length ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{selected.artifacts.map((artifact) => <a className="flex min-w-0 items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--pbl-border)] bg-white p-3 transition hover:border-[var(--pbl-teacher-border)] hover:bg-[var(--pbl-teacher-soft)]/40" download href={artifact.downloadUrl ?? `/api/courses/${encodeURIComponent(course.id)}/showcase/artifacts/${encodeURIComponent(artifact.versionId)}?download=1`} key={artifact.versionId}><span className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-xs)] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]"><Download size={16} /></span><span className="min-w-0 flex-1"><strong className="block truncate text-sm text-[var(--pbl-text-strong)]">{artifact.title}</strong><span className="mt-0.5 block text-xs text-[var(--pbl-text-muted)]">{artifactLabel(artifact)} · 下载</span></span></a>)}</div> : <p className="mt-3 text-sm text-[var(--pbl-text-muted)]">该学生尚未提交可投屏文档或 PDF。</p>}
              {pending ? <div className="mt-3 rounded-[var(--radius-sm)] border border-amber-200 bg-amber-50 p-3"><label className="text-xs font-semibold text-amber-900" htmlFor="showcase-rejection-reason">退回说明（可选）</label><TextInput className="mt-1 bg-white" id="showcase-rejection-reason" maxLength={1_000} onChange={(event) => setRejectionReason(event.target.value)} placeholder="例如：请先更新最终成果版本" value={rejectionReason} /></div> : null}
            </Card> : null}
          </div>
        )}
      />
      </div>

      {active && activeArtifact && !minimized ? <TeacherPresentationOverlay inline={inlinePresentation} artifact={activeArtifact} courseId={course.id} onEnd={() => void stopPresentation()} onMinimize={() => setMinimized(true)} onToggleFollow={() => setTeacherFollowing((value) => !value)} presentation={active} teacherFollowing={teacherFollowing} studentName={active.studentName ?? activeStudent?.studentName} /> : null}
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
  onToggleFollow,
  presentation,
  teacherFollowing,
  studentName,
}: {
  artifact: FinalArtifactSummary;
  inline?: boolean;
  courseId: string;
  onEnd: () => void;
  onMinimize: () => void;
  onToggleFollow: () => void;
  presentation: ShowcasePresentationSnapshot;
  teacherFollowing: boolean;
  studentName?: string;
}) {
  return (
    <div className={inline ? "teacher-presentation-showcase flex min-h-[240px] flex-1 flex-col bg-white" : "fixed inset-0 z-[180] flex flex-col bg-slate-950/75 p-2 backdrop-blur-sm sm:p-4"} role="presentation">
      <section aria-labelledby="teacher-showcase-title" aria-modal={inline ? undefined : true} className={`mx-auto flex h-full w-full flex-1 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-white/70 bg-[var(--pbl-surface)] ${inline ? "min-h-[240px]" : "max-w-[1500px] shadow-2xl"}`} role={inline ? "region" : "dialog"}>
        <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-3 border-b border-[var(--pbl-border)] bg-white px-4 sm:px-6"><span className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[var(--pbl-teacher)] text-white"><MonitorUp size={18} /></span><div className="min-w-0 flex-1"><p className="text-xs font-semibold text-[var(--pbl-teacher)]">当前汇报 · {studentName ?? "学生"} · {teacherFollowing ? "跟随汇报" : "独立浏览"}</p><h2 className="break-words text-lg font-bold text-[var(--pbl-text-strong)]" id="teacher-showcase-title">{artifact.title}</h2></div><Pill tone={teacherFollowing ? "green" : "amber"}>{teacherFollowing ? "跟随中" : "已脱离"}</Pill><PrimaryButton onClick={onToggleFollow} size="sm" tone="slate" variant="outline">{teacherFollowing ? <><Pause size={14} />独立浏览</> : <><Play size={14} />恢复跟随</>}</PrimaryButton><PrimaryButton onClick={onMinimize} size="sm" tone="slate" variant="outline"><MonitorOff size={14} />{inline ? "汇报管理" : "最小化"}</PrimaryButton><PrimaryButton onClick={onEnd} size="sm" tone="red" variant="outline"><Square size={14} />结束汇报</PrimaryButton></header>
        <div className="min-h-0 flex-1 p-2 sm:p-3"><ShowcaseArtifactViewer key={artifact.versionId} artifact={artifact} courseId={courseId} mode="teacher" presentation={presentation} teacherFollowing={teacherFollowing} /></div>
        <footer className="shrink-0 border-t border-[var(--pbl-border)] bg-white px-4 py-2 text-center text-xs text-[var(--pbl-text-muted)]">结束汇报后会进入教师点评；点评结束才会自动点名下一位。</footer>
      </section>
    </div>
  );
}
