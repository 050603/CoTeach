"use client";

import { ResilientImage } from "@/components/resilient-image";
import { StudentShell } from "@/components/platform/student-shell";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { activityTypeLabel, instanceStatusLabel, progressStatusLabel } from "@/lib/platform/labels";

import { studentClassroomHref } from "@/lib/platform/classroom-entry";
import { SurveyQuestionFields } from "@/components/platform/survey-question-fields";
import { surveyTextAnswer, type SurveyAnswer, type SurveyQuestion } from "@/lib/platform/survey";
import { StudentSurveyExperience } from "@/components/platform/student-survey-experience";
import { StudentPdfResourceViewer } from "@/components/classroom/simple-stage-resources";
import { StudentExperimentAssessment, type ExperimentPhase, type ExperimentQuestion } from "@/components/platform/student-experiment-assessment";

type Experiment = { enabled: boolean; pretest: ExperimentQuestion[]; posttest: ExperimentQuestion[] };
type ActivityInstance = { id: string; status: string; startedAt: string | null; endedAt: string | null; canWrite?: boolean; coverImageUrl?: string | null; pretestSubmitted?: boolean; posttestSubmitted?: boolean; posttestAvailable?: boolean; experiment?: Experiment | null };
type Activity = { id: string; type: string; title: string; description: string | null; isOpen: boolean; offering: { id: string; name: string; status: string }; chapter: { title: string }; config?: { content?: string; url?: string; resourceKind?: "link" | "file"; fileName?: string; questions?: SurveyQuestion[] }; experiment?: Experiment | null; progress: { status: string; progressData?: { answer?: string; answers?: Record<string, SurveyAnswer> } }; instance: ActivityInstance | null; instances?: ActivityInstance[] };

function experimentForInstance(activity: Activity, instance: ActivityInstance): Experiment | null | undefined {
  return instance.experiment === undefined ? activity.experiment : instance.experiment;
}

async function fetchActivity(activityId: string): Promise<Activity> {
  const response = await fetch(`/api/platform/activities/${activityId}`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? "无法加载活动");
  return data.activity as Activity;
}

export default function StudentActivityPage() {
  const params = useParams<{ activityId: string }>();
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState("");
  const [answers, setAnswers] = useState<Record<string, SurveyAnswer>>({});
  const [saved, setSaved] = useState(false);
  const [participationId, setParticipationId] = useState<string | null>(null);
  const [activeAssessment, setActiveAssessment] = useState<{ instanceId: string; phase: ExperimentPhase } | null>(null);
  const recordingResource = useRef<string | null>(null);

  useEffect(() => { fetchActivity(params.activityId).then((data) => { setActivity(data); setAnswer(data.progress?.progressData?.answer ?? ""); setAnswers(data.progress?.progressData?.answers ?? {}); }).catch((reason) => setError(reason instanceof Error ? reason.message : "加载失败")); }, [params.activityId]);

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
    const experiment = activity ? experimentForInstance(activity, target) : null;
    if (experiment?.enabled && experiment.pretest.length > 0 && !target.pretestSubmitted) {
      setError("请先完成本次课堂前测，再进入课堂。");
      return;
    }
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

  function markAssessmentSubmitted(instanceId: string, phase: ExperimentPhase) {
    const field = phase === "pretest" ? "pretestSubmitted" : "posttestSubmitted";
    setActivity((current) => current ? {
      ...current,
      instance: current.instance?.id === instanceId ? { ...current.instance, [field]: true } : current.instance,
      instances: current.instances?.map((item) => item.id === instanceId ? { ...item, [field]: true } : item),
    } : current);
    setActiveAssessment(null);
    setError(null);
    void fetchActivity(params.activityId).then(setActivity).catch(() => setError("测验已提交，但课堂状态刷新失败，请重新加载页面。"));
  }

  async function recordResourceOpen(resource: Activity) {
    if (recordingResource.current === resource.id || resource.progress.status === "completed" || !resource.isOpen || resource.offering.status !== "open") return;
    recordingResource.current = resource.id;
    setError(null);
    try {
      const response = await fetch(`/api/platform/activities/${resource.id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "学习记录保存失败");
      setActivity((current) => current?.id === resource.id
        ? { ...current, progress: { status: "completed", progressData: data.progress.progressData } }
        : current);
    } catch (reason) {
      recordingResource.current = null;
      setError(reason instanceof Error ? reason.message : "学习记录保存失败，请重试");
    }
  }

  useEffect(() => {
    if (activity?.type !== "Resource" || activity.config?.url || !activity.config?.content?.trim()) return;
    const frame = window.requestAnimationFrame(() => void recordResourceOpen(activity));
    return () => window.cancelAnimationFrame(frame);
  }, [activity]);

  if (error && !activity) return <StudentShell backHref="/student?all=1" backLabel="返回我的课程"><section className="mx-auto max-w-2xl py-20"><h1 className="text-xl font-semibold">暂时无法打开活动</h1><p role="alert" className="mt-3 text-sm text-[var(--pbl-danger)]">{error}</p><button type="button" className="mt-6 min-h-11 rounded-xl bg-[var(--pbl-student)] px-6 text-sm font-semibold text-white" onClick={() => window.location.reload()}>重新加载</button></section></StudentShell>;
  if (!activity) return <StudentShell backHref="/student?all=1" backLabel="返回我的课程"><section aria-busy="true" aria-label="正在加载活动" className="mx-auto max-w-3xl space-y-5 py-20"><div className="h-6 w-24 animate-pulse rounded-lg bg-emerald-100 motion-reduce:animate-none" /><div className="h-10 w-2/3 animate-pulse rounded-lg bg-emerald-50 motion-reduce:animate-none" /><div className="h-40 animate-pulse rounded-xl bg-white/70 motion-reduce:animate-none" /><p role="status" className="text-sm text-[var(--pbl-text-muted)]">正在展开活动…</p></section></StudentShell>;
  const classroom = activity.type.toUpperCase() === "CLASSROOM";
  const instance = activity.instance;
  const finishedInstances = (activity.instances ?? []).filter((item) => item.status === "finished");
  function renderExperiment(target: ActivityInstance, phase: ExperimentPhase) {
    const experiment = activity ? experimentForInstance(activity, target) : null;
    const questions = experiment?.enabled ? experiment[phase] : [];
    if (!questions?.length) return null;
    const submitted = phase === "pretest" ? target.pretestSubmitted : target.posttestSubmitted;
    const label = phase === "pretest" ? "前测" : "后测";
    if (submitted) return activeAssessment?.instanceId === target.id && activeAssessment.phase === phase
      ? <StudentExperimentAssessment key={`${target.id}-${phase}`} instanceId={target.id} phase={phase} onCancel={() => setActiveAssessment(null)} onSubmitted={() => markAssessmentSubmitted(target.id, phase)} />
      : <div className="mt-3 flex flex-wrap items-center gap-3"><p role="status" className="text-xs font-semibold text-[var(--pbl-student)]">{label}已提交，答案已保存到本次课堂记录。</p><button className="min-h-11 rounded-[10px] border border-[var(--pbl-border)] bg-white px-3 text-xs font-semibold text-[var(--pbl-student)]" onClick={() => setActiveAssessment({ instanceId: target.id, phase })} type="button">查看{label}答案</button></div>;
    const available = phase === "pretest" ? ["scheduled", "teaching"].includes(target.status) : Boolean(target.posttestAvailable ?? target.status === "finished");
    if (!available) return phase === "posttest"
      ? <p className="mt-3 text-xs text-[var(--pbl-text-muted)]">后测将在教师进入第 5 阶段后开放。</p> : null;
    if (!activity?.isOpen) return <p className="mt-3 text-xs text-[var(--pbl-text-muted)]">本次课堂活动尚未开放，暂时无法提交{label}。</p>;
    return activeAssessment?.instanceId === target.id && activeAssessment.phase === phase
      ? <StudentExperimentAssessment key={`${target.id}-${phase}`} instanceId={target.id} phase={phase} onCancel={() => setActiveAssessment(null)} onSubmitted={() => markAssessmentSubmitted(target.id, phase)} />
      : <div className="mt-5 rounded-[14px] border border-[var(--pbl-student-border)] bg-white p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="rounded-full bg-[var(--pbl-student-soft)] px-3 py-1 text-xs font-semibold text-[var(--pbl-student)]">{phase === "pretest" ? "课前前测" : "课后后测"}</span><span className="text-xs font-medium tabular-nums text-[var(--pbl-text-muted)]">共 {questions.length} 题</span></div>
        <p className="mt-3 text-base font-semibold text-[var(--pbl-text-strong)]">{phase === "pretest" ? "开始学习前，请先完成前测" : "课堂已结束，请完成后测"}</p>
        <p className="mt-1 text-sm leading-6 text-[var(--pbl-text-muted)]">按自己的真实想法作答，答案会与本次课堂记录关联。</p>
        <button className="mt-4 min-h-11 w-full rounded-[10px] bg-[var(--pbl-student)] px-5 text-sm font-bold text-white sm:w-auto" onClick={() => { setActiveAssessment({ instanceId: target.id, phase }); setError(null); }} type="button">{phase === "pretest" ? "开始前测" : "开始后测"}</button>
      </div>;
  }
  if (activity.type === "Form") return <StudentSurveyExperience activity={activity} answers={answers} busy={busy} error={error} saved={saved} onAnswersChange={(next) => { setAnswers(next); setSaved(false); }} onSubmit={submit} />;
  if (activity.type === "Resource") {
    const resourceUrl = activity.config?.url;
    const uploadedPdf = Boolean(resourceUrl && /^\/api\/uploads\/[0-9a-f-]+$/i.test(resourceUrl));
    const externalLink = resourceUrl && /^https?:\/\//i.test(resourceUrl);
    return <StudentShell backHref={`/student/courses/${activity.offering.id}`} backLabel="返回课程">
      <div className={uploadedPdf ? "mx-auto max-w-6xl" : "mx-auto max-w-3xl"}>
        <section className="pbl-content-card p-5 md:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="rounded-full bg-[var(--pbl-bg)] px-3 py-1 text-xs font-bold text-[var(--pbl-student)]">{activityTypeLabel(activity.type)}</span>
            <span className="text-xs font-semibold text-[var(--pbl-text-muted)]">{activity.progress.status === "completed" ? "已学习" : progressStatusLabel(activity.progress.status)}</span>
          </div>
          <h1 className="mt-4 text-2xl font-bold md:text-3xl">{activity.title}</h1>
          <p className="mt-2 text-sm text-[var(--pbl-text-muted)]">{activity.offering.name} · {activity.chapter.title}</p>
          {activity.description ? <p className="mt-5 whitespace-pre-wrap text-sm leading-7">{activity.description}</p> : null}
          {!activity.isOpen ? <p className="mt-6" role="status">此任务尚未解锁，请等待教师开放。</p> : <>
            {activity.config?.content ? <div className="mt-6 whitespace-pre-wrap text-sm leading-8">{activity.config.content}</div> : null}
            {uploadedPdf && resourceUrl ? <div className="mt-6 h-[min(78vh,900px)] min-h-[32rem] overflow-hidden rounded-[var(--radius-sm)] border border-[var(--pbl-border)] bg-slate-100">
              <StudentPdfResourceViewer key={activity.id} onReady={() => void recordResourceOpen(activity)} progressKey={`activity:${activity.id}`} title={activity.config?.fileName || activity.title} url={resourceUrl} />
            </div> : externalLink ? <a className="mt-6 inline-flex min-h-11 items-center text-[var(--pbl-student)] underline underline-offset-4" href={resourceUrl} onClick={() => void recordResourceOpen(activity)} rel="noopener noreferrer" target="_blank">打开参考资料 ↗</a> : null}
            {error ? <div className="mt-4" role="alert"><p className="text-sm text-[var(--pbl-danger)]">{error}</p><button className="mt-2 text-sm font-semibold text-[var(--pbl-student)] underline" onClick={() => void recordResourceOpen(activity)} type="button">重试保存学习记录</button></div> : null}
            {activity.offering.status !== "open" ? <p className="mt-4 text-sm text-[var(--pbl-text-muted)]">课程已结束，可查看学习资料。</p> : null}
          </>}
        </section>
      </div>
    </StudentShell>;
  }
  if (classroom) {
    const activeExperiment = instance ? experimentForInstance(activity, instance) : null;
    const activePretestPending = Boolean(activeExperiment?.enabled && activeExperiment.pretest.length > 0 && !instance?.pretestSubmitted);
    return <StudentShell backHref={`/student/courses/${activity.offering.id}`} backLabel="返回课程">
      <div className="mx-auto max-w-3xl">
        <section className="pbl-content-card p-6 md:p-10">
          <div className="flex items-center justify-between gap-3">
            <span className="rounded-full bg-[var(--pbl-bg)] px-3 py-1 text-xs font-bold text-[var(--pbl-student)]">课堂</span>
            <span className="text-xs font-semibold text-[var(--pbl-text-muted)]">{progressStatusLabel(activity.progress.status)}</span>
          </div>
          <h1 className="mt-5 text-3xl font-bold">{activity.title}</h1>
          <p className="mt-2 text-sm text-[var(--pbl-text-muted)]">{activity.offering.name} · {activity.chapter.title}</p>
          {activity.description ? <p className="mt-6 whitespace-pre-wrap text-sm leading-7 text-[var(--pbl-text)]">{activity.description}</p> : null}
          {error ? <p role="alert" className="mt-5 rounded-xl border border-[var(--pbl-danger)] p-4 text-sm text-[var(--pbl-danger)]">{error}</p> : null}
          <div className="mt-8 overflow-hidden rounded-xl bg-[var(--pbl-bg)] text-sm">
            {instance?.coverImageUrl ? <div className="relative aspect-[16/7] w-full"><ResilientImage src={instance.coverImageUrl} alt={`${activity.title}课堂封面`} fill unoptimized className="object-cover" /></div> : null}
            <div className="p-5">
              <p className="font-semibold text-[var(--pbl-text)]">课堂活动</p>
              <p className="mt-1 leading-6 text-[var(--pbl-text-muted)]">进入课堂，与同伴一起完成学习任务，保存你的作品与学习记录。</p>
              {participationId ? <p className="mt-3 rounded-lg bg-white/70 px-3 py-2 text-xs text-[var(--pbl-text)]">已进入课堂，参与记录已保存。</p>
                : instance?.canWrite && activity.isOpen && activity.offering.status === "open" && !activePretestPending
                  ? <button className="mt-4 min-h-11 rounded-lg bg-[var(--pbl-student)] px-5 text-sm font-bold text-white disabled:opacity-50" disabled={busy} onClick={() => void enterClassroom()} type="button">{busy ? "进入中…" : "进入课堂"}</button>
                  : <p className="mt-3 text-xs text-[var(--pbl-student)]">{instance?.status === "finished" ? "本次课堂已结束。" : instance ? `课堂状态：${instanceStatusLabel(instance.status)}` : "教师尚未创建课堂实例。"}</p>}
              {instance ? renderExperiment(instance, "pretest") : null}
              {instance ? renderExperiment(instance, "posttest") : null}
              {finishedInstances.length > 0 ? <div className="mt-5 border-t border-indigo-100 pt-4">
                <p className="text-xs font-semibold text-[var(--pbl-text)]">历史课堂</p>
                <div className="mt-3 space-y-3">{finishedInstances.map((item, index) => {
                  const historyExperiment = experimentForInstance(activity, item);
                  const historyPretestPending = Boolean(historyExperiment?.enabled && historyExperiment.pretest.length > 0 && !item.pretestSubmitted);
                  return <div className="rounded-lg border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-3" key={item.id}>
                    <button type="button" disabled={busy || !activity.isOpen || historyPretestPending} onClick={() => void enterClassroom(item)} className="min-h-11 rounded-lg border border-[var(--pbl-border)] bg-white px-3 py-2 text-xs font-semibold text-[var(--pbl-student)] disabled:opacity-50">第 {finishedInstances.length - index} 次 · 查看课堂记录</button>
                    {item.id !== instance?.id ? renderExperiment(item, "posttest") : null}
                  </div>;
                })}</div>
              </div> : null}
            </div>
          </div>
        </section>
      </div>
    </StudentShell>;
  }
  return <StudentShell backHref={`/student/courses/${activity.offering.id}`} backLabel="返回课程"><div className="mx-auto max-w-3xl"><section className="pbl-content-card p-6 md:p-10"><div className="flex items-center justify-between gap-3"><span className="rounded-full bg-[var(--pbl-bg)] px-3 py-1 text-xs font-bold text-[var(--pbl-student)]">{activityTypeLabel(activity.type)}</span><span className="text-xs font-semibold text-[var(--pbl-text-muted)]">{progressStatusLabel(activity.progress.status)}</span></div><h1 className="mt-5 text-3xl font-bold">{activity.title}</h1><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">{activity.offering.name} · {activity.chapter.title}</p>{activity.description && !(activity.type === "Form" && activity.description === activity.config?.content) ? <p className="mt-6 whitespace-pre-wrap text-sm leading-7 text-[var(--pbl-text)]">{activity.description}</p> : null}<form className="mt-8 space-y-6 border-t border-[var(--pbl-border)] pt-6" onSubmit={submit}>
          {!activity.isOpen ? <p role="status">此任务尚未解锁，请等待教师开放。</p> : <>
            {activity.config?.content && <div className="whitespace-pre-wrap text-sm leading-8">{activity.config.content}</div>}
            {activity.config?.url && (/^https?:\/\//i.test(activity.config.url) || /^\/api\/uploads\/[0-9a-f-]+$/i.test(activity.config.url)) && <a href={activity.config.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-[var(--pbl-student)] underline underline-offset-4">{activity.config.resourceKind === "file" ? `打开 ${activity.config.fileName || "PDF 参考资料"}` : "打开参考资料"} ↗</a>}
            {activity.type !== "Resource" && (activity.config?.questions?.length ? activity.type === "Form" ? <SurveyQuestionFields answers={answers} onChange={(next) => { setAnswers(next); setSaved(false); }} questions={activity.config.questions.map((question) => ({ ...question, type: question.type ?? "short-text", chartType: question.chartType ?? "donut", options: question.options ?? [] }))} /> : activity.config.questions.map((question, index) => <label key={question.id} className="block text-sm font-medium">{index + 1}. {question.title}{question.required !== false ? "（必答）" : "（选答）"}<textarea required={question.required !== false} maxLength={10000} className="mt-3 min-h-28 w-full rounded-[10px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-3" value={surveyTextAnswer(answers[question.id])} onChange={(event) => { setAnswers({ ...answers, [question.id]: event.target.value }); setSaved(false); }} /></label>) : <label className="block text-sm font-medium">{activity.type === "Assignment" ? "作业内容" : "你的回答"}<textarea required maxLength={30000} className="mt-3 min-h-48 w-full rounded-[10px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-3" value={answer} onChange={(event) => { setAnswer(event.target.value); setSaved(false); }} /></label>)}
            {error && <p role="alert" className="text-sm text-[var(--pbl-danger)]">{error}</p>}
            {saved && <p role="status" className="text-sm text-[var(--pbl-student)]">已保存，课程学习进度已更新。</p>}
            <button disabled={busy || activity.offering.status !== "open"} className="min-h-11 rounded-[6px] bg-[var(--pbl-student)] px-6 text-sm font-semibold text-white disabled:opacity-50" type="submit">{busy ? "保存中…" : activity.type === "Resource" ? "标记为已学习" : activity.progress.status === "completed" ? "更新提交" : "提交"}</button>
            {activity.offering.status !== "open" && <p className="text-sm text-[var(--pbl-text-muted)]">课程已结束，可查看已提交的内容。</p>}
          </>}
        </form></section></div></StudentShell>;
}
