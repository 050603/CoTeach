"use client";

import { useState, type FormEvent } from "react";
import { ExperimentQuestionList, type ExperimentDisplayAnswer, type ExperimentDisplayQuestion } from "./experiment-question-card";

export type ExperimentQuestion = ExperimentDisplayQuestion;

export type ExperimentPhase = "pretest" | "posttest";

const phaseLabel = { pretest: "前测", posttest: "后测" } as const;

export function StudentExperimentAssessment({ instanceId, phase, questions, onCancel, onSubmitted }: {
  instanceId: string;
  phase: ExperimentPhase;
  questions: ExperimentQuestion[];
  onCancel: () => void;
  onSubmitted: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, ExperimentDisplayAnswer>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingQuestionId, setMissingQuestionId] = useState<string | null>(null);

  function updateAnswer(questionId: string, value: ExperimentDisplayAnswer) {
    setAnswers((current) => ({ ...current, [questionId]: value }));
    setError(null);
    if (missingQuestionId === questionId) setMissingQuestionId(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const missing = questions.find((question) => {
      const answer = answers[question.id];
      return Array.isArray(answer) ? answer.length === 0 : !answer?.trim();
    });
    if (missing) {
      setMissingQuestionId(missing.id);
      setError(`请完成第 ${questions.indexOf(missing) + 1} 题后提交。`);
      document.getElementById(`experiment-${phase}-${missing.id}`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/platform/classroom-instances/${instanceId}/experiment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase, answers: Object.fromEntries(questions.map((question) => [question.id, answers[question.id]])) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? `${phaseLabel[phase]}提交失败`);
      onSubmitted();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${phaseLabel[phase]}提交失败，请重试`);
    } finally {
      setBusy(false);
    }
  }

  const answeredCount = questions.filter((question) => {
    const answer = answers[question.id];
    return Array.isArray(answer) ? answer.length > 0 : Boolean(answer?.trim());
  }).length;

  return <form className="mt-6 space-y-5" onSubmit={(event) => void submit(event)} noValidate>
    <div className="space-y-4 rounded-[14px] border border-[var(--pbl-student-border)] bg-[var(--pbl-student-soft)] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-xs font-semibold tracking-wider text-[var(--pbl-student)]">{phase === "pretest" ? "开始课堂前" : "课堂结束后"}</p><h2 className="mt-1 text-xl font-bold text-[var(--pbl-text-strong)]">{phaseLabel[phase]} · 课堂学习调查</h2></div>
        <span className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold tabular-nums text-[var(--pbl-student)]">已完成 {answeredCount}/{questions.length}</span>
      </div>
      <p className="text-sm leading-6 text-[var(--pbl-text-muted)]">请按自己的真实想法完成每道题。提交后答案会保存在本次课堂记录中。</p>
      <div aria-label={`${phaseLabel[phase]}作答进度`} aria-valuemax={questions.length} aria-valuemin={0} aria-valuenow={answeredCount} className="h-1.5 overflow-hidden rounded-full bg-white" role="progressbar"><div className="h-full rounded-full bg-[var(--pbl-student)] transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${questions.length ? answeredCount / questions.length * 100 : 0}%` }} /></div>
    </div>
    <ExperimentQuestionList
      answers={answers}
      inputNamePrefix={`experiment-${phase}`}
      invalidQuestionId={missingQuestionId}
      onAnswerChange={updateAnswer}
      questionIdPrefix={`experiment-${phase}`}
      questions={questions}
    />
    {error ? <p role="alert" className="rounded-[10px] border border-[var(--pbl-danger)] bg-white px-4 py-3 text-sm text-[var(--pbl-danger)]">{error}</p> : null}
    <div className="flex flex-col-reverse items-stretch gap-3 border-t border-[var(--pbl-border)] pt-5 sm:flex-row sm:items-center sm:justify-between">
      <button className="min-h-11 rounded-[10px] border border-[var(--pbl-border)] bg-white px-5 text-sm font-semibold text-[var(--pbl-text)]" disabled={busy} onClick={onCancel} type="button">稍后完成</button>
      <button className="min-h-11 rounded-[10px] bg-[var(--pbl-student)] px-6 text-sm font-bold text-white disabled:opacity-50" disabled={busy} type="submit">{busy ? "提交中…" : `提交${phaseLabel[phase]}`}</button>
    </div>
  </form>;
}
