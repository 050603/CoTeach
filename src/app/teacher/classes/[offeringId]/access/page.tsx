"use client";

/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { activityTypeLabel } from "@/lib/platform/labels";

type Offering = { id: string; name: string; chapters: Array<{ id: string; title: string; isOpen: boolean; activities: Array<{ id: string; title: string; type: string; isOpen: boolean }> }> };

export default function AccessSettingsPage() {
  const { offeringId } = useParams<{ offeringId: string }>(); const [offering, setOffering] = useState<Offering | null>(null); const [error, setError] = useState<string | null>(null);
  async function load() { const response = await fetch("/api/platform/offerings", { cache: "no-store" }); const data = await response.json(); if (!response.ok) throw new Error(data.message ?? "无法加载教学班"); const found = data.offerings.find((item: Offering) => item.id === offeringId); if (!found) throw new Error("教学班不存在"); setOffering(found); }
  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : "加载失败")); }, [offeringId]);
  async function toggle(url: string, isOpen: boolean) { const response = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isOpen: !isOpen }) }); if (!response.ok) { setError((await response.json()).message ?? "更新失败"); return; } await load(); }
  if (error) return <main className="p-8"><p className="rounded bg-rose-50 p-3 text-rose-700">{error}</p></main>;
  if (!offering) return <main className="grid min-h-screen place-items-center">加载中…</main>;
  return <main className="min-h-screen bg-[var(--pbl-bg)] px-5 py-10 text-[var(--pbl-text)]"><div className="mx-auto max-w-3xl"><Link href={`/teacher/classes/${offering.id}`} className="text-sm text-[var(--pbl-text-muted)]">← 返回课程编排</Link><h1 className="mt-6 text-3xl font-bold">开放与锁定</h1><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">未开放内容仍会显示在学生课程计划中，但后端会拒绝进入和写入。</p><div className="mt-7 space-y-3">{offering.chapters.map((chapter) => <section className="rounded-xl border border-[var(--pbl-border)] bg-white p-5" key={chapter.id}><div className="flex items-center gap-3"><h2 className="font-bold">{chapter.title}</h2><button className={`ml-auto rounded-lg px-3 py-1.5 text-xs font-bold ${chapter.isOpen ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`} onClick={() => void toggle(`/api/platform/chapters/${chapter.id}`, chapter.isOpen)} type="button">{chapter.isOpen ? "章节已开放" : "章节未开放"}</button></div><div className="mt-3 space-y-2">{chapter.activities.map((activity) => <div className="flex items-center gap-3 rounded-lg border border-[var(--pbl-border)] px-3 py-2" key={activity.id}><span className="w-20 text-xs text-[var(--pbl-text-muted)]">{activityTypeLabel(activity.type)}</span><span className="flex-1 text-sm font-semibold">{activity.title}</span><button className={`rounded-lg px-3 py-1.5 text-xs font-bold ${activity.isOpen ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`} onClick={() => void toggle(`/api/platform/activities/${activity.id}`, activity.isOpen)} type="button">{activity.isOpen ? "已开放" : "未开放"}</button></div>)}</div></section>)}</div></div></main>;
}
