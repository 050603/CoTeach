"use client";

import { useState } from "react";
import { BarChart3, BookOpenCheck, ChevronRight, CircleAlert, ListChecks, Users, X } from "lucide-react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, Pill } from "@/components/ui";
import { aggregateKnowledgePointMastery, firstKnowledgeLectureAttempts, knowledgeLectureQuizEstimate } from "@/lib/knowledge-lecture";
import type { Course, StudentAiProgress } from "@/lib/session/types";
import { cn } from "@/lib/utils";
import { inferStageCollectionMode } from "@/lib/system-mode";

type QuestionAnalyticsRow = {
  id: string;
  sectionId: string;
  sectionTitle: string;
  questionNumber: number;
  prompt: string;
  knowledgePointNames: string[];
  answeredStudents: number;
  correctStudents: number;
  accuracy: number;
  commonFeedback?: string;
};

type SectionChartDatum = {
  id: string;
  fullName: string;
  completionRate: number | null;
  averageScore: number | null;
};

function SectionAxisTick({
  x = 0,
  y = 0,
  payload,
}: {
  x?: number;
  y?: number;
  payload?: { index?: number; value?: string };
}) {
  const fullName = payload?.value ?? "";
  const displayName = fullName.length > 8 ? `${fullName.slice(0, 8)}…` : fullName;

  return (
    <g className="cursor-help" transform={`translate(${x},${y})`}>
      <title>{fullName}</title>
      <text fill="#78716c" fontSize="10" textAnchor="middle">
        <tspan fontWeight="700" x="0" y="13">第 {(payload?.index ?? 0) + 1} 节</tspan>
        <tspan fill="#a8a29e" x="0" y="28">{displayName}</tspan>
      </text>
    </g>
  );
}

function SectionChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: SectionChartDatum }>;
}) {
  const section = payload?.[0]?.payload;
  if (!active || !section) return null;

  return (
    <div className="min-w-48 rounded-xl border border-stone-200 bg-white/95 p-3 shadow-xl backdrop-blur-sm">
      <p className="max-w-64 text-xs font-bold leading-5 text-stone-900">{section.fullName}</p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-blue-50 px-2.5 py-2">
          <p className="text-[9px] font-semibold text-blue-600">完成率</p>
          <p className="mt-0.5 text-sm font-bold tabular-nums text-blue-900">{section.completionRate === null ? "暂无" : `${section.completionRate}%`}</p>
        </div>
        <div className="rounded-lg bg-emerald-50 px-2.5 py-2">
          <p className="text-[9px] font-semibold text-emerald-600">平均得分</p>
          <p className="mt-0.5 text-sm font-bold tabular-nums text-emerald-900">{section.averageScore === null ? "暂无" : `${section.averageScore} 分`}</p>
        </div>
      </div>
    </div>
  );
}

export function aggregateQuestionAnalytics(
  course: Course,
  progress: Record<string, StudentAiProgress>,
): QuestionAnalyticsRow[] {
  const sections = new Map((course.content.knowledgeLectureSections ?? []).map((section) => [section.id, section]));
  const pointNames = new Map(course.content.knowledgePoints.map((point) => [point.id, point.name]));
  const accumulators = new Map<string, {
    sectionId: string;
    quizOutlineId: string;
    questionId: string;
    questionNumber: number;
    prompt: string;
    knowledgePointIds: Set<string>;
    answeredStudents: Set<string>;
    correctStudents: Set<string>;
    earned: number;
    maxScore: number;
    feedback: string[];
  }>();

  Object.entries(progress).forEach(([studentId, entry]) => {
    firstKnowledgeLectureAttempts(entry).forEach((attempt) => {
      attempt.questions.forEach((question, questionIndex) => {
        const id = `${attempt.quizOutlineId}:${question.questionId}`;
        const current = accumulators.get(id) ?? {
          sectionId: attempt.sectionId,
          quizOutlineId: attempt.quizOutlineId,
          questionId: question.questionId,
          questionNumber: questionIndex + 1,
          prompt: question.prompt,
          knowledgePointIds: new Set<string>(),
          answeredStudents: new Set<string>(),
          correctStudents: new Set<string>(),
          earned: 0,
          maxScore: 0,
          feedback: [],
        };
        (question.knowledgePointIds.length ? question.knowledgePointIds : attempt.knowledgePointIds)
          .forEach((knowledgePointId) => current.knowledgePointIds.add(knowledgePointId));
        current.answeredStudents.add(studentId);
        current.earned += question.earned;
        current.maxScore += question.points;
        if (question.correct === true || (question.points > 0 && question.earned / question.points >= 0.8)) {
          current.correctStudents.add(studentId);
        } else if (question.feedback.trim()) {
          current.feedback.push(question.feedback.trim());
        }
        accumulators.set(id, current);
      });
    });
  });

  return [...accumulators.entries()].map(([id, item]) => ({
    id,
    sectionId: item.sectionId,
    sectionTitle: sections.get(item.sectionId)?.title ?? "知识讲授小测",
    questionNumber: item.questionNumber,
    prompt: item.prompt,
    knowledgePointNames: [...item.knowledgePointIds].map((knowledgePointId) => pointNames.get(knowledgePointId) ?? knowledgePointId),
    answeredStudents: item.answeredStudents.size,
    correctStudents: item.correctStudents.size,
    accuracy: item.maxScore > 0 ? Math.round(item.earned / item.maxScore * 100) : 0,
    commonFeedback: item.feedback[0],
  })).sort((left, right) => {
    const leftOrder = sections.get(left.sectionId)?.order ?? 0;
    const rightOrder = sections.get(right.sectionId)?.order ?? 0;
    return leftOrder - rightOrder || left.questionNumber - right.questionNumber;
  });
}

export function KnowledgeLectureAnalytics({
  course,
  progressOverride,
  studentCountOverride,
  showSectionSummaryChart = true,
  title = "节末小测实时学情",
}: {
  course: Course;
  progressOverride?: Record<string, StudentAiProgress>;
  studentCountOverride?: number;
  showSectionSummaryChart?: boolean;
  title?: string;
}) {
  const progress = progressOverride ?? course.aiLearningProgress ?? {};
  const studentCount = studentCountOverride ?? course.students.length;
  const sections = course.content.knowledgeLectureSections ?? [];
  const rows = aggregateKnowledgePointMastery(course, progress);
  const questionRows = aggregateQuestionAnalytics(course, progress);
  const answeredStudentIds = Object.entries(progress).flatMap(([studentId, entry]) =>
    firstKnowledgeLectureAttempts(entry).length ? [studentId] : [],
  );
  const attempts = Object.values(progress).flatMap(firstKnowledgeLectureAttempts);
  const averageScore = attempts.length
    ? Math.round(attempts.reduce((sum, attempt) => sum + (attempt.maxScore > 0 ? attempt.score / attempt.maxScore : 0), 0) / attempts.length * 100)
    : 0;
  const isNewSystem = inferStageCollectionMode(course.stages) === "new";
  const [selectedSectionId, setSelectedSectionId] = useState<string>();
  const [knowledgePointTooltip, setKnowledgePointTooltip] = useState<{ name: string; x: number; y: number }>();
  const selectedSection = sections.find((section) => section.id === selectedSectionId);
  const selectedQuestionRows = questionRows.filter((question) => question.sectionId === selectedSectionId);
  const sectionChartData: SectionChartDatum[] = sections.map((section) => {
    const attempts = Object.entries(progress).flatMap(([studentId, entry]) => firstKnowledgeLectureAttempts(entry)
      .filter((attempt) => attempt.sectionId === section.id)
      .map((attempt) => ({ studentId, attempt })));
    const averageScore = attempts.length
      ? Math.round(attempts.reduce((sum, item) => sum + (item.attempt.maxScore > 0 ? item.attempt.score / item.attempt.maxScore : 0), 0) / attempts.length * 100)
      : null;
    return {
      id: section.id,
      fullName: section.title,
      completionRate: studentCount > 0 ? Math.round(new Set(attempts.map((item) => item.studentId)).size / studentCount * 100) : null,
      averageScore,
    };
  });

  return (
    <Card className="overflow-hidden p-0">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-100 bg-white px-4 py-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="grid size-9 place-items-center rounded-[10px] bg-[var(--pbl-teacher)] text-white"><BarChart3 size={17} /></span>
            <div><h3 className="text-base font-bold text-stone-950">{title}</h3><p className="mt-0.5 text-xs text-stone-500">按 AI 逐题得分归集到对应知识点，学生提交后实时更新</p></div>
          </div>
        </div>
        {isNewSystem ? <span className="max-w-[12rem] text-right text-[10px] leading-4 text-stone-400">右栏展示班级摘要；此处查看知识点、分节和逐题证据</span> : <div className="flex flex-wrap gap-2 text-xs font-bold"><span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-stone-700 ring-1 ring-stone-200"><Users size={13} />已作答 {new Set(answeredStudentIds).size}/{studentCount}</span><span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-[var(--pbl-teacher)] ring-1 ring-[var(--pbl-teacher-border)]"><BookOpenCheck size={13} />班级均分 {attempts.length ? `${averageScore}分` : "—"}</span></div>}
      </header>

      {showSectionSummaryChart && isNewSystem && sectionChartData.length ? <section className="border-b border-stone-100 bg-stone-50/40 px-4 py-4" aria-labelledby="knowledge-section-chart-title">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="text-sm font-bold text-stone-900" id="knowledge-section-chart-title">各小节完成率与均分</h4><p className="mt-0.5 text-[10px] text-stone-500">用轻量趋势线对比完成率和得分；悬浮数据点或标题可查看完整信息。</p></div><div className="flex items-center gap-3 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-[10px] font-semibold text-stone-600 shadow-sm"><span className="inline-flex items-center gap-1.5"><span className="relative h-2 w-4 border-t border-dashed border-blue-500"><span className="absolute -top-1 left-1.5 size-2 rounded-full border-2 border-blue-500 bg-white" /></span>完成率</span><span className="inline-flex items-center gap-1.5"><span className="relative h-2 w-4 border-t-2 border-emerald-500"><span className="absolute -top-1 left-1.5 size-2 rounded-full bg-emerald-500 ring-2 ring-white" /></span>平均得分</span></div></div>
        <div className="mt-3 overflow-x-auto rounded-2xl border border-stone-200/80 bg-white shadow-[0_8px_24px_rgba(28,25,23,0.04)]" role="img" aria-label={sectionChartData.map((item) => `${item.fullName}：完成率${item.completionRate === null ? "暂无" : `${item.completionRate}%`}，均分${item.averageScore === null ? "暂无" : `${item.averageScore}分`}`).join("；")}>
          <div className="h-60 px-2 pb-1 pt-3" style={{ minWidth: `${Math.max(680, sectionChartData.length * 112)}px` }}>
            <ResponsiveContainer height="100%" width="100%">
              <ComposedChart data={sectionChartData} margin={{ top: 8, right: 16, left: -10, bottom: 0 }}>
                <CartesianGrid stroke="#e7e5e4" strokeDasharray="2 6" vertical={false} />
                <XAxis axisLine={false} dataKey="fullName" height={48} interval={0} tick={<SectionAxisTick />} tickLine={false} />
                <YAxis axisLine={false} domain={[0, 100]} fontSize={10} tick={{ fill: "#a8a29e" }} tickFormatter={(value) => `${value}%`} tickLine={false} ticks={[0, 25, 50, 75, 100]} width={42} />
                <Tooltip content={<SectionChartTooltip />} cursor={{ stroke: "#cbd5e1", strokeDasharray: "4 5", strokeWidth: 1 }} />
                <Line activeDot={{ fill: "#ffffff", r: 6, stroke: "#3b82f6", strokeWidth: 3 }} connectNulls={false} dataKey="completionRate" dot={{ fill: "#ffffff", r: 4, stroke: "#3b82f6", strokeWidth: 2 }} name="完成率" stroke="#60a5fa" strokeDasharray="4 5" strokeWidth={1.75} type="monotone" />
                <Line activeDot={{ fill: "#10b981", r: 6, stroke: "#ffffff", strokeWidth: 3 }} connectNulls={false} dataKey="averageScore" dot={{ fill: "#10b981", r: 4, stroke: "#ffffff", strokeWidth: 2 }} name="平均得分" stroke="#10b981" strokeWidth={2.5} type="monotone" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
        <p className="mt-2 text-right text-[9px] text-stone-400">小节较多时可横向滑动查看</p>
        <ul className="sr-only">{sectionChartData.map((item) => <li key={item.id}>{item.fullName}：完成率 {item.completionRate === null ? "暂无数据" : `${item.completionRate}%`}，均分 {item.averageScore === null ? "暂无数据" : `${item.averageScore} 分`}</li>)}</ul>
      </section> : null}

      <div className={cn(
        "grid gap-0 bg-white transition-[grid-template-columns] duration-300",
        selectedSectionId
          ? "min-h-[calc(100dvh-13rem)] xl:grid-cols-[minmax(0,.9fr)_minmax(280px,.75fr)_minmax(420px,1.2fr)]"
          : "xl:grid-cols-[minmax(0,1fr)_minmax(380px,1fr)]",
      )}>
        <section className="border-b border-stone-100 p-4 xl:border-b-0 xl:border-r">
          <div className="mb-3 flex items-center justify-between gap-3"><div><h4 className="text-sm font-bold text-stone-900">知识点未达标率排名</h4><p className="mt-0.5 text-[10px] text-stone-500">未达 80% 人数 ÷ 有效作答人数</p></div><Pill tone={rows.some((row) => row.answeredStudents) ? "orange" : "gray"}>{rows.filter((row) => row.answeredStudents).length} 个有作答</Pill></div>
          <div className="space-y-3">
            {rows.filter((row) => row.answeredStudents).map((row, index) => (
              <article className="grid grid-cols-[28px_minmax(0,1fr)_52px] items-center gap-2" key={row.knowledgePointId}>
                <span className={cn("grid size-7 place-items-center rounded-full text-xs font-bold", index < 3 && row.unmetRate > 0 ? "bg-amber-100 text-amber-900" : "bg-stone-100 text-stone-500")}>{index + 1}</span>
                <div className="min-w-0">
                  <div className="flex items-start justify-between gap-2"><button
                    className="line-clamp-2 cursor-pointer text-left text-xs font-bold leading-5 text-stone-800 underline decoration-transparent underline-offset-4 transition hover:text-[var(--pbl-teacher)] hover:decoration-[var(--pbl-teacher)]"
                    onClick={() => window.dispatchEvent(new CustomEvent("openpbl:recommend-knowledge-point", { detail: { knowledgePointId: row.knowledgePointId } }))}
                    onMouseEnter={(event) => setKnowledgePointTooltip({ name: row.name, x: event.clientX, y: event.clientY })}
                    onMouseLeave={() => setKnowledgePointTooltip(undefined)}
                    onMouseMove={(event) => setKnowledgePointTooltip({
                      name: row.name,
                      x: Math.max(8, Math.min(event.clientX + 12, window.innerWidth - 332)),
                      y: Math.max(8, Math.min(event.clientY + 12, window.innerHeight - 90)),
                    })}
                    title="查看对应补讲 PPT 推荐"
                    type="button"
                  >{row.name}</button><span className="shrink-0 pt-0.5 text-[10px] text-stone-400">{row.incorrectStudents}/{row.answeredStudents} 人未达 80%</span></div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-stone-100"><div className={cn("h-full rounded-full", row.unmetRate >= 50 ? "bg-rose-500" : row.unmetRate >= 30 ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${row.unmetRate}%` }} /></div>
                  <p className="mt-1 text-[9px] text-stone-400">平均失分率 {row.scoreLossRate}% · 覆盖全班 {row.responseCoverage}% · {row.status === "confirmed" ? "已确认共性" : row.status === "observing" ? `观察中，需 ${row.minimumSampleSize} 人作答` : row.status === "collecting" ? `收集中，需 ${row.minimumSampleSize} 人作答` : "未达到共性阈值"}</p>
                </div>
                <strong className={cn("text-right text-sm tabular-nums", row.unmetRate >= 50 ? "text-rose-700" : row.unmetRate >= 30 ? "text-amber-700" : "text-emerald-700")}>{row.unmetRate}%</strong>
              </article>
            ))}
            {!rows.some((row) => row.answeredStudents) ? <div className="grid min-h-36 place-items-center rounded-xl border border-dashed border-stone-200 bg-stone-50 text-center text-sm text-stone-500"><span><CircleAlert className="mx-auto mb-2 text-stone-300" size={23} />等待学生完成第一节小测</span></div> : null}
          </div>
        </section>

        <section className={cn("p-4", selectedSectionId && "border-b border-stone-100 xl:border-b-0 xl:border-r")}>
          <div className="mb-3 flex items-center justify-between gap-3"><div><h4 className="text-sm font-bold text-stone-900">各小节测验情况</h4><p className="mt-0.5 text-[10px] text-stone-500">点击小节查看逐题详情</p></div><Pill tone={sections.length ? "blue" : "gray"}>{sections.length} 节</Pill></div>
          <div className="space-y-2.5">
            {sections.map((section) => {
              const quizEstimate = knowledgeLectureQuizEstimate(course, section);
              const sectionAttempts = Object.values(progress).flatMap((entry) =>
                firstKnowledgeLectureAttempts(entry).filter((attempt) => attempt.sectionId === section.id),
              );
              const average = sectionAttempts.length
                ? Math.round(sectionAttempts.reduce((sum, attempt) => sum + (attempt.maxScore > 0 ? attempt.score / attempt.maxScore : 0), 0) / sectionAttempts.length * 100)
                : undefined;
              const selected = section.id === selectedSectionId;
              return (
                <button aria-expanded={selected} className={cn("w-full rounded-[var(--radius-sm)] border p-3 text-left transition", selected ? "border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] shadow-sm" : "border-stone-200 bg-stone-50/60 hover:border-[var(--pbl-teacher-border)] hover:bg-white")} key={section.id} onClick={() => setSelectedSectionId((current) => current === section.id ? undefined : section.id)} type="button">
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="line-clamp-2 text-xs font-bold leading-5 text-stone-800" title={section.title}>{section.title}</p><p className="mt-1 line-clamp-2 text-[10px] leading-4 text-stone-500">{section.knowledgePointIds.map((id) => course.content.knowledgePoints.find((point) => point.id === id)?.name ?? id).join(" · ")}</p></div><span className="flex shrink-0 items-center gap-1 text-xs font-bold text-[var(--pbl-teacher)]">{average === undefined ? "待作答" : `${average}分`}<ChevronRight className={cn("text-stone-400 transition-transform", selected && "rotate-180 text-[var(--pbl-teacher)]")} size={14} /></span></div>
                  <div className="mt-2 flex items-center justify-between text-[10px] font-semibold text-stone-500"><span>{sectionAttempts.length}/{studentCount} 人完成</span><span>{quizEstimate.questionCount} 题 · 预计 {quizEstimate.estimatedMinutes} 分钟</span></div>
                  <p className={cn("mt-2 border-t pt-2 text-right text-[10px] font-bold", selected ? "border-[var(--pbl-teacher-border)] text-[var(--pbl-teacher)]" : "border-stone-200 text-stone-400")}>{selected ? "再次点击收起题目" : "查看本节每道题"}</p>
                </button>
              );
            })}
            {!sections.length ? <p className="rounded-xl border border-dashed border-stone-200 p-6 text-center text-xs text-stone-500">该课程仍使用旧版单次测验结构，重新生成知识讲授内容后可按小节查看。</p> : null}
          </div>
        </section>

        {selectedSectionId ? (
          <section className="min-w-0 border-l border-stone-100 bg-white p-4" aria-label="所选小节逐题详情">
            <div className="mb-3 flex items-start justify-between gap-3"><div className="min-w-0"><h4 className="flex items-center gap-1.5 text-sm font-bold text-stone-900"><ListChecks size={15} className="text-[var(--pbl-teacher)]" />本节逐题详情</h4><p className="mt-1 truncate text-[10px] font-semibold text-[var(--pbl-teacher)]">{selectedSection?.title}</p></div><button aria-label="收起逐题详情" className="grid size-7 shrink-0 place-items-center rounded-full border border-stone-200 bg-white text-stone-500 hover:border-[var(--pbl-teacher-border)] hover:text-[var(--pbl-teacher)]" onClick={() => setSelectedSectionId(undefined)} type="button"><X size={13} /></button></div>
            <div className="space-y-2.5 pr-1">
              {selectedQuestionRows.map((question) => (
                <article className="rounded-[var(--radius-sm)] border border-stone-200 bg-white p-3" key={question.id}>
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-[10px] font-bold text-[var(--pbl-teacher)]">第 {question.questionNumber} 题</p><p className="mt-1 text-xs font-bold leading-5 text-stone-800">{question.prompt}</p></div><strong className={cn("shrink-0 text-sm tabular-nums", question.accuracy >= 80 ? "text-emerald-700" : question.accuracy >= 60 ? "text-amber-700" : "text-rose-700")}>{question.accuracy}%</strong></div>
                  <p className="mt-1.5 text-[10px] leading-4 text-stone-500">对应知识点：{question.knowledgePointNames.join(" · ") || "未关联"}</p>
                  <div className="mt-2 flex items-center justify-between text-[10px] font-semibold text-stone-500"><span>{question.answeredStudents} 人作答</span><span>{question.correctStudents}/{question.answeredStudents} 人达到 80%</span></div>
                  {question.commonFeedback ? <p className="mt-2 rounded-md bg-rose-50 px-2 py-1.5 text-[10px] leading-4 text-rose-700">典型问题：{question.commonFeedback}</p> : null}
                </article>
              ))}
              {!selectedQuestionRows.length ? <div className="grid min-h-36 place-items-center rounded-xl border border-dashed border-stone-200 bg-white text-center text-sm text-stone-500"><span><CircleAlert className="mx-auto mb-2 text-stone-300" size={23} />本节尚无逐题作答数据</span></div> : null}
            </div>
          </section>
        ) : null}
      </div>
      {knowledgePointTooltip ? <div className="pointer-events-none fixed z-[120] max-w-[320px] rounded-[8px] border border-stone-200 bg-stone-950 px-3 py-2 text-xs font-semibold leading-5 text-white shadow-xl" role="tooltip" style={{ left: knowledgePointTooltip.x, top: knowledgePointTooltip.y }}>{knowledgePointTooltip.name}</div> : null}
    </Card>
  );
}
