"use client";

import Link from "next/link";
import { ArrowLeft, Check, CheckCircle2, Clock3, FileText, Send, Sparkles, UserRoundCheck } from "lucide-react";
import type { FormEvent } from "react";
import { surveyAnswerHasValue, type SurveyAnswer, type SurveyQuestion } from "@/lib/platform/survey";
import { SurveyQuestionFields } from "./survey-question-fields";

type SurveyActivity = {
  id: string;
  title: string;
  description: string | null;
  isOpen: boolean;
  offering: { id: string; name: string; status: string };
  chapter: { title: string };
  config?: { content?: string; questions?: SurveyQuestion[] };
  progress: { status: string };
};

export function StudentSurveyExperience({ activity, answers, busy, error, saved, onAnswersChange, onSubmit }: {
  activity: SurveyActivity;
  answers: Record<string, SurveyAnswer>;
  busy: boolean;
  error: string | null;
  saved: boolean;
  onAnswersChange: (answers: Record<string, SurveyAnswer>) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const questions = (activity.config?.questions ?? []).map((question) => ({ ...question, type: question.type ?? "short-text" as const, options: question.options ?? [] }));
  const answeredCount = questions.filter((question) => surveyAnswerHasValue(answers[question.id])).length;
  const percentage = questions.length ? Math.round((answeredCount / questions.length) * 100) : 0;
  const locked = !activity.isOpen || activity.offering.status !== "open";

  return <main className="survey-student-page min-h-screen">
    <div aria-hidden="true" className="survey-student-ambient survey-student-ambient-one" />
    <div aria-hidden="true" className="survey-student-ambient survey-student-ambient-two" />
    <div className="survey-student-layout">
      <aside className="survey-student-rail">
        <div className="survey-student-rail-copy">
          <span>QUESTIONNAIRE</span>
          <strong>把真实想法<br />留在这里</strong>
          <p>没有标准答案。回答将实名保存，用于本课程研究与教学改进。</p>
        </div>
        <div className="survey-student-progress" aria-label={`已完成 ${answeredCount} 题，共 ${questions.length} 题`}>
          <div className="flex items-end justify-between"><span>填写进度</span><strong>{answeredCount}<small> / {questions.length}</small></strong></div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-emerald-900/10"><span className="block h-full rounded-full bg-emerald-700 transition-[width] duration-500" style={{ width: `${percentage}%` }} /></div>
        </div>
      </aside>

      <section className="survey-answer-sheet">
        <span aria-hidden="true" className="survey-paper-tape survey-paper-tape-left" /><span aria-hidden="true" className="survey-paper-tape survey-paper-tape-right" />
        <div className="survey-paper-margin" aria-hidden="true" />
        <header className="survey-sheet-header">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-xs font-bold tracking-[0.16em] text-emerald-800"><FileText size={15} />课堂小问卷</span>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-stone-500"><span className="inline-flex items-center gap-1.5 text-emerald-800"><UserRoundCheck size={14} />实名提交</span><span className="inline-flex items-center gap-2"><Clock3 size={14} />约 {Math.max(2, questions.length * 2)} 分钟</span></div>
          </div>
          <h1>{activity.title}</h1>
          <p className="survey-sheet-course">{activity.offering.name}<span>·</span>{activity.chapter.title}</p>
          {activity.config?.content ? <p className="survey-sheet-note"><Sparkles size={16} />{activity.config.content}</p> : null}
        </header>

        {locked ? <div className="survey-sheet-locked">问卷目前未开放，请等待教师发布。</div> : <form onSubmit={onSubmit}>
          <SurveyQuestionFields answers={answers} onChange={onAnswersChange} questions={questions} />
          <footer className="survey-sheet-footer">
            <div className="min-h-10 flex-1">{error ? <p className="text-sm text-rose-700" role="alert">{error}</p> : saved ? <p className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-800" role="status"><CheckCircle2 size={17} />回答已经保存，你仍然可以继续修改</p> : answeredCount === questions.length && questions.length ? <p className="inline-flex items-center gap-2 text-sm text-stone-600"><Check size={16} className="text-emerald-700" />所有题目均已填写</p> : <p className="text-sm text-stone-500">已完成 {answeredCount} / {questions.length} 题</p>}</div>
            <div className="survey-sheet-actions">
              {activity.progress.status === "completed" ? <Link className="survey-sheet-return" href={`/student/courses/${activity.offering.id}`}><ArrowLeft size={16} />返回课程</Link> : null}
              <button className="survey-sheet-submit" disabled={busy || locked} type="submit"><Send size={17} />{busy ? "正在交卷…" : activity.progress.status === "completed" ? "更新回答" : "提交问卷"}</button>
            </div>
          </footer>
        </form>}
      </section>
    </div>
  </main>;
}
