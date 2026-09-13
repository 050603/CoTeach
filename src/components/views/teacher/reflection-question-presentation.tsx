"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, List, RefreshCw } from "lucide-react";
import { TeacherPresentationActions } from "@/components/classroom/teacher-presentation-actions";
import { SurveyWordCloud } from "@/components/platform/survey-word-cloud";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui";
import { buildReflectionPresentation, type ReflectionPresentationQuestion } from "@/lib/classroom/reflection-presentation";
import { reflectionSummaryMinimumSampleSize } from "@/lib/reflection-summary";
import type { Course, ReflectionClassSummaryV1, ReflectionSurveyScore } from "@/lib/session/types";
import styles from "./reflection-question-presentation.module.css";

type EvidenceSelection = { type: "all" } | { type: "term"; label: string } | { type: "option"; value: ReflectionSurveyScore };

function evidenceFor(question: ReflectionPresentationQuestion, selection: EvidenceSelection | null) {
  if (!selection || selection.type === "all") return question.answers;
  if (selection.type === "option") return question.answers.filter((answer) => answer.value === selection.value);
  const students = new Set(question.type === "text" ? question.terms.find((term) => term.label === selection.label)?.students.map((student) => student.id) : []);
  return question.answers.filter((answer) => students.has(answer.student.id));
}

export function ReflectionQuestionPresentation({ course, summary, presentation, onRefreshSummary, summaryPending, summaryError }: {
  course: Course;
  summary?: ReflectionClassSummaryV1;
  presentation: "teaching" | "analytics";
  onRefreshSummary: () => void;
  summaryPending: boolean;
  summaryError?: string;
}) {
  const questions = useMemo(() => buildReflectionPresentation(course, summary), [course, summary]);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [selection, setSelection] = useState<EvidenceSelection | null>(null);
  const context = `${course.id}:${presentation}`;
  const [previousContext, setPreviousContext] = useState(context);
  if (previousContext !== context) {
    setPreviousContext(context);
    setSelection(null);
    setDirectoryOpen(false);
  }
  const question = questions[questionIndex];
  const total = new Set(course.students.map((student) => student.id)).size;
  const completion = total ? Math.round(question.responseCount / total * 100) : 0;
  const minimumSample = reflectionSummaryMinimumSampleSize(total);
  const answers = evidenceFor(question, selection);
  const selectedOption = question.type === "scale" && selection?.type === "option" ? question.options.find((option) => option.value === selection.value) : undefined;
  const evidenceTitle = selection?.type === "term" ? `主题“${selection.label}”的回答` : selectedOption ? `选择“${selectedOption.label}”的回答` : "本题回答";

  function selectQuestion(index: number) {
    setQuestionIndex(Math.max(0, Math.min(questions.length - 1, index)));
    setSelection(null);
    setDirectoryOpen(false);
  }

  return <section aria-label={presentation === "analytics" ? "班级学情大屏" : "反思问卷大屏"} className={styles.surface}>
    <header className={styles.heading}>
      <div className={styles.context}>
        <span>第 {questionIndex + 1} / {questions.length} 题 · {question.type === "text" ? "主观反思" : "评价量表"}</span>
        <span>已回答 <strong>{question.responseCount}</strong> / {total} 人 · 完成率 <strong>{completion}%</strong></span>
      </div>
      <h2>{question.title}</h2>
    </header>

    {directoryOpen ? <nav aria-label="反思题目目录" className={styles.directory}>{questions.map((item, index) => <button aria-current={index === questionIndex ? "step" : undefined} key={item.key} onClick={() => selectQuestion(index)} type="button"><span>{index + 1}</span>{item.title}</button>)}</nav> : null}

    {question.type === "text" ? <div className={styles.textQuestion}>
      <div className={styles.analysis}>
        <p role="status">{summaryPending ? "正在更新词云，已有结果仍可查看。" : question.analysis.message}</p>
        <button disabled={summaryPending || !question.responseCount || question.responseCount < minimumSample} onClick={onRefreshSummary} type="button"><RefreshCw size={18} />{summaryPending ? "更新中…" : "更新词云"}</button>
        {question.responseCount < minimumSample ? <span>至少收到 {minimumSample} 份有效反思后可更新</span> : null}
      </div>
      {summaryError ? <p className={styles.error} role="alert">词云更新失败：{summaryError}</p> : null}
      {question.terms.length ? <div className={styles.cloud}>
        <SurveyWordCloud key={`${course.id}:${question.key}`} large hasResponses onSelect={(term) => setSelection({ type: "term", label: term.label })} selected={selection?.type === "term" ? selection.label : null} status="ready" terms={question.terms.map((term) => ({ label: term.label, value: term.count }))} />
      </div> : <div className={styles.empty}><p>{question.responseCount ? "本题暂无可展示的关键词" : "本题暂未收到回答"}</p><span>{question.responseCount ? "可查看已提交回答；更新词云后展示有来源的主题。" : "收到学生反思后，这里将显示本题的班级情况。"}</span></div>}
    </div> : <div className={styles.scaleQuestion}>
      <p className={styles.average}>本题平均分 <strong>{question.average === null ? "—" : question.average.toFixed(1)}</strong><span> / 5 分</span></p>
      <div aria-label="本题五个选项的回答分布" className={styles.options}>
        {question.options.map((option) => <button aria-label={`${option.label}，${option.count} 人，${option.percent}%`} className={styles.option} key={option.value} onClick={() => setSelection({ type: "option", value: option.value })} type="button">
          <span className={styles.optionLabel}><span>{option.value}</span>{option.label}</span>
          <span aria-hidden="true" className={styles.track}><span data-score={option.value} style={{ width: `${option.percent}%` }} /></span>
          <span className={styles.optionCount}><strong>{option.count}</strong> 人 <span>{option.percent}%</span></span>
        </button>)}
      </div>
      <p className={styles.caption}>{question.responseCount ? "百分比按本题已回答人数计算；点击选项可查看对应回答。" : "尚无有效回答，各选项人数与占比均为 0。"}</p>
    </div>}

    <TeacherPresentationActions>
      <button aria-label="上一道反思题" disabled={questionIndex === 0} onClick={() => selectQuestion(questionIndex - 1)} type="button"><ChevronLeft size={18} />上一题</button>
      <select aria-label="选择反思题目" className={styles.questionSelect} onChange={(event) => selectQuestion(Number(event.target.value))} value={questionIndex}>{questions.map((item, index) => <option key={item.key} value={index}>{index + 1}. {item.title}</option>)}</select>
      <button aria-label="下一道反思题" disabled={questionIndex === questions.length - 1} onClick={() => selectQuestion(questionIndex + 1)} type="button">下一题<ChevronRight size={18} /></button>
      <button aria-expanded={directoryOpen} onClick={() => setDirectoryOpen((value) => !value)} type="button"><List size={18} />题目目录</button>
      <button onClick={() => setSelection({ type: "all" })} type="button">查看本题回答</button>
    </TeacherPresentationActions>

    <Dialog open={selection !== null} onOpenChange={(open) => { if (!open) setSelection(null); }}>
      <DialogContent className={styles.dialog}>
        <DialogHeader><DialogTitle className={styles.dialogTitle}>{evidenceTitle} · {answers.length} 人</DialogTitle><DialogDescription className={styles.dialogDescription}>第 {questionIndex + 1} 题 · {question.title}</DialogDescription></DialogHeader>
        <div className={styles.answers}>{answers.length ? answers.map((answer) => <article key={`${answer.student.id}:${answer.reflectionId}`}>
          <h3>{answer.student.name}</h3>
          <p>{typeof answer.value === "number" && question.type === "scale" ? `${answer.value} 分 · ${question.options.find((option) => option.value === answer.value)?.label ?? ""}` : answer.value}</p>
        </article>) : <p className={styles.caption}>暂无符合条件的回答。</p>}</div>
      </DialogContent>
    </Dialog>
  </section>;
}
