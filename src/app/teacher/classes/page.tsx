"use client";
/* eslint-disable react-hooks/set-state-in-effect, @next/next/no-img-element */

import Link from "next/link";
import { LearningArt } from "@/components/platform/learning-art";
import { PlatformLoading, PlatformEmpty, PlatformError } from "@/components/platform/platform-feedback";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowRight, BookOpen, CalendarDays, Plus, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { offeringStatusLabel } from "@/lib/platform/labels";
import { teacherPlatformFetch } from "@/lib/platform/client";
import { TeacherPlatformHeader, TeacherPlatformPage } from "@/components/platform/teacher-shell";

type Offering = { id: string; name: string; description: string | null; term: string | null; startsAt?: string | null; coverImageUrl?: string | null; status: string; chapters: Array<{ id: string; activities: Array<{ id: string }> }> };
const input = "min-h-11 w-full rounded-[6px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-3 text-sm";

export default function TeacherClassesPage() {
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [term, setTerm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError(null); setLoading(true);
    try {
      const response = await teacherPlatformFetch("/api/platform/offerings", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "无法加载课程系列");
      setOfferings(data.offerings ?? []);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "加载失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function create(event: FormEvent) {
    event.preventDefault(); if (busy || !name.trim()) return;
    setBusy(true); setError(null);
    try {
      const response = await teacherPlatformFetch("/api/platform/offerings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), term: term.trim() }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.message ?? "创建失败");
      await load(); setOpen(false); setName(""); setTerm("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "创建失败"); }
    finally { setBusy(false); }
  }
  const visible = offerings.filter((item) => (!filter || item.status.toLowerCase() === filter) && `${item.name} ${item.term ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  return <TeacherPlatformPage>
    <TeacherPlatformHeader active="classes" />
    <div className="pbl-workspace-content"><div className="pbl-page-heading"><LearningArt /><div><p className="text-xs tracking-[0.18em] text-[var(--pbl-text-muted)]">教学 · 组织与实施</p><h1 className="mt-3 font-serif text-3xl font-semibold md:text-4xl">课程系列</h1><p className="mt-4 max-w-xl text-sm leading-7 text-[var(--pbl-text-muted)]">从一门完整的课程出发，组织章节、课堂与学习任务，陪伴学生完成一段学习旅程。</p></div><button onClick={() => setOpen(true)} className="flex min-h-11 items-center gap-2 rounded-[6px] bg-[var(--pbl-teacher)] px-5 text-sm font-semibold text-white"><Plus size={17} />新建课程系列</button></div>
      <div className="pbl-stat-grid" aria-label="课程概况">{[["课程系列", offerings.length, "全部教学计划"], ["开放中", offerings.filter(item => item.status.toLowerCase() === "open").length, "学生正在参与"], ["学习内容", offerings.reduce((sum, item) => sum + item.chapters.reduce((n, chapter) => n + chapter.activities.length, 0), 0), "课堂与学习任务"]].map(([label, value, detail]) => <div className="pbl-stat-card" key={label}><p className="text-xs text-[var(--pbl-text-muted)]">{label}</p><strong className="mt-3 block text-3xl font-semibold tabular-nums tracking-tight">{loading ? "—" : value}</strong><p className="mt-2 text-xs text-[var(--pbl-text-muted)]">{detail}</p></div>)}</div>
      <div className="pbl-list-toolbar"><label className="flex w-full items-center gap-3 sm:w-80"><Search size={18} className="shrink-0 text-[var(--pbl-text-muted)]" /><input aria-label="搜索课程系列" className="min-h-11 w-full bg-transparent text-sm outline-offset-4" placeholder="搜索课程名称或学期" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="flex items-center gap-4"><span className="text-xs text-[var(--pbl-text-muted)]">{visible.length} 门课程</span><select aria-label="课程状态" className="min-h-11 rounded-[6px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-3 text-sm" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="">全部状态</option><option value="draft">草稿</option><option value="open">开放中</option><option value="finished">已结课</option><option value="archived">已归档</option></select></div></div>
      {error && !open ? <PlatformError message={error} onRetry={() => void load()} /> : null}
      {loading ? <PlatformLoading label="正在加载课程系列…" /> : <div className="mt-7 grid gap-6 md:grid-cols-2 lg:grid-cols-3">{visible.map((item, index) => <Link key={item.id} href={`/teacher/classes/${item.id}`} className="pbl-course-card group"><div className="pbl-course-art relative flex h-40 items-end overflow-hidden p-5">{item.coverImageUrl ? <img src={item.coverImageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" /> : <><LearningArt variant={index} /><span className="pbl-cover-index">课程 / {String(index + 1).padStart(2, "0")}</span><BookOpen size={25} strokeWidth={1.5} className="text-[var(--pbl-teacher)]" /></>}<span className="absolute right-4 top-4 rounded-[6px] bg-[var(--pbl-surface)] px-3 py-1.5 text-xs">{offeringStatusLabel(item.status)}</span></div><div className="p-5"><p className="text-xs text-[var(--pbl-text-muted)]">{item.term || "学期待设置"}</p><h2 className="mt-2 font-serif text-xl font-semibold leading-8">{item.name}</h2><p className="mt-3 line-clamp-2 min-h-12 text-sm leading-6 text-[var(--pbl-text-muted)]">{item.description || "完善课程介绍，编排章节与任务，让学习从这里开始。"}</p><p className="mt-5 flex items-center gap-2 text-xs text-[var(--pbl-text-muted)]"><CalendarDays size={14} />{item.startsAt ? `${new Date(item.startsAt).toLocaleDateString("zh-CN")} 开课` : "开课时间待设置"}</p><div className="mt-5 flex items-center justify-between border-t border-[var(--pbl-border)] pt-4 text-xs"><span className="text-[var(--pbl-text-muted)]">{item.chapters.length} 章 · {item.chapters.reduce((sum, chapter) => sum + chapter.activities.length, 0)} 项学习内容</span><span className="flex items-center gap-1 font-semibold text-[var(--pbl-teacher)]">管理课程<ArrowRight size={14} /></span></div></div></Link>)}</div>}
      {!loading && !error && visible.length === 0 ? <PlatformEmpty title={offerings.length ? "没有找到相关课程" : "从第一门课程系列开始"} description={offerings.length ? "试试其他关键词或筛选条件。" : "创建课程后，按章节添加课堂、问卷、作业与参考资料。"} /> : null}
    </div><Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}><DialogContent className="pbl-platform-theme pbl-platform-dialog bg-[var(--pbl-surface)] sm:max-w-lg"><DialogHeader><DialogTitle className="font-serif text-2xl">新建课程系列</DialogTitle><DialogDescription>先为课程命名，随后编排章节、完善课程主页。</DialogDescription></DialogHeader><form onSubmit={create} className="space-y-5"><label className="block space-y-2 text-sm"><span>课程名称</span><input autoFocus required maxLength={160} className={input} placeholder="例如：设计思维与社区创新" value={name} onChange={(event) => setName(event.target.value)} /></label><label className="block space-y-2 text-sm"><span>学期</span><input className={input} placeholder="例如：2026 秋季" value={term} onChange={(event) => setTerm(event.target.value)} /></label>{error ? <p role="alert" className="text-sm text-[var(--pbl-danger)]">{error}</p> : null}<button disabled={busy} className="min-h-11 w-full rounded-[6px] bg-[var(--pbl-teacher)] text-sm font-semibold text-white disabled:opacity-50">{busy ? "正在创建…" : "创建课程系列"}</button></form></DialogContent></Dialog>
  </TeacherPlatformPage>;
}
