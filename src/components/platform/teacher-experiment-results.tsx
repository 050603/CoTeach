"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock3, Download, RefreshCw } from "lucide-react";
import type { TeacherPresentationMode } from "@/lib/classroom/presentation";

type Question = { id: string; type: string; prompt: string; options?: string[]; correctAnswer?: string | string[]; group?: { id: string; title: string; instruction?: string } };
type Submission = {
  id: string; phase: "pretest" | "posttest";
  variant: "none" | "A_PRE_B_POST" | "B_PRE_A_POST";
  student: { id?: string; displayName: string; username: string }; submittedAt: string;
  questionnaire: { pretest: Question[]; posttest: Question[] };
  answers: Record<string, string | string[]>; objectiveScore: number; objectiveTotal: number;
};
type Results = {
  enabled: boolean; status?: string; enrollmentCount: number; pretestCount: number; posttestCount: number;
  posttestDraftCount?: number; posttestOpenedAt?: string | null;
  posttestAvailable?: boolean;
  studentRows?: Array<{ student: { id: string; displayName: string }; status: "not-started" | "in-progress" | "submitted"; submittedAt?: string | null }>;
  variantCounts: { aPreBPost: number; bPreAPost: number };
  submissions: Submission[];
};

type Props = {
  instanceId: string;
  offeringId: string;
  mode?: "overview" | "posttest";
  presentation?: TeacherPresentationMode;
  configHref?: string;
  focusedStudentId?: string;
  studentFilter?: "all" | "pending" | "low-score";
  revision?: string;
};

const statusLabel = { "not-started": "未开始", "in-progress": "作答中", submitted: "已提交" } as const;

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN");
}

function answerText(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.join("、");
  if (value === "true") return "正确";
  if (value === "false") return "错误";
  return value || "未作答";
}

function SubmissionDetail({ submission }: { submission: Submission }) {
  const questions = submission.questionnaire[submission.phase] ?? [];
  return <section className="border-t border-[var(--pbl-border)] px-4 py-4 text-sm" aria-label={`${submission.phase === "pretest" ? "前测" : "后测"}正式答案`}>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-semibold text-[var(--pbl-text)]">{submission.phase === "pretest" ? "前测" : "后测"} · {formatDate(submission.submittedAt)}</h4>
      <span className="text-[var(--pbl-text-muted)]">{submission.objectiveTotal ? `客观题 ${submission.objectiveScore}/${submission.objectiveTotal}` : "无计分题"}</span>
    </div>
    <div className="space-y-5">{questions.map((question, index) => <div key={`${submission.id}:${question.id}`}>
      {question.group && questions[index - 1]?.group?.id !== question.group.id ? <div className="mb-3 border-l-2 border-[var(--pbl-teacher)] bg-[var(--pbl-bg)] px-3 py-2"><p className="font-semibold">{question.group.title}</p>{question.group.instruction ? <p className="mt-1 whitespace-pre-wrap text-[var(--pbl-text-muted)]">{question.group.instruction}</p> : null}</div> : null}
      <p className="whitespace-pre-wrap font-medium">{index + 1}. {question.prompt}</p>
      <p className="mt-1 whitespace-pre-wrap">学生作答：{answerText(submission.answers[question.id])}</p>
      {question.correctAnswer && (Array.isArray(question.correctAnswer) ? question.correctAnswer.length > 0 : true) ? <p className="mt-1 text-[var(--pbl-text-muted)]">参考答案：{answerText(question.correctAnswer)}</p> : null}
    </div>)}</div>
  </section>;
}

export function TeacherExperimentResults({ instanceId, offeringId, mode = "overview", presentation = "workspace", configHref, focusedStudentId, studentFilter = "all", revision }: Props) {
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/platform/classroom-instances/${instanceId}/experiment/results`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "无法读取实验测验记录");
      if (!Array.isArray(data.submissions)) throw new Error("实验测验记录格式无效");
      setResults(data);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取实验测验记录"); }
    finally { setLoading(false); }
  }, [instanceId]);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load, revision]);
  useEffect(() => {
    if (mode !== "posttest") return;
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    const onFocus = () => { void load(); };
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15_000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onFocus); };
  }, [load, mode]);

  const studentRows = useMemo(() => results?.studentRows ?? [], [results?.studentRows]);
  const filteredRows = useMemo(() => studentRows.filter((row) => studentFilter !== "pending" || row.status !== "submitted"), [studentRows, studentFilter]);
  const notStartedCount = studentRows.filter((row) => row.status === "not-started").length;
  const inProgressCount = studentRows.filter((row) => row.status === "in-progress").length;
  useEffect(() => {
    if (mode !== "posttest" || !focusedStudentId || !studentRows.some((row) => row.student.id === focusedStudentId)) return;
    const timer = window.setTimeout(() => document.getElementById(`posttest-student-${focusedStudentId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
    return () => window.clearTimeout(timer);
  }, [focusedStudentId, mode, studentRows]);

  async function exportResearch() {
    if (exporting) return;
    setExporting(true); setError("");
    try {
      const rows: unknown[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ type: "experiments", includeContent: "true", take: "500" });
        if (cursor) query.set("cursor", cursor);
        const response = await fetch(`/api/platform/offerings/${offeringId}/research-export?${query}`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message ?? "导出失败");
        rows.push(...data.rows);
        cursor = data.nextCursor;
      } while (cursor);
      const blob = new Blob([JSON.stringify({ exportVersion: 1, type: "experiments", offeringId, rows }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `classroom-experiments-${offeringId}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "导出失败"); }
    finally { setExporting(false); }
  }

  if (mode === "posttest") {
    const total = results?.enrollmentCount ?? 0;
    const submitted = results?.posttestCount ?? 0;
    const drafting = results?.posttestDraftCount ?? inProgressCount;
    const waiting = results?.studentRows ? notStartedCount : Math.max(0, total - submitted - drafting);
    const projected = presentation !== "workspace";
    return <section className="classroom-stage space-y-5 text-[var(--pbl-text)]" aria-label="后测进度">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--pbl-border)] pb-5">
        <div><p className="text-xs font-semibold tracking-[0.18em] text-[var(--pbl-teacher)]">第 5 阶段 · 实验测验</p><h2 className="mt-2 font-serif text-3xl font-semibold">后测</h2><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">{results?.posttestOpenedAt ? `已于 ${formatDate(results.posttestOpenedAt)} 开放，学生可完成个人后测。` : results?.posttestAvailable ? "课堂已结束，未提交的学生可继续完成后测。" : results?.status === "finished" ? "本场课堂结束前未开放后测。" : "进入本阶段后开放个人后测。"}</p></div>
        {!projected ? <div className="flex flex-wrap gap-2"><button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-[10px] border border-[var(--pbl-border)] px-4 text-sm font-medium" onClick={() => void load()} disabled={loading}><RefreshCw size={16} />{loading ? "刷新中…" : "刷新进度"}</button>{configHref ? <a className="inline-flex min-h-11 items-center rounded-[10px] border border-[var(--pbl-border)] px-4 text-sm font-medium text-[var(--pbl-teacher)]" href={configHref}>实验配置</a> : null}</div> : null}
      </header>
      {loading && !results ? <p role="status" className="py-12 text-center text-sm text-[var(--pbl-text-muted)]">正在读取后测进度…</p> : null}
      {error ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-[var(--pbl-danger)]"><span>{error}</span><button type="button" className="min-h-11 font-semibold underline" onClick={() => void load()}>重试</button></div> : null}
      {results && !results.enabled ? <div className="rounded-[14px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-5 py-9 text-center"><h3 className="text-lg font-semibold">本课堂未开启后测</h3><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">可在实验配置中设置前测、后测和题组。</p>{!projected && configHref ? <a href={configHref} className="mt-5 inline-flex min-h-11 items-center rounded-[10px] bg-[var(--pbl-teacher)] px-5 text-sm font-semibold text-white">进入实验配置</a> : null}</div> : null}
      {results?.enabled ? <>
        <div className="grid gap-3 sm:grid-cols-3" aria-label="后测人数统计">
          <div className="rounded-[10px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-5"><span className="text-sm text-[var(--pbl-text-muted)]">未开始</span><strong className="mt-2 block text-3xl tabular-nums">{waiting}</strong></div>
          <div className="rounded-[10px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-5"><span className="text-sm text-[var(--pbl-text-muted)]">作答中</span><strong className="mt-2 block text-3xl tabular-nums text-[var(--pbl-warning)]">{drafting}</strong></div>
          <div className="rounded-[10px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-5"><span className="text-sm text-[var(--pbl-text-muted)]">已提交</span><strong className="mt-2 block text-3xl tabular-nums text-[var(--pbl-student)]">{submitted}</strong></div>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-[var(--pbl-border)]" role="progressbar" aria-label="后测提交进度" aria-valuemin={0} aria-valuemax={total} aria-valuenow={submitted}><div className="h-full rounded-full bg-[var(--pbl-student)]" style={{ width: `${total ? Math.min(100, submitted / total * 100) : 0}%` }} /></div>
        <p className="text-sm text-[var(--pbl-text-muted)]">{submitted}/{total} 人已提交正式后测。草稿不计入提交人数。</p>
        {!projected ? <>
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2"><div><h3 className="text-lg font-semibold">学生作答状态</h3><p className="mt-1 text-sm text-[var(--pbl-text-muted)]">展开已提交学生，可查看同一场课堂的前测和后测正式答案。</p></div><button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-[10px] border border-[var(--pbl-border)] px-4 text-sm font-medium disabled:opacity-50" onClick={() => void exportResearch()} disabled={exporting}><Download size={16} />{exporting ? "导出中…" : "导出实验数据"}</button></div>
          {filteredRows.length ? <div className="divide-y divide-[var(--pbl-border)] overflow-hidden rounded-[14px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)]">{filteredRows.map((row) => {
            const records = results.submissions.filter((submission) => submission.student.id === row.student.id);
            const submittedPosttest = records.some((submission) => submission.phase === "posttest");
            return <div id={`posttest-student-${row.student.id}`} key={row.student.id} className="scroll-mt-24">
              {submittedPosttest ? <details open={focusedStudentId === row.student.id ? true : undefined}>
                <summary className="flex min-h-14 cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-3 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--pbl-teacher)]"><span className="font-medium">{row.student.displayName}</span><span className="inline-flex items-center gap-2 text-sm text-[var(--pbl-student)]"><CheckCircle2 size={16} />已提交 · {formatDate(row.submittedAt)}</span></summary>
                <div className="border-t border-[var(--pbl-border)]">{records.map((submission) => <SubmissionDetail key={submission.id} submission={submission} />)}</div>
              </details> : <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 px-4 py-3"><span className="font-medium">{row.student.displayName}</span><span className="inline-flex items-center gap-2 text-sm text-[var(--pbl-text-muted)]">{row.status === "in-progress" ? <Clock3 size={16} /> : null}{statusLabel[row.status]}</span></div>}
            </div>;
          })}</div> : <p className="rounded-[10px] border border-dashed border-[var(--pbl-border)] p-6 text-center text-sm text-[var(--pbl-text-muted)]">{studentFilter === "pending" ? "当前没有待提交的学生。" : "暂无学生记录。"}</p>}
        </> : null}
      </> : null}
    </section>;
  }

  if (loading && !results) return <section className="mt-7 rounded-2xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-6" role="status">正在读取前后测记录…</section>;
  if (!results?.enabled && !results?.submissions?.length && !error) return null;
  return <section className="mt-7 rounded-2xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-5 shadow-sm md:p-6" aria-label="实验模式前后测记录">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs font-semibold tracking-widest text-[var(--pbl-teacher)]">实验模式</p><h2 className="mt-2 text-xl font-semibold">前测与后测</h2><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">按本场课堂分别留存题目、答案和提交时间；研究导出使用匿名标识配对。</p></div>
      <div className="flex gap-2"><button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[var(--pbl-border)] px-4 text-sm" onClick={() => void load()} disabled={loading}><RefreshCw size={15} />刷新</button><button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[var(--pbl-teacher)] px-4 text-sm font-semibold text-white disabled:opacity-50" onClick={() => void exportResearch()} disabled={exporting}><Download size={15} />{exporting ? "导出中…" : "导出教学班实验数据"}</button></div>
    </div>
    {error ? <p role="alert" className="mt-4 text-sm text-[var(--pbl-danger)]">{error}</p> : null}
    {results ? <>
      <div className="mt-5 grid gap-3 sm:grid-cols-3"><div className="rounded-xl bg-[var(--pbl-bg)] p-4"><small>教学班学生</small><strong className="mt-1 block text-2xl">{results.enrollmentCount}</strong></div><div className="rounded-xl bg-[var(--pbl-bg)] p-4"><small>已交前测</small><strong className="mt-1 block text-2xl">{results.pretestCount}</strong></div><div className="rounded-xl bg-[var(--pbl-bg)] p-4"><small>已交后测</small><strong className="mt-1 block text-2xl">{results.posttestCount}</strong></div></div>
      {results.variantCounts?.aPreBPost || results.variantCounts?.bPreAPost ? <p className="mt-3 text-xs text-[var(--pbl-text-muted)]">A 前测 / B 后测：{results.variantCounts.aPreBPost} 人 · B 前测 / A 后测：{results.variantCounts.bPreAPost} 人</p> : null}
      {results.submissions.length ? <div className="mt-5 space-y-3">{results.submissions.map((submission) => <details key={submission.id} className="rounded-xl border border-[var(--pbl-border)]"><summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 p-4 text-sm"><span><strong>{submission.student.displayName}</strong> · {submission.phase === "pretest" ? "前测" : "后测"}{submission.variant !== "none" ? ` · ${submission.variant === "A_PRE_B_POST" ? "A→B" : "B→A"}` : ""} · {new Date(submission.submittedAt).toLocaleString("zh-CN")}</span><span>{submission.objectiveTotal ? `客观题 ${submission.objectiveScore}/${submission.objectiveTotal}` : "无计分题"}</span></summary><div className="space-y-3 border-t border-[var(--pbl-border)] p-4">{submission.questionnaire[submission.phase]?.map((question, index, questions) => <div key={question.id} className="text-sm">{question.group && questions[index - 1]?.group?.id !== question.group.id ? <div className="mb-3 border-l-2 border-[var(--pbl-teacher)] bg-[var(--pbl-bg)] px-3 py-2"><p className="font-semibold">{question.group.title}</p>{question.group.instruction ? <p className="mt-1 whitespace-pre-wrap text-[var(--pbl-text-muted)]">{question.group.instruction}</p> : null}</div> : null}<p className="whitespace-pre-wrap font-medium">{index + 1}. {question.prompt}</p><p className="mt-1">学生作答：{answerText(submission.answers[question.id])}</p>{question.correctAnswer && (Array.isArray(question.correctAnswer) ? question.correctAnswer.length > 0 : true) ? <p className="mt-1 text-[var(--pbl-text-muted)]">参考答案：{answerText(question.correctAnswer)}</p> : null}</div>)}</div></details>)}</div> : <p className="mt-5 text-sm text-[var(--pbl-text-muted)]">暂无前后测提交记录。</p>}
    </> : null}
  </section>;
}
