"use client";

import { useState } from "react";
import type { Course, AiSupportRecord } from "@/lib/session/types";
import type { TeacherPresentationMode } from "@/lib/classroom/presentation";
import { courseQuestionSet, latestCourseReflection, latestExperienceSurvey } from "@/lib/course-reflection";
import { normalizeReflectionClassSummary, reflectionClassSummaryIsStale, reflectionSummaryMinimumSampleSize } from "@/lib/reflection-summary";
import { buildReflectionClassSummary } from "@/lib/teaching-ai/client-api";
import { Card, PrimaryButton } from "@/components/ui";
import { ReflectionQuestionPresentation } from "./reflection-question-presentation";

export function CourseReflectionReview({ course, presentation = "workspace" }: { course: Course; presentation?: TeacherPresentationMode }) {
  const set = courseQuestionSet(course)!;
  const [localSupport, setLocalSupport] = useState<AiSupportRecord>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const source = localSupport ?? [...(course.aiSupports ?? [])].filter((item) => item.kind === "reflection-class-summary").sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const summary = normalizeReflectionClassSummary(source?.structuredPayload, new Set(course.students.map((student) => student.id)));
  const rows = course.students.map((student) => ({ student, reflection: latestCourseReflection(course, student.id), experience: latestExperienceSurvey(course, student.id) }));
  const submitted = rows.filter((row) => row.reflection).length;
  const refreshSummary = async () => {
    setBusy(true); setError(undefined);
    try { const support = await buildReflectionClassSummary(course.id); setLocalSupport(support); window.dispatchEvent(new CustomEvent("openpbl:reflection-summary-updated", { detail: { courseId: course.id, support } })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "课程反思分析失败，请重试。"); }
    finally { setBusy(false); }
  };
  if (presentation !== "workspace") return <ReflectionQuestionPresentation course={course} summary={summary} presentation={presentation} onRefreshSummary={() => void refreshSummary()} summaryPending={busy} summaryError={error} />;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-2xl font-bold">课程反思与系统体验</h2><p className="mt-2 text-sm text-stone-600">课程反思 {submitted}/{rows.length} 人 · 独立体验问卷 {rows.filter((row) => row.experience).length}/{rows.length} 人</p></div><a className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-800 underline" href={`/api/courses/${encodeURIComponent(course.id)}/reflections/export`} download>导出逐题回答与体验数据</a></div>
    <Card><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-bold">课程反思分析</h3><PrimaryButton disabled={busy || submitted < reflectionSummaryMinimumSampleSize(rows.length)} onClick={() => void refreshSummary()} tone="blue">{busy ? "分析中…" : "更新课程反思分析"}</PrimaryButton></div>
      {summary ? <div className="mt-4 space-y-3"><p>{summary.courseSummary}</p>{reflectionClassSummaryIsStale(summary, course) ? <p className="text-sm text-amber-800">有新的反思提交，可更新分析。</p> : null}{summary.categories.map((category) => <p key={category.key}><strong>{category.title}：</strong>{category.summary}</p>)}</div> : <p className="mt-3 text-sm text-stone-600">收到足够课程反思后，根据真实逐题回答生成分析。体验问卷未交不会影响课程反思完成度。</p>}
      {error ? <p className="mt-3 text-sm text-rose-700" role="alert">{error}</p> : null}
    </Card>
    <section aria-label="逐生课程反思" className="space-y-3">{rows.map(({ student, reflection, experience }) => <details className="rounded-lg border border-stone-200 bg-white px-4 py-2" key={student.id}>
      <summary className="min-h-11 cursor-pointer py-2 font-semibold">{student.name} · {reflection ? "课程反思已交" : "课程反思未交"} · {experience ? "体验已交" : "体验未交"}</summary>
      <div className="space-y-4 border-t border-stone-100 py-4">{set.questions.map((question, index) => <div key={question.id}><p className="font-semibold">{index + 1}. {question.prompt}</p><p className="mt-1 whitespace-pre-wrap text-sm leading-7">{reflection?.courseReflection?.answers[question.id] || "未回答"}</p></div>)}
        {experience ? <div className="border-t border-stone-200 pt-3"><h4 className="font-semibold">独立系统体验</h4><p className="mt-1 whitespace-pre-wrap text-sm leading-7">{experience.systemReflection}</p><p className="mt-2 text-sm">AI 帮助度 {experience.aiHelpfulness}/5 · 系统易用度 {experience.systemUsability}/5 · 再使用意愿 {experience.reuseIntention}/5</p></div> : null}
      </div>
    </details>)}</section>
  </div>;
}
