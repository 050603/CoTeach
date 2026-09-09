"use client";

import Link from "next/link";
import Image from "next/image";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, ClipboardCheck, RefreshCw, Users } from "lucide-react";
import { teacherClassroomEntry } from "@/lib/platform/classroom-entry";
import { TeacherPlatformHeader, TeacherPlatformPage } from "@/components/platform/teacher-shell";

type Classroom = { instance: { id: string; title: string; offeringId: string; status: string; snapshot: unknown; coverImageUrl?: string | null }; participants: Array<{ id: string; displayName: string; lastEnteredAt: string | null; completedAt: string | null; _count: { artifacts: number; reflections: number; evaluations: number } }> };
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-4 text-sm font-medium disabled:opacity-50";

export default function ClassroomMonitor() {
  const { instanceId } = useParams<{ instanceId: string }>();
  const [data, setData] = useState<Classroom | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/platform/classroom-instances/${instanceId}/participants`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "无法读取课堂");
      setData(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取课堂"); }
    finally { setLoading(false); }
  }, [instanceId]);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);
  const snapshot = data?.instance.snapshot;
  const kind = snapshot && typeof snapshot === "object" && "kind" in snapshot && typeof snapshot.kind === "string" ? snapshot.kind : undefined;
  const entry = data ? teacherClassroomEntry(data.instance, kind) : null;
  const status = data?.instance.status.toLowerCase();
  const back = data ? `/teacher/classes/${data.instance.offeringId}` : "/teacher/classes";
  const metrics = [
    ["参与学生", data?.participants.length ?? 0, "已进入本场课堂"],
    ["项目成果", data?.participants.reduce((sum, participant) => sum + participant._count.artifacts, 0) ?? 0, "记录每一次实践"],
    ["学习反思", data?.participants.reduce((sum, participant) => sum + participant._count.reflections, 0) ?? 0, "让经验转化为成长"],
    ["已有评价", data?.participants.filter(participant => participant._count.evaluations > 0).length ?? 0, "已收到评价的学生"],
  ];
  return <TeacherPlatformPage>
    <TeacherPlatformHeader active="classes" backHref={back} backLabel="返回课程" />
    <div className="pbl-workspace-content">
      <header className="pbl-page-heading"><div><p className="text-xs font-semibold tracking-widest text-[var(--pbl-teacher)]">学习过程 · 成长证据</p><h1 className="mt-3 font-serif text-3xl font-semibold md:text-4xl">课堂学习记录</h1><p className="mt-4 break-words text-base text-[var(--pbl-text-muted)]">{data?.instance.title ?? "查看学生的参与、成果与评价"}</p>{data && <span className="mt-5 inline-flex rounded-full bg-[var(--pbl-teacher-soft)] px-4 py-2 text-sm text-[var(--pbl-teacher)]">{status === "teaching" ? "授课中" : status === "finished" ? "已结束 · 记录留存" : "待授课"}</span>}</div>{data?.instance.coverImageUrl ? <div className="relative aspect-video w-[360px] max-w-[38%] shrink-0 overflow-hidden rounded-[14px] border border-white/70 shadow-lg"><Image src={data.instance.coverImageUrl} alt={`${data.instance.title}课堂封面`} fill unoptimized className="object-cover" /></div> : null}</header>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="课堂概况">{metrics.map(([label, value, detail]) => <div className="pbl-stat-card" key={label}><p className="text-xs text-[var(--pbl-text-muted)]">{label}</p><strong className="mt-3 block text-3xl font-semibold tabular-nums">{data ? value : "—"}</strong><p className="mt-2 text-xs text-[var(--pbl-text-muted)]">{detail}</p></div>)}</div>
      <section className="mt-7 overflow-hidden rounded-2xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--pbl-border)] p-5 md:p-6"><div><h2 className="flex items-center gap-2 text-lg font-semibold"><Users size={20} className="text-[var(--pbl-teacher)]"/>学生学习档案</h2><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">查看每位学生的作品与反思，留下具体的成长反馈。</p></div><div className="flex flex-wrap gap-2"><button className={button} disabled={loading} onClick={() => void load()}><RefreshCw size={15} className={loading ? "motion-safe:animate-spin" : ""}/>{loading ? "正在刷新" : "刷新记录"}</button>{entry && <Link className={button} href={status === "finished" ? `/teacher/teach/${instanceId}/setup` : entry.href}>{status === "finished" ? "返回教学工作台" : entry.label}<ArrowUpRight size={16}/></Link>}</div></div>
        {error && <div role="alert" className="m-5 rounded-xl bg-red-50 p-4 text-sm text-[var(--pbl-danger)]">{error}<button className="ml-3 underline" onClick={() => void load()}>重新加载</button></div>}
        {!data && loading ? <div role="status" className="space-y-4 p-6"><p className="text-sm text-[var(--pbl-text-muted)]">正在加载学习记录…</p>{[0, 1, 2].map(item => <div key={item} className="h-14 rounded-xl bg-[var(--pbl-bg)] motion-safe:animate-pulse"/>)}</div> : data && data.participants.length === 0 ? <div className="px-6 py-16 text-center"><ClipboardCheck size={36} strokeWidth={1.4} className="mx-auto text-[var(--pbl-teacher)]"/><h3 className="mt-4 font-semibold">等待第一份学习记录</h3><p className="mt-2 text-sm leading-7 text-[var(--pbl-text-muted)]">学生进入课堂后，参与情况与提交的成果将在这里汇集。</p></div> : data && <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><caption className="sr-only">学生参与、成果、反思和评价记录</caption><thead className="bg-[var(--pbl-bg)] text-xs text-[var(--pbl-text-muted)]"><tr>{["学生", "最近参与", "成果", "反思", "评价", "学习档案"].map(label => <th scope="col" key={label} className="px-5 py-4 font-medium">{label}</th>)}</tr></thead><tbody>{data.participants.map(participant => <tr className="border-t border-[var(--pbl-border)] transition-colors hover:bg-[var(--pbl-bg)]" key={participant.id}><th scope="row" className="max-w-60 break-words px-5 py-4 font-medium">{participant.displayName}</th><td className="px-5 py-4 text-xs text-[var(--pbl-text-muted)]">{participant.lastEnteredAt ? new Date(participant.lastEnteredAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "暂无记录"}</td><td className="px-5 py-4 tabular-nums">{participant._count.artifacts}</td><td className="px-5 py-4 tabular-nums">{participant._count.reflections}</td><td className="px-5 py-4 tabular-nums">{participant._count.evaluations}</td><td className="px-5 py-4"><Link className="inline-flex min-h-11 items-center gap-1 font-medium text-[var(--pbl-teacher)]" href={`/teacher/participations/${participant.id}`} aria-label={`查看与评价 ${participant.displayName}`}>查看与评价<ArrowUpRight size={14}/></Link></td></tr>)}</tbody></table></div>}
      </section>
    </div>
  </TeacherPlatformPage>;
}
