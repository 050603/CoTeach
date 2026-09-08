"use client";

/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { activityTypeLabel, instanceStatusLabel, offeringStatusLabel } from "@/lib/platform/labels";

type Instance = {
  id: string;
  status: string;
  templateVersionId: string;
  templateId?: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

type Activity = {
  id: string;
  type: string;
  title: string;
  isOpen: boolean;
  templateId?: string | null;
  version?: number;
  instances?: Instance[];
};

type Offering = {
  id: string;
  name: string;
  status: string;
  version?: number;
  chapters: Array<{
    id: string;
    title: string;
    isOpen: boolean;
    activities: Activity[];
  }>;
};

type Template = {
  id: string;
  title: string;
  versions: Array<{ id: string; version: number; status: string }>;
};

export default function TeacherClassEditorPage() {
  const { offeringId } = useParams<{ offeringId: string }>();
  const [offering, setOffering] = useState<Offering | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [chapterTitle, setChapterTitle] = useState("");
  const [activity, setActivity] = useState({ chapterId: "", title: "", type: "Resource", templateId: "" });
  const [error, setError] = useState<string | null>(null);
  const [busyActivity, setBusyActivity] = useState<string | null>(null);

  async function load() {
    const [offeringResponse, templateResponse] = await Promise.all([
      fetch("/api/platform/offerings", { cache: "no-store" }),
      fetch("/api/platform/templates", { cache: "no-store" }),
    ]);
    const offeringData = await offeringResponse.json();
    if (!offeringResponse.ok) throw new Error(offeringData.message ?? "无法加载教学班");
    const templateData = await templateResponse.json();
    if (!templateResponse.ok) throw new Error(templateData.message ?? "无法加载课堂内容库");
    const found = offeringData.offerings?.find((item: Offering) => item.id === offeringId) as Offering | undefined;
    if (!found) throw new Error("教学班不存在");
    setOffering(found);
    setTemplates(templateData.templates ?? []);
    setActivity((current) => ({
      ...current,
      chapterId: current.chapterId || found.chapters[0]?.id || "",
      templateId: current.templateId || templateData.templates?.[0]?.id || "",
    }));
  }

  useEffect(() => {
    void load().catch((reason) => setError(reason instanceof Error ? reason.message : "加载失败"));
  }, [offeringId]);

  async function addChapter(event: FormEvent) {
    event.preventDefault();
    const response = await fetch(`/api/platform/offerings/${offeringId}/chapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: chapterTitle }),
    });
    if (!response.ok) {
      setError((await response.json()).message ?? "创建章节失败");
      return;
    }
    setChapterTitle("");
    await load();
  }

  async function addActivity(event: FormEvent) {
    event.preventDefault();
    const response = await fetch(`/api/platform/offerings/${offeringId}/chapters/${activity.chapterId}/activities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: activity.title,
        type: activity.type,
        ...(activity.type === "Classroom" && activity.templateId ? { templateId: activity.templateId } : {}),
      }),
    });
    if (!response.ok) {
      setError((await response.json()).message ?? "创建活动失败");
      return;
    }
    setActivity((current) => ({ ...current, title: "" }));
    await load();
  }

  async function bindTemplate(item: Activity, templateId: string) {
    setBusyActivity(item.id);
    try {
      const response = await fetch(`/api/platform/activities/${item.id}/manage`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: templateId || null, version: item.version }),
      });
      if (!response.ok) throw new Error((await response.json()).message ?? "无法更新课堂模板");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法更新课堂模板");
    } finally {
      setBusyActivity(null);
    }
  }

  async function createInstance(item: Activity) {
    const template = templates.find((candidate) => candidate.id === item.templateId);
    const version = template?.versions[0];
    if (!version) {
      setError("请先为课堂活动绑定一个已就绪的课堂模板版本");
      return;
    }
    setBusyActivity(item.id);
    try {
      const response = await fetch(`/api/platform/activities/${item.id}/instance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateVersionId: version.id }),
      });
      if (!response.ok) throw new Error((await response.json()).message ?? "无法创建课堂实例");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法创建课堂实例");
    } finally {
      setBusyActivity(null);
    }
  }

  async function updateInstance(item: Activity, action: "start" | "finish") {
    const instance = item.instances?.[0];
    if (!instance) return;
    setBusyActivity(item.id);
    try {
      const response = await fetch(`/api/platform/classroom-instances/${instance.id}/${action}`, { method: "POST" });
      if (!response.ok) throw new Error((await response.json()).message ?? "无法更新课堂实例");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法更新课堂实例");
    } finally {
      setBusyActivity(null);
    }
  }

  const readyTemplates = useMemo(
    () => templates.filter((template) => template.versions.some((version) => ["ready", "published", "PUBLISHED", "active", "ACTIVE"].includes(version.status))),
    [templates],
  );

  if (error && !offering) return <main className="p-8"><p className="rounded bg-rose-50 p-3 text-rose-700">{error}</p></main>;
  if (!offering) return <main className="grid min-h-screen place-items-center">加载中…</main>;

  return (
    <main className="min-h-screen bg-[var(--pbl-bg)] px-5 py-10 text-[var(--pbl-text)]">
      <div className="mx-auto max-w-5xl">
        <Link href="/teacher/classes" className="text-sm text-[var(--pbl-text-muted)]">← 我的教学班</Link>
        <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold">{offering.name}</h1>
            <p className="mt-2 text-sm text-[var(--pbl-text-muted)]">课程编排 · {offeringStatusLabel(offering.status)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link className="rounded-lg border border-[var(--pbl-border)] bg-white px-3 py-2 text-sm font-semibold" href={`/teacher/classes/${offering.id}/access`}>开放与锁定</Link>
            <Link className="rounded-lg border border-[var(--pbl-border)] bg-white px-3 py-2 text-sm font-semibold" href={`/teacher/classes/${offering.id}/students`}>学生名单</Link>
          </div>
        </div>
        {error ? <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p> : null}

        <div className="mt-8 grid gap-4 rounded-xl border border-[var(--pbl-border)] bg-white p-5 md:grid-cols-2">
          <form className="space-y-3" onSubmit={addChapter}>
            <h2 className="font-bold">新增章节</h2>
            <input className="min-h-10 w-full rounded-lg border border-[var(--pbl-border)] px-3 text-sm" value={chapterTitle} onChange={(event) => setChapterTitle(event.target.value)} placeholder="例如：第一章 项目启动" required />
            <button className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-bold text-white" type="submit">添加章节</button>
          </form>
          <form className="space-y-3" onSubmit={addActivity}>
            <h2 className="font-bold">新增学习活动</h2>
            <select className="min-h-10 w-full rounded-lg border border-[var(--pbl-border)] px-3 text-sm" value={activity.chapterId} onChange={(event) => setActivity((current) => ({ ...current, chapterId: event.target.value }))} required>
              {offering.chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}
            </select>
            <div className="flex gap-2">
              <select className="min-h-10 rounded-lg border border-[var(--pbl-border)] px-3 text-sm" value={activity.type} onChange={(event) => setActivity((current) => ({ ...current, type: event.target.value }))}>
                <option value="Classroom">课堂</option><option value="Assignment">作业</option><option value="Quiz">测验</option><option value="Form">表单</option><option value="Resource">资源</option>
              </select>
              <input className="min-h-10 min-w-0 flex-1 rounded-lg border border-[var(--pbl-border)] px-3 text-sm" value={activity.title} onChange={(event) => setActivity((current) => ({ ...current, title: event.target.value }))} placeholder="活动标题" required />
            </div>
            {activity.type === "Classroom" ? <select className="min-h-10 w-full rounded-lg border border-[var(--pbl-border)] px-3 text-sm" value={activity.templateId} onChange={(event) => setActivity((current) => ({ ...current, templateId: event.target.value }))}>
              <option value="">不绑定模板（稍后配置）</option>
              {readyTemplates.map((template) => <option key={template.id} value={template.id}>{template.title} · 版本 {template.versions[0]?.version}</option>)}
            </select> : null}
            <button className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-bold text-white" type="submit">添加活动</button>
          </form>
        </div>

        <div className="mt-7 space-y-3">
          {offering.chapters.map((chapter, index) => <section className="rounded-xl border border-[var(--pbl-border)] bg-white p-5" key={chapter.id}>
            <div className="flex items-center gap-3"><span className="grid size-8 place-items-center rounded-full bg-indigo-50 text-sm font-bold text-indigo-700">{index + 1}</span><h2 className="font-bold">{chapter.title}</h2><span className="ml-auto text-xs text-[var(--pbl-text-muted)]">{chapter.activities.length} 个活动</span></div>
            <div className="mt-3 grid gap-2">
              {chapter.activities.map((item) => {
                const instance = item.instances?.[0];
                return <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--pbl-border)] px-3 py-2 text-sm" key={item.id}>
                  <span className="w-20 text-xs text-[var(--pbl-text-muted)]">{activityTypeLabel(item.type)}</span>
                  <span className="min-w-32 flex-1 font-semibold">{item.title}</span>
                  <span className="text-xs">{item.isOpen ? "开放" : "锁定"}</span>
                  {item.type === "Classroom" ? <>
                    <select aria-label={`${item.title}课堂模板`} className="min-h-8 max-w-56 rounded-lg border border-[var(--pbl-border)] px-2 text-xs" disabled={Boolean(instance && instance.status !== "finished") || busyActivity === item.id} value={item.templateId ?? ""} onChange={(event) => void bindTemplate(item, event.target.value)}>
                      <option value="">未绑定模板</option>
                      {readyTemplates.map((template) => <option key={template.id} value={template.id}>{template.title} · 版本 {template.versions[0]?.version}</option>)}
                    </select>
                    <span className="text-xs text-[var(--pbl-text-muted)]">{instance ? `实例：${instanceStatusLabel(instance.status)}` : item.templateId ? "已绑定模板" : "未绑定模板"}</span>
                    {(!instance || instance.status === "finished") && item.templateId ? <button className="rounded-lg border border-indigo-300 px-2.5 py-1.5 text-xs font-semibold text-indigo-700 disabled:opacity-50" disabled={busyActivity === item.id} onClick={() => void createInstance(item)} type="button">{instance?.status === "finished" ? "重新授课" : "创建课堂实例"}</button> : null}
                    {instance?.status === "scheduled" ? <button className="rounded-lg border border-emerald-300 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 disabled:opacity-50" disabled={busyActivity === item.id} onClick={() => void updateInstance(item, "start")} type="button">开始课堂</button> : null}
                    {instance?.status === "teaching" ? <button className="rounded-lg border border-rose-300 px-2.5 py-1.5 text-xs font-semibold text-rose-700 disabled:opacity-50" disabled={busyActivity === item.id} onClick={() => void updateInstance(item, "finish")} type="button">结束课堂</button> : null}
                  </> : null}
                </div>;
              })}
            </div>
          </section>)}
        </div>
      </div>
    </main>
  );
}
