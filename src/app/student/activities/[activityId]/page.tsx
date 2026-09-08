"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { activityTypeLabel, instanceStatusLabel, progressStatusLabel } from "@/lib/platform/labels";

type ActivityInstance = { id: string; status: string; startedAt: string | null; endedAt: string | null; canWrite?: boolean };
type Activity = { id: string; type: string; title: string; description: string | null; isOpen: boolean; offering: { id: string; name: string; status: string }; chapter: { title: string }; progress: { status: string }; instance: ActivityInstance | null; instances?: ActivityInstance[] };

export default function StudentActivityPage() {
  const params = useParams<{ activityId: string }>();
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [participationId, setParticipationId] = useState<string | null>(null);

  useEffect(() => { fetch(`/api/platform/activities/${params.activityId}`, { cache: "no-store" }).then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.message ?? "无法加载活动"); setActivity(data.activity); }).catch((reason) => setError(reason instanceof Error ? reason.message : "加载失败")); }, [params.activityId]);

  async function enterClassroom() {
    if (!activity?.instance || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/platform/classroom-instances/${activity.instance.id}/enter`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "无法进入课堂");
      setParticipationId(data.participation?.id ?? null);
      setActivity((current) => current ? { ...current, progress: { ...current.progress, status: "in_progress" } } : current);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法进入课堂"); }
    finally { setBusy(false); }
  }

  if (error) return <main className="min-h-screen bg-[var(--pbl-bg)] px-5 py-12"><div className="mx-auto max-w-2xl"><p className="rounded-lg bg-rose-50 p-4 text-rose-700">{error}</p></div></main>;
  if (!activity) return <main className="grid min-h-screen place-items-center bg-[var(--pbl-bg)] text-sm text-[var(--pbl-text-muted)]">加载活动中…</main>;
  const classroom = activity.type.toUpperCase() === "CLASSROOM";
  const instance = activity.instance;
  const finishedInstances = (activity.instances ?? []).filter((item) => item.status === "finished" && item.id !== instance?.id);
  return <main className="min-h-screen bg-[var(--pbl-bg)] px-5 py-10 text-[var(--pbl-text)]"><div className="mx-auto max-w-2xl"><Link className="text-sm text-[var(--pbl-text-muted)]" href={`/student/courses/${activity.offering.id}`}>← 返回课程</Link><section className="mt-7 rounded-2xl border border-[var(--pbl-border)] bg-white p-7 shadow-sm"><div className="flex items-center justify-between gap-3"><span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-700">{activityTypeLabel(activity.type)}</span><span className="text-xs font-semibold text-[var(--pbl-text-muted)]">{progressStatusLabel(activity.progress.status)}</span></div><h1 className="mt-5 text-3xl font-bold">{activity.title}</h1><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">{activity.offering.name} · {activity.chapter.title}</p>{activity.description ? <p className="mt-6 whitespace-pre-wrap text-sm leading-7 text-[var(--pbl-text)]">{activity.description}</p> : null}{classroom ? <div className="mt-8 rounded-xl bg-indigo-50 p-4 text-sm"><p className="font-semibold text-indigo-900">课堂活动</p><p className="mt-1 leading-6 text-indigo-800">课堂参与、成果和 AI 协作数据会归属于本次课堂实例。</p>{participationId ? <p className="mt-3 rounded-lg bg-white/70 px-3 py-2 text-xs text-indigo-900">已进入课堂，参与记录已保存。</p> : instance?.canWrite ? <button className="mt-4 min-h-11 rounded-lg bg-indigo-600 px-5 text-sm font-bold text-white disabled:opacity-50" disabled={busy} onClick={() => void enterClassroom()} type="button">{busy ? "进入中…" : "进入课堂"}</button> : <p className="mt-3 text-xs text-indigo-700">{instance?.status === "finished" ? "本次课堂已结束。" : instance ? `课堂状态：${instanceStatusLabel(instance.status)}` : "教师尚未创建课堂实例。"}</p>}{finishedInstances.length > 0 ? <div className="mt-5 border-t border-indigo-100 pt-4"><p className="text-xs font-semibold text-indigo-900">历史课堂</p><div className="mt-2 flex flex-wrap gap-2">{finishedInstances.map((item, index) => <span className="rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700" key={item.id}>第 {finishedInstances.length - index} 次 · {instanceStatusLabel(item.status)}</span>)}</div></div> : null}</div> : <div className="mt-8 rounded-xl border border-dashed border-amber-300 bg-amber-50 p-4 text-sm text-amber-800"><p className="font-semibold">功能准备中</p><p className="mt-1 leading-6">该活动已加入课程计划，后续版本将开放提交与在线内容。</p></div>}</section></div></main>;
}
