"use client";

import { useId, useMemo, useState } from "react";
import { ExperimentQuestionList, type ExperimentDisplayAnswer } from "./experiment-question-card";
import {
  composeExperimentForms,
  publicExperimentQuestions,
  type ExperimentConfig,
  type ExperimentVariant,
} from "@/lib/platform/experiment";

type Phase = "pretest" | "posttest";

const phaseName: Record<Phase, string> = { pretest: "前测", posttest: "后测" };

function previewRandomIndex(variant: ExperimentVariant) {
  let state = variant === "B_PRE_A_POST" ? 0x5d9e93a1 : 0x21bf7819;
  return (upperBound: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % upperBound;
  };
}

export function ExperimentPreview({ config }: { config: ExperimentConfig }) {
  const [phase, setPhase] = useState<Phase>("pretest");
  const [variant, setVariant] = useState<ExperimentVariant>("A_PRE_B_POST");
  const [answers, setAnswers] = useState<Record<string, Record<string, ExperimentDisplayAnswer>>>({});
  const previewId = useId();
  const effectiveVariant = config.scenarioPair ? variant : "none";
  const forms = useMemo(() => composeExperimentForms(config, effectiveVariant, previewRandomIndex(effectiveVariant)), [config, effectiveVariant]);
  const questions = publicExperimentQuestions(forms[phase]);
  const answerKey = `${effectiveVariant}:${phase}`;
  const currentAnswers = answers[answerKey] ?? {};

  function updateAnswer(questionId: string, value: ExperimentDisplayAnswer) {
    setAnswers((current) => ({ ...current, [answerKey]: { ...(current[answerKey] ?? {}), [questionId]: value } }));
  }

  return <section aria-label="学生视角预览" className="rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-bg)] p-4 md:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-bold text-[var(--pbl-text-strong)]">学生视角预览</h2>
        <p className="mt-1 text-sm text-[var(--pbl-text-muted)]">可以试选和填写答案；预览中的作答不会保存或提交。</p>
      </div>
      <span className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-[var(--pbl-text-muted)]">仅供教师查看</span>
    </div>
    {!config.enabled ? <p role="status" className="mt-4 rounded-lg border border-[var(--pbl-border)] bg-white px-3 py-2 text-xs text-[var(--pbl-text-muted)]">实验模式尚未启用，此预览不会对学生开放。</p> : null}
    <div aria-label="选择测验阶段" className="mt-5 flex flex-wrap gap-2" role="tablist">
      {(["pretest", "posttest"] as const).map((item) => <button
        aria-selected={phase === item}
        className={`min-h-11 rounded-lg px-4 text-sm font-semibold ${phase === item ? "bg-[var(--pbl-student)] text-white" : "border border-[var(--pbl-border)] bg-white text-[var(--pbl-text)]"}`}
        key={item}
        onClick={() => setPhase(item)}
        role="tab"
        type="button"
      >{phaseName[item]}</button>)}
    </div>
    {config.scenarioPair ? <div aria-label="选择 A/B 版本" className="mt-3 flex flex-wrap gap-2" role="tablist">
      <button aria-selected={variant === "A_PRE_B_POST"} className={`min-h-11 rounded-lg px-4 text-xs font-semibold ${variant === "A_PRE_B_POST" ? "bg-[var(--pbl-teacher)] text-white" : "border border-[var(--pbl-border)] bg-white"}`} onClick={() => setVariant("A_PRE_B_POST")} role="tab" type="button">A→B · 前测 A / 后测 B</button>
      <button aria-selected={variant === "B_PRE_A_POST"} className={`min-h-11 rounded-lg px-4 text-xs font-semibold ${variant === "B_PRE_A_POST" ? "bg-[var(--pbl-teacher)] text-white" : "border border-[var(--pbl-border)] bg-white"}`} onClick={() => setVariant("B_PRE_A_POST")} role="tab" type="button">B→A · 前测 B / 后测 A</button>
    </div> : null}
    <p className="mt-4 rounded-lg border border-[var(--pbl-border)] bg-white px-3 py-2 text-xs leading-5 text-[var(--pbl-text-muted)]">
      {config.randomizeQuestionOrder || config.randomizeOptionOrder
        ? "下方是固定的随机顺序示例。实际题序与选项顺序会为每位学生单独确定，同组题目始终排在一起，并在本次课堂中保持一致。"
        : "下方按教师设定的题序与选项顺序展示。"}
    </p>
    <div aria-label={`${phaseName[phase]}题目预览`} className="mt-5 space-y-4">
      {questions.length ? <ExperimentQuestionList answers={currentAnswers} inputNamePrefix={`${previewId}-${answerKey}`} onAnswerChange={updateAnswer} questions={questions} /> : <p className="rounded-lg border border-dashed border-[var(--pbl-border)] bg-white p-5 text-center text-sm text-[var(--pbl-text-muted)]">这一阶段还没有可预览的题目。</p>}
    </div>
  </section>;
}
