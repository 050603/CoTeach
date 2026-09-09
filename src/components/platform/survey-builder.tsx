"use client";

import { AlignLeft, Check, ChevronDown, ChevronUp, CircleDot, CopyPlus, Plus, Trash2, X } from "lucide-react";
import type { SurveyQuestion } from "@/lib/platform/survey";

type Props = {
  questions: SurveyQuestion[];
  onChange: (questions: SurveyQuestion[]) => void;
};

const inputClass = "min-h-11 w-full rounded-lg border border-[var(--pbl-border)] bg-white px-3 text-sm outline-none transition focus:border-[var(--pbl-teacher)] focus:ring-2 focus:ring-[var(--pbl-teacher-soft)]";

function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function newQuestion(): SurveyQuestion {
  return { id: newId("q"), title: "", type: "short-text", required: true, options: [] };
}

export function SurveyBuilder({ questions, onChange }: Props) {
  function update(index: number, next: SurveyQuestion) {
    onChange(questions.map((question, questionIndex) => questionIndex === index ? next : question));
  }

  function move(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= questions.length) return;
    const next = [...questions];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <section aria-labelledby="survey-builder-heading" className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold" id="survey-builder-heading">问卷题目</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--pbl-text-muted)]">单选题自动形成比例图，简答题自动汇总为词云。</p>
        </div>
        <span className="shrink-0 rounded-full bg-[var(--pbl-teacher-soft)] px-3 py-1 text-xs font-semibold text-[var(--pbl-teacher)]">{questions.length} 题</span>
      </div>

      <div className="space-y-3">
        {questions.map((question, index) => (
          <article className="overflow-hidden rounded-xl border border-[var(--pbl-border)] bg-[#fbfcff] shadow-[0_8px_24px_rgba(30,64,175,0.04)]" key={question.id}>
            <div className="flex items-center gap-3 border-b border-[var(--pbl-border)] bg-white px-4 py-3">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--pbl-teacher)] text-xs font-bold text-white">{index + 1}</span>
              <div className="flex flex-1 gap-2" role="group" aria-label={`第 ${index + 1} 题题型`}>
                <button className={`inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold ${question.type === "single-choice" ? "bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]" : "text-[var(--pbl-text-muted)]"}`} onClick={() => update(index, { ...question, type: "single-choice", options: question.options.length >= 2 ? question.options : [{ id: newId("o"), label: "" }, { id: newId("o"), label: "" }] })} type="button"><CircleDot size={15} />单选题</button>
                <button className={`inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold ${question.type === "short-text" ? "bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]" : "text-[var(--pbl-text-muted)]"}`} onClick={() => update(index, { ...question, type: "short-text" })} type="button"><AlignLeft size={15} />简答题</button>
              </div>
              <button aria-label="上移题目" className="grid size-9 place-items-center rounded-lg text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-bg)] disabled:opacity-30" disabled={index === 0} onClick={() => move(index, -1)} type="button"><ChevronUp size={16} /></button>
              <button aria-label="下移题目" className="grid size-9 place-items-center rounded-lg text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-bg)] disabled:opacity-30" disabled={index === questions.length - 1} onClick={() => move(index, 1)} type="button"><ChevronDown size={16} /></button>
              <button aria-label="删除题目" className="grid size-9 place-items-center rounded-lg text-[var(--pbl-text-muted)] hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30" disabled={questions.length === 1} onClick={() => onChange(questions.filter((_, questionIndex) => questionIndex !== index))} type="button"><Trash2 size={16} /></button>
            </div>
            <div className="space-y-4 p-4">
              <label className="block text-xs font-medium text-[var(--pbl-text-muted)]">题目内容
                <input aria-label={`第 ${index + 1} 题题目内容`} className={`${inputClass} mt-2`} maxLength={500} placeholder={question.type === "single-choice" ? "例如：今天的课堂节奏如何？" : "例如：今天最让你有启发的内容是什么？"} required value={question.title} onChange={(event) => update(index, { ...question, title: event.target.value })} />
              </label>
              {question.type === "single-choice" ? <div className="space-y-2">
                <p className="text-xs font-medium text-[var(--pbl-text-muted)]">选项</p>
                {question.options.map((option, optionIndex) => <div className="flex items-center gap-2" key={option.id}><span className="grid size-7 shrink-0 place-items-center rounded-full border border-[var(--pbl-border)] bg-white text-[11px] font-semibold text-[var(--pbl-text-muted)]">{String.fromCharCode(65 + optionIndex)}</span><input aria-label={`第 ${index + 1} 题选项 ${optionIndex + 1}`} className={inputClass} maxLength={200} placeholder={`选项 ${optionIndex + 1}`} required value={option.label} onChange={(event) => update(index, { ...question, options: question.options.map((item, itemIndex) => itemIndex === optionIndex ? { ...item, label: event.target.value } : item) })} /><button aria-label="删除选项" className="grid size-10 shrink-0 place-items-center rounded-lg text-[var(--pbl-text-muted)] hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30" disabled={question.options.length <= 2} onClick={() => update(index, { ...question, options: question.options.filter((_, itemIndex) => itemIndex !== optionIndex) })} type="button"><X size={16} /></button></div>)}
                {question.options.length < 10 ? <button className="inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-xs font-semibold text-[var(--pbl-teacher)]" onClick={() => update(index, { ...question, options: [...question.options, { id: newId("o"), label: "" }] })} type="button"><Plus size={15} />添加选项</button> : null}
              </div> : <div aria-hidden="true" className="rounded-lg border border-dashed border-[var(--pbl-border)] bg-white px-4 py-5 text-xs text-[var(--pbl-text-muted)]"><AlignLeft className="mb-2" size={17} />学生将在这里输入文字回答，系统会提取班级高频关键词。</div>}
              <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 text-xs font-medium"><span className={`grid size-5 place-items-center rounded border ${question.required ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher)] text-white" : "border-[var(--pbl-border)] bg-white"}`}>{question.required ? <Check size={13} /> : null}</span><input checked={question.required} className="sr-only" onChange={(event) => update(index, { ...question, required: event.target.checked })} type="checkbox" />设为必答题</label>
            </div>
          </article>
        ))}
      </div>
      <button className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)]/40 text-sm font-semibold text-[var(--pbl-teacher)] transition hover:bg-[var(--pbl-teacher-soft)]" disabled={questions.length >= 30} onClick={() => onChange([...questions, newQuestion()])} type="button"><CopyPlus size={17} />添加题目</button>
    </section>
  );
}

export function createEmptySurveyQuestion(): SurveyQuestion {
  return newQuestion();
}
