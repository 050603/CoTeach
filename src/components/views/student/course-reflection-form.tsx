"use client";

import { useState } from "react";
import type { Course, CourseReflectionResponse, ExperienceSurveyResponse, ReflectionSurveyScore } from "@/lib/session/types";
import { useSession } from "@/lib/session/store";
import { COURSE_REFLECTION_MAX_LENGTH, courseQuestionSet, courseReflectionText, latestCourseReflection, latestExperienceSurvey } from "@/lib/course-reflection";
import { REFLECTION_SURVEY_QUESTIONS, REFLECTION_SURVEY_SCALE, isReflectionSurveyScore } from "@/lib/reflection-survey";
import { Card, PrimaryButton, TextArea, toast } from "@/components/ui";
import { CourseStageRequirements } from "@/components/classroom/course-stage-requirements";

export function CourseReflectionForm({ course }: { course: Course }) {
  const session = useSession();
  const studentId = session.studentId ?? "";
  const set = courseQuestionSet(course)!;
  const original = latestCourseReflection(course, studentId);
  const previousExperience = latestExperienceSurvey(course, studentId);
  const [recordId, setRecordId] = useState(original?.id);
  const [answers, setAnswers] = useState<Record<string, string>>(original?.courseReflection?.answers ?? {});
  const [courseResponse, setCourseResponse] = useState(original?.courseReflection);
  const [experience, setExperience] = useState<Partial<ExperienceSurveyResponse>>(previousExperience ?? {});
  const [experienceSaved, setExperienceSaved] = useState<ExperienceSurveyResponse | undefined>(original?.experienceSurvey);
  const editable = course.status === "teaching" && course.stages[course.currentStageIndex]?.key === "reflection";
  const busy = session.saveState === "saving";
  const complete = set.questions.every((q) => !q.required || answers[q.id]?.trim());
  const experienceComplete = Boolean(experience.systemReflection?.trim()) && isReflectionSurveyScore(experience.aiHelpfulness)
    && isReflectionSurveyScore(experience.systemUsability) && isReflectionSurveyScore(experience.reuseIntention);
  const save = (response?: CourseReflectionResponse, survey?: ExperienceSurveyResponse) => {
    const record = session.upsertReflection({ id: recordId, courseId: course.id, studentId,
      content: response ? courseReflectionText(response) : "", courseReflection: response, experienceSurvey: survey });
    if (record) setRecordId(record.id);
    return record;
  };
  return <div className="space-y-5">
    <CourseStageRequirements course={course} stageKey="reflection" expanded />
    <Card><h2 className="text-xl font-bold">课程学习反思</h2><p className="mt-2 text-sm text-stone-600">按本课程确认的题目回答，结合自己的作品、决策与学习经历。{courseResponse ? " 已有提交，可在本阶段更新。" : ""}</p>
      <div className="mt-5 space-y-5">{set.questions.map((question, index) => <label className="block" key={question.id}>
        <span className="font-semibold">{index + 1}. {question.prompt}{question.required ? " *" : "（选答）"}</span>
        <TextArea aria-label={question.prompt} className="mt-2 min-h-28" disabled={!editable || busy} maxLength={COURSE_REFLECTION_MAX_LENGTH} value={answers[question.id] ?? ""} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })} />
      </label>)}</div>
      <PrimaryButton className="mt-5" disabled={!studentId || !editable || !complete || busy} tone="green" onClick={() => {
        const response: CourseReflectionResponse = { schemaVersion: 1, questionSetId: set.id, questionSetVersion: set.version,
          questions: set.questions, answers: Object.fromEntries(set.questions.map((q) => [q.id, (answers[q.id] ?? "").trim()])), submittedAt: new Date().toISOString() };
        if (save(response, experienceSaved)) { setCourseResponse(response); session.updateStudentProgress("reflection", 100); toast.success("课程反思已提交"); }
      }}>提交课程反思</PrimaryButton>
    </Card>
    <Card><h2 className="text-xl font-bold">系统体验问卷</h2><p className="mt-2 text-sm text-stone-600">独立提交，用于改进 AI 协作与系统体验，不计入课程反思完成度或课程成绩。</p>
      <label className="mt-4 block text-sm font-semibold">{REFLECTION_SURVEY_QUESTIONS.systemReflection}<TextArea className="mt-2" aria-label="系统体验意见" disabled={!editable || busy} maxLength={COURSE_REFLECTION_MAX_LENGTH} value={experience.systemReflection ?? ""} onChange={(event) => setExperience({ ...experience, systemReflection: event.target.value })} /></label>
      {(["aiHelpfulness", "systemUsability", "reuseIntention"] as const).map((field) => <fieldset className="mt-4" key={field}><legend className="text-sm font-semibold">{REFLECTION_SURVEY_QUESTIONS[field]}</legend><div className="mt-2 flex flex-wrap gap-2">{REFLECTION_SURVEY_SCALE.map((option) => <label className="flex min-h-11 items-center gap-1.5 rounded-md border border-stone-200 px-3 text-sm" key={option.value}><input type="radio" name={`${course.id}:${field}`} disabled={!editable || busy} checked={experience[field] === option.value} onChange={() => setExperience({ ...experience, [field]: option.value as ReflectionSurveyScore })} />{option.value} {option.label}</label>)}</div></fieldset>)}
      <PrimaryButton className="mt-5" disabled={!studentId || !editable || !experienceComplete || busy} tone="slate" variant="outline" onClick={() => {
        const survey: ExperienceSurveyResponse = { schemaVersion: 1, systemReflection: experience.systemReflection!.trim(), aiHelpfulness: experience.aiHelpfulness!, systemUsability: experience.systemUsability!, reuseIntention: experience.reuseIntention!, submittedAt: new Date().toISOString() };
        if (save(courseResponse, survey)) { setExperienceSaved(survey); toast.success("系统体验问卷已提交"); }
      }}>提交系统体验问卷</PrimaryButton>
    </Card>
    {session.saveState === "error" ? <p role="alert" className="text-sm text-rose-700">保存失败，请保留当前页面并重新提交。</p> : null}
  </div>;
}
