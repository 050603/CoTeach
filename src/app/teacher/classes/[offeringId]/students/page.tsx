"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import Link from "next/link";
import { Search, UsersRound } from "lucide-react";
import { PlatformLoading, PlatformEmpty, PlatformError } from "@/components/platform/platform-feedback";
import { TeacherPlatformPage, TeacherPlatformHeader } from "@/components/platform/teacher-shell";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { teacherPlatformFetch } from "@/lib/platform/client";

type Student = { id: string; enrollmentId: string; username: string; displayName: string; progress: Array<{ id?: string; status: string; activity?: { title: string; type: string; config?: { questions?: Array<{ id: string; title: string }> } }; progressData?: { answer?: string; content?: string; answers?: Record<string, string>; submission?: { answer?: string; content?: string; answers?: Record<string, string> } } }> };

export default function TeacherStudentsPage() {
  const { offeringId } = useParams<{ offeringId: string }>();
  const [query, setQuery] = useState("");
  const [students, setStudents] = useState<Student[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const response = await teacherPlatformFetch(`/api/platform/offerings/${offeringId}/students`, { cache: "no-store" });
    const data = await response.json(); if (!response.ok) throw new Error(data.message ?? "无法加载学生"); setStudents(data.students ?? []);
  }, [offeringId]);
  useEffect(() => { load().catch((reason) => setError(reason instanceof Error ? reason.message : "加载失败")).finally(() => setLoading(false)); }, [load]);
  async function reset(enrollmentId: string) {
    if (busy) return; setBusy(enrollmentId); setError(""); setMessage("");
    try {
      const response = await teacherPlatformFetch(`/api/platform/offerings/${offeringId}/reset-password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enrollmentId }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.message ?? "生成失败"); setMessage(`一次性重置链接：${location.origin}/student/reset-password?token=${data.token}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "生成失败，请重试"); }
    finally { setBusy(null); }
  }
  const visible = students.filter(student => `${student.displayName} ${student.username}`.toLowerCase().includes(query.toLowerCase()));
  const completed = students.reduce((sum, student) => sum + student.progress.filter(item => item.status.toLowerCase() === "completed").length, 0);
  const participating = students.filter(student => student.progress.length > 0).length;
  const retry = () => { setError(""); setLoading(true); void load().catch(reason => setError(reason instanceof Error ? reason.message : "加载失败")).finally(() => setLoading(false)); };
  return <TeacherPlatformPage><TeacherPlatformHeader active="classes" /><div className="pbl-workspace-content"><Link href={`/teacher/classes/${offeringId}`} className="text-sm text-[var(--pbl-text-muted)]">← 返回教学班</Link><div className="pbl-course-heading mt-7"><h1 className="font-serif text-3xl font-semibold">学生与学习记录</h1><p className="mt-3 text-sm text-[var(--pbl-text-muted)]">查看课程成员、学习进度与任务提交，协助学生管理账号。</p></div>{error ? <PlatformError message={error} onRetry={retry} /> : null}{message ? <p role="status" className="mt-4 break-all rounded-[6px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-4 text-sm">{message}</p> : null}<div className="pbl-stat-grid">{[["课程成员", students.length, "一起学习的伙伴"], ["已参与学习", participating, "留下学习过程记录"], ["已完成任务", completed, "所有成员的完成总数"]].map(([label,value,detail]) => <div className="pbl-stat-card" key={label}><p className="text-xs text-[var(--pbl-text-muted)]">{label}</p><strong className="mt-3 block text-3xl font-semibold">{loading ? "—" : value}</strong><p className="mt-2 text-xs text-[var(--pbl-text-muted)]">{detail}</p></div>)}</div><div className="pbl-list-toolbar mb-5"><label className="flex min-w-0 items-center gap-3"><Search size={18}/><input aria-label="搜索学生" placeholder="搜索姓名或账号" className="min-h-11 min-w-0 bg-transparent text-sm" value={query} onChange={event => setQuery(event.target.value)}/></label><span className="text-xs text-[var(--pbl-text-muted)]">{visible.length} 位学生</span></div>{loading && <PlatformLoading label="正在加载学生…" />}<div className="pbl-content-card overflow-hidden">{visible.map((student) => <details className="border-b border-[var(--pbl-border)] last:border-0" key={student.id}><summary className="flex min-h-24 cursor-pointer flex-wrap items-center gap-4 px-5 py-4"><span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]" aria-hidden="true"><UsersRound size={20}/></span><div className="min-w-40 flex-1"><h2 className="text-base font-semibold">{student.displayName}</h2><p className="mt-2 text-xs text-[var(--pbl-text-muted)]">账号：{student.username}</p></div><span className="text-xs text-[var(--pbl-text-muted)]">已完成 {student.progress.filter((item) => item.status.toLowerCase() === "completed").length} 项</span><span className="text-sm text-[var(--pbl-teacher)]">查看学习记录 ↓</span></summary><div className="border-t border-[var(--pbl-border)] bg-[var(--pbl-bg)]/50 px-5 py-5"><div className="space-y-4">{student.progress.map((progress, index) => { const data = progress.progressData?.submission ?? progress.progressData; return <section className="border-b border-[var(--pbl-border)] pb-4 last:border-0" key={progress.id ?? index}><h3 className="text-sm font-semibold">{progress.activity?.title ?? `学习任务 ${index + 1}`}<span className="ml-3 text-xs font-normal text-[var(--pbl-text-muted)]">{progress.status.toLowerCase() === "completed" ? "已完成" : progress.status.toLowerCase() === "submitted" ? "已提交" : "进行中"}</span></h3>{(data?.answer || data?.content) ? <p className="mt-3 whitespace-pre-wrap text-sm leading-7">{data.answer || data.content}</p> : null}{data?.answers ? <dl className="mt-3 space-y-3">{Object.entries(data.answers).map(([question, answer]) => <div key={question}><dt className="text-xs text-[var(--pbl-text-muted)]">{progress.activity?.config?.questions?.find((item) => item.id === question)?.title ?? question}</dt><dd className="mt-1 whitespace-pre-wrap text-sm leading-6">{answer}</dd></div>)}</dl> : null}</section>; })}{student.progress.length === 0 ? <p className="text-sm text-[var(--pbl-text-muted)]">暂时没有学习记录。</p> : null}</div><button disabled={Boolean(busy)} className="mt-5 min-h-11 rounded-[6px] border border-[var(--pbl-border)] px-4 text-xs disabled:opacity-50" onClick={() => void reset(student.enrollmentId)} type="button">{busy === student.enrollmentId ? "生成中…" : "生成密码重置链接"}</button></div></details>)}{!loading && !error && !visible.length ? <PlatformEmpty title={query ? "没有找到这位学生" : "等待学生加入"} description={query ? "试试其他姓名或账号。" : "学生使用课程邀请码加入后，将显示在这里。"} /> : null}</div></div></TeacherPlatformPage>;
}
