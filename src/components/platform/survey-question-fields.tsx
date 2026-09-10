"use client";

import { AlignLeft, Check, Circle, CircleDot, ListChecks, Square } from "lucide-react";
import { selectedSurveyOptionIds, surveyTextAnswer, type SurveyAnswer, type SurveyChoiceAnswer, type SurveyQuestion } from "@/lib/platform/survey";

function choiceDetails(answer: SurveyAnswer | undefined): Record<string, string> {
  return answer && typeof answer === "object" && !Array.isArray(answer) ? answer.optionText ?? {} : {};
}

function choiceAnswer(question: SurveyQuestion, selected: string[], details: Record<string, string>): SurveyAnswer {
  const filteredDetails = Object.fromEntries(Object.entries(details).filter(([optionId, detail]) => selected.includes(optionId) && detail));
  const value = question.type === "single-choice" ? selected[0] ?? "" : selected;
  if (!question.options.some((option) => option.allowTextInput) && !Object.keys(filteredDetails).length) return value;
  return { selected: value, ...(Object.keys(filteredDetails).length ? { optionText: filteredDetails } : {}) } satisfies SurveyChoiceAnswer;
}

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
          <p>{question.type === "short-text" ? <>{question.required ? "必答" : "选答"}<span>·</span>用关键词或一两句话写下真实想法</> : <>{question.required ? "必答" : "选答"}{question.type === "multiple-choice" && question.maxSelections ? <><span>·</span><span>最多选 {question.maxSelections} 项</span></> : null}</>}</p>
        </div>
      </div>

      {question.type !== "short-text" ? <div className="survey-paper-options">{question.options.map((option, optionIndex) => {
        const current = answers[question.id];
        const selectedIds = selectedSurveyOptionIds(current);
        const selected = selectedIds.includes(option.id);
        const maxSelections = question.type === "multiple-choice" ? question.maxSelections : undefined;
        const limitReached = maxSelections !== undefined && selectedIds.length >= maxSelections;
        const disabled = limitReached && !selected;
        const updateChoice = () => {
          if (disabled) return;
          const nextSelected = question.type === "single-choice"
            ? [option.id]
            : selected ? selectedIds.filter((id) => id !== option.id) : [...selectedIds, option.id];
          onChange({ ...answers, [question.id]: choiceAnswer(question, nextSelected, choiceDetails(current)) });
        };
        const detail = choiceDetails(current)[option.id] ?? "";
        return <div className={`survey-paper-option-wrap ${selected ? "is-selected" : ""} ${selected && option.allowTextInput ? "has-detail" : ""}`} key={option.id}>
          <label className={`survey-paper-option ${question.type === "multiple-choice" ? "is-multiple" : ""} ${selected ? "is-selected" : ""} ${disabled ? "is-disabled" : ""}`}>
            <input aria-required={question.required} checked={selected} className="sr-only" disabled={disabled} name={question.id} required={question.type === "single-choice" && question.required} type={question.type === "multiple-choice" ? "checkbox" : "radio"} value={option.id} onChange={updateChoice} />
            <span className="survey-paper-option-mark">{selected ? <Check size={16} /> : question.type === "multiple-choice" ? <Square size={12} /> : <Circle size={12} />}</span>
            <span className="survey-paper-option-letter">{String.fromCharCode(65 + optionIndex)}</span>
            <span>{option.label}</span>
          </label>
          {selected && option.allowTextInput ? <input aria-label={`请补充${option.label}的具体内容`} aria-required="true" className="survey-paper-option-detail" maxLength={200} pattern=".*\S.*" placeholder="请填写" required title="请填写补充内容" value={detail} onChange={(event) => onChange({ ...answers, [question.id]: choiceAnswer(question, selectedIds, { ...choiceDetails(current), [option.id]: event.target.value }) })} /> : null}
        </div>;
      })}</div> : <label className="survey-writing-wrap">
        <span className="sr-only">{question.title}</span>
        <AlignLeft aria-hidden="true" className="survey-writing-icon" size={16} />
        <textarea aria-label={question.title} className="survey-writing-area" maxLength={10000} placeholder="从这里开始写…" required={question.required} value={surveyTextAnswer(answers[question.id])} onChange={(event) => onChange({ ...answers, [question.id]: event.target.value })} />
      </label>}
    </section>
  ))}</div>;
}
