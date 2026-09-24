"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";

type Question = { id: string; type: string; prompt: string; options?: string[]; correctAnswer?: string | string[]; group?: { id: string; title: string; instruction?: string } };
type Submission = {
  id: string; phase: "pretest" | "posttest";
  variant: "none" | "A_PRE_B_POST" | "B_PRE_A_POST";
  student: { displayName: string; username: string }; submittedAt: string;
  questionnaire: { pretest: Question[]; posttest: Question[] };
  answers: Record<string, string | string[]>; objectiveScore: number; objectiveTotal: number;
};
type Results = {
  enabled: boolean; enrollmentCount: number; pretestCount: number; posttestCount: number;
  variantCounts: { aPreBPost: number; bPreAPost: number };
  submissions: Submission[];
};

function answerText(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.join("、");
  if (value === "true") return "正确";
  if (value === "false") return "错误";
  return value || "未作答";
}

export function TeacherExperimentResults({ instanceId, offeringId }: { instanceId: string; offeringId: string }) {
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

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

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
