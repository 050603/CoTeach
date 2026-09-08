"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import Link from "next/link";
import { useEffect, useState } from "react";
import { templateVersionStatusLabel } from "@/lib/platform/labels";

type Template = { id: string; title: string; description: string | null; status: string; versions: Array<{ id: string; version: number; status: string; createdAt: string }> };

export default function TeacherTemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [courseId, setCourseId] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch("/api/platform/templates", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message ?? "无法加载课程库");
    setTemplates(data.templates ?? []);
  }

  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : "加载失败")); }, []);

  async function importCourse(event: React.FormEvent) {
    event.preventDefault();
    if (!courseId.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/platform/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId, title: title || undefined }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "导入失败");
      setCourseId(""); setTitle(""); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "导入失败"); }
    finally { setBusy(false); }
  }

  async function archive(templateId: string) {
    const response = await fetch(`/api/platform/templates/${templateId}/versions`, { method: "DELETE" });
    if (!response.ok) { const data = await response.json().catch(() => ({})); setError(data.message ?? "归档失败"); return; }
    await load();
  }

  return <main className="min-h-screen bg-[var(--pbl-bg)] px-5 py-10 text-[var(--pbl-text)]"><div className="mx-auto max-w-5xl"><div className="flex flex-wrap items-end justify-between gap-3"><div><Link href="/teacher/classes" className="text-sm text-[var(--pbl-text-muted)]">← 我的教学班</Link><h1 className="mt-5 text-3xl font-bold">我的课堂内容库</h1><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">课程库按教师隔离。发布后的版本不可变，教学班绑定实例快照。</p></div><Link className="rounded-lg border border-[var(--pbl-border)] bg-white px-3 py-2 text-sm font-semibold" href="/teacher">返回旧课堂</Link></div><form className="mt-8 grid gap-3 rounded-xl border border-[var(--pbl-border)] bg-white p-5 md:grid-cols-[1fr_220px_auto]" onSubmit={importCourse}><div><label className="text-xs font-semibold text-[var(--pbl-text-muted)]" htmlFor="legacy-course-id">从已有课堂导入</label><input id="legacy-course-id" className="mt-1 min-h-11 w-full rounded-lg border border-[var(--pbl-border)] px-3 text-sm" value={courseId} onChange={(event) => setCourseId(event.target.value)} placeholder="旧课堂 ID" required /></div><div><label className="text-xs font-semibold text-[var(--pbl-text-muted)]" htmlFor="template-title">模板标题（可选）</label><input id="template-title" className="mt-1 min-h-11 w-full rounded-lg border border-[var(--pbl-border)] px-3 text-sm" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="课堂模板" /></div><button className="self-end min-h-11 rounded-lg bg-indigo-600 px-4 text-sm font-bold text-white disabled:opacity-50" disabled={busy} type="submit">{busy ? "导入中…" : "导入模板"}</button></form>{error ? <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p> : null}<div className="mt-7 grid gap-4 md:grid-cols-2">{templates.map((template) => <article className="rounded-xl border border-[var(--pbl-border)] bg-white p-5" key={template.id}><div className="flex items-start justify-between gap-3"><div><h2 className="font-bold">{template.title}</h2><p className="mt-1 text-xs text-[var(--pbl-text-muted)]">{template.description ?? "私有课堂模板"}</p></div><button className="text-xs font-semibold text-rose-600" onClick={() => void archive(template.id)} type="button">归档</button></div><div className="mt-4 space-y-2">{template.versions.map((version) => <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs" key={version.id}><span>版本 {version.version}</span><span className="text-emerald-600">{templateVersionStatusLabel(version.status)}</span></div>)}</div></article>)}{templates.length === 0 ? <p className="rounded-xl border border-dashed border-[var(--pbl-border)] p-8 text-sm text-[var(--pbl-text-muted)]">还没有课堂模板。可以从旧课堂导入，或通过生成流程发布新版本。</p> : null}</div></div></main>;
}
