"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  Download,
  FileText,
  Lightbulb,
  MessageSquareText,
  Sparkles,
} from "lucide-react";
import { Avatar } from "@/components/dashboard-shell";
import {
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Pill,
  PrimaryButton,
} from "@/components/ui";
import type {
  AiSupportRecord,
  Course,
  ReflectionRecord,
  ReflectionSummaryCategory,
  ReflectionSummaryTerm,
  ReflectionSurveyResponseV1,
} from "@/lib/session/types";
import {
  REFLECTION_SURVEY_SCALE,
  latestReflectionByStudent,
  normalizeReflectionSurvey,
  reflectionSurveyAverage,
  reflectionSurveyDistribution,
} from "@/lib/reflection-survey";
import {
  REFLECTION_SUMMARY_CATEGORY_DEFINITIONS,
  normalizeReflectionClassSummary,
  reflectionClassSummaryIsStale,
} from "@/lib/reflection-summary";
import { StagePageHeader } from "@/components/classroom/classroom-ui";
import { ReflectionWordCloud } from "./reflection-word-cloud";
import type { TeacherStageFocus } from "@/lib/classroom/teacher-dashboard-metrics";

const SCORE_FIELDS: Array<{
  key: "aiHelpfulness" | "systemUsability" | "reuseIntention";
  label: string;
}> = [
  { key: "aiHelpfulness", label: "AI 引导帮助" },
  { key: "systemUsability", label: "系统易理解" },
  { key: "reuseIntention", label: "继续使用意愿" },
];

const SCORE_SEGMENT_CLASSES = {
  1: "bg-rose-500",
  2: "bg-orange-300",
  3: "bg-stone-300",
  4: "bg-emerald-300",
  5: "bg-emerald-600",
} as const;

function formatDate(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN");
}

function surveyFor(record?: ReflectionRecord): ReflectionSurveyResponseV1 | undefined {
  return normalizeReflectionSurvey(record?.survey);
}

function latestSummarySupport(course: Course): AiSupportRecord | undefined {
  return (course.aiSupports ?? [])
    .filter((support) => support.kind === "reflection-class-summary" && support.targetType === "course")
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

function shortText(value: string, length = 92): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  const firstSentence = normalized.match(/^.*?[。！？!?；;]/)?.[0] ?? normalized;
  return firstSentence.length > length ? `${firstSentence.slice(0, length)}…` : firstSentence;
}

function SummaryBadge({ course, summary }: { course: Course; summary: ReturnType<typeof normalizeReflectionClassSummary> }) {
  const stale = reflectionClassSummaryIsStale(summary, course);
  if (!summary) return <Pill tone="gray">达到 20% 提交后生成 AI 洞察</Pill>;
  return <Pill tone={stale ? "orange" : "violet"}>{stale ? "有新反思待更新" : `基于 ${summary.responseCount} 份反思 · 第 ${summary.coverageBucket}% 档`}</Pill>;
}

function InsightCard({
  category,
  onSelect,
  seed,
  responseCount,
}: {
  category: ReflectionSummaryCategory;
  onSelect: (term: ReflectionSummaryTerm, category: ReflectionSummaryCategory) => void;
  seed: string;
  responseCount: number;
}) {
  const terms = useMemo(() => category.terms.map((term) => ({
    label: term.label,
    value: new Set(term.sources.map((source) => source.studentId)).size,
  })), [category.terms]);
  return (
    <Card className="overflow-hidden border-stone-200/80 shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-stone-100 pb-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-stone-900"><Sparkles className="text-violet-600" size={17} />{category.title}</h2>
          <p className="mt-1 text-xs leading-5 text-stone-500">{category.summary}</p>
        </div>
        <span className="shrink-0 rounded-full bg-stone-100 px-2 py-1 text-[10px] font-semibold text-stone-500">{terms.length ? `${terms.length} 个主题` : "待形成共识"}</span>
      </div>
      <div className="mt-3">
        <ReflectionWordCloud
          onSelect={(term) => {
            const source = category.terms.find((item) => item.label === term.label);
            if (source) onSelect(source, category);
          }}
          seed={seed}
          terms={terms}
        />
      </div>
      <p className="mt-2 text-[11px] text-stone-400">基于 {responseCount} 份反思</p>
    </Card>
  );
}

export function NewReflectionTeacherView({ course, focus }: { course: Course; focus?: Extract<TeacherStageFocus, { stageKey: "reflection" }> }) {
  const [selectedStudentId, setSelectedStudentId] = useState<string>();
  const [selectedTerm, setSelectedTerm] = useState<{ category: ReflectionSummaryCategory; term: ReflectionSummaryTerm }>();
  const [localSummary, setLocalSummary] = useState<{ courseId: string; support: AiSupportRecord }>();
  const [studentQuery, setStudentQuery] = useState("");
  const [studentFilter, setStudentFilter] = useState<"all" | "pending" | "low-score">("all");
  const latest = useMemo(() => latestReflectionByStudent(course.reflections), [course.reflections]);
  const submitted = useMemo(
    () => course.students
      .map((student) => ({ student, reflection: latest.get(student.id) }))
      .map((item) => ({ ...item, survey: surveyFor(item.reflection) }))
      .filter((item) => Boolean(item.survey)),
    [course.students, latest],
  );
  const submittedRecords = submitted
    .map((item) => item.reflection)
    .filter((reflection): reflection is ReflectionRecord => Boolean(surveyFor(reflection)));
  const submittedCount = submitted.length;
  const exportHref = `/api/courses/${encodeURIComponent(course.id)}/reflections/export`;
  const visibleStudents = useMemo(() => course.students
    .filter((student) => student.name.toLocaleLowerCase().includes(studentQuery.trim().toLocaleLowerCase()))
    .filter((student) => {
      const survey = surveyFor(latest.get(student.id));
      if (studentFilter === "pending") return !survey;
      if (studentFilter === "low-score") return Boolean(survey && [survey.aiHelpfulness, survey.systemUsability, survey.reuseIntention].some((score) => score <= 2));
      return true;
    }), [course.students, latest, studentFilter, studentQuery]);

  const focusedStudentId = focus?.studentId;
  const focusedStudent = course.students.find((student) => student.id === focusedStudentId);
  const focusedSurvey = focusedStudentId ? surveyFor(latest.get(focusedStudentId)) : undefined;
  const focusKey = JSON.stringify([focus?.filter, focusedStudentId, focusedStudent?.name, Boolean(focusedSurvey)]);
  const [appliedFocusKey, setAppliedFocusKey] = useState("");
  if (focusKey !== appliedFocusKey) {
    setAppliedFocusKey(focusKey);
    if (focus) {
      setStudentFilter(focus.filter);
      if (focusedStudentId) {
        if (focusedStudent) setStudentQuery(focusedStudent.name);
        setSelectedStudentId(focusedSurvey ? focusedStudentId : undefined);
      }
    }
  }
  useEffect(() => {
    if (!focusedStudentId) return;
    const timer = window.setTimeout(() => document.getElementById(`reflection-student-${focusedStudentId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
    return () => window.clearTimeout(timer);
  }, [focusedStudentId]);
  useEffect(() => {
    const onSummaryUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ courseId?: string; support?: AiSupportRecord }>).detail;
      if (detail?.courseId === course.id && detail.support) setLocalSummary({ courseId: course.id, support: detail.support });
    };
    window.addEventListener("openpbl:reflection-summary-updated", onSummaryUpdated);
    return () => window.removeEventListener("openpbl:reflection-summary-updated", onSummaryUpdated);
  }, [course.id]);
  const storedSummarySupport = latestSummarySupport(course);
  const summarySupport = [
    localSummary?.courseId === course.id ? localSummary.support : undefined,
    storedSummarySupport,
  ].filter((item): item is AiSupportRecord => Boolean(item)).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  const summary = useMemo(
    () => normalizeReflectionClassSummary(summarySupport?.structuredPayload, new Set(course.students.map((student) => student.id))),
    [course.students, summarySupport?.structuredPayload],
  );
  const studentSummaries = useMemo(
    () => new Map((summary?.studentSummaries ?? []).map((item) => [item.studentId, item.summary])),
    [summary?.studentSummaries],
  );
  const categories = useMemo(() => REFLECTION_SUMMARY_CATEGORY_DEFINITIONS.map((definition) => (
    summary?.categories.find((category) => category.key === definition.key) ?? {
      key: definition.key,
      title: definition.title,
      summary: "当前反思中尚未形成明确共识",
      terms: [],
    }
  )), [summary]);
  const selectedStudent = selectedStudentId ? course.students.find((student) => student.id === selectedStudentId) : undefined;
  const selectedReflection = selectedStudent ? latest.get(selectedStudent.id) : undefined;
  const selectedSurvey = surveyFor(selectedReflection);

  return (
    <div className="classroom-stage space-y-5">
      <StagePageHeader
        action={<PrimaryButton disabled={!submittedCount} onClick={() => { window.location.href = exportHref; }} size="sm" tone="blue"><Download size={15} />导出 CSV</PrimaryButton>}
        status={<SummaryBadge course={course} summary={summary} />}
        title="学习反思与课程洞察"
      />

      <section className="grid gap-4 md:grid-cols-2" aria-label="AI 反思洞察">
        {categories.map((category) => (
          <InsightCard
            category={category}
            key={category.key}
            onSelect={(term, selectedCategory) => setSelectedTerm({ category: selectedCategory, term })}
            responseCount={summary?.responseCount ?? 0}
            seed={`${course.id}:${category.key}:${summary?.generatedAt ?? "empty"}`}
          />
        ))}
      </section>

      <Card className="border-stone-200/80 shadow-sm">
        <div className="flex flex-col gap-3 border-b border-stone-100 pb-4 sm:flex-row sm:items-start sm:justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold"><BarChart3 className="text-stone-500" size={19} />量表分布</h2>
          <Pill tone={submittedCount ? "green" : "gray"}>{submittedCount ? "逐生证据" : "暂无有效回答"}</Pill>
        </div>
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2" aria-label="量表颜色图例">
          {REFLECTION_SURVEY_SCALE.map((option) => (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-stone-500" key={option.value}>
              <span className={`size-2.5 rounded-sm ${SCORE_SEGMENT_CLASSES[option.value]}`} />
              {option.value} {option.label}
            </span>
          ))}
        </div>
        <div className="mt-5 space-y-4">
          {SCORE_FIELDS.map(({ key, label }) => {
            const distribution = reflectionSurveyDistribution(submittedRecords, key);
            const scoreCount = Object.values(distribution).reduce((sum, count) => sum + count, 0);
            const average = reflectionSurveyAverage(submittedRecords, key);
            const negativePercent = scoreCount ? Math.round((distribution[1] + distribution[2]) / scoreCount * 100) : 0;
            const neutralPercent = scoreCount ? Math.round(distribution[3] / scoreCount * 100) : 0;
            const positivePercent = scoreCount ? Math.max(0, 100 - negativePercent - neutralPercent) : 0;
            return (
              <section className="rounded-xl border border-stone-200 bg-stone-50/55 px-4 py-4" key={key}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-bold text-stone-800">{label}</h3>
                    <p className="mt-1 text-xs text-stone-400">{scoreCount ? `${scoreCount} 份回答` : "等待有效回答"}</p>
                  </div>
                  <span className="shrink-0 rounded-lg bg-white px-3 py-1.5 text-xs text-stone-500 shadow-sm">均分 <strong className="text-base text-stone-900">{average?.toFixed(1) ?? "—"}</strong> / 5</span>
                </div>
                <div
                  aria-label={`${label}：${REFLECTION_SURVEY_SCALE.map((option) => `${option.value}分${distribution[option.value]}人`).join("、")}`}
                  className="mt-4 flex h-9 overflow-hidden rounded-lg bg-stone-200 ring-1 ring-inset ring-stone-200"
                  role="img"
                >
                  {REFLECTION_SURVEY_SCALE.map((option) => {
                    const count = distribution[option.value];
                    const percent = scoreCount ? count / scoreCount * 100 : 0;
                    return count ? (
                      <div
                        className={`grid min-w-0 place-items-center text-[11px] font-bold ${option.value === 1 || option.value === 5 ? "text-white" : "text-stone-800"} ${SCORE_SEGMENT_CLASSES[option.value]}`}
                        key={option.value}
                        style={{ width: `${percent}%` }}
                        title={`${option.value} 分（${option.label}）：${count} 人，${Math.round(percent)}%`}
                      >
                        {percent >= 14 ? `${option.value}分 · ${count}人` : ""}
                      </div>
                    ) : null;
                  })}
                </div>
                <div className="mt-2 grid grid-cols-3 text-[11px] font-medium">
                  <span className="text-rose-600">不同意 {negativePercent}%</span>
                  <span className="text-center text-stone-500">不确定 {neutralPercent}%</span>
                  <span className="text-right text-emerald-700">同意 {positivePercent}%</span>
                </div>
              </section>
            );
          })}
        </div>
      </Card>

      <Card className="border-stone-200/80 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-bold"><MessageSquareText className="text-[var(--pbl-teacher)]" size={19} />逐生反思摘要</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative"><span className="sr-only">搜索学生</span><input aria-label="搜索反思学生" className="h-9 w-36 rounded-lg border border-stone-200 bg-white px-3 text-xs outline-none focus:border-blue-400" onChange={(event) => setStudentQuery(event.target.value)} placeholder="搜索姓名" value={studentQuery} /></label>
            <select aria-label="筛选反思学生" className="h-9 rounded-lg border border-stone-200 bg-white px-2 text-xs font-semibold text-stone-700" onChange={(event) => setStudentFilter(event.target.value as typeof studentFilter)} value={studentFilter}><option value="all">全部</option><option value="pending">未提交</option><option value="low-score">低分体验</option></select>
            <span className="text-xs text-stone-500">按姓名或状态查看完整回答</span>
          </div>
        </div>
        {course.students.length ? (
          <ul className="grid gap-3 md:grid-cols-2">
            {visibleStudents.map((student) => {
              const reflection = latest.get(student.id);
              const survey = surveyFor(reflection);
              const summaryText = studentSummaries.get(student.id)
                ?? (survey ? shortText(survey.learningReflection) : "尚未提交反思");
              const content = (
                <>
                  <div className="flex items-start gap-3">
                    <Avatar name={student.name} size={36} />
                    <div className="min-w-0 flex-1 text-left">
                      <div className="flex items-center justify-between gap-2">
                        <strong className="truncate text-sm text-stone-900">{student.name}</strong>
                        <Pill size="sm" tone={survey ? "green" : "orange"}>{survey ? "已提交" : "待提交"}</Pill>
                      </div>
                      <p className="mt-2 line-clamp-2 text-xs leading-5 text-stone-600">{summaryText}</p>
                    </div>
                  </div>
                  {survey ? (
                    <div className="mt-3 grid grid-cols-3 gap-1.5 text-[10px]">
                      {SCORE_FIELDS.map(({ key, label }) => <span className="rounded-lg bg-stone-50 px-2 py-1.5 text-center text-stone-500" key={key} title={label}><strong className="block text-sm text-[var(--pbl-teacher)]">{survey[key]}</strong>{label}</span>)}
                    </div>
                  ) : reflection?.content ? <p className="mt-3 text-[11px] text-amber-700">检测到旧版反思记录，尚未包含本阶段问卷数据。</p> : null}
                  {reflection ? <p className="mt-2 text-right text-[10px] text-stone-400">更新于 {formatDate(reflection.updatedAt)}</p> : null}
                </>
              );
              return (
                <li id={`reflection-student-${student.id}`} key={student.id}>
                  {survey ? (
                    <button
                      aria-label={`${student.name}的反思详情`}
                      className="w-full rounded-xl border border-stone-200 bg-white p-3 text-left transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                      onClick={() => setSelectedStudentId(student.id)}
                      type="button"
                    >
                      {content}
                    </button>
                  ) : (
                    <div className="rounded-xl border border-stone-200 bg-white p-3">{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="rounded-lg border border-dashed border-stone-300 py-12 text-center text-sm text-stone-500">暂无学生名单。</div>
        )}
        {course.students.length > 0 && !visibleStudents.length ? <div className="rounded-lg border border-dashed border-stone-300 py-10 text-center text-sm text-stone-500">没有符合当前筛选的学生。</div> : null}
      </Card>

      <Dialog onOpenChange={(open) => { if (!open) setSelectedStudentId(undefined); }} open={Boolean(selectedStudent && selectedSurvey)}>
        <DialogContent className="max-h-[88vh] w-[min(720px,calc(100vw-24px))] max-w-none overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3"><Avatar name={selectedStudent?.name ?? "学生"} size={38} />{selectedStudent?.name ?? "学生"}的完整反思</DialogTitle>
            <DialogDescription>学生编号：{selectedStudent?.id ?? "—"} · 提交于：{formatDate(selectedReflection?.createdAt)} · 最近更新：{formatDate(selectedReflection?.updatedAt)}</DialogDescription>
          </DialogHeader>
          {selectedSurvey ? <SurveyDetail survey={selectedSurvey} /> : null}
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={(open) => { if (!open) setSelectedTerm(undefined); }} open={Boolean(selectedTerm)}>
        <DialogContent className="max-h-[88vh] w-[min(760px,calc(100vw-24px))] max-w-none overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Lightbulb className="text-violet-600" size={18} />{selectedTerm ? `主题“${selectedTerm.term.label}” · ${new Set(selectedTerm.term.sources.map((source) => source.studentId)).size} 名学生` : "主题详情"}</DialogTitle>
            <DialogDescription>{selectedTerm?.category.title}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {selectedTerm?.term.sources.map((source) => {
              const student = course.students.find((item) => item.id === source.studentId);
              const survey = surveyFor(student ? latest.get(student.id) : undefined);
              if (!student || !survey) return null;
              return (
                <article className="rounded-xl border border-stone-200 bg-stone-50/60 p-3" key={`${source.studentId}-${source.fields.join("-")}`}>
                  <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Avatar name={student.name} size={30} /><div><strong className="text-sm text-stone-900">{student.name}</strong><p className="text-[10px] text-stone-400">学生编号：{student.id}</p></div></div><span className="text-[10px] text-stone-400">提交于 {formatDate(latest.get(student.id)?.createdAt)}</span></div>
                  <div className="mt-3 space-y-2">
                    {source.fields.map((field) => <div key={field}><p className="text-[11px] font-semibold text-stone-500">{field === "learningReflection" ? "学习收获与困难" : "AI 协作与课程改进"}</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-stone-700">{survey[field]}</p></div>)}
                  </div>
                  <ScoreChips survey={survey} />
                </article>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ScoreChips({ survey }: { survey: ReflectionSurveyResponseV1 }) {
  return <div className="mt-3 flex flex-wrap gap-1.5">{SCORE_FIELDS.map(({ key, label }) => <span className="rounded-full bg-white px-2 py-1 text-[10px] text-stone-500" key={key}>{label} <strong className="text-stone-800">{survey[key]}/5</strong></span>)}</div>;
}

function SurveyDetail({ survey }: { survey: ReflectionSurveyResponseV1 }) {
  return (
    <div className="grid gap-3 pt-2 lg:grid-cols-2">
      <div className="rounded-lg border border-stone-200 bg-stone-50/60 p-3">
        <p className="flex items-center gap-2 text-xs font-semibold text-stone-600"><FileText size={14} />学习收获与困难</p>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-stone-700">{survey.learningReflection}</p>
      </div>
      <div className="rounded-lg border border-stone-200 bg-stone-50/60 p-3">
        <p className="flex items-center gap-2 text-xs font-semibold text-stone-600"><MessageSquareText size={14} />AI 协作与课程改进</p>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-stone-700">{survey.systemReflection}</p>
      </div>
      <div className="lg:col-span-2"><ScoreChips survey={survey} /></div>
    </div>
  );
}
