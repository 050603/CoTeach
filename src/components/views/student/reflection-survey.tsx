"use client";

import { CourseReflectionForm } from "./course-reflection-form";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpenCheck,
  CheckCircle2,
  RefreshCw,
  Send,
} from "lucide-react";
import { RadioGroup } from "radix-ui";
import { Card, Pill, PrimaryButton, TextArea, toast } from "@/components/ui";
import { buildReflectionEvidencePrompts } from "@/lib/teaching-ai/client-api";
import { useSession } from "@/lib/session/store";
import type {
  Course,
  ReflectionRecord,
  ReflectionSurveyResponseV1,
  ReflectionSurveyScore,
} from "@/lib/session/types";
import {
  REFLECTION_SURVEY_FALLBACK_SUGGESTIONS,
  REFLECTION_SURVEY_QUESTIONS,
  REFLECTION_SURVEY_SCALE,
  REFLECTION_SURVEY_TEXT_MAX_LENGTH,
  normalizeReflectionSurvey,
  reflectionToLegacyContent,
} from "@/lib/reflection-survey";
import { StagePageHeader } from "@/components/classroom/classroom-ui";

type SurveyFields = {
  learningReflection: string;
  systemReflection: string;
  aiHelpfulness?: ReflectionSurveyScore;
  systemUsability?: ReflectionSurveyScore;
  reuseIntention?: ReflectionSurveyScore;
};

const SCALE_FIELDS: Array<{
  key: "aiHelpfulness" | "systemUsability" | "reuseIntention";
  label: string;
}> = [
  { key: "aiHelpfulness", label: REFLECTION_SURVEY_QUESTIONS.aiHelpfulness },
  { key: "systemUsability", label: REFLECTION_SURVEY_QUESTIONS.systemUsability },
  { key: "reuseIntention", label: REFLECTION_SURVEY_QUESTIONS.reuseIntention },
];

function latestReflection(
  reflections: readonly ReflectionRecord[] | undefined,
  studentId: string,
): ReflectionRecord | undefined {
  return [...(reflections ?? [])]
    .filter((reflection) => reflection.studentId === studentId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

function draftFromReflection(reflection?: ReflectionRecord): SurveyFields {
  const survey = normalizeReflectionSurvey(reflection?.survey);
  return {
    learningReflection: survey?.learningReflection ?? "",
    systemReflection: survey?.systemReflection ?? "",
    aiHelpfulness: survey?.aiHelpfulness,
    systemUsability: survey?.systemUsability,
    reuseIntention: survey?.reuseIntention,
  };
}

function isComplete(fields: SurveyFields): fields is ReflectionSurveyResponseV1 {
  return Boolean(
    fields.learningReflection.trim()
    && fields.systemReflection.trim()
    && fields.aiHelpfulness
    && fields.systemUsability
    && fields.reuseIntention,
  );
}

function completedFieldCount(fields: SurveyFields): number {
  return [
    fields.learningReflection.trim(),
    fields.systemReflection.trim(),
    fields.aiHelpfulness,
    fields.systemUsability,
    fields.reuseIntention,
  ].filter(Boolean).length;
}

function isHeuristicPrompt(value: string): boolean {
  return /[？?]$/.test(value.trim());
}

function ReflectionPromptHints({ items }: { items: string[] }) {
  return (
    <details className="mt-2 rounded-lg border border-stone-100 bg-stone-50/60 px-2.5 py-1.5 text-[11px] text-stone-500">
      <summary className="cursor-pointer list-none font-semibold text-stone-400">需要一点思路？</summary>
      <ul className="mt-1.5 space-y-1 border-t border-stone-100 pt-1.5 leading-5">
        {items.map((item) => <li key={item}>· {item}</li>)}
      </ul>
    </details>
  );
}

function LegacyReflectionStudentView({ course }: { course: Course }) {
  const session = useSession();
  const studentId = session.studentId ?? "";
  const studentName = session.studentName ?? session.user.name;
  const existingReflection = useMemo(
    () => latestReflection(course.reflections, studentId),
    [course.reflections, studentId],
  );
  const existingSurvey = useMemo(
    () => normalizeReflectionSurvey(existingReflection?.survey),
    [existingReflection?.survey],
  );
  const [fields, setFields] = useState<SurveyFields>(() => draftFromReflection(existingReflection));
  const [saved, setSaved] = useState(Boolean(existingSurvey));
  const [submitted, setSubmitted] = useState(Boolean(existingSurvey));
  // Keep the server record id locally as soon as a submission succeeds. This
  // makes a second click/update use the same record even before realtime
  // hydration delivers the updated course object.
  const [reflectionId, setReflectionId] = useState(existingReflection?.id);
  const [lastSavedAt, setLastSavedAt] = useState(existingSurvey ? existingReflection?.updatedAt : undefined);
  const [generatingPrompts, setGeneratingPrompts] = useState(false);
  const [generatedSuggestions, setGeneratedSuggestions] = useState<string[]>();
  const automaticGenerationKey = useRef<string | null>(null);
  const canEdit = course.status !== "finished";
  const complete = isComplete(fields);
  const completedCount = completedFieldCount(fields);
  const statusLabel = !canEdit
    ? submitted ? "反思已提交 · 课程已结束" : "课程已结束 · 未提交"
    : submitted && !saved
      ? "有修改待重新提交"
      : submitted
        ? "反思已提交"
        : complete
          ? "5/5 已完成，待提交"
          : `${completedCount}/5 已完成`;

  const project = useMemo(
    () => course.groups?.find((group) => group.members.some((member) => member.studentId === studentId)),
    [course.groups, studentId],
  );
  const savedSuggestions = useMemo(
    () => (course.aiSupports ?? [])
      .filter((support) =>
        support.kind === "reflection-evidence"
        && support.studentId === studentId,
      )
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
      ?.suggestions.slice(0, 2),
    [course.aiSupports, studentId],
  );
  const suggestions = (generatedSuggestions?.length ? generatedSuggestions : undefined)
    ?? (savedSuggestions?.length ? savedSuggestions : undefined)
    ?? [...REFLECTION_SURVEY_FALLBACK_SUGGESTIONS];

  function updateText(key: "learningReflection" | "systemReflection", value: string) {
    setFields((current) => ({
      ...current,
      [key]: value.slice(0, REFLECTION_SURVEY_TEXT_MAX_LENGTH),
    }));
    setSaved(false);
  }

  function updateScore(key: "aiHelpfulness" | "systemUsability" | "reuseIntention", value: ReflectionSurveyScore) {
    setFields((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  const generatePrompts = useCallback(async () => {
    if (!studentId || !course || !canEdit) return;
    setGeneratingPrompts(true);
    try {
      const draft = await buildReflectionEvidencePrompts({
        course,
        group: project,
        studentId,
        format: "compact",
      });
      const support = session.upsertAiSupport({
        ...draft,
        courseId: course.id,
        studentName,
      });
      const heuristicSuggestions = support?.suggestions
        .filter((suggestion) => typeof suggestion === "string" && isHeuristicPrompt(suggestion))
        .slice(0, 2);
      if (heuristicSuggestions?.length === 2) {
        setGeneratedSuggestions(heuristicSuggestions);
      } else {
        throw new Error("AI 未返回两条问句提示，已切换为固定提示。");
      }
    } catch (error) {
      // The fixed prompts remain available, so an unavailable model never
      // prevents a student from completing the short survey.
      setGeneratedSuggestions([...REFLECTION_SURVEY_FALLBACK_SUGGESTIONS]);
      toast.error("AI 反思提示暂时不可用", {
        description: error instanceof Error ? error.message : "已显示固定提示，可继续填写。",
      });
    } finally {
      setGeneratingPrompts(false);
    }
  }, [canEdit, course, project, session, studentId, studentName]);

  useEffect(() => {
    if (!studentId || !canEdit) return;
    const key = `${course.id}:${studentId}`;
    if (automaticGenerationKey.current === key) return;
    automaticGenerationKey.current = key;
    void generatePrompts();
  }, [canEdit, course.id, generatePrompts, studentId]);

  function submit() {
    if (!studentId || !canEdit || !complete) return;
    const survey: ReflectionSurveyResponseV1 = {
      schemaVersion: 1,
      learningReflection: fields.learningReflection.trim(),
      systemReflection: fields.systemReflection.trim(),
      aiHelpfulness: fields.aiHelpfulness,
      systemUsability: fields.systemUsability,
      reuseIntention: fields.reuseIntention,
    };
    const savedReflection = session.upsertReflection({
      id: reflectionId,
      content: reflectionToLegacyContent(survey),
      survey,
      studentName,
    });
    if (savedReflection) setReflectionId(savedReflection.id);
    session.updateStudentProgress("reflection", 100);
    const now = new Date().toISOString();
    const wasSubmitted = submitted;
    setSubmitted(true);
    setLastSavedAt(now);
    setSaved(true);
    toast.success(wasSubmitted ? "反思已更新" : "反思已提交", {
      description: "教师可以查看你的回答。",
    });
  }

  if (!studentId) {
    return <Card className="text-center text-sm text-stone-500">请先以学生身份进入课堂。</Card>;
  }

  return (
    <div className="classroom-stage space-y-5">
      <StagePageHeader
        status={<Pill tone={!canEdit || submitted ? "green" : complete ? "blue" : "gray"}>{statusLabel}</Pill>}
        title="学习反思"
        variant="student-card"
      />

      <section className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Card className="border-[var(--pbl-student-border)] shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-100 pb-4">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-bold"><BookOpenCheck size={19} />学习反思问卷</h2>
            </div>
            <Pill size="sm" tone={complete ? "green" : "gray"}>{completedCount}/5 已完成</Pill>
          </div>

          <div className="mt-5 space-y-5">
            <label className="block">
              <span className="mb-1.5 block text-sm font-bold">1. {REFLECTION_SURVEY_QUESTIONS.learningReflection} <span className="text-rose-600">*</span></span>
              <TextArea
                aria-label={REFLECTION_SURVEY_QUESTIONS.learningReflection}
                className="min-h-28"
                disabled={!canEdit}
                maxLength={REFLECTION_SURVEY_TEXT_MAX_LENGTH}
                onChange={(event) => updateText("learningReflection", event.target.value)}
                placeholder={REFLECTION_SURVEY_QUESTIONS.learningReflection}
                required
                value={fields.learningReflection}
              />
              <span className="mt-1 block text-right text-xs text-stone-400">{fields.learningReflection.length}/{REFLECTION_SURVEY_TEXT_MAX_LENGTH}</span>
              <ReflectionPromptHints items={["哪个时刻让你发现自己真正学会了什么？", "最难推进的是哪一步？你如何处理？", "这次困难有没有改变你的做法？"]} />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-bold">2. {REFLECTION_SURVEY_QUESTIONS.systemReflection} <span className="text-rose-600">*</span></span>
              <TextArea
                aria-label={REFLECTION_SURVEY_QUESTIONS.systemReflection}
                className="min-h-24"
                disabled={!canEdit}
                maxLength={REFLECTION_SURVEY_TEXT_MAX_LENGTH}
                onChange={(event) => updateText("systemReflection", event.target.value)}
                placeholder={REFLECTION_SURVEY_QUESTIONS.systemReflection}
                required
                value={fields.systemReflection}
              />
              <span className="mt-1 block text-right text-xs text-stone-400">{fields.systemReflection.length}/{REFLECTION_SURVEY_TEXT_MAX_LENGTH}</span>
              <ReflectionPromptHints items={["AI 的哪次参与真正帮助你推进？", "有没有一条建议你没有采纳？为什么？", "下一轮课程或系统最值得调整什么？"]} />
            </label>

            <div className="space-y-4">
              {SCALE_FIELDS.map(({ key, label }, index) => (
                <fieldset className="rounded-xl border border-stone-200 p-3" key={key}>
                  <legend className="px-1 text-sm font-bold">{index + 3}. {label} <span className="text-rose-600">*</span></legend>
                  <RadioGroup.Root
                    aria-label={label}
                    className="mt-3 grid grid-cols-5 gap-1.5 sm:gap-2"
                    disabled={!canEdit}
                    onValueChange={(value) => {
                      const option = REFLECTION_SURVEY_SCALE.find((item) => String(item.value) === value);
                      if (option) updateScore(key, option.value);
                    }}
                    value={fields[key] ? String(fields[key]) : undefined}
                  >
                    {REFLECTION_SURVEY_SCALE.map((option) => (
                      <RadioGroup.Item
                        aria-label={`${label}：${option.value}分，${option.label}`}
                        className="relative flex min-h-10 cursor-pointer flex-col items-center justify-center rounded-lg border border-stone-200 px-1 py-1.5 text-center text-[11px] text-stone-600 outline-none transition hover:border-[var(--pbl-student-border)] focus-visible:ring-2 focus-visible:ring-[var(--pbl-student)] data-[state=checked]:border-[var(--pbl-student)] data-[state=checked]:bg-[var(--pbl-student-soft)] data-[state=checked]:font-bold data-[state=checked]:text-[var(--pbl-student)] disabled:cursor-not-allowed disabled:opacity-60"
                        key={option.value}
                        value={String(option.value)}
                      >
                        <span className="text-base font-bold">{option.value}</span>
                        <span className="sr-only">{option.label}</span>
                        <RadioGroup.Indicator className="absolute inset-0 rounded-lg ring-1 ring-inset ring-[var(--pbl-student)]" />
                      </RadioGroup.Item>
                    ))}
                  </RadioGroup.Root>
                  <div className="mt-1 flex justify-between text-[10px] text-stone-400"><span>1 · 非常不同意</span><span>5 · 非常同意</span></div>
                </fieldset>
              ))}
            </div>
          </div>

          <div className="mt-5 grid gap-3 border-t border-stone-100 pt-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
            <div className="text-xs text-stone-500">
              {lastSavedAt && saved ? <span className="inline-flex items-center gap-1"><CheckCircle2 className="text-emerald-600" size={14} />最近提交：{new Date(lastSavedAt).toLocaleString("zh-CN")}</span> : submitted && !saved ? "已修改，点击更新学习反思后生效" : "完成所有项目后即可提交"}
            </div>
            <p className="text-center text-[11px] leading-5 text-stone-400">* 回答将仅用于教学计划改进和本课程实验分析。</p>
            <PrimaryButton className="sm:justify-self-end" disabled={!canEdit || !complete} onClick={submit} size="md" tone="teal">
              <Send size={16} />{submitted ? "更新学习反思" : "提交学习反思"}
            </PrimaryButton>
          </div>
          {!canEdit ? <p className="mt-3 text-xs text-stone-500">课程已结束，反思内容仅供查看。</p> : null}
        </Card>

        <Card className="classroom-panel border-[var(--pbl-border)] bg-[var(--pbl-surface)] xl:sticky xl:top-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-base font-bold"><BookOpenCheck className="text-[var(--pbl-student)]" size={18} />反思提示</h2>
            </div>
            <button
              aria-label="换一组反思提示"
              className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--pbl-border)] bg-white px-2.5 py-1.5 text-xs font-semibold text-[var(--pbl-text-muted)] transition hover:border-[var(--pbl-student-border)] hover:text-[var(--pbl-student)] disabled:cursor-wait disabled:opacity-60"
              disabled={generatingPrompts || !canEdit}
              onClick={() => void generatePrompts()}
              type="button"
            >
              <RefreshCw size={13} />{generatingPrompts ? "生成中…" : "换一组"}
            </button>
          </div>
          <ol className="mt-4 space-y-3">
            {suggestions.slice(0, 2).map((suggestion, index) => (
              <li className="flex gap-2.5 rounded-[var(--radius-sm)] border border-[var(--pbl-border)] bg-[var(--pbl-surface-soft)] p-3 text-sm leading-6 text-stone-700" key={`${suggestion}-${index}`}>
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-[var(--pbl-student-soft)] text-[10px] font-bold text-[var(--pbl-student)]">{index + 1}</span>
                <span>{suggestion}</span>
              </li>
            ))}
          </ol>
        </Card>
      </section>

    </div>
  );
}

export function NewReflectionStudentView({ course }: { course: Course }) {
  const set = course.content.stagePlan?.reflectionQuestionSet;
  return set?.questions.length ? <CourseReflectionForm key={`${course.id}:${set.id}:${set.version}`} course={course} /> : <LegacyReflectionStudentView course={course} />;
}
