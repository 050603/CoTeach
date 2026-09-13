"use client";

import { useEffect, useRef, useState } from "react";
import {
  Download,
  FileText,
  LoaderCircle,
  MonitorUp,
  Send,
  ShieldCheck,
  Square,
} from "lucide-react";
import {
  ShowcaseArtifactViewer,
  type ShowcaseViewStatePatch,
} from "@/components/showcase/showcase-artifact-viewer";
import { Card, Pill, PrimaryButton } from "@/components/ui";
import { useSession } from "@/lib/session/store";
import { StageEmptyState, StagePageHeader } from "@/components/classroom/classroom-ui";
import type {
  Course,
  FinalArtifactSummary,
  ShowcaseDisplayMode,
  ShowcasePresentationSnapshot,
} from "@/lib/session/types";
import { useShowcasePresentation } from "@/hooks/use-showcase-presentation";
import type { ShowcaseQueueItemStatus } from "@/lib/showcase/types";
import { CourseStageRequirements } from "@/components/classroom/course-stage-requirements";

function newRequestId(): string | undefined {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return undefined;
}

function artifactLabel(artifact: FinalArtifactSummary): string {
  if (artifact.kind === "pdf") return "PDF / 演示稿";
  if (artifact.kind === "document") return "Word 文档";
  if (artifact.mimeType?.includes("zip") || artifact.mimeType?.includes("compressed")) return "压缩包";
  if (artifact.mimeType?.startsWith("text/") || artifact.mimeType?.includes("javascript") || artifact.mimeType?.includes("json")) return "代码或文本";
  return "额外成果";
}

function formatFileSize(size?: number): string | undefined {
  if (!size) return undefined;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

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

const flowSteps = ["成果已准备", "等待教师点名", "申请投屏", "等待批准", "进行汇报", "教师点评", "已完成"];

export function NewShowcaseStudentView({ course }: { course: Course }) {
  const session = useSession();
  const studentId = session.studentId ?? "";
  const { data, loading, error, runAction, reload } = useShowcasePresentation(course.id);
  const [selectedVersionId, setSelectedVersionId] = useState<string>();
  const [pdfMode, setPdfMode] = useState<ShowcaseDisplayMode>("continuous");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [syncing, setSyncing] = useState(false);
  const pendingSyncRef = useRef<ShowcaseViewStatePatch | undefined>(undefined);
  const syncInFlightRef = useRef(false);

  const ownArtifacts = data?.ownArtifacts ?? [];
  const selectedArtifact = ownArtifacts.find((artifact) => artifact.versionId === selectedVersionId) ?? ownArtifacts[0];
  const ownItem = data?.queue.find((item) => item.studentId === studentId);
  const current = data?.currentQueueItem ?? null;
  const next = data?.nextQueueItem ?? null;
  const activePresentation = data?.activePresentation ?? null;
  const activeArtifact = activePresentation ? artifactForPresentation(activePresentation) : undefined;
  const isController = activePresentation?.studentId === studentId;
  const ownRequest = data?.presentations
    .filter((presentation) => presentation.studentId === studentId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  useEffect(() => {
    if (!activePresentation) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [activePresentation]);

  async function flushSync() {
    if (syncInFlightRef.current || !pendingSyncRef.current || !activePresentation || !isController) return;
    const patch = pendingSyncRef.current;
    pendingSyncRef.current = undefined;
    syncInFlightRef.current = true;
    setSyncing(true);
    try {
      await runAction({ action: "update", presentationId: activePresentation.id, viewState: patch });
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : "汇报位置同步失败");
    } finally {
      syncInFlightRef.current = false;
      setSyncing(false);
      if (pendingSyncRef.current) void flushSync();
    }
  }

  function queueSync(patch: ShowcaseViewStatePatch) {
    if (!isController || !activePresentation) return;
    pendingSyncRef.current = patch;
    void flushSync();
  }

  async function requestPresentation() {
    if (!selectedArtifact || selectedArtifact.kind === "file" || ownItem?.studentId !== current?.studentId || busy || activePresentation || ownRequest?.status === "pending") return;
    setBusy(true);
    setLocalError(undefined);
    try {
      const requestId = newRequestId();
      await runAction({
        action: "request",
        artifactKind: selectedArtifact.kind,
        artifactVersionId: selectedArtifact.versionId,
        displayMode: selectedArtifact.kind === "pdf" ? pdfMode : "continuous",
        ...(requestId ? { requestId } : {}),
      });
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : "投屏申请失败");
    } finally {
      setBusy(false);
    }
  }

  async function endPresentation() {
    if (!activePresentation || !isController || busy) return;
    setBusy(true);
    try {
      await runAction({ action: "end", presentationId: activePresentation.id });
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : "结束汇报失败");
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) {
    return <Card className="grid min-h-56 place-items-center"><span className="inline-flex items-center gap-2 text-sm text-stone-500"><LoaderCircle className="animate-spin" size={18} />正在读取汇报状态…</span></Card>;
  }

  const isCurrent = Boolean(ownItem && current && ownItem.studentId === current.studentId);
  const awaitingSelection = data?.queueConfig?.selectionMode === "teacher-selected" && !ownItem;
  const status = ownItem?.status ?? "not-ready";
  const flowIndex = status === "not-ready" ? 0 : status === "waiting" ? 1 : status === "called" || status === "rejected" ? 2 : status === "pending-approval" ? 3 : status === "presenting" ? 4 : status === "evaluating" ? 5 : 6;
  const primaryMessage = awaitingSelection && ownArtifacts.length
    ? "作品已提交，教师将选择部分同学现场汇报；请继续观看并准备回应。"
    : !ownItem || status === "not-ready"
    ? "先完成并提交可投屏成果"
    : status === "completed"
      ? "本次汇报已完成"
      : !isCurrent
        ? `等待教师点名（当前是第 ${ownItem.position} 位）`
        : status === "called" || status === "rejected"
          ? "你已被选为汇报学生，请申请投屏"
          : status === "pending-approval"
            ? "申请已提交，等待教师批准"
            : status === "presenting"
              ? "你正在汇报，滚动或翻页会同步给全班"
              : "教师正在进行现场点评";

  return (
    <div className="classroom-stage space-y-5">
      <StagePageHeader
        description={data?.queueConfig?.selectionMode === "teacher-selected" ? "每位同学提交个人作品，教师选择现场汇报同学；入选后按提示申请投屏。" : "这里是课堂汇报控制台：先看队列位置，再按提示完成申请、汇报和教师点评。"}
        status={<Pill tone={activePresentation ? "green" : status === "completed" ? "teal" : isCurrent ? "amber" : ownArtifacts.length ? "blue" : "gray"}>{activePresentation ? "课堂汇报中" : statusLabels[status]}</Pill>}
        title="成果汇报"
        variant="student-card"
      />
      <CourseStageRequirements course={course} stageKey="showcase" expanded />

      {(error || localError) ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert"><span>{localError ?? error}</span><button aria-label="重试读取汇报状态" className="inline-flex min-h-11 items-center rounded-[var(--radius-xs)] border border-rose-300 px-3 font-semibold text-rose-800 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700" onClick={() => { setLocalError(undefined); void reload(); }} type="button">重试</button></div> : null}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,21rem)]">
        <Card className="classroom-panel order-2 overflow-hidden p-0 lg:order-1" compact>
          <div className="flex flex-col gap-3 border-b border-[var(--pbl-border)] px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="classroom-eyebrow text-[var(--pbl-student)]">成果准备区</p>
                <Pill size="sm" tone="teal">{ownArtifacts.length} 份资料</Pill>
              </div>
              <h2 className="mt-1 text-lg font-bold text-[var(--pbl-text-strong)]">选择主汇报资料并预览</h2>
              <p className="mt-1 text-xs leading-5 text-[var(--pbl-text-muted)]">主文档、上传的 PDF 和转成 PDF 的演示稿都可以在这里切换；当前选中项会用于申请投屏。</p>
            </div>
            {selectedArtifact?.downloadUrl ? <a className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--pbl-border)] bg-white px-3 py-2 text-sm font-semibold text-[var(--pbl-text-strong)] hover:border-[var(--pbl-student-border)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pbl-student)]" download href={selectedArtifact.downloadUrl}><Download size={15} />下载当前资料</a> : null}
          </div>

          {ownArtifacts.length ? (
            <>
              <div aria-label="选择主汇报资料" className="flex gap-1 overflow-x-auto border-b border-[var(--pbl-border)] bg-[var(--pbl-surface-soft)] px-3 pt-2" role="tablist">
                {ownArtifacts.map((artifact) => {
                  const active = selectedArtifact?.versionId === artifact.versionId;
                  return (
                    <button
                      aria-controls="student-artifact-preview"
                      aria-selected={active}
                      className={`min-h-11 min-w-[9rem] max-w-[15rem] shrink-0 border-b-2 px-3 py-2 text-left transition focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--pbl-student)] ${active ? "border-[var(--pbl-student)] bg-white text-[var(--pbl-text-strong)]" : "border-transparent text-[var(--pbl-text-muted)] hover:border-[var(--pbl-student-border)] hover:bg-white/70"}`}
                      id={`artifact-tab-${artifact.versionId}`}
                      key={artifact.versionId}
                      onClick={() => {
                        setSelectedVersionId(artifact.versionId);
                        if (artifact.kind === "pdf") setPdfMode("continuous");
                      }}
                      role="tab"
                      type="button"
                    >
                      <span className="block truncate text-xs font-semibold">{artifactLabel(artifact)} · 第 {artifact.sequence} 版</span>
                      <strong className="mt-0.5 block truncate text-sm">{artifact.title}</strong>
                    </button>
                  );
                })}
              </div>

              {selectedArtifact ? (
                <div aria-labelledby={`artifact-tab-${selectedArtifact.versionId}`} id="student-artifact-preview" role="tabpanel">
                  <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 border-b border-[var(--pbl-border)] px-4 py-2.5">
                    <div className="min-w-0">
                      <strong className="block truncate text-sm text-[var(--pbl-text-strong)]">{selectedArtifact.title}</strong>
                      <span className="text-xs text-[var(--pbl-text-muted)]">{selectedArtifact.kind === "file" ? "此资料仅支持下载" : "已选为主汇报资料"}</span>
                    </div>
                    {selectedArtifact.kind === "pdf" ? (
                      <div aria-label="PDF 预览方式" className="inline-flex rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-[var(--pbl-surface-soft)] p-0.5 text-xs font-semibold">
                        <button aria-pressed={pdfMode === "continuous"} className={`min-h-11 rounded px-3 py-1.5 ${pdfMode === "continuous" ? "bg-white text-[var(--pbl-text-strong)] shadow-sm" : "text-[var(--pbl-text-muted)]"}`} onClick={() => setPdfMode("continuous")} type="button">连续阅读</button>
                        <button aria-pressed={pdfMode === "slides"} className={`min-h-11 rounded px-3 py-1.5 ${pdfMode === "slides" ? "bg-[var(--pbl-student)] text-white shadow-sm" : "text-[var(--pbl-text-muted)]"}`} onClick={() => setPdfMode("slides")} type="button">逐页演示</button>
                      </div>
                    ) : null}
                  </div>
                  {selectedArtifact.kind === "file" ? (
                    <div className="grid min-h-[34rem] place-items-center bg-[var(--pbl-surface-soft)] p-6 text-center">
                      <div><span className="mx-auto grid size-14 place-items-center rounded-2xl bg-white text-[var(--pbl-student)] shadow-sm"><FileText size={26} /></span><h3 className="mt-4 font-semibold text-[var(--pbl-text-strong)]">{artifactLabel(selectedArtifact)}</h3><p className="mt-1 text-sm text-[var(--pbl-text-muted)]">{formatFileSize(selectedArtifact.size) ?? "已提交"} · 代码和压缩包等资料暂不支持页面预览或投屏。</p>{selectedArtifact.downloadUrl ? <a className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--pbl-student)] px-4 py-2 text-sm font-semibold text-white" download href={selectedArtifact.downloadUrl}><Download size={16} />下载资料</a> : null}</div>
                    </div>
                  ) : (
                    <div className="h-[min(68dvh,52rem)] min-h-[34rem] overflow-hidden bg-[var(--pbl-surface-soft)]" data-testid="large-artifact-preview">
                      <ShowcaseArtifactViewer key={selectedArtifact.versionId} courseId={course.id} artifact={selectedArtifact} displayMode={selectedArtifact.kind === "pdf" ? pdfMode : "continuous"} mode="self" />
                    </div>
                  )}
                </div>
              ) : null}
            </>
          ) : <StageEmptyState className="m-4 min-h-[34rem]" description="返回项目实践完成主文档，或提交 PDF、转成 PDF 的演示稿及其他成果。" icon={FileText} title="还没有汇报资料" tone="student" />}
        </Card>

        <aside className="order-1 min-w-0 lg:sticky lg:top-20 lg:order-2 lg:max-h-[calc(100dvh-6rem)]" data-testid="student-showcase-sidebar">
          <Card className="classroom-panel flex max-h-[calc(100dvh-6rem)] flex-col overflow-hidden p-0" compact>
            <div className="shrink-0 border-b border-[var(--pbl-border)] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><p className="classroom-eyebrow text-[var(--pbl-student)]">我的汇报进度</p><h2 className="mt-1 text-base font-bold leading-6 text-[var(--pbl-text-strong)]">{primaryMessage}</h2></div>
                <Pill size="sm" tone={statusTones[status]}>{statusLabels[status]}</Pill>
              </div>
              <div aria-label="汇报流程" className="mt-3" data-testid="compact-showcase-progress">
                <div className="grid grid-cols-7 gap-1">{flowSteps.map((step, index) => <span aria-label={`${index + 1}. ${step}`} className={`h-1.5 rounded-full ${index <= flowIndex ? "bg-[var(--pbl-student)]" : "bg-[var(--pbl-border)]"}`} key={step} title={step} />)}</div>
                <div className="mt-1.5 flex items-center justify-between text-[11px]"><span className="font-semibold text-[var(--pbl-student)]">第 {flowIndex + 1}/7 步 · {flowSteps[flowIndex]}</span><span className="text-[var(--pbl-text-muted)]">{ownItem ? `队列第 ${ownItem.position} 位` : "尚未入队"}</span></div>
              </div>
              <div className="mt-3 rounded-[var(--radius-sm)] bg-[var(--pbl-surface-soft)] px-3 py-2 text-xs leading-5 text-[var(--pbl-text-muted)]"><p>当前：<strong className="text-[var(--pbl-text-strong)]">{current?.studentName ?? "尚未开始"}</strong>{next ? ` · 下一位：${next.studentName}` : ""}</p>{ownItem?.estimatedWaitMinutes !== undefined && !isCurrent && status !== "completed" ? <p>预计等待约 {ownItem.estimatedWaitMinutes} 分钟{data?.queueConfig?.schemaVersion === 2 ? "（含计划点评与切换时间）" : "（不含审批、切换与点评）"}</p> : null}</div>
              {isCurrent && (status === "called" || status === "rejected") && selectedArtifact && selectedArtifact.kind !== "file" ? <PrimaryButton className="mt-3 w-full justify-center" disabled={busy} onClick={() => void requestPresentation()} tone="teal"><Send size={16} />{busy ? "申请中…" : status === "rejected" ? "重新申请投屏" : "申请全班投屏"}</PrimaryButton> : null}
              {isCurrent && (status === "called" || status === "rejected") && selectedArtifact?.kind === "file" ? <p className="mt-3 rounded-[var(--radius-sm)] bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">当前资料不能投屏，请在左侧选择主文档或 PDF。</p> : null}
              {isCurrent && status === "pending-approval" ? <div className="mt-3 rounded-[var(--radius-sm)] border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">教师端已收到申请，请等待批准。</div> : null}
              {status === "evaluating" ? <div className="mt-3 rounded-[var(--radius-sm)] border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">教师正在进行课堂点评，评价结束后会自动进入下一位。</div> : null}
              {status === "rejected" && ownRequest?.rejectionReason ? <p className="mt-2 text-xs text-rose-700">教师说明：{ownRequest.rejectionReason}</p> : null}
            </div>
            <div className="flex min-h-0 flex-1 flex-col p-4">
              <div className="flex shrink-0 items-center justify-between gap-3"><div><h2 className="font-bold text-[var(--pbl-text-strong)]">汇报顺序</h2><p className="mt-0.5 text-xs text-[var(--pbl-text-muted)]">当前、下一位和我的位置</p></div><Pill size="sm" tone="blue">{data?.queue.length ?? 0} 人</Pill></div>
              <div className="mt-3 min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain pr-1">
                {data?.queue.length ? data.queue.map((item) => {
                  const mine = item.studentId === studentId;
                  const isActive = item.status === "presenting";
                  const isNext = item.studentId === next?.studentId;
                  return <div className={`flex items-center gap-2 rounded-[var(--radius-sm)] border px-2.5 py-2 ${mine ? "border-[var(--pbl-student)] bg-[var(--pbl-student-soft)]/70" : isActive ? "border-emerald-300 bg-emerald-50" : isNext ? "border-amber-300 bg-amber-50/60" : "border-[var(--pbl-border)] bg-white"}`} key={item.studentId}><span className={`grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-bold ${mine ? "bg-[var(--pbl-student)] text-white" : "bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-muted)]"}`}>{item.position}</span><div className="min-w-0 flex-1"><div className="flex items-center gap-1.5"><strong className="truncate text-sm text-[var(--pbl-text-strong)]">{item.studentName}</strong>{mine ? <span className="shrink-0 text-[10px] font-bold text-[var(--pbl-student)]">我</span> : null}</div><span className="mt-0.5 block truncate text-[11px] text-[var(--pbl-text-muted)]">{item.primaryArtifactTitle ?? "暂无可投屏成果"}</span></div><Pill size="sm" tone={statusTones[item.status]}>{isActive ? "正在汇报" : statusLabels[item.status]}</Pill></div>;
                }) : <StageEmptyState className="min-h-48" description="教师开始汇报流程后会显示队列。" title="等待队列生成" />}
              </div>
            </div>
          </Card>
        </aside>
      </div>

      {activePresentation && activeArtifact ? <StudentPresentationOverlay artifact={activeArtifact} busy={busy} courseId={course.id} isController={isController} onEnd={() => void endPresentation()} onViewStateChange={queueSync} presentation={activePresentation} syncing={syncing} queuePosition={data?.queue.find((item) => item.studentId === activePresentation.studentId)?.position} /> : null}
    </div>
  );
}

function StudentPresentationOverlay({
  artifact,
  busy,
  courseId,
  isController,
  onEnd,
  onViewStateChange,
  presentation,
  syncing,
  queuePosition,
}: {
  artifact: FinalArtifactSummary;
  busy: boolean;
  courseId: string;
  isController: boolean;
  onEnd: () => void;
  onViewStateChange: (patch: ShowcaseViewStatePatch) => void;
  presentation: ShowcasePresentationSnapshot;
  syncing: boolean;
  queuePosition?: number;
}) {
  return (
    <div className="fixed inset-0 z-[180] flex flex-col bg-slate-950/75 p-2 backdrop-blur-sm sm:p-4" role="presentation">
      <section aria-labelledby="student-showcase-title" aria-modal="true" className="mx-auto flex h-full w-full max-w-[1500px] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-white/70 bg-[var(--pbl-surface)] shadow-2xl" role="dialog">
        <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-[var(--pbl-border)] bg-white px-4 sm:px-6"><span className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[var(--pbl-student)] text-white"><MonitorUp size={18} /></span><div className="min-w-0 flex-1"><p className="text-xs font-semibold text-[var(--pbl-student)]">{isController ? "你的汇报控制台" : "课堂成果汇报"} · {presentation.studentName ?? "学生"}{queuePosition ? ` · 第 ${queuePosition} 位` : ""}</p><h2 className="truncate text-lg font-bold text-[var(--pbl-text-strong)]" id="student-showcase-title">{artifact.title}</h2></div><Pill tone="green">{isController ? (syncing ? "同步中" : "你正在控制") : "强制跟随"}</Pill>{isController ? <PrimaryButton disabled={busy} onClick={onEnd} size="sm" tone="red" variant="outline"><Square size={14} />结束汇报</PrimaryButton> : <span className="inline-flex items-center gap-1 text-xs text-stone-500"><ShieldCheck size={14} />只读</span>}</header>
        <div className="min-h-0 flex-1 p-2 sm:p-3"><ShowcaseArtifactViewer key={artifact.versionId} artifact={artifact} courseId={courseId} mode={isController ? "controller" : "follower"} onViewStateChange={onViewStateChange} presentation={presentation} /></div>
        <footer className="shrink-0 border-t border-[var(--pbl-border)] bg-white px-4 py-2 text-center text-xs text-[var(--pbl-text-muted)]">{isController ? "滚动或翻页会同步到教师和全班同学；结束汇报后等待教师现场点评。" : "由汇报学生控制浏览位置；此页面不可独立浏览。"}</footer>
      </section>
    </div>
  );
}
