"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowUpDown, Bot, ChevronDown, Clock3, Download, FileCode2, FileText, FolderDown, MessageSquareText, Search, ShieldAlert, UserRound } from "lucide-react";
import { Card, Pill } from "@/components/ui";
import { RichDocumentPreview } from "@/components/teacher/rich-document-preview";
import { AiMemberMarkdown } from "@/components/views/student/ai-member-markdown";
import { parseCodeArtifact } from "@/lib/ai-collaboration/code-artifact";
import { buildStudentAiInteractionTurns } from "@/lib/ai-collaboration/interaction-transcript";
import type { ClassroomSubmission, Course, ProjectPdfVersion } from "@/lib/session/types";
import { cn } from "@/lib/utils";
import { StageEmptyState, StagePageHeader } from "@/components/classroom/classroom-ui";
import { MakeArtifactModeSetting } from "@/components/teacher/make-artifact-mode-setting";
import { normalizePblCourseConfig } from "@/lib/pbl-course-config";
import { inferStageCollectionMode } from "@/lib/system-mode";
import type { TeacherStageFocus } from "@/lib/classroom/teacher-dashboard-metrics";

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function deriveAiCollaborationMetrics(events: NonNullable<Course["aiInteractionEvents"]>) {
  const turns = buildStudentAiInteractionTurns(events);
  const proactiveSuggestions = turns.filter((turn) =>
    turn.location === "paragraph-comment"
    && turn.messages.some((message) => message.role === "ai"),
  ).length;
  const dialogueRounds = new Set(events.flatMap((event) =>
    event.eventType === "request" && event.actorRole === "student"
      ? [event.requestId || event.id]
      : [],
  )).size;
  const boundaryTriggers = new Set(events.flatMap((event) => {
    const payload = payloadRecord(event.payload);
    const boundaryResponse = event.eventType === "response" && payload.kind === "boundary";
    const protectedPolicy = event.eventType === "policy"
      && typeof payload.protectedCapability === "string"
      && payload.protectedCapability.length > 0;
    return boundaryResponse || protectedPolicy
      ? [event.requestId || `${event.conversationId ?? "conversation"}:${event.id}`]
      : [];
  })).size;
  return { proactiveSuggestions, dialogueRounds, boundaryTriggers, turns };
}

function latestArtifactForStudent(
  course: Course,
  studentId: string,
  includeExternalBrief = false,
  ignoreFailed = false,
): ClassroomSubmission | undefined {
  const groupIds = new Set((course.groups ?? [])
    .filter((group) => group.members.some((member) => member.studentId === studentId))
    .map((group) => group.id));
  return [...(course.submissions ?? [])]
    .filter((submission) =>
      submission.stageKey === "make"
      && (!ignoreFailed || submission.status !== "failed")
      && (
        submission.type === "document"
        || submission.type === "code"
        || (includeExternalBrief && submission.type === "artifact-brief")
        || Boolean(submission.files?.length)
      )
      && (submission.studentId === studentId || Boolean(submission.groupId && groupIds.has(submission.groupId))))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

/** JSON-session fallback: the audit table is optional in local/demo mode, but
 * companion threads still retain the complete Markdown conversation. */
function externalThreadEvents(course: Course, studentId: string): NonNullable<Course["aiInteractionEvents"]> {
  const threadPrefixes = new Set([
    "ai-collaboration:external-artifact:make",
    "ai-collaboration-comments:external-artifact:make",
  ]);
  return (course.companionThreads ?? [])
    .filter((thread) => thread.studentId === studentId && threadPrefixes.has(thread.stageKey))
    .flatMap((thread) => thread.messages)
    .filter((message) => message.role === "student" || message.role === "agent")
    .map((message) => ({
      id: `thread:${message.id}`,
      courseId: course.id,
      studentId,
      stageKey: "make",
      conversationId: message.conversationId,
      source: message.role === "agent" && message.conversationId?.startsWith("document-comment-")
        ? "proactive-comment" as const
        : "sidebar" as const,
      eventType: message.role === "student" ? "request" as const : "response" as const,
      actorRole: message.role === "student" ? "student" as const : "ai" as const,
      actorId: message.authorId,
      content: message.content,
      payload: { workspaceKind: "external-artifact" },
      createdAt: message.createdAt,
    }));
}

type StudentRow = {
  student: Course["students"][number];
  artifact: ClassroomSubmission | undefined;
  aiEvents: NonNullable<Course["aiInteractionEvents"]>;
  documentVersions: NonNullable<Course["projectDocumentVersions"]>;
  externalVersions: ProjectPdfVersion[];
  signals: NonNullable<Course["learningSignals"]>;
  completion: number;
  submitted: boolean;
  dialogueRounds: number;
  updatedAt: string;
};

function latestTimestamp(values: Array<string | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? "";
}

function latestExternalVersion(versions: ProjectPdfVersion[]): ProjectPdfVersion | undefined {
  return versions.reduce<ProjectPdfVersion | undefined>((latest, version) => {
    if (!latest) return version;
    if (version.sequence !== latest.sequence) return version.sequence > latest.sequence ? version : latest;
    return version.createdAt > latest.createdAt ? version : latest;
  }, undefined);
}

export function AiCollaborationTeacherMonitor({ course, focus }: { course: Course; focus?: Extract<TeacherStageFocus, { stageKey: "make" }> }) {
  const artifactMode = normalizePblCourseConfig(course.pblConfig).makeArtifactMode;
  const isNewSystem = inferStageCollectionMode(course.stages) === "new";
  const rows = useMemo<StudentRow[]>(() => course.students.map((student) => {
    const artifact = latestArtifactForStudent(course, student.id, artifactMode === "other", isNewSystem);
    const persistedAiEvents = (course.aiInteractionEvents ?? []).filter((item) =>
      item.stageKey === "make"
      && item.studentId === student.id
      && (artifactMode === "other"
        ? payloadRecord(item.payload).workspaceKind === "external-artifact"
        : payloadRecord(item.payload).workspaceKind !== "external-artifact"));
    const aiEvents = artifactMode === "other" && !persistedAiEvents.length
      ? externalThreadEvents(course, student.id)
      : persistedAiEvents;
    const documentVersions = (course.projectDocumentVersions ?? []).filter((item) =>
      item.stageKey === "make" && item.studentId === student.id);
    const externalVersions = (course.projectPdfVersions ?? []).filter((item) =>
      item.stageKey === "make" && item.studentId === student.id);
    const signals = (course.learningSignals ?? []).filter((item) =>
      item.stageKey === "make" && item.studentId === student.id && item.status === "open");
    const submitted = externalVersions.some((item) => item.status === "submitted")
      || documentVersions.some((item) => item.status === "submitted")
      || Boolean(artifact?.files?.length && artifactMode !== "other");
    const completion = submitted ? 100 : artifact ? 75 : aiEvents.length ? 35 : 0;
    const dialogueRounds = deriveAiCollaborationMetrics(aiEvents).dialogueRounds;
    return {
      student,
      artifact,
      aiEvents,
      documentVersions,
      externalVersions,
      signals,
      completion,
      submitted,
      dialogueRounds,
      updatedAt: latestTimestamp([
        artifact?.updatedAt,
        ...aiEvents.map((item) => item.createdAt),
        ...documentVersions.map((item) => item.submittedAt ?? item.createdAt),
        ...externalVersions.map((item) => item.submittedAt ?? item.createdAt),
        ...signals.map((item) => item.lastDetectedAt),
      ]),
    };
  }), [artifactMode, course, isNewSystem]);
  const [selectedStudentId, setSelectedStudentId] = useState<string>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "unsubmitted" | "attention">("all");
  const [sort, setSort] = useState<"updated" | "completion">("updated");
  const [focusTarget, setFocusTarget] = useState<"artifact" | "conversation" | "signal" | null>(null);
  const visibleRows = useMemo(() => rows
    .filter((row) => row.student.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .filter((row) => filter === "unsubmitted" ? !row.submitted : filter === "attention" ? row.signals.length > 0 || (!row.artifact && !row.externalVersions.length) : true)
    .sort((left, right) => sort === "completion"
      ? left.completion - right.completion || right.updatedAt.localeCompare(left.updatedAt)
      : right.updatedAt.localeCompare(left.updatedAt) || left.student.name.localeCompare(right.student.name, "zh-CN")),
  [filter, query, rows, sort]);
  const selected = rows.find((row) => row.student.id === selectedStudentId)
    ?? rows.find((row) => row.artifact || row.externalVersions.length)
    ?? rows[0];

  useEffect(() => {
    if (focus) {
      setSelectedStudentId(focus.studentId);
      setFocusTarget(focus.section);
    }
  }, [focus?.studentId, focus?.section]);

  useEffect(() => {
    if (!selected || !focusTarget) return;
    const timer = window.setTimeout(() => {
      document.getElementById(`practice-${focusTarget}-${selected.student.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      setFocusTarget(null);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [focusTarget, selected]);

  return (
    <div className="classroom-stage space-y-4">
      <StagePageHeader
        action={(
          <div className="flex flex-wrap items-center justify-end gap-2">
            <MakeArtifactModeSetting course={course} />
            <a
              className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--pbl-border)] bg-white px-3 text-xs font-semibold text-[var(--pbl-text-muted)] transition hover:border-[var(--pbl-teacher-border)] hover:text-[var(--pbl-teacher)]"
              download
              href={`/api/project-practice/export?courseId=${encodeURIComponent(course.id)}`}
            >
              <Download size={14} />导出过程档案
            </a>
          </div>
        )}
        description="查看学生成果与 AI 协作进度，优先处理尚未形成成果的学生。"
        title="项目实践进度"
      />

      <Card className="classroom-panel p-0">
        <div className="grid min-h-[34rem] lg:grid-cols-[19rem_minmax(0,1fr)]">
          <aside className="min-w-0 rounded-t-[var(--radius-md)] border-b border-[var(--pbl-border)] bg-stone-50/95 lg:rounded-l-[var(--radius-md)] lg:rounded-tr-none lg:border-b-0 lg:border-r">
            <div className="p-4 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)]">
            <div className="flex items-center justify-between gap-3"><h2 className="font-bold text-[var(--pbl-text-strong)]">学生列表</h2><Pill tone="gray">{rows.length} 人</Pill></div>
            <div className="mt-3 grid gap-2">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" size={14} />
                <input aria-label="搜索学生" className="h-9 w-full rounded-lg border border-stone-200 bg-white pl-9 pr-3 text-xs outline-none focus:border-blue-400" onChange={(event) => setQuery(event.target.value)} placeholder="搜索学生姓名" value={query} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="relative"><span className="sr-only">筛选学生</span><select aria-label="筛选学生" className="h-9 w-full appearance-none rounded-lg border border-stone-200 bg-white px-2.5 pr-7 text-xs font-semibold text-stone-700" onChange={(event) => setFilter(event.target.value as typeof filter)} value={filter}><option value="all">全部学生</option><option value="unsubmitted">未提交</option><option value="attention">需关注</option></select><ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-stone-400" size={13} /></label>
                <label className="relative"><span className="sr-only">学生排序</span><ArrowUpDown className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-stone-400" size={12} /><select aria-label="学生排序" className="h-9 w-full appearance-none rounded-lg border border-stone-200 bg-white pl-7 pr-6 text-xs font-semibold text-stone-700" onChange={(event) => setSort(event.target.value as typeof sort)} value={sort}><option value="updated">最近更新</option><option value="completion">完成度</option></select><ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-stone-400" size={13} /></label>
              </div>
            </div>
            <div className="mt-3 max-h-[calc(100dvh-15rem)] min-h-72 space-y-1.5 overflow-y-auto overscroll-contain pr-1">
              {visibleRows.map((row) => (
                <button
                  className={cn("w-full rounded-[var(--radius-sm)] border px-3 py-2.5 text-left transition", selected?.student.id === row.student.id ? "border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)]/70" : "border-[var(--pbl-border)] bg-white hover:border-[var(--pbl-teacher-border)]")}
                  key={row.student.id}
                  onClick={() => setSelectedStudentId(row.student.id)}
                  type="button"
                >
                  <div className="flex items-center justify-between gap-2"><span className="truncate font-semibold text-stone-900">{row.student.name}</span><span className="text-[11px] font-black tabular-nums text-stone-500">{row.completion}%</span></div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-stone-100"><span className={cn("block h-full rounded-full", row.completion === 100 ? "bg-emerald-500" : row.signals.length ? "bg-amber-500" : "bg-blue-500")} style={{ width: `${row.completion}%` }} /></div>
                  <div className="mt-2 flex min-w-0 items-center justify-between gap-2"><p className="truncate text-[11px] text-[var(--pbl-text-muted)]">{row.artifact?.title ?? latestExternalVersion(row.externalVersions)?.title ?? "尚未形成成果"}</p>{row.signals.length ? <Pill size="sm" tone="red">需关注</Pill> : <Pill size="sm" tone={row.submitted ? "green" : "gray"}>{row.submitted ? "已提交" : "未提交"}</Pill>}</div>
                  {isNewSystem ? <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-stone-400"><span>AI 对话 {row.dialogueRounds} 轮</span><span>{row.updatedAt ? `更新 ${new Date(row.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "暂无更新"}</span></div> : null}
                </button>
              ))}
              {!rows.length ? <StageEmptyState description="学生加入课堂后，成果会显示在这里。" title="暂无学生进入课堂" /> : null}
              {rows.length && !visibleRows.length ? <StageEmptyState description="可清除搜索词或切换筛选条件。" title="没有匹配的学生" /> : null}
            </div>
            </div>
          </aside>
          <section className="min-w-0 p-4 md:p-5">
            {selected ? (
              <ArtifactPreview
                aiEvents={selected.aiEvents}
                artifact={selected.artifact}
                documentVersions={selected.documentVersions}
                externalVersions={selected.externalVersions}
                artifactMode={artifactMode}
                courseId={course.id}
                studentId={selected.student.id}
                studentName={selected.student.name}
                signals={selected.signals}
              />
            ) : <StageEmptyState description="从左侧学生列表选择一名学生查看成果。" title="暂无可查看的学习成果" />}
          </section>
        </div>
      </Card>
    </div>
  );
}

function ArtifactPreview({
  artifact,
  studentName,
  aiEvents,
  documentVersions,
  externalVersions,
  courseId,
  studentId,
  signals,
  artifactMode,
}: {
  artifact?: ClassroomSubmission;
  studentName: string;
  aiEvents: Course["aiInteractionEvents"];
  documentVersions: Course["projectDocumentVersions"];
  externalVersions: ProjectPdfVersion[];
  courseId: string;
  studentId: string;
  signals: NonNullable<Course["learningSignals"]>;
  artifactMode: "document" | "other" | "python" | "c";
}) {
  const code = artifact?.type === "code" ? parseCodeArtifact(artifact.content) : null;
  const externalBrief = artifact?.type === "artifact-brief" ? artifact : undefined;
  const metrics = deriveAiCollaborationMetrics(aiEvents ?? []);
  const interactionTurns = metrics.turns;
  const displayedInteractionTurns = [...interactionTurns].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || right.sequence - left.sequence
  );
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200 pb-4">
        <div><p className="text-xs font-semibold text-[var(--pbl-ai)]">{studentName} · {artifactMode === "other" ? "其他成果" : artifactMode === "python" ? "Python 代码" : artifactMode === "c" ? "C 语言代码" : "文档成果"}</p><h3 className="mt-1 text-xl font-bold text-[var(--pbl-text-strong)]">{artifactMode === "other" ? "成果协作稿与本地成果" : artifact?.title ?? "尚未保存学习成果"}</h3>{artifact ? <p className="mt-1 flex items-center gap-1 text-xs text-[var(--pbl-text-muted)]"><Clock3 size={13} />最近保存：{new Date(artifact.updatedAt).toLocaleString("zh-CN")}</p> : <p className="mt-1 text-xs text-[var(--pbl-text-muted)]">仍可查看该学生已经发生的 AI 协作过程。</p>}</div>
        <div className="flex flex-wrap justify-end gap-2">
          <Pill tone="blue"><Bot size={13} />AI 主动建议 {metrics.proactiveSuggestions}</Pill>
          <Pill tone="gray"><MessageSquareText size={13} />学生对话 {metrics.dialogueRounds} 轮</Pill>
          <Pill tone={metrics.boundaryTriggers ? "red" : "green"}><ShieldAlert size={13} />边界触发 {metrics.boundaryTriggers} 次</Pill>
          {externalVersions.length ? <Pill tone={externalVersions.some((version) => version.status === "submitted") ? "green" : "gray"}>本地成果 {externalVersions.filter((version) => version.status === "submitted").length} 版</Pill> : null}
          {documentVersions?.length ? <Pill tone="green">Word 成果 {documentVersions.filter((version) => version.status === "submitted").length} 版</Pill> : null}
          <a className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-stone-700 hover:border-blue-300 hover:text-blue-700" download href={`/api/project-practice/export?courseId=${encodeURIComponent(courseId)}&studentId=${encodeURIComponent(studentId)}`}><Download size={13} />导出该生 JSON</a>
        </div>
      </div>
      {signals.length ? (
        <section className="mt-4 rounded-xl border border-amber-200 bg-amber-50/70 p-4" id={`practice-signal-${studentId}`}>
          <div className="flex items-center justify-between gap-3"><h4 className="flex items-center gap-2 text-sm font-bold text-amber-950"><AlertTriangle size={16} />需关注问题</h4><Pill tone="red">{signals.length} 条</Pill></div>
          <ul className="mt-2 space-y-2">{signals.map((signal) => <li className="rounded-lg bg-white/80 px-3 py-2" key={signal.id}><strong className="text-xs text-amber-950">{signal.title}</strong><p className="mt-1 text-xs leading-5 text-stone-600">{signal.summary}</p></li>)}</ul>
        </section>
      ) : null}
      <div id={`practice-artifact-${studentId}`}>
      {!artifact ? (
        <div className="mt-4 rounded-xl border border-dashed border-stone-300 bg-stone-50 px-5 py-8 text-center text-sm text-stone-500">该生尚未保存{artifactMode === "other" ? "成果协作稿" : artifactMode === "python" || artifactMode === "c" ? "代码成果" : "文档成果"}。</div>
      ) : code ? (
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-bold text-stone-800"><FileCode2 size={17} className="text-[var(--pbl-teacher)]" />{code.language === "python" ? "Python" : "C"} · {code.files.length} 个文件</div>
          {code.files.map((file) => <section className="overflow-hidden rounded-xl border border-stone-800 bg-stone-950" key={file.id}><header className="border-b border-stone-800 px-4 py-2 font-mono text-xs text-stone-300">{file.path}</header><pre className="max-h-80 overflow-auto p-4 text-xs leading-6 text-stone-100"><code>{file.content}</code></pre></section>)}
        </div>
      ) : externalBrief ? (
        <div className="mt-4 rounded-xl border border-[var(--pbl-student-border)] bg-[color-mix(in_srgb,var(--pbl-student-soft)_35%,white)] p-5"><div className="mb-3 flex items-center justify-between gap-3"><div className="flex items-center gap-2 text-sm font-bold text-stone-800"><FileText size={17} className="text-[var(--pbl-student)]" />成果协作稿实时预览</div><span className="text-[10px] text-[var(--pbl-text-muted)]">仅展示学生在平台维护的工作稿</span></div><RichDocumentPreview className="max-h-[34rem] overflow-auto rounded-lg bg-white p-4" html={externalBrief.content} minHeight={160} /></div>
      ) : artifact && artifactMode === "document" ? (
        <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-5"><div className="mb-3 flex items-center gap-2 text-sm font-bold text-stone-800"><FileText size={17} className="text-blue-600" />富文档实时预览</div><RichDocumentPreview className="max-h-[30rem] overflow-auto rounded-lg bg-white p-4" html={artifact.content} minHeight={160} /></div>
      ) : null}
      {artifact?.files?.length ? (
        <section className="mt-4 rounded-xl border border-blue-200 bg-blue-50/55 p-4">
          <div className="flex items-center justify-between gap-3"><h4 className="flex items-center gap-2 text-sm font-bold text-blue-950"><FolderDown size={16} />学生提交的本地成果文件</h4><span className="text-[10px] font-semibold text-blue-700">仅收集与下载，不要求在线预览</span></div>
          <ul className="mt-3 space-y-2">{artifact.files.map((file) => {
            const canOpen = isBrowserOpenableArtifact(file.name, file.type);
            return <li className="flex items-center justify-between gap-3 rounded-lg border border-blue-100 bg-white px-3 py-2.5" key={`${file.name}-${file.url}`}><div className="min-w-0"><strong className="block truncate text-xs text-stone-900">{file.name}</strong><span className="mt-0.5 block text-[10px] text-stone-500">{file.type || "外部文件"}{file.size ? ` · ${file.size}` : ""} · {canOpen ? "可打开查看" : "暂不支持在线预览"}</span></div>{file.url ? <div className="flex shrink-0 items-center gap-2">{canOpen ? <a className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-bold text-blue-700 hover:bg-blue-50" href={file.url} rel="noreferrer" target="_blank">打开</a> : null}<a className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-800" download href={file.url}><Download size={13} />下载</a></div> : null}</li>;
          })}</ul>
        </section>
      ) : null}
      {externalVersions.length ? (
        <section className="mt-4 rounded-xl border border-[var(--pbl-student-border)] bg-[color-mix(in_srgb,var(--pbl-student-soft)_28%,white)] p-4" id={`practice-upload-${studentId}`}>
          <div className="flex items-center justify-between gap-3"><h4 className="flex items-center gap-2 text-sm font-bold text-[var(--pbl-text-strong)]"><FolderDown size={16} />学生上传的本地成果版本</h4><span className="text-[10px] text-[var(--pbl-text-muted)]">只收集文件信息，不解析内容</span></div>
          <ul className="mt-3 space-y-2">{[...externalVersions].sort((left, right) => right.sequence - left.sequence).map((version) => { const name = version.title; const lower = name.toLocaleLowerCase(); const openable = lower.endsWith(".pdf") || lower.endsWith(".doc") || lower.endsWith(".docx"); const url = `/api/uploads/${encodeURIComponent(version.uploadId)}`; return <li className="flex flex-col gap-2 rounded-lg border border-[var(--pbl-student-border)]/70 bg-white px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between" key={version.id}><div className="min-w-0"><strong className="block truncate text-xs text-stone-900">第 {version.sequence} 版 · {name}</strong><span className="mt-0.5 block text-[10px] text-stone-500">{version.mimeType || "成果文件"}{version.size ? ` · ${(version.size / (1024 * 1024)).toFixed(1)} MB` : ""} · {new Date(version.submittedAt).toLocaleString("zh-CN")} · {openable ? "可打开查看" : "暂不支持在线预览"}</span></div><div className="flex shrink-0 items-center gap-2">{openable ? <a className="rounded-lg border border-[var(--pbl-student-border)] px-3 py-1.5 text-xs font-semibold text-[var(--pbl-student)] hover:bg-[var(--pbl-student-soft)]" href={url} rel="noreferrer" target="_blank">打开</a> : null}<a className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--pbl-student)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--pbl-student-hover)]" download href={`${url}?download=1`}><Download size={13} />下载</a></div></li>; })}</ul>
        </section>
      ) : null}
      </div>
      {documentVersions?.length ? (
        <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
          <div className="flex items-center justify-between gap-2"><p className="text-sm font-bold text-emerald-950">Word 提交版本</p><span className="text-[10px] text-emerald-700">保留每次提交</span></div>
          <div className="mt-2 space-y-1.5">
            {[...documentVersions].sort((a, b) => b.sequence - a.sequence).map((version) => (
              <div className="flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-xs" key={version.id}>
                <span className="text-stone-700">第 {version.sequence} 版 · {new Date(version.submittedAt ?? version.createdAt).toLocaleString("zh-CN")}</span>
                {version.docxUploadId ? <a className="font-semibold text-emerald-700 hover:underline" download href={`/api/uploads/${version.docxUploadId}?download=1`}>下载 Word</a> : version.status === "failed" ? <span className="text-rose-700">生成失败</span> : <span className="text-amber-700">生成中</span>}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {interactionTurns.length ? (
        <div className="mt-4 rounded-xl border border-stone-200 bg-white p-4" id={`practice-conversation-${studentId}`}>
          <div className="flex items-center justify-between gap-3"><p className="flex items-center gap-2 text-sm font-bold text-stone-800"><MessageSquareText size={16} className="text-blue-600" />学生与 AI 协作对话</p><span className="text-[10px] text-stone-500">按上下文对话轮完整展示</span></div>
          <div className="mt-3 max-h-[42rem] space-y-4 overflow-auto pr-1">
            {displayedInteractionTurns.map((turn) => (
              <section className="rounded-xl border border-stone-200 bg-stone-50/70 p-3" key={`${turn.conversationId}-${turn.sequence}`}>
                <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-stone-500">
                  <div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-blue-100 px-2 py-0.5 font-semibold text-blue-800">{turn.locationLabel}</span><span>第 {turn.turn} 轮对话 · {turn.messages.length} 条消息</span></div>
                  <time>{new Date(turn.occurredAt).toLocaleString("zh-CN")}</time>
                </div>
                {turn.context?.targetText ? <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-stone-700"><span className="font-semibold text-amber-800">{turn.context.issueType ? `${turn.context.issueType} · ` : ""}批注对象：</span>{turn.context.targetText}</div> : null}
                <div className="mt-3 space-y-2">
                  {turn.messages.map((message) => (
                    <div key={message.id}>
                      <div className={cn(
                        "max-w-[88%] rounded-xl px-3 py-2.5 text-xs leading-5",
                        message.role === "student"
                          ? "ml-auto rounded-br-sm bg-stone-900 text-white"
                          : message.error
                            ? "rounded-bl-sm bg-rose-50 text-rose-700"
                            : "rounded-bl-sm border border-stone-200 bg-white text-stone-800",
                      )}>
                        <p className={cn("mb-1 flex items-center gap-1 text-[10px]", message.role === "student" ? "justify-end text-stone-300" : message.error ? "text-rose-600" : "font-semibold text-blue-700")}>
                          {message.role === "student" ? <><UserRound size={11} />学生</> : <><Bot size={11} />{message.error ? "系统" : "AI 组员"}</>}
                          <time className="ml-1 opacity-70">{new Date(message.occurredAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
                        </p>
                        <div className={cn(message.role === "student" && "[&_a]:text-sky-200 [&_blockquote]:text-stone-200 [&_code]:text-stone-100")}>
                          <AiMemberMarkdown content={message.content} />
                        </div>
                      </div>
                      {message.modification ? <div className="mt-2 rounded-lg border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)]/70 p-3 text-xs text-stone-900"><div className="flex flex-wrap items-center justify-between gap-2"><strong>AI 修改 · {message.modification.title ?? (message.modification.type === "work-delivery" ? "组员交付" : "局部建议")}</strong><span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold">{message.modification.undoneAt ? "已撤销" : message.modification.decision === "adopted" ? "学生已采用" : message.modification.decision === "revision" ? "已退回修改" : message.modification.decision === "rejected" ? "学生未采用" : "等待决定"}</span></div>{message.modification.targetText ? <div className="mt-2 rounded-md bg-rose-50 px-2.5 py-2"><span className="font-semibold text-rose-700">原内容：</span><span className="whitespace-pre-wrap text-stone-700">{message.modification.targetText}</span></div> : null}{message.modification.replacement ? <div className="mt-1.5 rounded-md bg-emerald-50 px-2.5 py-2"><span className="font-semibold text-emerald-700">AI 建议：</span><span className="whitespace-pre-wrap text-stone-700">{message.modification.replacement}</span></div> : null}{message.modification.decisionSummary ? <p className="mt-2 text-[11px] text-[var(--pbl-teacher)]">{message.modification.decisionSummary}</p> : null}</div> : null}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      ) : <div className="mt-4 rounded-xl border border-dashed border-stone-300 px-4 py-8 text-center text-sm text-stone-500">尚无学生与 AI 的协作对话。</div>}
    </div>
  );
}

function isBrowserOpenableArtifact(fileName: string, mimeType: string): boolean {
  const normalizedName = fileName.toLocaleLowerCase();
  const normalizedMime = mimeType.toLocaleLowerCase();
  return normalizedMime.includes("pdf")
    || normalizedMime.includes("word")
    || normalizedMime.includes("officedocument.wordprocessingml")
    || normalizedName.endsWith(".pdf")
    || normalizedName.endsWith(".doc")
    || normalizedName.endsWith(".docx");
}
