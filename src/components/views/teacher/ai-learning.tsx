"use client";

import type { TeacherPresentationMode } from "@/lib/classroom/presentation";
import { StageTaskPresentation } from "./stage-task-presentation";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CircleAlert,
  CircleCheck,
  Eye,
  PauseCircle,
  Settings2,
  X,
} from "lucide-react";
import { Avatar } from "@/components/dashboard-shell";
import { Card, Pill, ProgressBar } from "@/components/ui";
import type { AdaptiveBranchOutline, AdaptiveTriggerEvaluation, Course, LearningEvent, Student, StudentAiProgress } from "@/lib/session/types";
import {
  calculateAdaptiveRemainingBudgetSec,
  eligibleAdaptiveBranches,
  evaluateAdaptiveBranchDecision,
} from "@/lib/adaptive-learning";
import { AiLearningTeacherPreview } from "./ai-learning-preview";
import { StudentLearningDetail, type StudentLearningDetailTab } from "./student-learning-detail";
import { isReliableAiProgress } from "@openmaic/lib/progress/completion-model";
import { aggregateCommonIssues, calculateToleratedDurationSec, isLearningSignalRelevant } from "@/lib/learning-analytics/analyzer";
import { formatLearningContentReference } from "@/lib/learning-analytics/content-reference";
import { cn } from "@/lib/utils";
import { deriveClassroomTimingSnapshot } from "@/lib/classroom/timing";
import { isOpaqueInternalId, userFacingName } from "@/lib/user-facing-labels";
import { ClassInterventionPanel } from "./class-intervention-panel";
import { KnowledgeLectureAnalytics } from "./knowledge-lecture-analytics";
import { firstKnowledgeLectureAttempts } from "@/lib/knowledge-lecture";
import { StagePageHeader } from "@/components/classroom/classroom-ui";
import type { TeacherStageFocus } from "@/lib/classroom/teacher-dashboard-metrics";

export function computeAiLearningProgress(entry?: StudentAiProgress): number {
  if (!entry || !isReliableAiProgress(entry)) return 0;
  if (entry.masteryLevel === "completed" || entry.masteryLevel === "mastered") return 100;
  const completedCount = new Set(entry.completedScenes ?? []).size;
  const reachedCount = Math.max(completedCount, entry.currentSceneIndex);
  return Math.min(99, Math.round((reachedCount / Math.max(1, entry.totalScenes)) * 100));
}

export function summarizeAiLearningStudent(course: Course, student: Student) {
  const events = (course.learningEvents ?? [])
    .filter((event) => event.studentId === student.id && event.stageKey === "ai-learning")
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const effectiveDurationMs = events.reduce(
    (sum, event) => event.type === "heartbeat" && event.visible !== false
      ? sum + Math.max(0, event.durationMs ?? 0)
      : sum,
    0,
  );
  const expectedByScene = new Map<string, number>();
  for (const event of events) {
    if (event.sceneId && typeof event.expectedDurationSec === "number") {
      expectedByScene.set(event.sceneId, calculateToleratedDurationSec({
        expectedDurationSec: event.expectedDurationSec,
        ttsDurationSec: event.ttsDurationSec,
        plannedStudentActivitySec: event.plannedStudentActivitySec,
      }) * 1_000);
    }
  }
  const expectedDurationMs = [...expectedByScene.values()].reduce((sum, value) => sum + value, 0);
  const lastEvent = events.at(-1);
  const signals = (course.learningSignals ?? []).filter(
    (signal) => signal.studentId === student.id
      && signal.stageKey === "ai-learning"
      && signal.status === "open"
      && isLearningSignalRelevant(
        signal,
        course.learningEvents ?? [],
        ["completed", "mastered"].includes(course.aiLearningProgress?.[student.id]?.masteryLevel ?? ""),
      ),
  );
  const quizAttempts = firstKnowledgeLectureAttempts(course.aiLearningProgress?.[student.id]);
  const quizEarned = quizAttempts.reduce((sum, attempt) => sum + attempt.score, 0);
  const quizMaxScore = quizAttempts.reduce((sum, attempt) => sum + attempt.maxScore, 0);
  return {
    student,
    events,
    progress: computeAiLearningProgress(course.aiLearningProgress?.[student.id]),
    effectiveDurationMs,
    expectedDurationMs,
    lastEvent,
    signals,
    hasEvidence: events.length > 0,
    accuracy: quizMaxScore > 0 ? Math.round(quizEarned / quizMaxScore * 100) : undefined,
    answeredQuestions: quizAttempts.reduce((sum, attempt) => sum + attempt.questions.length, 0),
  };
}

export function deriveAiLearningClassMetrics(course: Course) {
  const summaries = course.students.map((student) => summarizeAiLearningStudent(course, student));
  const timedStudents = summaries.filter((summary) => summary.hasEvidence && summary.expectedDurationMs > 0);
  const averageVariance = timedStudents.length
    ? Math.round(timedStudents.reduce((sum, item) =>
        sum + ((item.effectiveDurationMs - item.expectedDurationMs) / item.expectedDurationMs) * 100, 0,
      ) / timedStudents.length)
    : undefined;
  const attempts = Object.values(course.aiLearningProgress ?? {}).flatMap(firstKnowledgeLectureAttempts);
  const earned = attempts.reduce((sum, attempt) => sum + attempt.score, 0);
  const maxScore = attempts.reduce((sum, attempt) => sum + attempt.maxScore, 0);
  return {
    averageProgress: summaries.length
      ? Math.round(summaries.reduce((sum, item) => sum + item.progress, 0) / summaries.length)
      : undefined,
    averageSpeedText: averageVariance === undefined
      ? "暂无数据"
      : averageVariance === 0
        ? "与预期一致"
        : averageVariance < 0
          ? `比预期快 ${Math.abs(averageVariance)}%`
          : `比预期慢 ${averageVariance}%`,
    averageSpeedHelper: averageVariance === undefined
      ? "等待学生产生有效学习记录"
      : "按实际用时与课程预计用时比较",
    classAccuracy: maxScore > 0 ? Math.round(earned / maxScore * 100) : undefined,
    attemptCount: attempts.length,
    summaries,
  };
}

function minutes(ms: number): string {
  return ms < 60_000 ? "<1 分钟" : `${Math.round(ms / 60_000)} 分钟`;
}

function currentScene(events: LearningEvent[]): string {
  const latest = [...events].reverse().find((event) => event.sceneId);
  return latest ? formatLearningContentReference(latest.content, latest.metadata?.sceneTitle?.toString() || "当前学习内容") : "尚未开始";
}

type AdaptiveStatusTone = "muted" | "active" | "ready" | "danger";
const CLASSROOM_TRIGGER_CONDITION_KEYS = new Set(["anchor", "evidence", "score", "time"]);

function adaptiveToneClass(tone: AdaptiveStatusTone): string {
  if (tone === "danger") return "bg-rose-100 text-rose-800";
  if (tone === "active") return "bg-blue-100 text-blue-800";
  if (tone === "ready") return "bg-emerald-100 text-emerald-800";
  return "bg-stone-100 text-stone-600";
}

export function adaptiveResponseStatus(
  progress: StudentAiProgress | undefined,
  planEnabled: boolean,
  pretestRequired = true,
): { label: string; tone: "muted" | "active" | "ready" | "danger" } {
  const state = progress?.adaptiveLearning;
  if (!planEnabled) return { label: "课程未启用", tone: "muted" };
  if (state?.enabled === false) return { label: "个体已关闭", tone: "danger" };
  if (pretestRequired && !state?.pretestCompletedAt) return { label: "等待前测", tone: "muted" };
  const currentRun = [...(state?.branchRuns ?? [])].reverse().find((run) =>
    ["generating", "ready"].includes(run.status),
  );
  if (currentRun?.status === "generating") return { label: "资源准备中", tone: "active" };
  if (currentRun?.status === "ready") return { label: "额外资源学习中", tone: "active" };
  if (state?.branchRuns.some((run) => run.status === "completed")) {
    return { label: "已学习额外资源", tone: "ready" };
  }
  return { label: "监测触发点", tone: "ready" };
}

export function AiLearningTeacherView({
  course,
  onSelectStudent,
  focus,
  presentation = "workspace",
  immersive = false,
}: {
  course: Course;
  presentation?: TeacherPresentationMode;
  immersive?: boolean;
  onSelectStudent?: (id: string) => void;
  focus?: Extract<TeacherStageFocus, { stageKey: "ai-learning" }>;
}) {
  const [selectedStudentId, setSelectedStudentId] = useState<string>();
  const displayContext = `${course.id}:${course.currentStageIndex}:${presentation}`;
  const [previousPresentation, setPreviousPresentation] = useState(displayContext);
  if (previousPresentation !== displayContext) {
    setPreviousPresentation(displayContext);
    setSelectedStudentId(undefined);
  }
  const [studentDetailTab, setStudentDetailTab] = useState<StudentLearningDetailTab>("trajectory");
  const [sortMetric, setSortMetric] = useState<"progress" | "accuracy">("progress");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const hasClassroom = Boolean(course.aiLearningClassroomId);
  const summaries = useMemo(
    () => course.students.map((student) => summarizeAiLearningStudent(course, student)),
    [course],
  );
  const unresolvedSignals = summaries.flatMap((summary) => summary.signals);
  const commonIssues = aggregateCommonIssues(unresolvedSignals, course.students.length);
  const sortedSummaries = useMemo(() => [...summaries].sort((left, right) => {
    const leftValue = sortMetric === "progress" ? left.progress : left.accuracy;
    const rightValue = sortMetric === "progress" ? right.progress : right.accuracy;
    if (leftValue === undefined && rightValue === undefined) return left.student.name.localeCompare(right.student.name, "zh-CN");
    if (leftValue === undefined) return 1;
    if (rightValue === undefined) return -1;
    const difference = leftValue - rightValue;
    return (sortDirection === "asc" ? difference : -difference) || left.student.name.localeCompare(right.student.name, "zh-CN");
  }), [sortDirection, sortMetric, summaries]);

  function openStudent(studentId: string, tab: StudentLearningDetailTab) {
    setStudentDetailTab(tab);
    setSelectedStudentId(studentId);
    onSelectStudent?.(studentId);
  }

  const focusedStudentId = focus?.studentId;
  const focusedTab = focus?.tab;
  const focusKey = JSON.stringify([focusedStudentId, focusedTab]);
  const [appliedFocusKey, setAppliedFocusKey] = useState("");
  // Reset local navigation only when the dashboard requests a different target.
  if (focusKey !== appliedFocusKey) {
    setAppliedFocusKey(focusKey);
    if (presentation === "workspace" && focusedStudentId && focusedTab) {
      setStudentDetailTab(focusedTab);
      setSelectedStudentId(focusedStudentId);
    }
  }
  useEffect(() => {
    if (presentation === "workspace" && focusedStudentId) onSelectStudent?.(focusedStudentId);
  }, [focusedStudentId, focusedTab, onSelectStudent, presentation]);

  return (
    <div className="classroom-stage teacher-presentation-content space-y-5" hidden={presentation === "analytics"}>
      {presentation === "workspace" ? <>
      <StagePageHeader
        description="查看全班进度、小测结果与需要介入的知识点。"
        status={<Pill tone={hasClassroom ? "green" : "amber"}>{hasClassroom ? "课堂运行中" : "待生成课堂"}</Pill>}
        title="知识讲授学情"
      />
      {!hasClassroom ? (
        <Card className="border-[var(--pbl-warning-soft)] bg-[var(--pbl-warning-soft)]/70">
          <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 text-[var(--pbl-warning)]" size={21} /><div><h3 className="font-bold text-[var(--pbl-warning)]">知识讲授课堂尚未生成</h3><p className="mt-1 text-sm text-[var(--pbl-warning)]">完成备课生成后，教师可以预览课程并查看真实学习数据。</p></div></div>
        </Card>
      ) : null}

      </> : null}
      {hasClassroom ? <AiLearningTeacherPreview course={course} presentation={presentation} workspacePreviewEnabled={!immersive} /> : presentation === "teaching" ? <StageTaskPresentation course={course} /> : null}
      {presentation === "workspace" ? <>

      <KnowledgeLectureAnalytics course={course} showSectionSummaryChart={!immersive} title="全班知识讲授学情" />

      <ClassInterventionPanel commonIssues={commonIssues} course={course} />

      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-100 px-4 py-3">
          <div>
            <h3 className="text-base font-bold">学生学习情况</h3>
            <p className="mt-0.5 text-xs text-stone-500">点击头像或进度查看学习轨迹，点击答题数据查看逐题作答</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor={`student-sort-${course.id}`}>学生排序指标</label>
            <select className="h-9 rounded-[8px] border border-stone-200 bg-white px-2.5 text-xs font-bold text-stone-700 outline-none focus:border-[var(--pbl-teacher)]" id={`student-sort-${course.id}`} onChange={(event) => setSortMetric(event.target.value as "progress" | "accuracy")} value={sortMetric}>
              <option value="progress">按学习进度</option>
              <option value="accuracy">按答题准确率</option>
            </select>
            <button aria-label={sortDirection === "asc" ? "当前正序，点击改为倒序" : "当前倒序，点击改为正序"} className="inline-flex h-9 items-center gap-1 rounded-[8px] border border-stone-200 bg-white px-2.5 text-xs font-bold text-stone-700 hover:border-[var(--pbl-teacher-border)]" onClick={() => setSortDirection((value) => value === "asc" ? "desc" : "asc")} type="button">
              {sortDirection === "asc" ? <ArrowUp size={14} /> : <ArrowDown size={14} />}{sortDirection === "asc" ? "正序" : "倒序"}
            </button>
          </div>
        </div>
        {summaries.length ? (
          <ul aria-label="学生状态总览" className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 bg-stone-50/60 p-3">
            {sortedSummaries.map((summary) => (
                <li className="min-w-0 rounded-[10px] border border-stone-200 bg-white p-3 shadow-sm transition hover:border-[var(--pbl-teacher-border)]" key={summary.student.id}>
                  <div className="flex items-center justify-between gap-2">
                    <button aria-label={`查看${summary.student.name}的学习轨迹`} className="flex min-w-0 items-center gap-2 rounded-[7px] text-left focus:outline-none focus:ring-2 focus:ring-[var(--pbl-teacher)]" onClick={() => openStudent(summary.student.id, "trajectory")} type="button">
                      <Avatar name={summary.student.name} size={32} />
                      <span className="min-w-0"><span className="block truncate text-sm font-bold text-stone-900">{summary.student.name}</span><span className="block truncate text-[10px] text-stone-400">{currentScene(summary.events)}</span></span>
                    </button>
                    <button aria-label={`查看${summary.student.name}的学习轨迹，当前进度${summary.progress}%`} className="shrink-0 rounded-md px-1.5 py-1 text-sm font-bold tabular-nums text-[var(--pbl-teacher)] hover:bg-[var(--pbl-teacher-soft)]" onClick={() => openStudent(summary.student.id, "trajectory")} type="button">{summary.progress}%</button>
                  </div>

                  <button aria-label={`查看${summary.student.name}的学习轨迹与进度`} className="mt-3 block w-full rounded-[8px] p-2 text-left transition hover:bg-[var(--pbl-teacher-soft)] focus:outline-none focus:ring-2 focus:ring-[var(--pbl-teacher)]" onClick={() => openStudent(summary.student.id, "trajectory")} type="button">
                    <ProgressBar className="h-1.5" tone={summary.progress >= 90 ? "green" : "teal"} value={summary.progress} />
                    <span className="mt-2 flex items-center justify-between text-[10px]"><span className="text-stone-400">学习进度 <strong className="ml-1 text-xs text-stone-800">{summary.progress}%</strong></span><span className="text-stone-400">学习时长 <strong className="ml-1 text-xs text-stone-800">{summary.hasEvidence ? minutes(summary.effectiveDurationMs) : "—"}</strong></span></span>
                  </button>
                  <button aria-label={`查看${summary.student.name}的答题详情`} className="mt-2 flex w-full items-center justify-between rounded-[8px] bg-stone-50 px-3 py-2 text-left transition hover:bg-[var(--pbl-surface-soft)] focus:outline-none focus:ring-2 focus:ring-[var(--pbl-teacher)]" onClick={() => openStudent(summary.student.id, "answers")} type="button">
                    <span><span className="block text-[9px] text-stone-400">答题准确率</span><strong className={cn("mt-0.5 block text-xs", summary.accuracy === undefined ? "text-stone-400" : summary.accuracy >= 80 ? "text-emerald-700" : summary.accuracy >= 60 ? "text-amber-700" : "text-rose-700")}>{summary.accuracy === undefined ? "—" : `${summary.accuracy}%`}</strong></span>
                    <span className="text-right"><span className="block text-[9px] text-stone-400">答题数量</span><strong className="mt-0.5 block text-xs text-stone-700">{summary.answeredQuestions} 道</strong></span>
                  </button>
                </li>
              ))}
          </ul>
        ) : <div className="py-12 text-center text-sm text-stone-500"><Eye className="mx-auto mb-2 text-stone-300" size={24} />暂无学生加入课堂</div>}
      </Card>

      <StudentLearningDetail course={course} initialTab={studentDetailTab} key={`${selectedStudentId ?? "none"}:${studentDetailTab}`} onOpenChange={(open) => { if (!open) setSelectedStudentId(undefined); }} open={Boolean(selectedStudentId)} studentId={selectedStudentId} />
      </> : null}
    </div>
  );
}

// Retained temporarily for archived adaptive-course records; the current
// teacher page no longer renders this legacy dialog.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function AdaptiveTriggerAuditDialog({
  course,
  studentId,
  onClose,
  onToggleAdaptive,
}: {
  course: Course;
  studentId?: string;
  onClose: () => void;
  onToggleAdaptive: (studentId: string, patch: { enabled?: boolean }) => void;
}) {
  if (!studentId) return null;
  const student = course.students.find((item) => item.id === studentId);
  const progress = course.aiLearningProgress?.[studentId];
  const adaptive = progress?.adaptiveLearning;
  const plan = course.content.adaptiveLearningPlan;
  const pretestRequired = Boolean(plan?.pretest.questions.length);
  if (!student) return null;

  const evaluations = adaptive?.triggerEvaluations ?? [];
  const eligibleBranches =
    plan ? eligibleAdaptiveBranches(plan, adaptive) : [];
  const classroomTiming = course.uiState?.classroomTiming;
  const runtimeStageRemainingSec =
    classroomTiming?.activeStageKey === "ai-learning"
      ? deriveClassroomTimingSnapshot(
          classroomTiming,
          new Date().toISOString(),
        ).activeStage?.remainingSec
      : undefined;
  const remainingBudgetSec =
    plan
      ? calculateAdaptiveRemainingBudgetSec(
          plan,
          adaptive ?? { branchRuns: [] },
          runtimeStageRemainingSec,
        )
      : 0;
  const auditState =
    adaptive && plan
      ? {
          ...adaptive,
          evidence: [
            ...adaptive.evidence,
            ...evaluations.flatMap((evaluation) => {
              if (
                typeof evaluation.score !== "number"
                || evaluation.scoreSource === "pretest"
                || adaptive.evidence.some((item) =>
                  item.source === "node-quiz"
                  && item.sceneId === evaluation.completedSceneId
                )
              ) {
                return [];
              }
              const branch = plan.branches.find(
                (item) => item.id === evaluation.branchOutlineId,
              );
              return [{
                id: `audit-evidence-${evaluation.id}`,
                source: "node-quiz" as const,
                score: evaluation.score,
                occurredAt: evaluation.evaluatedAt,
                sceneId: evaluation.completedSceneId,
                knowledgePointIds: branch?.anchorKnowledgePointIds ?? [],
              }];
            }),
          ],
        }
      : adaptive;
  const liveEvaluations =
    plan && auditState && (!pretestRequired || auditState.pretestCompletedAt)
      ? eligibleBranches.flatMap((branch) => evaluateAdaptiveBranchDecision({
          plan,
          state: auditState,
          anchorKnowledgePointIds: branch.anchorKnowledgePointIds,
          completedSceneId:
            progress?.completedOutlineIds?.at(-1)
            ?? progress?.completedScenes.at(-1),
          runtimeSceneId: progress?.completedScenes.at(-1),
          remainingBudgetSec,
          candidateBranchIds: [branch.id],
          reachedSceneIds:
            progress?.completedOutlineIds?.length
              ? progress.completedOutlineIds
              : progress?.completedScenes ?? [],
          phase: branch.trigger?.placement === "before-main-course" ? "pre-course" : "after-module",
        }).evaluations)
      : [];
  const response = adaptiveResponseStatus(
    progress,
    Boolean(plan?.enabled && plan.status === "teacher-confirmed"),
    pretestRequired,
  );
  const learnedCount = adaptive?.branchRuns.filter((run) => run.status === "completed").length ?? 0;
  const enabled = adaptive?.enabled !== false;
  const knowledgePointNames = new Map([
    ...course.content.knowledgePoints,
    ...(plan?.prerequisiteKnowledgePoints ?? []),
  ].map((point) => [point.id, point.name]));
  const sceneNames = new Map([
    ...(course.content._openmaicSceneOutlines ?? []),
    ...course.content.lessonOutline,
  ].map((scene) => [scene.id, scene.title]));
  const namesForKnowledgePoints = (ids: string[], fallback: string) => {
    const names = ids.flatMap((id) => {
      const name = knowledgePointNames.get(id)?.trim();
      return name && name !== id && !isOpaqueInternalId(name) ? [name] : [];
    });
    return names.length ? names.join("、") : fallback;
  };
  const sceneTitle = (branch: AdaptiveBranchOutline) => {
    const sceneIds = branch.trigger?.assessmentSceneIds?.length
      ? branch.trigger.assessmentSceneIds
      : branch.trigger?.afterSceneId
        ? [branch.trigger.afterSceneId]
        : [];
    const titles = sceneIds.flatMap((sceneId) => {
      const title = sceneNames.get(sceneId)?.trim();
      return title && title !== sceneId && !isOpaqueInternalId(title) ? [title] : [];
    });
    return titles.length
      ? titles.join(" / ")
      : `${namesForKnowledgePoints(branch.anchorKnowledgePointIds, "对应主课")}达标测`;
  };

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-stone-950/55 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`${student.name}额外资源学习详情`}>
      <div className="flex max-h-[90vh] w-[min(880px,96vw)] flex-col overflow-hidden rounded-[14px] border border-white/20 bg-stone-50 shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-stone-200 bg-white px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xl font-bold text-stone-950">{student.name} · 额外资源学习详情</h3>
              <span className={cn(
                "rounded-full px-2.5 py-1 text-xs font-bold",
                adaptiveToneClass(response.tone),
              )}>{response.label}</span>
            </div>
            <p className="mt-1 text-sm text-stone-500">查看该生是否触发额外资源，以及触发或未触发的直接原因。</p>
          </div>
          <button aria-label="关闭额外资源学习详情" className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-stone-500 hover:bg-stone-100" onClick={onClose} type="button"><X size={18} /></button>
        </header>

        <div className="overflow-y-auto p-5">
          <section aria-label="学生额外资源学习概况" className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-[10px] border border-stone-200 bg-white px-4 py-3 text-xs text-stone-600">
            <LearningSummary label="主课" value={`${computeAiLearningProgress(progress)}%`} />
            <LearningSummary label="先决证据" value={!pretestRequired ? "无需前测" : typeof adaptive?.pretestScore === "number" ? `${adaptive.pretestScore} 分` : "待前测"} />
            <LearningSummary label="已学资源" value={`${learnedCount} 份`} />
            <LearningSummary label="可用时间" value={`${Math.floor(remainingBudgetSec / 60)}分 ${remainingBudgetSec % 60}秒`} />
            <button
              className={cn(
                "ml-auto inline-flex h-8 items-center gap-1.5 rounded-[7px] border px-2.5 text-xs font-bold transition",
                enabled ? "border-rose-200 text-rose-700 hover:bg-rose-50" : "border-emerald-200 bg-emerald-50 text-emerald-700",
              )}
              onClick={() => onToggleAdaptive(student.id, { enabled: !enabled })}
              type="button"
            >
              {enabled ? <PauseCircle size={14} /> : <Settings2 size={14} />}
              {enabled ? "暂停个性化" : "开启个性化"}
            </button>
          </section>

          {!plan?.enabled || plan.status !== "teacher-confirmed" ? (
            <div className="mt-4 rounded-[9px] border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-800">个性化资源编排未启用或尚未由教师确认，额外资源不会插入。</div>
          ) : adaptive?.enabled === false ? (
            <div className="mt-4 rounded-[9px] border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-800">该学生的个体自适应路径已关闭。</div>
          ) : evaluations.length === 0 && (progress?.completedScenes.length ?? 0) > 0 ? (
            <div className="mt-4 rounded-[9px] border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900">
              已有主课学习进度，但暂未产生额外资源触发记录。
            </div>
          ) : null}

          <div className="mt-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h4 className="font-bold text-stone-900">额外资源</h4>
              <span className="text-xs text-stone-500">共 {eligibleBranches.length} 项可匹配资源</span>
            </div>
            <div className="space-y-3">
            {eligibleBranches.map((branch) => {
              const latestRecorded = [...evaluations]
                .filter((evaluation) => evaluation.branchOutlineId === branch.id)
                .sort((a, b) => Date.parse(b.evaluatedAt) - Date.parse(a.evaluatedAt))[0];
              const live = liveEvaluations.find(
                (evaluation) => evaluation.branchOutlineId === branch.id,
              );
              const run = [...(adaptive?.branchRuns ?? [])].reverse().find((item) => item.branchOutlineId === branch.id);
              const prerequisiteNames = namesForKnowledgePoints(
                branch.prerequisiteKnowledgePointIds,
                "关联先决知识",
              );
              const weakPrerequisiteNames = namesForKnowledgePoints(
                branch.prerequisiteKnowledgePointIds.filter((id) =>
                  adaptive?.pretestWeakKnowledgePointIds?.includes(id),
                ),
                prerequisiteNames,
              );
              return (
                <TriggerAuditCard
                  branch={branch}
                  evaluation={live ?? latestRecorded}
                  key={branch.id}
                  pretestRequired={pretestRequired}
                  prerequisiteNames={prerequisiteNames}
                  runStatus={run?.status}
                  sceneTitle={sceneTitle(branch)}
                  weakPrerequisiteNames={weakPrerequisiteNames}
                />
              );
            })}
            {plan?.branches.length && (!pretestRequired || adaptive?.pretestCompletedAt) && !eligibleBranches.length ? (
              <div className="rounded-[9px] border border-dashed border-stone-300 py-12 text-center text-sm text-stone-500">
                当前学习证据没有匹配的额外资源。
              </div>
            ) : null}
            {!plan?.branches.length ? <div className="rounded-[9px] border border-dashed border-stone-300 py-12 text-center text-sm text-stone-500">课程尚未配置额外学习资源。</div> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LearningSummary({ label, value }: { label: string; value: string }) {
  return <span><span className="text-stone-400">{label}</span><strong className="ml-1.5 text-stone-900">{value}</strong></span>;
}

function TriggerAuditCard({
  branch,
  evaluation,
  pretestRequired,
  prerequisiteNames,
  runStatus,
  sceneTitle,
  weakPrerequisiteNames,
}: {
  branch: AdaptiveBranchOutline;
  evaluation?: AdaptiveTriggerEvaluation;
  pretestRequired: boolean;
  prerequisiteNames: string;
  runStatus?: string;
  sceneTitle: string;
  weakPrerequisiteNames: string;
}) {
  const triggered = evaluation?.result === "triggered";
  const classroomConditions = evaluation?.conditions.filter((condition) => CLASSROOM_TRIGGER_CONDITION_KEYS.has(condition.key)) ?? [];
  const passedConditions = classroomConditions.filter((condition) => condition.passed);
  const pendingConditions = classroomConditions.filter((condition) => !condition.passed);
  const hasHiddenBlocker = Boolean(evaluation?.conditions.some((condition) =>
    !CLASSROOM_TRIGGER_CONDITION_KEYS.has(condition.key) && !condition.passed,
  ));
  const runLabel: Record<string, string> = {
    generating: "资源准备中",
    ready: "资源学习中",
    completed: "已完成学习",
    skipped: "已跳过",
    failed: "资源加载失败",
  };
  const kindLabel: Record<AdaptiveBranchOutline["kind"], string> = {
    prerequisite: "先决知识回顾",
    "worked-example": "新例题",
    application: "应用举例",
    extension: "拓展与思考",
  };
  const prerequisite = branch.trigger?.placement === "before-main-course";
  const threshold = branch.trigger?.scoreThreshold;
  const timeRequiredSec = Math.max(branch.targetDurationSec, branch.trigger?.minimumRemainingSec ?? 90);
  const triggerRule = prerequisite
    ? `检测到“${prerequisiteNames}”存在缺口`
    : `达标测${typeof threshold === "number" ? ` ≥ ${threshold} 分` : "达到课程阈值"}，且剩余至少 ${Math.ceil(timeRequiredSec / 60)} 分钟`;
  function readableCondition(condition: AdaptiveTriggerEvaluation["conditions"][number]): { actual: string; expected: string } {
    if (condition.key === "anchor" && !prerequisite) {
      const completedTitle = evaluation?.completedSceneTitle?.trim();
      return {
        actual: condition.passed
          ? completedTitle && completedTitle !== evaluation?.completedSceneId && !isOpaqueInternalId(completedTitle)
            ? `已完成“${completedTitle}”`
            : "已完成对应主课达标测"
          : "尚未到达对应主课达标测",
        expected: `完成“${sceneTitle}”`,
      };
    }
    if (condition.key === "evidence" && prerequisite) {
      return {
        actual: condition.passed
          ? `检测到缺口：“${weakPrerequisiteNames}”`
          : `未检测到“${prerequisiteNames}”缺口`,
        expected: `至少一项先决知识存在缺口：“${prerequisiteNames}”`,
      };
    }
    return { actual: condition.actual, expected: condition.expected };
  }
  function describeExpectedTiming(): string {
    if (runStatus === "completed") return "已完成学习，无需再次触发";
    if (runStatus === "ready") return "已触发，学生正在学习";
    if (runStatus === "generating") return "已触发，资源准备完成后开始";
    if (runStatus) return "已有触发记录，请关注当前资源状态";
    if (triggered) return "条件已满足，可立即触发";
    if (evaluation && pendingConditions.some((condition) => condition.key === "anchor")) {
      return `到达「${sceneTitle}」后自动复核`;
    }
    if (evaluation && pendingConditions.length) {
      return `已到达触发点；${pendingConditions.map((condition) => condition.label).join("、")}满足后自动触发`;
    }
    if (evaluation && hasHiddenBlocker) return "课堂条件已满足，资源可用后自动触发";
    if (prerequisite) return pretestRequired ? "课前测提交后、主课开始前" : "主课开始前";
    return `完成「${sceneTitle}」后，条件满足时`;
  }
  const expectedTiming = describeExpectedTiming();
  const displayStatus = runStatus
    ? runLabel[runStatus] ?? runStatus
    : triggered
      ? "可立即激活"
      : evaluation && hasHiddenBlocker && !pendingConditions.length
        ? "资源暂不可用"
        : evaluation
          ? "条件未满足"
          : "尚未到达";
  return (
    <article className={cn("rounded-[10px] border bg-white px-4 py-3", triggered ? "border-emerald-200" : evaluation ? "border-amber-200" : "border-stone-200")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={branch.kind === "prerequisite" ? "orange" : "blue"}>{kindLabel[branch.kind]}</Pill>
            <span className="text-xs font-semibold text-stone-400">插入位置：{branch.trigger?.placement === "before-main-course" ? "正式主课开始前" : sceneTitle}</span>
          </div>
          <h4 className="mt-1.5 font-bold text-stone-900">{userFacingName(branch.title, "未命名额外资源")}</h4>
        </div>
        <span className={cn("rounded-full px-2.5 py-1 text-xs font-bold", triggered ? "bg-emerald-100 text-emerald-800" : evaluation ? "bg-amber-100 text-amber-900" : "bg-stone-100 text-stone-600")}>
          {displayStatus}
        </span>
      </div>

      {evaluation ? (
        <div className="mt-3 grid gap-2 border-t border-stone-100 pt-3 text-xs sm:grid-cols-[110px_1fr]">
          <span className="font-bold text-stone-400">触发条件</span>
          <span className="font-semibold text-stone-700">{triggerRule}</span>
          <span className="font-bold text-stone-400">当前满足</span>
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {passedConditions.length ? passedConditions.map((condition) => (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 font-semibold text-emerald-800" key={condition.key}><CircleCheck size={12} />{condition.label} · {readableCondition(condition).actual}</span>
            )) : <span className="text-stone-500">暂未满足课堂触发条件</span>}
          </div>
          <span className="font-bold text-stone-400">仍需满足</span>
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {pendingConditions.length ? pendingConditions.map((condition) => (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 font-semibold text-amber-900" key={condition.key}><CircleAlert size={12} />{condition.label} · 当前 {readableCondition(condition).actual} / 需 {readableCondition(condition).expected}</span>
            )) : <span className="font-semibold text-emerald-700">课堂触发条件均已满足</span>}
          </div>
          <span className="font-bold text-stone-400">预计触发</span>
          <span className="text-stone-700">{expectedTiming}</span>
        </div>
      ) : (
        <div className="mt-3 grid gap-2 border-t border-stone-100 pt-3 text-xs sm:grid-cols-[110px_1fr]">
          <span className="font-bold text-stone-400">触发条件</span><span className="font-semibold text-stone-700">{triggerRule}</span>
          <span className="font-bold text-stone-400">当前状态</span><span className="text-stone-500">{pretestRequired ? "等待学生完成前测或到达对应主课节点" : "等待学生到达对应主课节点"}</span>
          <span className="font-bold text-stone-400">预计触发</span><span className="text-stone-700">{expectedTiming}</span>
        </div>
      )}
    </article>
  );
}
