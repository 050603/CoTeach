"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import Link from "next/link";
import { ResilientImage } from "@/components/resilient-image";
import { LearningArt } from "@/components/platform/learning-art";
import { PlatformLoading, PlatformEmpty, PlatformError } from "@/components/platform/platform-feedback";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowRight, BookOpen, CalendarDays, Plus, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
      if (!response.ok) throw new Error(data.message ?? "无法加载教学班");
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
  const summary = [
    ["教学班", offerings.length],
    ["开放中", offerings.filter((item) => item.status.toLowerCase() === "open").length],
    ["学习内容", offerings.reduce((sum, item) => sum + item.chapters.reduce((count, chapter) => count + chapter.activities.length, 0), 0)],
  ] as const;
  return <TeacherPlatformPage>
    <TeacherPlatformHeader active="classes" />
    <div className="pbl-workspace-content pbl-teacher-dashboard pbl-teacher-classes-page"><div className="pbl-page-heading pbl-classes-heading pbl-teacher-dashboard-heading"><LearningArt /><div><p className="text-xs tracking-[0.18em] text-[var(--pbl-teacher)]">课程管理</p><h1 className="mt-3 text-3xl font-semibold md:text-4xl">教学班</h1></div><div className="pbl-classes-heading-actions"><dl className="pbl-heading-metrics" aria-label="课程概况">{summary.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{loading ? "—" : value}</dd></div>)}</dl><button onClick={() => setOpen(true)} className="pbl-teacher-create-button"><Plus size={17} />新建教学班</button></div></div>
      <div className="pbl-list-toolbar pbl-teacher-list-toolbar"><label className="pbl-teacher-search"><Search size={18} /><input aria-label="搜索教学班" placeholder="搜索课程名称或学期" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="pbl-teacher-toolbar-actions"><span>{visible.length} 个教学班</span><select aria-label="课程状态" className="pbl-teacher-filter-select" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="">全部状态</option><option value="draft">草稿</option><option value="open">开放中</option><option value="finished">已结课</option><option value="archived">已归档</option></select></div></div>
      {error && !open ? <PlatformError message={error} onRetry={() => void load()} /> : null}
      {loading ? <PlatformLoading label="正在加载教学班…" /> : <div className="pbl-teacher-card-grid">{visible.map((item, index) => <Link key={item.id} href={`/teacher/classes/${item.id}`} className="pbl-course-card pbl-teacher-class-card group"><div className="pbl-course-art pbl-teacher-class-cover">{item.coverImageUrl ? <ResilientImage fill unoptimized fallback={<LearningArt variant={index} />} src={item.coverImageUrl} alt={`${item.name}教学班封面`} className="absolute inset-0 h-full w-full object-cover" /> : <><LearningArt variant={index} /><span className="pbl-cover-index">教学班 / {String(index + 1).padStart(2, "0")}</span><BookOpen size={25} strokeWidth={1.5} className="pbl-teacher-cover-icon" /></>}<span className="pbl-teacher-status-badge" data-status={item.status.toLowerCase()}>{offeringStatusLabel(item.status)}</span></div><div className="pbl-teacher-class-body"><p className="pbl-teacher-card-eyebrow">{item.term || "学期待设置"}</p><h2 title={item.name}>{item.name}</h2><p className="pbl-teacher-card-description">{item.description || "暂无课程介绍"}</p><p className="pbl-teacher-card-date"><CalendarDays size={14} />{item.startsAt ? `${new Date(item.startsAt).toLocaleDateString("zh-CN")} 开课` : "开课时间待设置"}</p><div className="pbl-teacher-card-footer"><span>{item.chapters.length} 章 · {item.chapters.reduce((sum, chapter) => sum + chapter.activities.length, 0)} 项学习内容</span><strong>管理教学班<ArrowRight size={14} /></strong></div></div></Link>)}</div>}
      {!loading && !error && visible.length === 0 ? <PlatformEmpty title={offerings.length ? "没有找到相关教学班" : "创建第一个教学班"} description={offerings.length ? "试试其他关键词或筛选条件。" : "创建教学班后，按章节添加课堂、问卷、作业与参考资料。"} /> : null}
    </div><Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}><DialogContent className="pbl-platform-theme pbl-platform-dialog pbl-platform-form-dialog pbl-course-series-dialog bg-[var(--pbl-surface)] sm:max-w-xl"><DialogHeader><span className="pbl-dialog-header-icon"><BookOpen size={20} /></span><div><p className="pbl-dialog-eyebrow">建立教学空间</p><DialogTitle className="font-serif text-2xl">新建教学班</DialogTitle><DialogDescription>创建基础信息后，即可进入教学班编排章节、课堂和学习任务。</DialogDescription></div></DialogHeader><form onSubmit={create}><div className="pbl-platform-dialog-body"><div className="pbl-dialog-section-heading"><div><h3>课程基本信息</h3><p>课程名称将直接展示给学生，学期可稍后在课程设置中修改。</p></div><span>01</span></div><div className="pbl-dialog-field-stack"><label className="pbl-dialog-field"><span>课程名称 <small>必填</small></span><input autoFocus required maxLength={160} className={input} placeholder="例如：设计思维与社区创新" value={name} onChange={(event) => setName(event.target.value)} /></label><label className="pbl-dialog-field"><span>开课学期</span><input className={input} placeholder="例如：2026 秋季" value={term} onChange={(event) => setTerm(event.target.value)} /></label></div>{error ? <p role="alert" className="pbl-dialog-error">{error}</p> : null}</div><DialogFooter className="pbl-platform-dialog-footer"><p>创建后进入教学班详情继续完善，不会立即向学生开放。</p><div><button type="button" disabled={busy} className="pbl-dialog-secondary" onClick={() => setOpen(false)}>取消</button><button disabled={busy} className="pbl-dialog-primary">{busy ? "正在创建…" : "创建并继续"}</button></div></DialogFooter></form></DialogContent></Dialog>
  </TeacherPlatformPage>;
}
