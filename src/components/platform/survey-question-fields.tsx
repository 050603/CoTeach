"use client";

import { AlignLeft, Check, Circle } from "lucide-react";
import type { SurveyQuestion } from "@/lib/platform/survey";

export function SurveyQuestionFields({ questions, answers, onChange }: {
  questions: SurveyQuestion[];
  answers: Record<string, string>;
  onChange: (answers: Record<string, string>) => void;
}) {
  return <div className="survey-sheet-questions">{questions.map((question, index) => (
    <section className="survey-sheet-question" key={question.id}>
      <div className="survey-sheet-question-heading">
        <span className="survey-sheet-number">{String(index + 1).padStart(2, "0")}</span>
        <div>
          <h2>{question.title}</h2>
          <p>{question.type === "single-choice" ? "请选择一个最符合你想法的选项" : "用关键词或一两句话写下真实想法"}<span>·</span>{question.required ? "必答" : "选答"}</p>
        </div>
      </div>

      {question.type === "single-choice" ? <div className="survey-paper-options">{question.options.map((option, optionIndex) => {
        const selected = answers[question.id] === option.id;
        return <label className={`survey-paper-option ${selected ? "is-selected" : ""}`} key={option.id}>
          <input checked={selected} className="sr-only" name={question.id} required={question.required} type="radio" value={option.id} onChange={() => onChange({ ...answers, [question.id]: option.id })} />
          <span className="survey-paper-option-mark">{selected ? <Check size={16} /> : <Circle size={12} />}</span>
          <span className="survey-paper-option-letter">{String.fromCharCode(65 + optionIndex)}</span>
          <span>{option.label}</span>
        </label>;
      })}</div> : <label className="survey-writing-wrap">
        <span className="sr-only">{question.title}</span>
        <AlignLeft aria-hidden="true" className="survey-writing-icon" size={16} />
        <textarea aria-label={question.title} className="survey-writing-area" maxLength={10000} placeholder="从这里开始写…" required={question.required} value={answers[question.id] ?? ""} onChange={(event) => onChange({ ...answers, [question.id]: event.target.value })} />
      </label>}
    </section>
  ))}</div>;
}
