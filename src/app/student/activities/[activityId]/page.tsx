"use client";

import Image from "next/image";
import { StudentShell } from "@/components/platform/student-shell";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { activityTypeLabel, instanceStatusLabel, progressStatusLabel } from "@/lib/platform/labels";

import { studentClassroomHref } from "@/lib/platform/classroom-entry";
import { SurveyQuestionFields } from "@/components/platform/survey-question-fields";
import type { SurveyQuestion } from "@/lib/platform/survey";
import { StudentSurveyExperience } from "@/components/platform/student-survey-experience";

type ActivityInstance = { id: string; status: string; startedAt: string | null; endedAt: string | null; canWrite?: boolean; coverImageUrl?: string | null };
type Activity = { id: string; type: string; title: string; description: string | null; isOpen: boolean; offering: { id: string; name: string; status: string }; chapter: { title: string }; config?: { content?: string; url?: string; questions?: SurveyQuestion[] }; progress: { status: string; progressData?: { answer?: string; answers?: Record<string, string> } }; instance: ActivityInstance | null; instances?: ActivityInstance[] };

export default function StudentActivityPage() {
  const params = useParams<{ activityId: string }>();
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [participationId, setParticipationId] = useState<string | null>(null);

  useEffect(() => { fetch(`/api/platform/activities/${params.activityId}`, { cache: "no-store" }).then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.message ?? "无法加载活动"); setActivity(data.activity); setAnswer(data.activity.progress?.progressData?.answer ?? ""); setAnswers(data.activity.progress?.progressData?.answers ?? {}); }).catch((reason) => setError(reason instanceof Error ? reason.message : "加载失败")); }, [params.activityId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !activity?.isOpen) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const response = await fetch(`/api/platform/activities/${activity.id}/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer, answers }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "提交失败");
      setActivity({ ...activity, progress: { status: "completed", progressData: data.progress.progressData } }); setSaved(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "提交失败，请重试"); }
    finally { setBusy(false); }
  }

  async function enterClassroom(target = activity?.instance) {
    if (!target || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/platform/classroom-instances/${target.id}/enter`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "无法进入课堂");
      setParticipationId(data.participation?.id ?? null);
      if (data.participation?.id) window.location.assign(studentClassroomHref(data.instance.id, data.participation.id, data.instance?.templateVersion?.snapshot?.kind, data.instance?.status));
      if (data.instance?.status?.toLowerCase() === "teaching") setActivity((current) => current ? { ...current, progress: { ...current.progress, status: "in_progress" } } : current);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法进入课堂"); }
    finally { setBusy(false); }
  }

  if (error && !activity) return <StudentShell backHref="/student?all=1" backLabel="返回我的课程"><section className="mx-auto max-w-2xl py-20"><h1 className="text-xl font-semibold">暂时无法打开活动</h1><p role="alert" className="mt-3 text-sm text-[var(--pbl-danger)]">{error}</p><button type="button" className="mt-6 min-h-11 rounded-xl bg-[var(--pbl-student)] px-6 text-sm font-semibold text-white" onClick={() => window.location.reload()}>重新加载</button></section></StudentShell>;
  if (!activity) return <StudentShell backHref="/student?all=1" backLabel="返回我的课程"><section aria-busy="true" aria-label="正在加载活动" className="mx-auto max-w-3xl space-y-5 py-20"><div className="h-6 w-24 animate-pulse rounded-lg bg-emerald-100 motion-reduce:animate-none" /><div className="h-10 w-2/3 animate-pulse rounded-lg bg-emerald-50 motion-reduce:animate-none" /><div className="h-40 animate-pulse rounded-xl bg-white/70 motion-reduce:animate-none" /><p role="status" className="text-sm text-[var(--pbl-text-muted)]">正在展开活动…</p></section></StudentShell>;
  const classroom = activity.type.toUpperCase() === "CLASSROOM";
  const instance = activity.instance;
  const finishedInstances = (activity.instances ?? []).filter((item) => item.status === "finished");
  if (activity.type === "Form") return <StudentShell backHref={`/student/courses/${activity.offering.id}`} backLabel="返回课程"><StudentSurveyExperience activity={activity} answers={answers} busy={busy} error={error} saved={saved} onAnswersChange={(next) => { setAnswers(next); setSaved(false); }} onSubmit={submit} /></StudentShell>;
  return <StudentShell backHref={`/student/courses/${activity.offering.id}`} backLabel="返回课程"><div className="mx-auto max-w-3xl"><section className="pbl-content-card p-6 md:p-10"><div className="flex items-center justify-between gap-3"><span className="rounded-full bg-[var(--pbl-bg)] px-3 py-1 text-xs font-bold text-[var(--pbl-student)]">{activityTypeLabel(activity.type)}</span><span className="text-xs font-semibold text-[var(--pbl-text-muted)]">{progressStatusLabel(activity.progress.status)}</span></div><h1 className="mt-5 text-3xl font-bold">{activity.title}</h1><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">{activity.offering.name} · {activity.chapter.title}</p>{activity.description && !(activity.type === "Form" && activity.description === activity.config?.content) ? <p className="mt-6 whitespace-pre-wrap text-sm leading-7 text-[var(--pbl-text)]">{activity.description}</p> : null}{classroom && error ? <p role="alert" className="mt-5 rounded-xl border border-[var(--pbl-danger)] p-4 text-sm text-[var(--pbl-danger)]">{error}</p> : null}{classroom ? <div className="mt-8 overflow-hidden rounded-xl bg-[var(--pbl-bg)] text-sm">{instance?.coverImageUrl ? <div className="relative aspect-[16/7] w-full"><Image src={instance.coverImageUrl} alt={`${activity.title}课堂封面`} fill unoptimized className="object-cover" /></div> : null}<div className="p-5"><p className="font-semibold text-[var(--pbl-text)]">课堂活动</p><p className="mt-1 leading-6 text-[var(--pbl-text-muted)]">进入课堂，与同伴一起完成学习任务，保存你的作品与学习记录。</p>{participationId ? <p className="mt-3 rounded-lg bg-white/70 px-3 py-2 text-xs text-[var(--pbl-text)]">已进入课堂，参与记录已保存。</p> : instance?.canWrite && activity.isOpen && activity.offering.status === "open" ? <button className="mt-4 min-h-11 rounded-lg bg-[var(--pbl-student)] px-5 text-sm font-bold text-white disabled:opacity-50" disabled={busy} onClick={() => void enterClassroom()} type="button">{busy ? "进入中…" : "进入课堂"}</button> : <p className="mt-3 text-xs text-[var(--pbl-student)]">{instance?.status === "finished" ? "本次课堂已结束。" : instance ? `课堂状态：${instanceStatusLabel(instance.status)}` : "教师尚未创建课堂实例。"}</p>}{finishedInstances.length > 0 ? <div className="mt-5 border-t border-indigo-100 pt-4"><p className="text-xs font-semibold text-[var(--pbl-text)]">历史课堂</p><div className="mt-2 flex flex-wrap gap-2">{finishedInstances.map((item, index) => <button type="button" disabled={busy || !activity.isOpen} onClick={() => void enterClassroom(item)} className="min-h-11 rounded-lg border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-3 py-2 text-xs font-semibold text-[var(--pbl-student)] disabled:opacity-50" key={item.id}>第 {finishedInstances.length - index} 次 · 查看课堂记录</button>)}</div></div> : null}</div></div> : <form className="mt-8 space-y-6 border-t border-[var(--pbl-border)] pt-6" onSubmit={submit}>
          {!activity.isOpen ? <p role="status">此任务尚未解锁，请等待教师开放。</p> : <>
            {activity.config?.content && <div className="whitespace-pre-wrap text-sm leading-8">{activity.config.content}</div>}
            {activity.config?.url && /^https?:\/\//i.test(activity.config.url) && <a href={activity.config.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-[var(--pbl-student)] underline underline-offset-4">打开参考资料 ↗</a>}
            {activity.type !== "Resource" && (activity.config?.questions?.length ? activity.type === "Form" ? <SurveyQuestionFields answers={answers} onChange={(next) => { setAnswers(next); setSaved(false); }} questions={activity.config.questions.map((question) => ({ ...question, type: question.type ?? "short-text", options: question.options ?? [] }))} /> : activity.config.questions.map((question, index) => <label key={question.id} className="block text-sm font-medium">{index + 1}. {question.title}{question.required !== false ? "（必答）" : "（选答）"}<textarea required={question.required !== false} maxLength={10000} className="mt-3 min-h-28 w-full rounded-[10px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-3" value={answers[question.id] ?? ""} onChange={(event) => { setAnswers({ ...answers, [question.id]: event.target.value }); setSaved(false); }} /></label>) : <label className="block text-sm font-medium">{activity.type === "Assignment" ? "作业内容" : "你的回答"}<textarea required maxLength={30000} className="mt-3 min-h-48 w-full rounded-[10px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-3" value={answer} onChange={(event) => { setAnswer(event.target.value); setSaved(false); }} /></label>)}
            {error && <p role="alert" className="text-sm text-[var(--pbl-danger)]">{error}</p>}
            {saved && <p role="status" className="text-sm text-[var(--pbl-student)]">已保存，课程学习进度已更新。</p>}
            <button disabled={busy || activity.offering.status !== "open"} className="min-h-11 rounded-[6px] bg-[var(--pbl-student)] px-6 text-sm font-semibold text-white disabled:opacity-50" type="submit">{busy ? "保存中…" : activity.type === "Resource" ? "标记为已学习" : activity.progress.status === "completed" ? "更新提交" : "提交"}</button>
            {activity.offering.status !== "open" && <p className="text-sm text-[var(--pbl-text-muted)]">课程已结束，可查看已提交的内容。</p>}
          </>}
        </form>}</section></div></StudentShell>;
}
