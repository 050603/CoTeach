"use client";

import { useState } from "react";
import {
  Download,
  FileText,
  LoaderCircle,
} from "lucide-react";
import { ShowcaseArtifactViewer } from "@/components/showcase/showcase-artifact-viewer";
import { Card, Pill } from "@/components/ui";
import { useSession } from "@/lib/session/store";
import { StageEmptyState, StagePageHeader } from "@/components/classroom/classroom-ui";
import type {
  Course,
  FinalArtifactSummary,
  ShowcaseDisplayMode,
} from "@/lib/session/types";
import { useShowcasePresentation } from "@/hooks/use-showcase-presentation";
import type { ShowcaseQueueItemStatus } from "@/lib/showcase/types";
import { FinalArtifactSubmission } from "./final-artifact-submission";

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

const flowSteps = ["材料已上传", "等待教师点名", "教师发起投屏", "现场汇报", "教师点评", "已完成"];

export function NewShowcaseStudentView({ course }: { course: Course }) {
  const session = useSession();
  const studentId = session.studentId ?? "";
  const { data, loading, error, reload } = useShowcasePresentation(course.id);
  const [selectedVersionId, setSelectedVersionId] = useState<string>();
  const [pdfMode, setPdfMode] = useState<ShowcaseDisplayMode>("continuous");
  const [localError, setLocalError] = useState<string>();

  const ownArtifacts = data?.ownArtifacts ?? [];
  const selectedArtifact = ownArtifacts.find((artifact) => artifact.versionId === selectedVersionId) ?? ownArtifacts[0];
  const ownItem = data?.queue.find((item) => item.studentId === studentId);
  const current = data?.currentQueueItem ?? null;
  const next = data?.nextQueueItem ?? null;
  if (loading && !data) {
    return <Card className="grid min-h-56 place-items-center"><span className="inline-flex items-center gap-2 text-sm text-stone-500"><LoaderCircle className="animate-spin" size={18} />正在读取汇报状态…</span></Card>;
  }

  const isCurrent = Boolean(ownItem && current && ownItem.studentId === current.studentId);
  const awaitingSelection = data?.queueConfig?.selectionMode === "teacher-selected" && !ownItem;
  const status = ownItem?.status ?? "not-ready";
  const flowIndex = status === "not-ready" ? 0 : status === "waiting" ? 1 : status === "called" || status === "rejected" || status === "pending-approval" ? 2 : status === "presenting" ? 3 : status === "evaluating" ? 4 : 5;
  const primaryMessage = awaitingSelection && ownArtifacts.length
    ? "作品已提交，教师将选择部分同学现场汇报；请继续观看并准备回应。"
    : !ownItem || status === "not-ready"
    ? "先完成并提交可投屏成果"
    : status === "completed"
      ? "本次汇报已完成"
      : !isCurrent
        ? `等待教师点名（当前是第 ${ownItem.position} 位）`
        : status === "called" || status === "rejected"
          ? "你已被选为汇报学生，请到讲台准备汇报"
          : status === "pending-approval"
            ? "教师将在教师机打开你的材料"
            : status === "presenting"
              ? "正在汇报，请在教师机上操作材料"
              : "教师正在进行现场点评";

  return (
    <div className="classroom-stage space-y-5">
      <StagePageHeader
        description={data?.queueConfig?.selectionMode === "teacher-selected" ? "每位同学上传项目材料，教师选择现场汇报同学并在教师端发起投屏。" : "上传并检查自己的汇报材料；轮到你时到讲台，在教师机上操作演示。"}
        status={<Pill tone={status === "presenting" ? "green" : status === "completed" ? "teal" : isCurrent ? "amber" : ownArtifacts.length ? "blue" : "gray"}>{statusLabels[status]}</Pill>}
        title="成果汇报"
        variant="student-card"
      />
      <FinalArtifactSubmission course={course} onSubmitted={reload} variant="showcase" />

      {(error || localError) ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert"><span>{localError ?? error}</span><button aria-label="重试读取汇报状态" className="inline-flex min-h-11 items-center rounded-[var(--radius-xs)] border border-rose-300 px-3 font-semibold text-rose-800 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700" onClick={() => { setLocalError(undefined); void reload(); }} type="button">重试</button></div> : null}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,21rem)]">
        <Card className="classroom-panel order-2 overflow-hidden p-0 lg:order-1" compact>
          <div className="flex flex-col gap-3 border-b border-[var(--pbl-border)] px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="classroom-eyebrow text-[var(--pbl-student)]">成果准备区</p>
                <Pill size="sm" tone="teal">{ownArtifacts.length} 份资料</Pill>
              </div>
              <h2 className="mt-1 text-lg font-bold text-[var(--pbl-text-strong)]">检查已上传的汇报材料</h2>
              <p className="mt-1 text-xs leading-5 text-[var(--pbl-text-muted)]">主文档和 PDF 可直接预览；教师端会看到每位同学上传的材料，并为当前汇报人选择投屏内容。</p>
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
                      <span className="text-xs text-[var(--pbl-text-muted)]">{selectedArtifact.kind === "file" ? "此资料仅支持下载" : "教师端可打开预览和投屏"}</span>
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
                <div className="grid grid-cols-6 gap-1">{flowSteps.map((step, index) => <span aria-label={`${index + 1}. ${step}`} className={`h-1.5 rounded-full ${index <= flowIndex ? "bg-[var(--pbl-student)]" : "bg-[var(--pbl-border)]"}`} key={step} title={step} />)}</div>
                <div className="mt-1.5 flex items-center justify-between text-[11px]"><span className="font-semibold text-[var(--pbl-student)]">第 {flowIndex + 1}/6 步 · {flowSteps[flowIndex]}</span><span className="text-[var(--pbl-text-muted)]">{ownItem ? `队列第 ${ownItem.position} 位` : "尚未入队"}</span></div>
              </div>
              <div className="mt-3 rounded-[var(--radius-sm)] bg-[var(--pbl-surface-soft)] px-3 py-2 text-xs leading-5 text-[var(--pbl-text-muted)]"><p>当前：<strong className="text-[var(--pbl-text-strong)]">{current?.studentName ?? "尚未开始"}</strong>{next ? ` · 下一位：${next.studentName}` : ""}</p>{ownItem?.estimatedWaitMinutes !== undefined && !isCurrent && status !== "completed" ? <p>预计等待约 {ownItem.estimatedWaitMinutes} 分钟{data?.queueConfig?.schemaVersion === 2 ? "（含计划点评与切换时间）" : "（含汇报、切换与点评）"}</p> : null}</div>
              {isCurrent && ["called", "pending-approval", "rejected"].includes(status) ? <div className="mt-3 rounded-[var(--radius-sm)] border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-900">请到前面讲台准备。教师会在教师机打开你的汇报材料并发起投屏，你可直接操作教师机完成演示。</div> : null}
              {status === "evaluating" ? <div className="mt-3 rounded-[var(--radius-sm)] border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">教师正在进行课堂点评，评价结束后会自动进入下一位。</div> : null}
            </div>
            <div className="flex min-h-0 flex-1 flex-col p-4">
              <div className="flex shrink-0 items-center justify-between gap-3"><div><h2 className="font-bold text-[var(--pbl-text-strong)]">汇报顺序</h2><p className="mt-0.5 text-xs text-[var(--pbl-text-muted)]">当前、下一位和我的位置</p></div><Pill size="sm" tone="blue">{data?.queue.length ?? 0} 人</Pill></div>
              <div className="mt-3 min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain pr-1">
                {data?.queue.length ? data.queue.map((item) => {
                  const mine = item.studentId === studentId;
                  const isActive = item.status === "presenting";
                  const isNext = item.studentId === next?.studentId;
                  return <div className={`flex items-center gap-2 rounded-[var(--radius-sm)] border px-2.5 py-2 ${mine ? "border-[var(--pbl-student)] bg-[var(--pbl-student-soft)]/70" : isActive ? "border-emerald-300 bg-emerald-50" : isNext ? "border-amber-300 bg-amber-50/60" : "border-[var(--pbl-border)] bg-white"}`} key={item.studentId}><span className={`grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-bold ${mine ? "bg-[var(--pbl-student)] text-white" : "bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-muted)]"}`}>{item.position}</span><div className="min-w-0 flex-1"><div className="flex items-center gap-1.5"><strong className="truncate text-sm text-[var(--pbl-text-strong)]">{item.studentName}</strong>{mine ? <span className="shrink-0 text-[10px] font-bold text-[var(--pbl-student)]">我</span> : null}</div><span className="mt-0.5 block truncate text-[11px] text-[var(--pbl-text-muted)]">{mine ? item.primaryArtifactTitle ?? "尚未上传材料" : "汇报材料由教师端管理"}</span></div><Pill size="sm" tone={statusTones[item.status]}>{isActive ? "正在汇报" : statusLabels[item.status]}</Pill></div>;
                }) : <StageEmptyState className="min-h-48" description="教师开始汇报流程后会显示队列。" title="等待队列生成" />}
              </div>
            </div>
          </Card>
        </aside>
      </div>

    </div>
  );
}
