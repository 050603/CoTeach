"use client";

import { useState } from "react";
import { CircleHelp, Download, FileText, ListOrdered, LoaderCircle } from "lucide-react";
import { ShowcaseArtifactViewer, type ShowcaseViewStatePatch } from "@/components/showcase/showcase-artifact-viewer";
import { ShowcaseDrawer, ShowcaseMaterialToolbar, artifactLabel, showcaseStyles as styles } from "@/components/showcase/showcase-workspace-controls";
import { Card, Pill } from "@/components/ui";
import { useSession } from "@/lib/session/store";
import { StageEmptyState } from "@/components/classroom/classroom-ui";
import type { Course, ShowcaseDisplayMode } from "@/lib/session/types";
import { useShowcasePresentation } from "@/hooks/use-showcase-presentation";
import type { ShowcaseQueueItemStatus } from "@/lib/showcase/types";
import { FinalArtifactSubmission } from "./final-artifact-submission";

const statusLabels: Record<ShowcaseQueueItemStatus, string> = {
  "not-ready": "成果未就绪", waiting: "等待汇报", called: "已点名", "pending-approval": "等待教师发起",
  presenting: "汇报中", evaluating: "教师点评中", rejected: "等待教师处理", completed: "已评价",
};
const statusTones: Record<ShowcaseQueueItemStatus, "gray" | "blue" | "amber" | "green" | "red" | "teal"> = {
  "not-ready": "gray", waiting: "gray", called: "blue", "pending-approval": "amber",
  presenting: "green", evaluating: "amber", rejected: "red", completed: "teal",
};
const flowSteps = ["材料已上传", "等待教师点名", "教师发起投屏", "现场汇报", "教师点评", "已完成"];
function formatSize(size?: number) {
  if (size === undefined) return "已提交";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function NewShowcaseStudentView({ course }: { course: Course }) {
  const studentId = useSession().studentId ?? "";
  const { data, loading, error, reload } = useShowcasePresentation(course.id);
  const [selectedVersionId, setSelectedVersionId] = useState<string>();
  const [pdfMode, setPdfMode] = useState<ShowcaseDisplayMode>("continuous");
  const [drawer, setDrawer] = useState<"help" | null>(null);
  const [readingPositions, setReadingPositions] = useState<Record<string, ShowcaseViewStatePatch>>({});
  const artifacts = data?.ownArtifacts ?? [];
  const selectedArtifact = artifacts.find((item) => item.versionId === selectedVersionId) ?? artifacts[0];
  const ownItem = data?.queue.find((item) => item.studentId === studentId);
  const current = data?.currentQueueItem ?? null;
  const next = data?.nextQueueItem ?? null;
  const awaitingSelection = data?.queueConfig?.selectionMode === "teacher-selected" && !ownItem && artifacts.length > 0;
  const status = ownItem?.status ?? "not-ready";
  const statusText = awaitingSelection ? "已提交，等待教师选择" : statusLabels[status];
  const flowIndex = status === "not-ready" ? 0 : status === "waiting" ? 1 : ["called", "rejected", "pending-approval"].includes(status) ? 2 : status === "presenting" ? 3 : status === "evaluating" ? 4 : 5;
  const isCurrent = Boolean(current && ownItem?.studentId === current.studentId);
  const primaryMessage = awaitingSelection ? "作品已提交，教师将选择现场汇报学生" : !ownItem || status === "not-ready" ? "先完成并提交可投屏成果" : status === "completed" ? "本次汇报已完成" : !isCurrent ? `等待教师点名（队列第 ${ownItem.position} 位）` : status === "called" || status === "rejected" ? "你已被选为汇报学生，请到讲台准备汇报" : status === "pending-approval" ? "教师将在教师机打开你的材料" : status === "presenting" ? "正在汇报，请在教师机上操作材料" : "教师正在进行现场点评";
  if (loading && !data) return <Card className="grid min-h-56 place-items-center"><span className="inline-flex items-center gap-2 text-sm text-stone-500"><LoaderCircle className="animate-spin" size={18} />正在读取汇报状态…</span></Card>;

  const queueContent = <>
    <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold"><ListOrdered size={16} />汇报顺序 · {data?.queue.length ?? 0} 人</h3>
    {data?.queue.length ? <div className="max-h-[min(55dvh,38rem)] space-y-1.5 overflow-y-auto pr-1">{data.queue.map((item) => {
      const mine = item.studentId === studentId;
      return <div className={`flex items-center gap-2 rounded-[var(--radius-sm)] border px-3 py-2 ${mine ? "border-[var(--pbl-student)] bg-[var(--pbl-student-soft)]" : item.studentId === current?.studentId ? "border-emerald-300 bg-emerald-50" : "border-[var(--pbl-border)]"}`} key={item.studentId}><span className="grid size-7 shrink-0 place-items-center rounded-full bg-white text-xs font-bold">{item.position}</span><div className="min-w-0 flex-1"><strong className="block truncate text-sm">{item.studentName}{mine ? " · 我" : ""}</strong><span className="block truncate text-xs text-[var(--pbl-text-muted)]">{mine ? item.primaryArtifactTitle ?? "尚未上传材料" : item.studentId === next?.studentId ? "下一位" : statusLabels[item.status]}</span></div><Pill size="sm" tone={statusTones[item.status]}>{statusLabels[item.status]}</Pill></div>;
    })}</div> : <StageEmptyState className="min-h-40" description="教师开始汇报流程后会显示队列。" title="等待队列生成" />}
    <details className="mt-3 border-t border-[var(--pbl-border)] pt-3" data-testid="compact-showcase-progress"><summary className="cursor-pointer text-sm font-semibold">查看完整汇报流程 · 第 {flowIndex + 1}/6 步</summary><ol aria-label="汇报流程" className="mt-3 space-y-2">{flowSteps.map((step, index) => <li className={`flex items-center gap-2 text-sm ${index === flowIndex ? "font-bold text-[var(--pbl-student)]" : "text-[var(--pbl-text-muted)]"}`} key={step}><span className="grid size-6 shrink-0 place-items-center rounded-full border border-[var(--pbl-border)]">{index + 1}</span>{step}</li>)}</ol></details>
  </>;

  return <div className={`${styles.workspace} ${styles.student}`}>
    <header className={styles.header}>
      <div className={styles.headerTitle}><h1 className="shrink-0 text-xl font-bold text-[var(--pbl-text-strong)]">成果汇报</h1><Pill size="sm" tone={artifacts.length ? "teal" : "gray"}>已上传 {artifacts.length} 份</Pill><span className="hidden truncate text-xs text-[var(--pbl-text-muted)] sm:inline" aria-live="polite">{statusText}</span></div>
      <div className={styles.headerActions}><FinalArtifactSubmission compact course={course} onSubmitted={() => { if (selectedArtifact) setSelectedVersionId(selectedArtifact.versionId); return reload(); }} variant="showcase" /><button aria-label="查看汇报帮助" className={styles.toolbarButton} onClick={() => setDrawer("help")} type="button"><CircleHelp size={17} /><span className="hidden sm:inline">帮助</span></button></div>
    </header>
    {error ? <div className="mt-2 flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">{error}<button className="underline" onClick={() => void reload()} type="button">重试</button></div> : null}
    <div className={styles.layout}>
      <main className={styles.main}>
        <ShowcaseMaterialToolbar artifacts={artifacts} displayMode={pdfMode} onDisplayModeChange={setPdfMode} onSelect={(item) => { setSelectedVersionId(item.versionId); setPdfMode("continuous"); }} selected={selectedArtifact} tone="student" />
        <div className={`${styles.preview} ${selectedArtifact?.kind === "pdf" && pdfMode === "slides" ? styles.slidesPreview : ""}`} data-testid="large-artifact-preview">
          {!selectedArtifact ? <StageEmptyState className="h-full border-0" description="上传 PDF、主文档或其他项目成果，教师会在课堂汇报时查看。" icon={FileText} title="还没有汇报资料" tone="student" /> : selectedArtifact.kind === "file" ? <div className="grid h-full place-items-center p-6 text-center"><div><FileText className="mx-auto text-[var(--pbl-student)]" size={28} /><p className="mt-2 break-all text-sm font-semibold">{selectedArtifact.title}</p><p className="mt-1 text-xs text-[var(--pbl-text-muted)]">{artifactLabel(selectedArtifact)} · {formatSize(selectedArtifact.size)}</p><p className="mt-1 text-xs text-[var(--pbl-text-muted)]">此格式供教师下载查看，课堂投屏请使用主文档或 PDF。</p>{selectedArtifact.downloadUrl ? <a className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--pbl-student)] px-4 text-sm font-semibold text-white" download href={selectedArtifact.downloadUrl}><Download size={16} />下载资料</a> : null}</div></div> : <ShowcaseArtifactViewer artifact={selectedArtifact} courseId={course.id} displayMode={selectedArtifact.kind === "pdf" ? pdfMode : "continuous"} initialViewState={readingPositions[selectedArtifact.versionId]} key={selectedArtifact.versionId} mode="self" onViewStateChange={(patch) => setReadingPositions((old) => ({ ...old, [selectedArtifact.versionId]: { ...old[selectedArtifact.versionId], ...patch } }))} />}
        </div>
      </main>
      <aside className={styles.aside} data-testid="student-showcase-sidebar"><div className="p-4"><div className="flex items-center justify-between gap-2"><h2 className="font-bold">我的汇报进度</h2><Pill size="sm" tone={awaitingSelection ? "blue" : statusTones[status]}>{statusText}</Pill></div><p className="mt-2 text-sm font-semibold leading-6">{primaryMessage}</p><p className="mt-2 text-xs text-[var(--pbl-text-muted)]">第 {flowIndex + 1}/6 步 · {flowSteps[flowIndex]}{ownItem ? ` · 队列第 ${ownItem.position} 位` : ""}</p><div className="mt-3 space-y-1 border-t border-[var(--pbl-border)] pt-3 text-xs"><p>当前：<strong>{current?.studentName ?? "尚未开始"}</strong></p><p>下一位：<strong>{next?.studentName ?? "待安排"}</strong></p>{ownItem?.estimatedWaitMinutes !== undefined && !isCurrent && status !== "completed" ? <p>预计等待约 {ownItem.estimatedWaitMinutes} 分钟</p> : null}</div>{isCurrent && ["called", "pending-approval", "rejected"].includes(status) ? <p className="mt-3 rounded-[var(--radius-sm)] bg-blue-50 p-2 text-xs leading-5 text-blue-900">请到前面讲台准备。教师会在教师机打开你的汇报材料并发起投屏，你可直接操作教师机完成演示。</p> : null}{status === "evaluating" ? <p className="mt-3 rounded-[var(--radius-sm)] bg-amber-50 p-2 text-xs leading-5 text-amber-900">教师正在进行课堂点评，评价结束后会自动进入下一位。</p> : null}<div className="mt-4 border-t border-[var(--pbl-border)] pt-3">{queueContent}</div></div></aside>
    </div>
    {drawer === "help" ? <ShowcaseDrawer onClose={() => setDrawer(null)} title="汇报材料帮助"><div className="space-y-3 text-sm leading-6"><p>上传准备在课堂展示的项目材料，单个文件不超过 100 MiB。</p><p>PDF 和主文档可以直接预览并由教师端投屏；其他格式供教师下载查看。</p><p>支持 PDF、Word、演示稿、表格、图片、音视频、压缩包、代码和文本文件。轮到你时请到讲台，在教师机上操作演示。</p></div></ShowcaseDrawer> : null}
  </div>;
}
