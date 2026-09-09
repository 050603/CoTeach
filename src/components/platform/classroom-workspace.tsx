"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BookOpen, FolderOpen, MessagesSquare, Award, ArrowLeft } from "lucide-react";
import { TeacherPlatformHeader, TeacherPlatformPage } from "./teacher-shell";
import { StudentShell } from "./student-shell";
import { readTemplateContent } from "@/lib/platform/template-content";

type Classroom = {
  participation: { id: string; completedAt: string | null };
  student: { displayName: string };
  instance: { id: string; status: string; activityId: string; offeringId: string; offeringName: string; title: string; runNo: number; templateVersion: number; snapshot: unknown };
  workspace: { version: number; projectState: { document?: string; code?: string; stageKey?: string } | null };
  isTeacher: boolean; canWrite: boolean;
};
type Outcomes = {
  submissions: Array<{ id: string; stageKey: string; submittedAt: string }>;
  artifacts: Array<{ id: string; title: string; versions: Array<{ id: string; sequence: number; sourceHtml: string | null }> }>;
  reflections: Array<{ id: string; content: string }>;
  evaluations: Array<{ id: string; evaluatorType: string; content: string; score: string | number | null }>;
  showcases: Array<{ id: string; artifactId: string; artifactVersionId: string | null }>;
};
type AiState = {
  conversations: Array<{ id: string; title: string; status: string; messages: Array<{ id: string; role: string; content: string }>; tasks: Array<{ id: string; status: string; error: string | null; confirmation?: { id: string; status: string } | null }> }>;
  supportRecords: Array<{ id: string; summary: string; status: string }>;
};
const field = "mt-2 w-full rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-3 text-sm";
const button = "min-h-11 rounded-xl border border-[var(--pbl-border)] px-4 py-2 text-sm font-medium disabled:opacity-50";

async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? "请求失败，请重试");
  return data as T;
}

function WorkspaceShell({ role, children }: { role: "teacher" | "student"; children: ReactNode }) {
  return role === "teacher" ? <TeacherPlatformPage><TeacherPlatformHeader active="classes"/><div className="pbl-workspace-content">{children}</div></TeacherPlatformPage> : <StudentShell>{children}</StudentShell>;
}

export function ClassroomWorkspace({ participationId, role = "student" }: { participationId: string; role?: "teacher" | "student" }) {
  const base = `/api/platform/participations/${participationId}`;
  const [classroom, setClassroom] = useState<Classroom | null>(null);
  const [outcomes, setOutcomes] = useState<Outcomes | null>(null);
  const [ai, setAi] = useState<AiState | null>(null);
  const [document, setDocument] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState("0");
  const [answer, setAnswer] = useState("");
  const [reflection, setReflection] = useState("");
  const [message, setMessage] = useState("");
  const [score, setScore] = useState("");
  const [feedback, setFeedback] = useState("");
  const [tab, setTab] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [selectedConversation, setSelectedConversation] = useState("");
  // A failed transport can have committed; retain the key for an identical retry.
  const [pending, setPending] = useState<{ signature: string; key: string } | null>(null);
  const load = useCallback(async () => {
    const [current, results, conversations] = await Promise.all([request<Classroom>(base), request<Outcomes>(`${base}/outcomes`), request<AiState>(`${base}/ai`)]);
    setError(""); setClassroom(current); setOutcomes(results); setAi(conversations);
    setDocument(current.workspace.projectState?.document ?? ""); setCode(current.workspace.projectState?.code ?? ""); setStage(current.workspace.projectState?.stageKey ?? "0");
    setDirty(false);
  }, [base]);
  useEffect(() => { const controller = { cancelled: false }; queueMicrotask(() => { if (!controller.cancelled) void load().catch((reason: Error) => setError(reason.message)); }); return () => { controller.cancelled = true; }; }, [load]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function mutate(path: string, data: Record<string, unknown>, method = "POST") {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    const signature = JSON.stringify([path, data]);
    const receipt = pending?.signature === signature ? pending : { signature, key: crypto.randomUUID() };
    setPending(receipt);
    try {
      const result = await request<{ version?: number }>(`${base}${path}`, method, { ...data, idempotencyKey: receipt.key });
      setPending(null);
      if (path === "") { setClassroom((current) => current ? { ...current, workspace: { ...current.workspace, version: result.version ?? current.workspace.version } } : current); setDirty(false); }
      else if (path === "/ai") { setAi(result as unknown as AiState); setMessage(""); }
      else { setOutcomes(await request<Outcomes>(`${base}/outcomes`)); }
      setNotice("已保存");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败，请重试"); }
    finally { setBusy(false); }
  }
  if (!classroom) return <WorkspaceShell role={role}><div className="rounded-2xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-8"><p role={error ? "alert" : "status"}>{error || "正在加载课堂…"}</p>{error ? <button className={`${button} mt-4`} onClick={() => { setError(""); void load().catch((e: Error) => setError(e.message)); }}>重试</button> : <div className="mt-6 h-48 rounded-xl bg-[var(--pbl-bg)] motion-safe:animate-pulse"/>}</div></WorkspaceShell>;
  const teacher = classroom.isTeacher;
  const activeTab = tab ?? (teacher || classroom.instance.status.toLowerCase() === "finished" ? "outcomes" : "lesson");
  const content = readTemplateContent(classroom.instance.snapshot);
  const active = ai?.conversations.find((item) => item.id === selectedConversation) ?? ai?.conversations.find((item) => item.status === "OPEN") ?? ai?.conversations[0];
  const canWrite = classroom.canWrite && !busy;
  const sections = content?.outline ?? [];
  const back = teacher ? `/teacher/classrooms/${classroom.instance.id}` : `/student/activities/${classroom.instance.activityId}`;
  return <WorkspaceShell role={teacher ? "teacher" : "student"}>
    <Link className="mb-5 inline-flex min-h-11 items-center gap-2 text-sm text-[var(--pbl-text-muted)]" href={back}><ArrowLeft size={16}/>返回{teacher ? "课堂学习记录" : "课程活动"}</Link>
    <header className="rounded-2xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-6 shadow-sm md:p-8"><div className="flex flex-wrap items-start justify-between gap-5"><div className="min-w-0"><p className="text-xs font-medium text-[var(--pbl-text-muted)]">{classroom.instance.offeringName} · 第 {classroom.instance.runNo} 次课堂</p><h1 className="mt-3 break-words font-serif text-3xl font-semibold">{teacher ? `${classroom.student.displayName}的学习档案` : classroom.instance.title}</h1><p className="mt-3 text-sm text-[var(--pbl-text-muted)]">{teacher ? classroom.instance.title : `${classroom.student.displayName} · 记录探索，积累成长`}</p></div><span className="rounded-full bg-[var(--pbl-bg)] px-4 py-2 text-xs font-medium">{classroom.instance.status === "teaching" ? "授课中" : "只读回顾"}</span></div><dl className="mt-6 grid grid-cols-3 gap-3 border-t border-[var(--pbl-border)] pt-5">{[["项目成果", outcomes?.artifacts.length ?? 0], ["学习反思", outcomes?.reflections.length ?? 0], ["成长评价", outcomes?.evaluations.length ?? 0]].map(([label, value]) => <div key={label}><dt className="text-xs text-[var(--pbl-text-muted)]">{label}</dt><dd className="mt-2 text-2xl font-semibold tabular-nums">{value}</dd></div>)}</dl></header>
    <nav aria-label="课堂工具" className="my-6 grid grid-cols-2 gap-2 rounded-2xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-2 md:grid-cols-4">{[{key: "lesson", label: "课堂任务", icon: BookOpen}, {key: "workspace", label: "项目工作区", icon: FolderOpen}, {key: "ai", label: "AI 协作", icon: MessagesSquare}, {key: "outcomes", label: "成果与评价", icon: Award}].map(({key, label, icon: Icon}) => <button key={key} className={`flex min-h-12 items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${activeTab === key ? teacher ? "bg-[var(--pbl-teacher)] text-white shadow-sm" : "bg-[var(--pbl-student)] text-white shadow-sm" : "text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-bg)]"}`} aria-pressed={activeTab === key} onClick={() => setTab(key)}><Icon size={17}/>{label}</button>)}</nav>
    {error && <p role="alert" className="my-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-[var(--pbl-danger)]">{error}</p>}{notice && <p role="status" className="my-4 rounded-xl bg-[var(--pbl-student-soft)] p-4 text-sm">{notice}</p>}
    {activeTab === "lesson" && <section className="space-y-6 rounded-2xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-5 shadow-sm md:p-8"><h2 className="text-xl font-semibold">学习目标</h2>{content ? <><p className="whitespace-pre-wrap leading-8">{content.summary}</p><ul className="list-disc space-y-2 pl-6">{content.learningObjectives.map((objective, index) => <li key={index}>{objective}</li>)}</ul>{sections.map((section, index) => <article key={index} className="border-t border-[var(--pbl-border)] pt-5"><h3 className="font-semibold">{index + 1}. {section.title} · {section.durationMinutes} 分钟</h3><p className="mt-3 whitespace-pre-wrap leading-8">{section.description}</p><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">{outcomes?.submissions.some((item) => item.stageKey === String(index)) ? "已提交本环节记录" : "待完成"}</p></article>)}{content.resources.map((resource, index) => <p key={index}>{/^https?:\/\//i.test(resource.url) ? <a href={resource.url} target="_blank" rel="noreferrer" className="underline">{resource.title}</a> : resource.title}</p>)}</> : <p>本次课堂的学习过程与作品可在成果与评价中回顾。</p>}
      {!teacher && classroom.canWrite && <form className="space-y-3 border-t pt-5" onSubmit={(event) => { event.preventDefault(); void mutate("/outcomes", { action: "submit_stage", stageKey: stage, payload: { answer } }); }}><label className="block">当前环节<select value={stage} onChange={(event) => setStage(event.target.value)} className={field}>{sections.length ? sections.map((section, index) => <option key={index} value={index}>{section.title}</option>) : <option value="0">课堂任务</option>}</select></label><label className="block">本环节发现与完成记录<textarea required value={answer} maxLength={30000} onChange={(event) => setAnswer(event.target.value)} className={`${field} min-h-32`} /></label><button disabled={!canWrite} className={button}>提交环节记录</button></form>}
    </section>}
    {activeTab === "workspace" && <section className="space-y-5 rounded-2xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-5 shadow-sm md:p-8"><h2 className="text-xl font-semibold">项目工作区</h2><label className="block">项目文档<textarea readOnly={teacher || !classroom.canWrite} value={document} maxLength={200000} onChange={(event) => { setDocument(event.target.value); setDirty(true); }} className={`${field} min-h-64`} /></label><label className="block">网页作品 HTML<textarea readOnly={teacher || !classroom.canWrite} value={code} maxLength={200000} onChange={(event) => { setCode(event.target.value); setDirty(true); }} className={`${field} min-h-48 font-mono`} /></label>{!teacher && classroom.canWrite && <button className={`${button} bg-[var(--pbl-student)] text-white`} disabled={!canWrite || !dirty} onClick={() => void mutate("", { version: classroom.workspace.version, document, code, stageKey: stage }, "PATCH")}>{busy ? "保存中…" : dirty ? "保存工作区" : "工作区已保存"}</button>}<p className="text-sm">保存版本 {classroom.workspace.version}。发生版本冲突时，请先复制当前文字，再重新加载。</p><button className={button} disabled={busy} onClick={() => {
      if (dirty) {
        const url = URL.createObjectURL(new Blob([JSON.stringify({ document, code, stageKey: stage }, null, 2)], { type: "application/json" }));
        const anchor = window.document.createElement("a"); anchor.href = url; anchor.download = `课堂草稿-${participationId}.json`; anchor.click(); URL.revokeObjectURL(url);
      }
      void load().catch((reason: Error) => setError(reason.message));
    }}>{dirty ? "保存本地副本并重新加载" : "重新加载"}</button>{code && <iframe title="网页作品预览" sandbox="" srcDoc={code} className="h-96 w-full rounded-[6px] border" />}</section>}
    {activeTab === "ai" && <section className="space-y-5 rounded-2xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-5 shadow-sm md:p-8"><h2 className="text-xl font-semibold">AI 协作与教师求助</h2><div className="flex flex-wrap gap-2">{ai?.conversations.map((conversation) => <button key={conversation.id} className={button} onClick={() => setSelectedConversation(conversation.id)}>{conversation.title}{conversation.status === "CLOSED" ? "（已结束）" : ""}</button>)}{!teacher && classroom.canWrite && <button className={button} disabled={!canWrite} onClick={() => { setSelectedConversation(""); void mutate("/ai", { op: "create_conversation", title: `项目讨论 ${(ai?.conversations.length ?? 0) + 1}` }); }}>新建讨论</button>}</div>
      {!active && <div className="rounded-xl bg-[var(--pbl-bg)] p-6 text-sm text-[var(--pbl-text-muted)]">{teacher || !classroom.canWrite ? "本次课堂还没有协作讨论记录。" : "新建一段讨论，梳理你的想法，或向教师发起求助。"}</div>}{active && <><div className="space-y-4">{active.messages.map((entry) => <article key={entry.id} className="border-l-2 border-[var(--pbl-border)] pl-4"><p className="text-sm font-semibold">{entry.role === "assistant" ? "AI 学习助手" : "学生"}</p><p className="mt-2 whitespace-pre-wrap leading-7">{entry.content}</p></article>)}</div>{active.tasks.filter((task) => task.status === "FAILED" || task.status === "RUNNING").map((task) => <p key={task.id} role="status">{task.status === "FAILED" ? `生成未完成：${task.error ?? "请重新发送"}` : "正在生成，可稍后刷新查看结果"}</p>)}{active.tasks.filter((task) => task.confirmation?.status === "PENDING").map((task) => <div key={task.id}><p>有一条协作建议等待确认</p>{!teacher && classroom.canWrite && ["APPROVED", "REJECTED"].map((decision) => <button key={decision} className={button} disabled={!canWrite} onClick={() => void mutate("/ai", { op: "decide_action", conversationId: active.id, confirmationId: task.confirmation!.id, decision })}>{decision === "APPROVED" ? "采纳" : "不采纳"}</button>)}</div>)}</>}
      {!teacher && classroom.canWrite && <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (active) void mutate("/ai", { op: "send_message", conversationId: active.id, content: message }); }}><label className="block">问题或想法<textarea required maxLength={12000} className={`${field} min-h-28`} value={message} onChange={(event) => setMessage(event.target.value)} /></label><div className="flex flex-wrap gap-2"><button disabled={!canWrite || !active || active.status !== "OPEN"} className={button}>发送给 AI</button><button type="button" disabled={!canWrite || !message.trim()} className={button} onClick={() => void mutate("/ai", { op: "create_support", summary: message.slice(0, 4000) })}>向教师求助</button>{active && <button type="button" className={button} disabled={!canWrite || !message.trim() || active.status !== "OPEN"} onClick={() => void mutate("/ai", { op: "request_action", conversationId: active.id, content: message.slice(0, 4000) })}>记录待确认方案</button>}</div></form>}
      <button className={button} disabled={busy} onClick={() => void request<AiState>(`${base}/ai`).then(setAi).catch((reason: Error) => setError(reason.message))}>刷新对话状态</button>
      {ai?.supportRecords.map((support) => <article key={support.id} className="border-t py-4"><p className="whitespace-pre-wrap">{support.summary}</p><p className="text-sm">{support.status === "RESOLVED" ? "已处理" : "等待教师处理"}</p>{teacher && support.status === "OPEN" && <button className={button} disabled={busy} onClick={() => void mutate("/ai", { op: "resolve_support", supportId: support.id })}>标记已处理</button>}</article>)}
    </section>}
    {activeTab === "outcomes" && <section className="space-y-6 rounded-2xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-5 shadow-sm md:p-8"><h2 className="text-xl font-semibold">成果、反思与评价</h2><p className="text-sm leading-7 text-[var(--pbl-text-muted)]">回看实践过程中的作品与思考，让每一份反馈成为下一步的方向。</p>{!outcomes?.artifacts.length && <div className="rounded-xl border border-dashed border-[var(--pbl-border)] bg-[var(--pbl-bg)] px-5 py-8 text-center"><FolderOpen size={28} className="mx-auto text-[var(--pbl-text-muted)]"/><p className="mt-3 text-sm font-medium">还没有提交项目成果</p><p className="mt-2 text-xs text-[var(--pbl-text-muted)]">{classroom.instance.status === "finished" ? "本场课堂未保存项目成果，可以继续查看学习反思与评价。" : teacher ? "学生提交后，可在这里查看作品版本并给出评价。" : "完成项目工作区后，提交一份作品记录你的探索。"}</p></div>}{!teacher && classroom.canWrite && <div className="space-y-3"><p>将当前工作区内容提交为新的成果版本。</p><button className={button} disabled={!canWrite || (!code.trim() && !document.trim())} onClick={() => void mutate("/outcomes", { action: "save_artifact", ...(outcomes?.artifacts[0] ? { artifactId: outcomes.artifacts[0].id } : {}), title: `${classroom.instance.title} · 项目成果`, type: code.trim() ? "HTML" : "TEXT", sourceHtml: code.trim() ? code : document })}>提交成果新版本</button></div>}{outcomes?.artifacts.map((artifact) => <article className="border-t pt-4" key={artifact.id}><h3 className="font-semibold">{artifact.title}</h3>{artifact.versions.map((version) => <details key={version.id} className="my-3"><summary className="cursor-pointer py-2">版本 {version.sequence}</summary><pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-[6px] border p-3 text-sm">{version.sourceHtml}</pre>{!teacher && classroom.canWrite && <button className={button} disabled={!canWrite} onClick={() => void mutate("/outcomes", { action: "showcase", artifactId: artifact.id, artifactVersionId: version.id })}>展示此版本</button>}</details>)}</article>)}<p>已保存 {outcomes?.showcases.length ?? 0} 次展示记录。</p>
      {!teacher && classroom.canWrite && <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void mutate("/outcomes", { action: "reflect", content: reflection }); }}><label className="block">学习反思<textarea required maxLength={30000} className={`${field} min-h-28`} value={reflection} onChange={(event) => setReflection(event.target.value)} /></label><button disabled={!canWrite} className={button}>提交反思</button></form>}{outcomes?.reflections.map((item) => <p className="whitespace-pre-wrap border-l-2 pl-4" key={item.id}>{item.content}</p>)}
      {(teacher || classroom.canWrite) && <form className="space-y-3 border-t pt-5" onSubmit={(event) => { event.preventDefault(); void mutate("/outcomes", { action: "evaluate", content: feedback, ...(score !== "" ? { score: Number(score) } : {}) }); }}><h3 className="font-semibold">{teacher ? "教师评价" : "学生自评"}</h3><label className="block">评价内容<textarea required maxLength={30000} className={`${field} min-h-28`} value={feedback} onChange={(event) => setFeedback(event.target.value)} /></label><label className="block">评分（可选，0–100）<input type="number" min={0} max={100} step="0.01" className={field} value={score} onChange={(event) => setScore(event.target.value)} /></label><button className={button} disabled={busy || (!teacher && !classroom.canWrite)}>保存评价</button></form>}{outcomes?.evaluations.map((evaluation) => <article className="border-t pt-4" key={evaluation.id}><p className="font-semibold">{evaluation.evaluatorType === "TEACHER" ? "教师评价" : "学生自评"}{evaluation.score !== null ? ` · ${evaluation.score} 分` : ""}</p><p className="mt-2 whitespace-pre-wrap">{evaluation.content}</p></article>)}
    </section>}
  </WorkspaceShell>;
}
