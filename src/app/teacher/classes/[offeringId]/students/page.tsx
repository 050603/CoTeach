"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownToLine, ChevronLeft, ChevronRight, ClipboardCopy, Clock3, Database,
  FileCheck2, KeyRound, PackageCheck, Search, Settings2, Trash2, UserRoundCheck,
  UsersRound, X,
} from "lucide-react";
import { PlatformEmpty, PlatformError, PlatformLoading } from "@/components/platform/platform-feedback";
import { TeacherPlatformHeader, TeacherPlatformPage } from "@/components/platform/teacher-shell";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogTitle, AlertDialogTrigger,
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Drawer, DrawerContent,
} from "@/components/ui";
import { Checkbox } from "@/components/ui/checkbox";
import { copyTextToClipboard } from "@/lib/browser/copy-text";
import { teacherPlatformFetch } from "@/lib/platform/client";
import { activityTypeLabel, progressStatusLabel } from "@/lib/platform/labels";
import type {
  getOfferingStudentDetail, getStudentActivitySubmissions, OfferingStudentSummary,
  OfferingStudentsSummary, StudentAttentionReason,
} from "@/lib/platform/student-records";

type StudentDetailData = Awaited<ReturnType<typeof getOfferingStudentDetail>>;
type SubmissionData = Awaited<ReturnType<typeof getStudentActivitySubmissions>>;
type DetailTab = "progress" | "submissions" | "classrooms" | "account";
type SortMode = "recent" | "name" | "completion";
type LearningStatus = "all" | "not_started" | "in_progress" | "completed";
type AttentionFilter = "all" | "participated" | StudentAttentionReason;
type ExportSection = "summary" | "activity_progress" | "activity_submissions" | "classrooms" | "artifacts" | "reflections" | "evaluations" | "summary_csv";

const PAGE_SIZE = 20;
const attentionLabels: Record<StudentAttentionReason, string> = {
  not_participated: "尚未参与",
  incomplete_open_activity: "有开放活动未完成",
  pending_teacher_evaluation: "待教师评价",
};
const tabLabels: Record<Exclude<DetailTab, "account">, string> = { progress: "活动进度", submissions: "提交记录", classrooms: "课堂与评价" };
const fieldClass = "min-h-11 rounded-[10px] border border-[var(--pbl-border)] bg-white px-3 text-sm outline-none";
const secondaryButton = "inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-[var(--pbl-border)] bg-white px-4 text-sm font-medium hover:border-[var(--pbl-teacher)] disabled:opacity-50";
const defaultExportSections: ExportSection[] = ["summary", "activity_progress", "activity_submissions", "classrooms", "artifacts", "reflections", "evaluations"];
const exportOptions: Array<{ value: ExportSection; label: string; description: string }> = [
  { value: "summary", label: "学生与学习摘要", description: "身份、完成比例、课堂参与、最近学习时间和关注原因" },
  { value: "activity_progress", label: "活动进度", description: "每项活动的状态、访问与完成时间，以及最新进度数据" },
  { value: "activity_submissions", label: "活动提交与问卷作答", description: "完整提交历史、提交时题目快照和答案" },
  { value: "classrooms", label: "课堂参与与阶段提交", description: "课堂场次、进入时间、阶段进度和已提交内容" },
  { value: "artifacts", label: "课堂成果与版本", description: "成果信息和全部已提交版本" },
  { value: "reflections", label: "学习反思", description: "课堂反思正文与时间" },
  { value: "evaluations", label: "评价记录", description: "教师评价、学生自评、分数和量规数据" },
  { value: "summary_csv", label: "附带摘要 CSV", description: "便于电子表格打开，作为 JSON 之外的兼容格式" },
];

function formatTime(value: string | null | undefined, fallback = "暂无记录") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function completionText(student: OfferingStudentSummary) {
  return student.openActivityCount ? `${student.completedOpenActivities}/${student.openActivityCount}` : "暂无开放活动";
}
function useWideLayout() {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const media = window.matchMedia?.("(min-width: 1280px)");
    if (!media) return;
    const update = () => setWide(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return wide;
}

export default function TeacherStudentsPage() {
  return <Suspense fallback={<PageLoading/>}><TeacherStudentsContent/></Suspense>;
}
function PageLoading() {
  return <TeacherPlatformPage><TeacherPlatformHeader compact active="classes"/><div className="pbl-workspace-content"><PlatformLoading label="正在汇总学生学习记录…"/></div></TeacherPlatformPage>;
}

function TeacherStudentsContent() {
  const { offeringId } = useParams<{ offeringId: string }>();
  const searchParams = useSearchParams();
  const [summary, setSummary] = useState<OfferingStudentsSummary | null>(null);
  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [activityId, setActivityId] = useState(searchParams.get("activity") ?? "all");
  const [learningStatus, setLearningStatus] = useState<LearningStatus>((searchParams.get("status") as LearningStatus) ?? "all");
  const [attention, setAttention] = useState<AttentionFilter>((searchParams.get("attention") as AttentionFilter) ?? "all");
  const [sort, setSort] = useState<SortMode>((searchParams.get("sort") as SortMode) ?? "recent");
  const [page, setPage] = useState(Math.max(1, Number(searchParams.get("page") ?? "1") || 1));
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get("student"));
  const [tab, setTab] = useState<DetailTab>((searchParams.get("tab") as DetailTab) ?? "progress");
  const [detail, setDetail] = useState<StudentDetailData | null>(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exportSections, setExportSections] = useState<ExportSection[]>(defaultExportSections);
  const wide = useWideLayout();
  const detailRequest = useRef(0);
  const studentListViewport = useRef<HTMLDivElement>(null);
  const studentButtons = useRef(new Map<string, HTMLButtonElement>());

  const load = useCallback(async () => {
    const response = await teacherPlatformFetch(`/api/platform/offerings/${offeringId}/students?view=summary`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message ?? "无法加载学生");
    setSummary(data);
  }, [offeringId]);
  useEffect(() => {
    setLoading(true); setError("");
    void load().catch((reason) => setError(reason instanceof Error ? reason.message : "加载失败")).finally(() => setLoading(false));
  }, [load]);

  const filtered = useMemo(() => {
    if (!summary) return [];
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return summary.students.filter((student) => {
      if (normalizedQuery && !`${student.displayName} ${student.username}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery)) return false;
      if (attention === "participated" && !student.participated) return false;
      if (attention !== "all" && attention !== "participated" && !student.attentionReasons.includes(attention)) return false;
      const status = activityId === "all"
        ? (!student.participated ? "not_started" : student.openActivityCount > 0 && student.completedOpenActivities === student.openActivityCount ? "completed" : "in_progress")
        : student.activityStatuses[activityId] ?? "not_started";
      return learningStatus === "all" || status === learningStatus;
    }).sort((a, b) => {
      if (sort === "name") return a.displayName.localeCompare(b.displayName, "zh-CN");
      if (sort === "completion") {
        const left = a.openActivityCount ? a.completedOpenActivities / a.openActivityCount : -1;
        const right = b.openActivityCount ? b.completedOpenActivities / b.openActivityCount : -1;
        return right - left || a.displayName.localeCompare(b.displayName, "zh-CN");
      }
      if (!a.lastLearningAt && !b.lastLearningAt) return a.displayName.localeCompare(b.displayName, "zh-CN");
      if (!a.lastLearningAt) return 1;
      if (!b.lastLearningAt) return -1;
      return Date.parse(b.lastLearningAt) - Date.parse(a.lastLearningAt);
    });
  }, [activityId, attention, learningStatus, query, sort, summary]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const selected = summary?.students.find((student) => student.enrollmentId === selectedId) ?? null;

  useEffect(() => { setPage(1); }, [query, activityId, learningStatus, attention, sort]);
  useEffect(() => {
    if ((!selectedId || !filtered.some((student) => student.enrollmentId === selectedId)) && visible[0]) setSelectedId(visible[0].enrollmentId);
  }, [filtered, selectedId, visible]);
  useEffect(() => {
    const viewport = studentListViewport.current;
    const item = studentButtons.current.get(selectedId ?? "");
    if (!viewport || !item) return;
    const viewportRect = viewport.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.top < viewportRect.top) viewport.scrollTop -= viewportRect.top - itemRect.top;
    else if (itemRect.bottom > viewportRect.bottom) viewport.scrollTop += itemRect.bottom - viewportRect.bottom;
  }, [safePage, selectedId]);

  const loadDetail = useCallback(async (enrollmentId: string) => {
    const requestId = ++detailRequest.current;
    setDetailLoading(true); setDetailError(""); setDetail(null);
    try {
      const response = await teacherPlatformFetch(`/api/platform/offerings/${offeringId}/students/${enrollmentId}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "无法加载学生档案");
      if (requestId === detailRequest.current) setDetail(data);
    } catch (reason) {
      if (requestId === detailRequest.current) setDetailError(reason instanceof Error ? reason.message : "无法加载学生档案");
    } finally {
      if (requestId === detailRequest.current) setDetailLoading(false);
    }
  }, [offeringId]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); }, [loadDetail, selectedId]);
  useEffect(() => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (activityId !== "all") params.set("activity", activityId);
    if (learningStatus !== "all") params.set("status", learningStatus);
    if (attention !== "all") params.set("attention", attention);
    if (sort !== "recent") params.set("sort", sort);
    if (safePage > 1) params.set("page", String(safePage));
    if (selectedId) params.set("student", selectedId);
    if (tab !== "progress") params.set("tab", tab);
    window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
  }, [activityId, attention, learningStatus, query, safePage, selectedId, sort, tab]);

  function selectStudent(enrollmentId: string) {
    setSelectedId(enrollmentId);
    if (!wide) setDrawerOpen(true);
  }
  function moveStudent(direction: -1 | 1) {
    const index = filtered.findIndex((student) => student.enrollmentId === selectedId);
    const next = filtered[index + direction];
    if (next) { setSelectedId(next.enrollmentId); setPage(Math.floor((index + direction) / PAGE_SIZE) + 1); }
  }
  async function exportArchive() {
    if (!filtered.length || !exportSections.length || exportBusy) return;
    setExportBusy(true); setExportError("");
    try {
      const response = await teacherPlatformFetch(`/api/platform/offerings/${offeringId}/students/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enrollmentIds: filtered.map((student) => student.enrollmentId), sections: exportSections }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.message ?? "无法生成数据包");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const fileName = encodedName ? decodeURIComponent(encodedName) : `${summary?.offering.name ?? "教学班"}-学生学习记录.zip`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = fileName; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setExportOpen(false);
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : "无法生成数据包，请重试");
    } finally {
      setExportBusy(false);
    }
  }
  function toggleExportSection(section: ExportSection) {
    setExportSections((current) => current.includes(section) ? current.filter((item) => item !== section) : [...current, section]);
  }
  function studentRemoved(enrollmentId: string) {
    const currentIndex = filtered.findIndex((student) => student.enrollmentId === enrollmentId);
    const next = filtered[currentIndex + 1] ?? filtered[currentIndex - 1] ?? null;
    setSummary((current) => {
      if (!current) return current;
      const students = current.students.filter((student) => student.enrollmentId !== enrollmentId);
      return { ...current, students, totals: {
        members: students.length,
        participated: students.filter((student) => student.participated).length,
        incomplete: students.filter((student) => student.attentionReasons.includes("incomplete_open_activity")).length,
        pendingEvaluation: students.filter((student) => student.attentionReasons.includes("pending_teacher_evaluation")).length,
      } };
    });
    setSelectedId(next?.enrollmentId ?? null); setDetail(null); setDrawerOpen(false);
    void load().catch((reason) => setError(reason instanceof Error ? reason.message : "无法刷新学生名单"));
  }
  const retry = () => {
    setLoading(true); setError("");
    void load().catch((reason) => setError(reason instanceof Error ? reason.message : "加载失败")).finally(() => setLoading(false));
  };
  const detailProps = { summary: selected, data: detail, loading: detailLoading, error: detailError, tab, setTab, index: filtered.findIndex((student) => student.enrollmentId === selectedId), total: filtered.length, onMove: moveStudent, onRetry: () => selectedId && void loadDetail(selectedId), onStudentRemoved: studentRemoved, offeringId };

  return <TeacherPlatformPage><TeacherPlatformHeader compact active="classes" backHref={`/teacher/classes/${offeringId}`} backLabel="返回教学班"/>
    <div className="pbl-workspace-content xl:pb-5">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div><p className="text-xs font-semibold tracking-[.16em] text-[var(--pbl-teacher)]">{summary?.offering.name ?? "教学班"}</p><h1 className="mt-2 text-3xl font-semibold">学生与学习记录</h1></div>
        <button className={secondaryButton} disabled={!filtered.length} onClick={() => { setExportError(""); setExportOpen(true); }}><ArrowDownToLine size={17}/>导出当前结果</button>
      </header>
      {error ? <div className="mt-5"><PlatformError message={error} onRetry={retry}/></div> : null}
      {loading ? <PlatformLoading label="正在汇总学生学习记录…"/> : summary ? <>
        <section aria-label="班级学习概览" className="mt-7 grid grid-cols-4 border-y border-[var(--pbl-border)] py-5">
          {[
            { label: "课程成员", value: summary.totals.members, filter: "all" as AttentionFilter },
            { label: "已参与学习", value: summary.totals.participated, filter: "participated" as AttentionFilter },
            { label: "存在未完成活动", value: summary.totals.incomplete, filter: "incomplete_open_activity" as AttentionFilter },
            { label: "待教师评价", value: summary.totals.pendingEvaluation, filter: "pending_teacher_evaluation" as AttentionFilter },
          ].map((item, index) => <button key={item.label} className={`min-h-20 border-l px-5 text-left first:border-l-0 ${attention === item.filter && item.filter !== "all" ? "bg-[var(--pbl-teacher-soft)]" : "hover:bg-white/60"}`} onClick={() => setAttention(item.filter)} aria-pressed={attention === item.filter && item.filter !== "all"}><span className="text-xs text-[var(--pbl-text-muted)]">{item.label}</span><strong className="mt-2 block text-2xl font-semibold tabular-nums">{item.value}</strong>{index === 1 ? <small className="text-[11px] text-[var(--pbl-text-muted)]">含真实访问或提交记录</small> : null}</button>)}
        </section>
        <section aria-label="筛选学生" className="mt-6 grid grid-cols-2 gap-3 xl:grid-cols-[minmax(220px,1fr)_repeat(4,minmax(135px,190px))]">
          <label className={`${fieldClass} col-span-2 flex items-center gap-2 xl:col-span-1`}><Search size={17}/><input className="min-w-0 flex-1 bg-transparent outline-none" aria-label="搜索学生" placeholder="搜索姓名或账号" value={query} onChange={(event) => setQuery(event.target.value)}/>{query ? <button aria-label="清除搜索" className="grid size-9 place-items-center" onClick={() => setQuery("")} type="button"><X size={15}/></button> : null}</label>
          <select className={fieldClass} aria-label="筛选活动" value={activityId} onChange={(event) => setActivityId(event.target.value)}><option value="all">全部活动</option>{summary.activities.filter((item) => !item.archived).map((item) => <option key={item.id} value={item.id}>{item.chapterTitle} · {item.title}</option>)}</select>
          <select className={fieldClass} aria-label="学习状态" value={learningStatus} onChange={(event) => setLearningStatus(event.target.value as LearningStatus)}><option value="all">全部学习状态</option><option value="not_started">未开始</option><option value="in_progress">进行中</option><option value="completed">已完成</option></select>
          <select className={fieldClass} aria-label="关注筛选" value={attention} onChange={(event) => setAttention(event.target.value as AttentionFilter)}><option value="all">全部关注状态</option><option value="not_participated">尚未参与</option><option value="incomplete_open_activity">有开放活动未完成</option><option value="pending_teacher_evaluation">待教师评价</option><option value="participated">已参与学习</option></select>
          <select className={fieldClass} aria-label="排序方式" value={sort} onChange={(event) => setSort(event.target.value as SortMode)}><option value="recent">最近学习优先</option><option value="name">按姓名排序</option><option value="completion">按完成比例排序</option></select>
        </section>
        {attention !== "all" ? <div className="mt-3 flex items-center gap-2 text-sm text-[var(--pbl-teacher)]"><span>关注筛选：{attention === "participated" ? "已参与学习" : attentionLabels[attention]}</span><button className="min-h-11 px-2 underline" onClick={() => setAttention("all")}>清除</button></div> : null}
        <div className="mt-6 grid min-h-[620px] grid-cols-1 gap-7 xl:grid-cols-[minmax(320px,32%)_minmax(0,1fr)] xl:gap-0">
          <section aria-label="学生名单" className="min-w-0 xl:sticky xl:top-[92px] xl:flex xl:h-[calc(100vh-112px)] xl:min-h-0 xl:self-start xl:flex-col xl:pr-5">
            <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">学生名单</h2><span className="text-xs text-[var(--pbl-text-muted)]">{filtered.length} 位学生</span></div>
            <div ref={studentListViewport} className="pbl-student-pane-scroll overflow-hidden border-y border-[var(--pbl-border)] bg-white/35 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain">
              {visible.map((student) => <button ref={(node) => { if (node) studentButtons.current.set(student.enrollmentId, node); else studentButtons.current.delete(student.enrollmentId); }} data-enrollment-id={student.enrollmentId} key={student.enrollmentId} aria-current={selectedId === student.enrollmentId ? "true" : undefined} className={`grid min-h-28 w-full grid-cols-[38px_minmax(0,1fr)] items-start gap-3 border-b border-[var(--pbl-border)] px-3 py-4 text-left last:border-b-0 ${selectedId === student.enrollmentId ? "bg-[var(--pbl-teacher-soft)]" : "hover:bg-white"}`} onClick={() => selectStudent(student.enrollmentId)}>
                <span className="grid size-9 place-items-center rounded-[9px] bg-white text-[var(--pbl-teacher)]"><UsersRound size={18}/></span>
                <span className="min-w-0"><span className="flex items-start justify-between gap-3"><strong className="min-w-0 truncate text-sm">{student.displayName}</strong><small className="shrink-0 font-semibold tabular-nums text-[var(--pbl-teacher)]">活动 {completionText(student)}</small></span><small className="mt-1 block truncate text-[var(--pbl-text-muted)]">{student.username}</small><span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--pbl-text-muted)]"><span>课堂 {student.classroomParticipationCount} 次</span><span className="flex items-center gap-1"><Clock3 size={12}/>{formatTime(student.lastLearningAt)}</span></span><span className="mt-2 flex flex-wrap gap-1">{student.attentionReasons.map((reason) => <small key={reason} className={`rounded-full px-2 py-1 text-[10px] ${reason === "pending_teacher_evaluation" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"}`}>{attentionLabels[reason]}</small>)}</span></span>
              </button>)}
              {!visible.length ? <PlatformEmpty title={query || attention !== "all" || learningStatus !== "all" || activityId !== "all" ? "没有符合条件的学生" : "等待学生加入"} description={query || attention !== "all" || learningStatus !== "all" || activityId !== "all" ? "调整搜索词或筛选条件后再试。" : "学生使用课程邀请码加入后，将显示在这里。"}/> : null}
            </div>
            {filtered.length > PAGE_SIZE ? <nav aria-label="学生名单分页" className="mt-4 flex items-center justify-between"><button className={secondaryButton} disabled={safePage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={16}/>上一页</button><span className="text-xs text-[var(--pbl-text-muted)]">第 {safePage} / {pageCount} 页</span><button className={secondaryButton} disabled={safePage === pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>下一页<ChevronRight size={16}/></button></nav> : null}
          </section>
          <aside className="hidden min-w-0 border-l border-[var(--pbl-border)] xl:block xl:pl-8 xl:pr-4"><StudentDetail {...detailProps}/></aside>
        </div>
      </> : null}
    </div>
    {!wide ? <Drawer open={drawerOpen && Boolean(selected)} onOpenChange={setDrawerOpen}><DrawerContent className="pbl-platform-theme pbl-student-pane-scroll w-[min(760px,100vw)]"><StudentDetail {...detailProps}/></DrawerContent></Drawer> : null}
    <ExportDialog open={exportOpen} onOpenChange={setExportOpen} count={filtered.length} sections={exportSections} onToggle={toggleExportSection} busy={exportBusy} error={exportError} onExport={() => void exportArchive()}/>
  </TeacherPlatformPage>;
}

function ExportDialog({ open, onOpenChange, count, sections, onToggle, busy, error, onExport }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  sections: ExportSection[];
  onToggle: (section: ExportSection) => void;
  busy: boolean;
  error: string;
  onExport: () => void;
}) {
  return <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value); }}><DialogContent className="pbl-platform-theme pbl-platform-dialog w-[min(700px,calc(100vw-24px))]"><DialogHeader><DialogTitle>导出学生学习记录数据包</DialogTitle><DialogDescription>将导出当前筛选结果中的 {count} 位学生。选择需要的数据后，系统会生成结构化 ZIP，JSON 文件可直接用于后续统计与分析。</DialogDescription></DialogHeader>
    <div className="grid gap-2 sm:grid-cols-2">{exportOptions.map((option) => <label key={option.value} htmlFor={`export-${option.value}`} className={`flex cursor-pointer gap-3 rounded-[12px] border p-3 transition ${sections.includes(option.value) ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)]" : "border-[var(--pbl-border)] bg-white hover:border-[var(--pbl-teacher)]"}`}><Checkbox id={`export-${option.value}`} checked={sections.includes(option.value)} onCheckedChange={() => onToggle(option.value)} className="mt-0.5"/><span><strong className="block text-sm font-medium">{option.label}</strong><small className="mt-1 block text-xs leading-5 text-[var(--pbl-text-muted)]">{option.description}</small></span></label>)}</div>
    <div className="flex gap-3 rounded-[10px] bg-[var(--pbl-bg)] p-3 text-xs leading-5 text-[var(--pbl-text-muted)]"><Database className="mt-0.5 shrink-0" size={16}/><p>压缩包内包含 manifest.json 和中文说明，所有数据文件通过 enrollmentId、activityId 与 participationId 建立关联。摘要 CSV 为可选兼容格式。</p></div>
    {error ? <p role="alert" className="text-sm text-[var(--pbl-danger)]">{error}</p> : null}
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--pbl-border)] pt-4"><span className="text-xs text-[var(--pbl-text-muted)]">已选择 {sections.length} 类数据</span><div className="flex gap-2"><button className={secondaryButton} disabled={busy} onClick={() => onOpenChange(false)}>取消</button><button className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] bg-[var(--pbl-teacher)] px-5 text-sm font-semibold text-white disabled:opacity-50" disabled={!sections.length || busy} onClick={onExport}><PackageCheck size={17}/>{busy ? "正在整理数据…" : "生成并下载 ZIP"}</button></div></div>
  </DialogContent></Dialog>;
}

function StudentDetail({ summary, data, loading, error, tab, setTab, index, total, onMove, onRetry, onStudentRemoved, offeringId }: {
  summary: OfferingStudentSummary | null; data: StudentDetailData | null; loading: boolean; error: string; tab: DetailTab; setTab: (tab: DetailTab) => void;
  index: number; total: number; onMove: (direction: -1 | 1) => void; onRetry: () => void; onStudentRemoved: (enrollmentId: string) => void; offeringId: string;
}) {
  if (!summary) return <div className="grid min-h-80 place-items-center text-sm text-[var(--pbl-text-muted)]">从名单中选择学生查看学习档案</div>;
  return <>
    <header className="flex flex-wrap items-start justify-between gap-4 pr-10 xl:pr-0">
      <div><p className="text-xs text-[var(--pbl-text-muted)]">学生学习档案</p><h2 className="mt-1 text-xl font-semibold">{summary.displayName}</h2><p className="mt-1 text-xs text-[var(--pbl-text-muted)]">{summary.username} · {summary.classroomParticipationCount} 次课堂参与</p></div>
      <div className="flex items-center gap-1"><button className="grid min-h-11 min-w-11 place-items-center rounded-[10px] border border-[var(--pbl-border)]" aria-label="上一位学生" disabled={index <= 0} onClick={() => onMove(-1)}><ChevronLeft size={17}/></button><span className="px-2 text-xs text-[var(--pbl-text-muted)]">{index + 1}/{total}</span><button className="grid min-h-11 min-w-11 place-items-center rounded-[10px] border border-[var(--pbl-border)]" aria-label="下一位学生" disabled={index < 0 || index >= total - 1} onClick={() => onMove(1)}><ChevronRight size={17}/></button></div>
    </header>
    <nav aria-label="学生档案内容" className="pbl-student-detail-tabs mt-5 flex overflow-x-auto border-b border-[var(--pbl-border)]">{(Object.keys(tabLabels) as Array<Exclude<DetailTab, "account">>).map((item) => <button key={item} role="tab" aria-selected={tab === item} className={`relative min-h-12 shrink-0 px-4 text-sm font-medium ${tab === item ? "text-[var(--pbl-teacher)] after:absolute after:inset-x-2 after:bottom-[-1px] after:h-0.5 after:bg-[var(--pbl-teacher)]" : "text-[var(--pbl-text-muted)]"}`} onClick={() => setTab(item)}>{tabLabels[item]}</button>)}<span className="min-w-3 flex-1"/><button role="tab" aria-selected={tab === "account"} className={`relative flex min-h-12 shrink-0 items-center gap-1.5 px-3 text-sm font-medium ${tab === "account" ? "text-[var(--pbl-teacher)] after:absolute after:inset-x-2 after:bottom-[-1px] after:h-0.5 after:bg-[var(--pbl-teacher)]" : "text-[var(--pbl-text-muted)]"}`} onClick={() => setTab("account")}><Settings2 size={15}/>账号设置</button></nav>
    {tab === "account" ? <div className="py-5"><AccountTab summary={summary} offeringId={offeringId} onStudentRemoved={onStudentRemoved}/></div> : loading ? <div className="py-8"><PlatformLoading label="正在加载学习档案…"/></div> : error ? <div className="mt-5"><PlatformError message={error} onRetry={onRetry}/></div> : data ? <div className="py-5">
      {tab === "progress" ? <ProgressTab data={data}/> : tab === "submissions" ? <SubmissionTab data={data} offeringId={offeringId}/> : <ClassroomTab data={data}/>}
    </div> : null}
  </>;
}

function AccountTab({ summary, offeringId, onStudentRemoved }: { summary: OfferingStudentSummary; offeringId: string; onStudentRemoved: (enrollmentId: string) => void }) {
  const [resetBusy, setResetBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetLink, setResetLink] = useState("");
  const [resetError, setResetError] = useState("");
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => { setResetOpen(false); setResetLink(""); setResetError(""); setRemoveError(""); setCopyState("idle"); }, [summary.enrollmentId]);
  async function resetPassword() {
    if (resetBusy) return;
    setResetBusy(true); setResetError(""); setCopyState("idle");
    try {
      const response = await teacherPlatformFetch(`/api/platform/offerings/${offeringId}/reset-password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enrollmentId: summary.enrollmentId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "生成失败");
      setResetLink(`${location.origin}/student/reset-password?token=${result.token}`); setResetOpen(true);
    } catch (reason) { setResetError(reason instanceof Error ? reason.message : "生成失败，请重试"); }
    finally { setResetBusy(false); }
  }
  async function removeStudent() {
    if (removeBusy) return;
    setRemoveBusy(true); setRemoveError("");
    try {
      const response = await teacherPlatformFetch(`/api/platform/offerings/${offeringId}/students/${summary.enrollmentId}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "无法移出学生");
      onStudentRemoved(summary.enrollmentId);
    } catch (reason) { setRemoveError(reason instanceof Error ? reason.message : "无法移出学生，请重试"); setRemoveBusy(false); }
  }
  return <div className="space-y-7">
    <section><div className="flex items-start gap-3 rounded-[12px] bg-white/70 p-4"><span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]"><Settings2 size={18}/></span><dl className="grid min-w-0 flex-1 gap-2 text-sm sm:grid-cols-2"><div><dt className="text-xs text-[var(--pbl-text-muted)]">学生</dt><dd className="mt-1 font-medium">{summary.displayName}</dd></div><div><dt className="text-xs text-[var(--pbl-text-muted)]">登录账号</dt><dd className="mt-1 break-all font-medium">{summary.username}</dd></div><div><dt className="text-xs text-[var(--pbl-text-muted)]">加入时间</dt><dd className="mt-1">{formatTime(summary.joinedAt)}</dd></div><div><dt className="text-xs text-[var(--pbl-text-muted)]">成员状态</dt><dd className="mt-1">{summary.status === "active" ? "正常学习中" : summary.status}</dd></div></dl></div></section>
    <section className="border-t border-[var(--pbl-border)] pt-5"><h3 className="text-sm font-semibold">密码协助</h3><p className="mt-2 text-xs leading-5 text-[var(--pbl-text-muted)]">生成学生专属的一次性密码重置链接。链接只会在本次生成后显示。</p><button className={`${secondaryButton} mt-3`} disabled={resetBusy} onClick={() => void resetPassword()}><KeyRound size={16}/>{resetBusy ? "正在生成…" : "生成密码重置链接"}</button>{resetError ? <p role="alert" className="mt-2 text-sm text-[var(--pbl-danger)]">{resetError}</p> : null}</section>
    <section className="border-t border-[var(--pbl-danger-border)] pt-5"><h3 className="text-sm font-semibold text-[var(--pbl-danger)]">成员管理</h3><p className="mt-2 text-xs leading-5 text-[var(--pbl-text-muted)]">移出后学生无法继续访问本课程，已有学习记录会完整保留，学生账号不会被删除。</p><AlertDialog><AlertDialogTrigger asChild><button className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-[10px] border border-[var(--pbl-danger-border)] bg-[var(--pbl-danger-soft)] px-4 text-sm font-medium text-[var(--pbl-danger)] disabled:opacity-50" disabled={removeBusy}><Trash2 size={16}/>{removeBusy ? "正在移出…" : "移出教学班"}</button></AlertDialogTrigger><AlertDialogContent className="pbl-platform-theme"><AlertDialogTitle>将“{summary.displayName}”移出教学班？</AlertDialogTitle><AlertDialogDescription>该学生将无法继续访问本课程。已有活动提交、课堂成果、反思和评价会继续保留，学生账号也不会被删除。</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void removeStudent()}>确认移出</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>{removeError ? <p role="alert" className="mt-2 text-sm text-[var(--pbl-danger)]">{removeError}</p> : null}</section>
    <Dialog open={resetOpen} onOpenChange={setResetOpen}><DialogContent className="pbl-platform-theme pbl-platform-dialog"><DialogHeader><DialogTitle>{summary.displayName}的密码重置链接</DialogTitle><DialogDescription>账号：{summary.username}。请通过可信渠道交给该学生，使用后链接即失效。</DialogDescription></DialogHeader><div className="break-all rounded-[10px] border border-[var(--pbl-border)] bg-[var(--pbl-bg)] p-4 text-sm">{resetLink}</div><button className={secondaryButton} onClick={() => void copyTextToClipboard(resetLink).then(() => setCopyState("copied")).catch(() => setCopyState("failed"))}><ClipboardCopy size={16}/>{copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败，请手动选择" : "复制链接"}</button></DialogContent></Dialog>
  </div>;
}

function ProgressTab({ data }: { data: StudentDetailData }) {
  const chapters = Array.from(new Map(data.activities.map((activity) => [activity.chapterId, activity.chapterTitle])));
  return <div className="space-y-6">{chapters.map(([chapterId, chapterTitle]) => <section key={chapterId}><h3 className="text-sm font-semibold">{chapterTitle}</h3><ol className="mt-2 divide-y divide-[var(--pbl-border)] border-y border-[var(--pbl-border)]">{data.activities.filter((activity) => activity.chapterId === chapterId).map((activity) => {
    const label = activity.archived ? "已归档" : !activity.isOpen && activity.progress.status === "not_started" ? "未开放" : progressStatusLabel(activity.progress.status);
    return <li key={activity.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-3"><div><p className="text-sm font-medium">{activity.title}</p><p className="mt-1 text-xs text-[var(--pbl-text-muted)]">{activityTypeLabel(activity.type)}{activity.progress.lastAccessedAt ? ` · 最近学习 ${formatTime(activity.progress.lastAccessedAt)}` : ""}</p></div><span className={`self-center rounded-full px-2.5 py-1 text-xs ${label === "已完成" ? "bg-emerald-100 text-emerald-800" : label === "进行中" || label === "已提交" ? "bg-blue-100 text-blue-800" : "bg-slate-100 text-slate-600"}`}>{label}</span></li>;
  })}</ol></section>)}</div>;
}

function SubmissionTab({ data, offeringId }: { data: StudentDetailData; offeringId: string }) {
  const activities = useMemo(() => data.activities.filter((activity) => activity.type.toUpperCase() !== "CLASSROOM"), [data.activities]);
  const [activityId, setActivityId] = useState(activities[0]?.id ?? "");
  const [result, setResult] = useState<SubmissionData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const request = useRef(0);
  useEffect(() => { setActivityId(activities[0]?.id ?? ""); setPage(1); }, [activities, data.student.enrollmentId]);
  useEffect(() => {
    if (!activityId) { setResult(null); return; }
    const requestId = ++request.current; setLoading(true); setError("");
    void teacherPlatformFetch(`/api/platform/offerings/${offeringId}/students/${data.student.enrollmentId}/submissions?activityId=${encodeURIComponent(activityId)}&page=${page}`, { cache: "no-store" }).then(async (response) => {
      const value = await response.json(); if (!response.ok) throw new Error(value.message ?? "无法加载提交记录"); if (requestId === request.current) setResult(value);
    }).catch((reason) => { if (requestId === request.current) setError(reason instanceof Error ? reason.message : "无法加载提交记录"); }).finally(() => { if (requestId === request.current) setLoading(false); });
  }, [activityId, data.student.enrollmentId, offeringId, page]);
  if (!activities.length) return <EmptyLine icon={<FileCheck2 size={20}/>} text="该教学班暂无可提交的非课堂活动"/>;
  return <div><label className="text-xs font-medium text-[var(--pbl-text-muted)]">选择活动<select className={`${fieldClass} mt-2 w-full`} value={activityId} onChange={(event) => { setActivityId(event.target.value); setPage(1); }}>{activities.map((activity) => <option key={activity.id} value={activity.id}>{activity.chapterTitle} · {activity.title}</option>)}</select></label>
    {loading ? <p role="status" className="py-8 text-sm text-[var(--pbl-text-muted)]">正在加载提交历史…</p> : error ? <p role="alert" className="py-5 text-sm text-[var(--pbl-danger)]">{error}</p> : result?.submissions.length ? <div className="mt-4 space-y-3">{result.submissions.map((submission, index) => <SubmissionRecord key={submission.id} submission={submission} currentConfig={data.activities.find((activity) => activity.id === activityId)?.config} defaultOpen={index === 0}/>)}</div> : <EmptyLine icon={<FileCheck2 size={20}/>} text="该活动暂无提交记录"/>}
    {result && result.submissions.length ? <div className="mt-4 flex items-center justify-between"><button className={secondaryButton} disabled={page === 1} onClick={() => setPage((value) => value - 1)}>上一页</button><span className="text-xs text-[var(--pbl-text-muted)]">第 {page} 页 · 共 {result.pagination.total} 条</span><button className={secondaryButton} disabled={!result.pagination.hasMore} onClick={() => setPage((value) => value + 1)}>下一页</button></div> : null}
  </div>;
}

function SubmissionRecord({ submission, currentConfig, defaultOpen }: { submission: SubmissionData["submissions"][number]; currentConfig: unknown; defaultOpen: boolean }) {
  const payload = asObject(submission.payload);
  const snapshot = asObject(submission.activitySnapshot);
  const config = submission.snapshotSource === "legacy" ? asObject(currentConfig) : asObject(snapshot.config);
  const answers = asObject(payload.answers);
  const questions = Array.isArray(config.questions) ? config.questions.map(asObject) : [];
  return <details open={defaultOpen} className="border-b border-[var(--pbl-border)] pb-4"><summary className="flex min-h-11 items-center justify-between gap-3 text-sm font-medium"><span>{formatTime(submission.submittedAt)}</span><span className="text-xs text-[var(--pbl-text-muted)]">版本 {submission.activityVersion}</span></summary>{submission.snapshotSource === "legacy" ? <p className="mb-3 text-xs text-amber-700">旧记录未保存题目快照，以下题目来自当前活动配置。</p> : null}{typeof payload.answer === "string" && payload.answer ? <p className="whitespace-pre-wrap text-sm leading-7">{payload.answer}</p> : null}{Object.keys(answers).length ? <dl className="space-y-3">{Object.entries(answers).map(([questionId, answer]) => {
    const question = questions.find((item) => item.id === questionId);
    const options = Array.isArray(question?.options) ? question.options.map(asObject) : [];
    const labels = (Array.isArray(answer) ? answer : [answer]).map((value) => options.find((option) => option.id === value)?.label ?? String(value));
    return <div key={questionId}><dt className="text-xs text-[var(--pbl-text-muted)]">{String(question?.title ?? questionId)}</dt><dd className="mt-1 whitespace-pre-wrap text-sm">{labels.join("、")}</dd></div>;
  })}</dl> : null}</details>;
}

function ClassroomTab({ data }: { data: StudentDetailData }) {
  if (!data.classrooms.length) return <EmptyLine icon={<UserRoundCheck size={20}/>} text="该学生尚未进入课堂"/>;
  return <div className="space-y-6">{data.classrooms.map((classroom) => {
    const stageProgress = asObject(classroom.stageProgress);
    const progress = asObject(stageProgress.progress);
    const returnTo = typeof window === "undefined" ? "" : `${window.location.pathname}${window.location.search}`;
    return <article key={classroom.id} className="border-b border-[var(--pbl-border)] pb-6 last:border-b-0"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">{classroom.instance.activity.title} · 第 {classroom.instance.runNo} 场</h3><p className="mt-1 text-xs text-[var(--pbl-text-muted)]">进入 {formatTime(classroom.firstEnteredAt)} · 最近 {formatTime(classroom.lastEnteredAt)}</p></div>{classroom.pendingTeacherEvaluation ? <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs text-amber-800">待教师评价</span> : null}</div>
      {Object.keys(progress).length ? <div className="mt-3"><p className="text-xs font-medium text-[var(--pbl-text-muted)]">阶段进度</p><div className="mt-2 flex flex-wrap gap-2">{Object.entries(progress).map(([key, value]) => <span key={key} className="rounded-full bg-slate-100 px-2 py-1 text-xs">{key}：{String(value)}</span>)}</div></div> : null}
      <dl className="mt-4 grid grid-cols-4 gap-2 text-center"><Metric label="课堂提交" value={classroom.submissions.length}/><Metric label="成果" value={classroom.artifacts.reduce((sum, item) => sum + item.versions.length, 0)}/><Metric label="反思" value={classroom.reflections.length}/><Metric label="评价" value={classroom.evaluations.length}/></dl>
      {classroom.submissions.map((item) => <details className="mt-3 border-t border-[var(--pbl-border)] pt-3" key={item.id}><summary className="min-h-11 text-sm font-medium">提交 · {item.stageKey} · {formatTime(item.submittedAt)}</summary><pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-[8px] bg-white p-3 text-xs">{readableJson(item.payload)}</pre></details>)}
      {classroom.artifacts.flatMap((artifact) => artifact.versions.map((version) => <details className="mt-3 border-t border-[var(--pbl-border)] pt-3" key={version.id}><summary className="min-h-11 text-sm font-medium">{artifact.title} · 版本 {version.sequence}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-[8px] bg-white p-3 text-sm">{version.sourceHtml}</pre></details>))}
      {classroom.reflections.map((item) => <blockquote key={item.id} className="mt-3 border-l-2 border-[var(--pbl-teacher)] pl-3 text-sm leading-6"><span className="text-xs text-[var(--pbl-text-muted)]">学习反思 · {formatTime(item.createdAt)}</span><p className="mt-1 whitespace-pre-wrap">{item.content}</p></blockquote>)}
      {classroom.evaluations.map((item) => <div key={item.id} className="mt-3 border-l-2 border-[var(--pbl-border)] pl-3 text-sm"><p className="font-medium">{item.evaluatorType.toUpperCase() === "TEACHER" ? "教师评价" : "学生自评"}{item.score !== null ? ` · ${item.score} 分` : ""}</p><p className="mt-1 whitespace-pre-wrap text-[var(--pbl-text-muted)]">{item.content}</p></div>)}
      <Link className={`${secondaryButton} mt-4`} href={`/teacher/participations/${classroom.id}?returnTo=${encodeURIComponent(returnTo)}`}>进入成果与评价<ChevronRight size={16}/></Link>
    </article>;
  })}</div>;
}

function Metric({ label, value }: { label: string; value: number }) { return <div className="bg-white/70 px-2 py-3"><dt className="text-[10px] text-[var(--pbl-text-muted)]">{label}</dt><dd className="mt-1 font-semibold tabular-nums">{value}</dd></div>; }
function EmptyLine({ icon, text }: { icon: ReactNode; text: string }) { return <div className="mt-5 flex min-h-28 flex-col items-center justify-center gap-2 border-y border-dashed border-[var(--pbl-border)] text-sm text-[var(--pbl-text-muted)]">{icon}<p>{text}</p></div>; }
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function readableJson(value: unknown) { const object = asObject(value); return typeof object.view === "object" ? JSON.stringify(object.view, null, 2) : JSON.stringify(value, null, 2); }
