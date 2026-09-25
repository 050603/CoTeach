"use client";

import { useEffect, useId, useRef } from "react";
import { Check } from "lucide-react";
import { groupExperimentQuestions, type ExperimentQuestionGroup } from "@/lib/platform/experiment";

export type ExperimentDisplayQuestion = {
  id: string;
  prompt: string;
  type: "single-choice" | "multiple-choice" | "true-false" | "short-answer" | "scale";
  options?: string[];
  category?: string;
  scale?: { min: number; max: number; minLabel?: string; maxLabel?: string };
  group?: ExperimentQuestionGroup;
  optional?: boolean;
  skipReasonRequired?: boolean;
};

export type ExperimentDisplayAnswer = string | string[];

const typeLabel: Record<ExperimentDisplayQuestion["type"], string> = {
  "single-choice": "单选题",
  "multiple-choice": "多选题",
  "true-false": "判断题",
  "short-answer": "简答题",
  scale: "量表题",
};

const categoryLabel: Record<string, string> = {
  knowledge: "知识理解",
  "micro-design": "微设计能力",
  confidence: "学习信心",
  collaboration: "协作体验",
  other: "其他",
};

function promptParagraphs(prompt: string) {
  return (prompt.trim().replace(/\r\n?/g, "\n") || "未填写题干").split(/\n\s*\n/);
}

export function ExperimentQuestionCard({ question, index, answer, onAnswerChange, inputName, id, invalid = false, grouped = false, descriptionId, readOnly = false }: {
  question: ExperimentDisplayQuestion;
  index: number;
  answer?: ExperimentDisplayAnswer;
  onAnswerChange: (answer: ExperimentDisplayAnswer) => void;
  inputName: string;
  id?: string;
  invalid?: boolean;
  grouped?: boolean;
  descriptionId?: string;
  readOnly?: boolean;
}) {
  const headingId = useId();
  const textArea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!textArea.current) return;
    textArea.current.style.height = "auto";
    textArea.current.style.height = `${Math.max(144, textArea.current.scrollHeight)}px`;
  }, [answer]);
  const choices = question.type === "true-false" ? ["true", "false"] : question.options ?? [];
  const scores = question.scale && question.scale.max > question.scale.min
    ? Array.from({ length: question.scale.max - question.scale.min + 1 }, (_, offset) => String(question.scale!.min + offset)) : [];

  return <fieldset
    aria-invalid={invalid || undefined}
    aria-labelledby={headingId}
    aria-describedby={descriptionId}
    className={`min-w-0 scroll-mt-24 bg-white py-5 sm:py-6 ${grouped ? "border-b px-4 last:border-b-0 sm:px-6" : "rounded-[14px] border px-4 sm:px-6"} ${invalid ? "border-[var(--pbl-danger)]" : "border-[var(--pbl-border)]"}`}
    id={id}
    tabIndex={-1}
  >
    <div className="flex min-w-0 items-start gap-3 sm:gap-4">
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-[var(--pbl-student-soft)] text-sm font-bold tabular-nums text-[var(--pbl-student)]">{String(index + 1).padStart(2, "0")}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-[var(--pbl-student)]">{typeLabel[question.type]}{question.category ? ` · ${categoryLabel[question.category] ?? question.category}` : ""}</p>
        <div className="mt-2 max-w-[68ch] space-y-3 text-[16px] font-semibold leading-8 text-[var(--pbl-text-strong)]" id={headingId}>
          <span className="sr-only">第 {index + 1} 题，{question.optional ? "选答" : "必答"}：</span>
          {promptParagraphs(question.prompt).map((paragraph, paragraphIndex) => <p className="whitespace-pre-wrap [overflow-wrap:anywhere]" key={paragraphIndex}>{paragraph}</p>)}
        </div>
      </div>
      <span aria-hidden="true" className="hidden shrink-0 text-xs font-medium text-[var(--pbl-text-muted)] sm:block">{question.optional ? "可跳过" : "必答"}</span>
    </div>
    <div className="mt-5 border-t border-[var(--pbl-border)] pt-5">
      {question.type === "short-answer" ? <div>
        <label className="mb-2 block text-xs font-medium text-[var(--pbl-text-muted)]" htmlFor={`${inputName}-text`}>你的回答</label>
        <textarea
          aria-label={question.prompt.trim() || `第 ${index + 1} 题简答`}
          className="min-h-36 w-full resize-y rounded-[10px] border border-[var(--pbl-border)] bg-[var(--pbl-bg)] px-4 py-3 text-sm leading-7 text-[var(--pbl-text-strong)] outline-none transition-colors placeholder:text-[var(--pbl-text-muted)] focus:border-[var(--pbl-student)] focus:ring-2 focus:ring-[var(--pbl-student-border)] motion-reduce:transition-none"
          readOnly={readOnly}
          ref={textArea}
          id={`${inputName}-text`}
          maxLength={10_000}
          onChange={(event) => onAnswerChange(event.target.value)}
          placeholder="结合题目情境，写下你的想法…"
          value={typeof answer === "string" ? answer : ""}
        />
      </div> : question.type === "scale" ? scores.length ? <div className="space-y-4">
        {!grouped || !descriptionId ? <p className="text-xs text-[var(--pbl-text-muted)]">请选择最符合你当前想法的分值</p> : null}
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(48px, 1fr))" }}>
          {scores.map((score) => {
            const selected = answer === score;
            return <label className={`flex min-h-12 cursor-pointer items-center justify-center rounded-[10px] border px-2 py-2 text-sm font-semibold tabular-nums transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--pbl-student)] motion-reduce:transition-none ${selected ? "border-[var(--pbl-student)] bg-[var(--pbl-student)] text-white" : "border-[var(--pbl-border)] bg-[var(--pbl-bg)] text-[var(--pbl-text-strong)] hover:border-[var(--pbl-student-border)] hover:bg-[var(--pbl-student-soft)]"}`} key={score}>
              <input aria-label={`${score} 分`} checked={selected} className="sr-only" disabled={readOnly} name={inputName} onChange={() => onAnswerChange(score)} type="radio" value={score} />{score}
            </label>;
          })}
        </div>
        <div className="flex items-start justify-between gap-4 border-t border-dashed border-[var(--pbl-border)] pt-3 text-xs leading-5 text-[var(--pbl-text-muted)]">
          <span className="max-w-[45%] whitespace-pre-wrap [overflow-wrap:anywhere]">{question.scale?.min} 分 · {question.scale?.minLabel || "最低"}</span>
          <span className="max-w-[45%] whitespace-pre-wrap text-right [overflow-wrap:anywhere]">{question.scale?.max} 分 · {question.scale?.maxLabel || "最高"}</span>
        </div>
        {answer ? <p aria-live="polite" className="text-xs font-semibold text-[var(--pbl-student)]">已选择 {answer} 分</p> : null}
      </div> : <p className="text-xs text-[var(--pbl-text-muted)]">请先在题目设置中填写有效量表范围。</p> : choices.length ? <div className={question.type === "true-false" ? "grid gap-3 sm:grid-cols-2" : "grid gap-3"}>
        {choices.map((choice, choiceIndex) => {
          const multiple = question.type === "multiple-choice";
          const selected = multiple ? Array.isArray(answer) && answer.includes(choice) : answer === choice;
          const text = question.type === "true-false" ? choice === "true" ? "正确" : "错误" : choice;
          return <label className={`flex min-h-14 min-w-0 cursor-pointer items-start gap-3 rounded-[10px] border px-3.5 py-3 text-sm leading-6 transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--pbl-student)] motion-reduce:transition-none ${selected ? "border-[var(--pbl-student)] bg-[var(--pbl-student-soft)] text-[var(--pbl-text-strong)]" : "border-[var(--pbl-border)] bg-[var(--pbl-bg)] text-[var(--pbl-text)] hover:border-[var(--pbl-student-border)] hover:bg-white"}`} key={choice}>
            <input
              aria-label={text}
              checked={selected}
              className="sr-only"
              disabled={readOnly}
              name={inputName}
              onChange={() => onAnswerChange(multiple
                ? selected ? (Array.isArray(answer) ? answer.filter((item) => item !== choice) : []) : [...(Array.isArray(answer) ? answer : []), choice]
                : choice)}
              type={multiple ? "checkbox" : "radio"}
              value={choice}
            />
            <span aria-hidden="true" className={`grid size-7 shrink-0 place-items-center rounded-[7px] text-xs font-bold ${selected ? "bg-[var(--pbl-student)] text-white" : "border border-[var(--pbl-border)] bg-white text-[var(--pbl-text-muted)]"}`}>{question.type === "true-false" ? choice === "true" ? "对" : "错" : String.fromCharCode(65 + choiceIndex)}</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>
            <span aria-hidden="true" className={`mt-1 grid size-5 shrink-0 place-items-center border-2 ${multiple ? "rounded-[6px]" : "rounded-full"} ${selected ? "border-[var(--pbl-student)] bg-[var(--pbl-student)]" : "border-[var(--pbl-border)] bg-white"}`}>{selected ? multiple ? <Check size={13} strokeWidth={3} className="text-white" /> : <span className="size-2 rounded-full bg-white" /> : null}</span>
          </label>;
        })}
      </div> : <p className="text-xs text-[var(--pbl-text-muted)]">请先在题目设置中填写选项。</p>}
      {question.optional && !readOnly && (Array.isArray(answer) ? answer.length > 0 : Boolean(answer)) ? <button className="mt-3 text-xs font-semibold text-[var(--pbl-student)] underline" onClick={() => onAnswerChange(question.type === "multiple-choice" ? [] : "")} type="button">清除作答并跳过</button> : null}
      {invalid ? <p className="mt-3 text-xs font-semibold text-[var(--pbl-danger)]">请完成这道题后再提交。</p> : null}
    </div>
  </fieldset>;
}

export function ExperimentQuestionList({ questions, answers, onAnswerChange, inputNamePrefix, questionIdPrefix, invalidQuestionId, startIndex = 0, readOnly = false }: {
  questions: ExperimentDisplayQuestion[];
  answers: Record<string, ExperimentDisplayAnswer>;
  onAnswerChange: (questionId: string, answer: ExperimentDisplayAnswer) => void;
  inputNamePrefix: string;
  questionIdPrefix?: string;
  invalidQuestionId?: string | null;
  startIndex?: number;
  readOnly?: boolean;
}) {
  const listId = useId();
  const sections = groupExperimentQuestions(questions);
  const ordered = sections.flatMap((section) => section.questions);

  return <div className="space-y-5">
    {sections.map((section, sectionIndex) => {
      const group = section.group;
      const titleId = `${listId}-group-${sectionIndex}-title`;
      const instructionId = `${listId}-group-${sectionIndex}-instruction`;
      const content = section.questions.map((question) => <ExperimentQuestionCard
        answer={answers[question.id]}
        descriptionId={group?.instruction ? instructionId : undefined}
        grouped={Boolean(group)}
        id={questionIdPrefix ? `${questionIdPrefix}-${question.id}` : undefined}
        index={startIndex + ordered.findIndex((item) => item.id === question.id)}
        inputName={`${inputNamePrefix}-${question.id}`}
        invalid={invalidQuestionId === question.id}
        key={question.id}
        onAnswerChange={(next) => onAnswerChange(question.id, next)}
        question={question}
        readOnly={readOnly}
      />);
      if (!group) return <div key={`question-${section.questions[0].id}`}>{content}</div>;
      return <section aria-labelledby={titleId} className="overflow-hidden rounded-[14px] border border-[var(--pbl-student-border)] bg-white" key={`group-${group.id}`}>
        <div className="border-b border-[var(--pbl-student-border)] bg-[var(--pbl-student-soft)] px-4 py-5 sm:px-6">
          <p className="text-xs font-semibold tracking-wider text-[var(--pbl-student)]">题组 · {section.questions.length} 题</p>
          <h3 className="mt-1.5 whitespace-pre-wrap text-lg font-bold leading-7 text-[var(--pbl-text-strong)] [overflow-wrap:anywhere]" id={titleId}>{group.title || "未填写题组标题"}</h3>
          {group.instruction ? <div className="mt-3 space-y-2 text-sm leading-7 text-[var(--pbl-text)]" id={instructionId}>
            {promptParagraphs(group.instruction).map((paragraph, index) => <p className="whitespace-pre-wrap [overflow-wrap:anywhere]" key={index}>{paragraph}</p>)}
          </div> : null}
        </div>
        <div>{content}</div>
      </section>;
    })}
  </div>;
}
