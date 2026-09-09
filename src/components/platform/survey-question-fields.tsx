"use client";

import { AlignLeft, Check, Circle, CircleDot, ListChecks, Square } from "lucide-react";
import type { SurveyAnswer, SurveyQuestion } from "@/lib/platform/survey";

export function SurveyQuestionFields({ questions, answers, onChange }: {
  questions: SurveyQuestion[];
  answers: Record<string, SurveyAnswer>;
  onChange: (answers: Record<string, SurveyAnswer>) => void;
}) {
  return <div className="survey-sheet-questions">{questions.map((question, index) => (
    <section className="survey-sheet-question" key={question.id}>
      <div className="survey-sheet-question-heading">
        <span className="survey-sheet-number">{String(index + 1).padStart(2, "0")}</span>
        <div>
          <div className="survey-sheet-question-title-line">
            <h2>{question.title}</h2>
            <span className={`survey-sheet-question-kind is-${question.type}`}>{question.type === "single-choice" ? <><CircleDot size={13} />单选题</> : question.type === "multiple-choice" ? <><ListChecks size={13} />多选题</> : <><AlignLeft size={13} />简答题</>}</span>
          </div>
          <p>{question.type === "single-choice" ? "单选：本题只能选择一个选项" : question.type === "multiple-choice" ? "多选：本题可以选择一个或多个选项" : "用关键词或一两句话写下真实想法"}<span>·</span>{question.required ? "必答" : "选答"}</p>
        </div>
      </div>

      {question.type !== "short-text" ? <div className="survey-paper-options">{question.options.map((option, optionIndex) => {
        const current = answers[question.id];
        const selected = question.type === "multiple-choice" ? Array.isArray(current) && current.includes(option.id) : current === option.id;
        const updateChoice = () => {
          if (question.type === "single-choice") return onChange({ ...answers, [question.id]: option.id });
          const selectedIds = Array.isArray(current) ? current : [];
          onChange({ ...answers, [question.id]: selected ? selectedIds.filter((id) => id !== option.id) : [...selectedIds, option.id] });
        };
        return <label className={`survey-paper-option ${question.type === "multiple-choice" ? "is-multiple" : ""} ${selected ? "is-selected" : ""}`} key={option.id}>
          <input aria-required={question.required} checked={selected} className="sr-only" name={question.id} required={question.type === "single-choice" && question.required} type={question.type === "multiple-choice" ? "checkbox" : "radio"} value={option.id} onChange={updateChoice} />
          <span className="survey-paper-option-mark">{selected ? <Check size={16} /> : question.type === "multiple-choice" ? <Square size={12} /> : <Circle size={12} />}</span>
          <span className="survey-paper-option-letter">{String.fromCharCode(65 + optionIndex)}</span>
          <span>{option.label}</span>
        </label>;
      })}</div> : <label className="survey-writing-wrap">
        <span className="sr-only">{question.title}</span>
        <AlignLeft aria-hidden="true" className="survey-writing-icon" size={16} />
        <textarea aria-label={question.title} className="survey-writing-area" maxLength={10000} placeholder="从这里开始写…" required={question.required} value={typeof answers[question.id] === "string" ? answers[question.id] : ""} onChange={(event) => onChange({ ...answers, [question.id]: event.target.value })} />
      </label>}
    </section>
  ))}</div>;
}
