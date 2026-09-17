"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpenCheck, CheckCircle2, Clock3, Loader2 } from "lucide-react";
import type { Scene } from "@openmaic/lib/types/stage";
import {
  StudentStageHost,
  prefetchAdaptiveClassroom,
  type AdaptiveSceneInsertion,
} from "@/components/openmaic-bridge/student-stage-host";
import {
  calculateAdaptiveRemainingBudgetSec,
  calculateKnowledgePointAssessmentScores,
  deriveMasteryAssessmentSceneIds,
  evaluateAdaptiveBranchDecision,
  resolveAdaptiveSceneIdentity,
} from "@/lib/adaptive-learning";
import type {
  AdaptiveAssessmentAnswer,
  AdaptiveBranchOutline,
  AdaptiveBranchRun,
  Course,
  KnowledgeLectureAttempt,
  StudentAdaptiveLearningState,
} from "@/lib/session/types";
import { readSubmittedState } from "@openmaic/lib/quiz/persistence";
import { deriveClassroomTimingSnapshot } from "@/lib/classroom/timing";
import { KnowledgeLectureBoard } from "@/components/views/student/knowledge-lecture-board";
import { toast } from "@/components/ui";
import { KnowledgeLectureQuizLockProvider } from "@/components/openmaic-bridge/knowledge-lecture-quiz-lock";
import { firstKnowledgeLectureAttempts } from "@/lib/knowledge-lecture";

const QUIZ_REVIEWED_EVENT = "openpbl:knowledge-lecture-quiz-reviewed";
const EXPLAIN_QUESTION_EVENT = "openpbl:knowledge-lecture-explain-question";

type QueuedResource = {
  branch: AdaptiveBranchOutline;
  run: Omit<AdaptiveBranchRun, "classroomId"> & { classroomId: string };
  placement: AdaptiveSceneInsertion["placement"];
  anchorSceneId?: string;
};

function hasUnqueuedPrerequisiteGap(
  plan: NonNullable<Course["content"]["adaptiveLearningPlan"]> | undefined,
  state: StudentAdaptiveLearningState,
): boolean {
  if (!plan?.enabled || plan.status !== "teacher-confirmed" || !state.pretestCompletedAt) return false;
  const weakIds = new Set(state.pretestWeakKnowledgePointIds ?? []);
  const queuedBranchIds = new Set(state.branchRuns.map((run) => run.branchOutlineId));
  return plan.branches.some((branch) =>
    branch.enabled !== false
    && branch.trigger?.placement === "before-main-course"
    && !queuedBranchIds.has(branch.id)
    && branch.prerequisiteKnowledgePointIds.some((id) => weakIds.has(id)),
  );
}

export function AdaptiveAiLearningRuntime({
  course,
  classroomId,
  studentId,
  studentName,
  backHref,
  variant = "embedded",
}: {
  course: Course;
  classroomId: string;
  studentId: string;
  studentName: string;
  backHref: string;
  variant?: "embedded" | "fullscreen";
}) {
  const candidatePlan = course.content.adaptiveLearningPlan;
  // Legacy or manually changed plans may contain plausible-looking questions that
  // actually test new lesson content. Only independently reviewed prerequisite
  // boundaries are allowed to alter a student's learning path.
  const plan = candidatePlan?.prerequisiteSemanticReview?.status === "passed"
    ? candidatePlan
    : undefined;
  const initialState = course.aiLearningProgress?.[studentId]?.adaptiveLearning ?? {
    evidence: [],
    branchRuns: [],
    microLessons: [],
  };
  const [adaptiveState, setAdaptiveState] = useState<StudentAdaptiveLearningState>(initialState);
  const [insertedResources, setInsertedResources] = useState<QueuedResource[]>([]);
  const [preCoursePreparing, setPreCoursePreparing] = useState(
    hasUnqueuedPrerequisiteGap(plan, initialState),
  );
  const [preCoursePreparationError, setPreCoursePreparationError] = useState<string>();
  const [reviewAttempt, setReviewAttempt] = useState<{
    attempt: KnowledgeLectureAttempt;
    questionId?: string;
  }>();
  const activeSceneRef = useRef<Scene | undefined>(undefined);
  const lectureAttemptRequestsRef = useRef(new Map<string, Promise<KnowledgeLectureAttempt | undefined>>());
  const restoredPreparationStartedRef = useRef(false);
  const switchingRef = useRef(false);
  const checkpointSceneIds = useMemo(
    () => new Set(deriveMasteryAssessmentSceneIds(course.content._openmaicSceneOutlines ?? [])),
    [course.content._openmaicSceneOutlines],
  );
  const remoteAdaptiveState = course.aiLearningProgress?.[studentId]?.adaptiveLearning;
  const lectureProgress = course.aiLearningProgress?.[studentId];
  const lectureSections = course.content.knowledgeLectureSections ?? [];
  const lockedLectureAttempts = useMemo(() => {
    const attempts = new Map<string, KnowledgeLectureAttempt>();
    firstKnowledgeLectureAttempts(lectureProgress).forEach((attempt) => {
      attempts.set(attempt.quizOutlineId, attempt);
      attempts.set(attempt.runtimeSceneId, attempt);
    });
    return attempts;
  }, [lectureProgress]);
  const knowledgePointNames = useMemo(
    () => new Map((course.content.knowledgePoints ?? []).map((point) => [point.id, point.name])),
    [course.content.knowledgePoints],
  );
  const preparedClassroomIds = useMemo(
    () => Array.from(new Set([
      ...(plan?.branches.flatMap((branch) =>
        branch.preparedResource?.status === "ready" &&
        branch.preparedResource.classroomId
          ? [branch.preparedResource.classroomId]
          : [],
      ) ?? []),
      ...adaptiveState.branchRuns.flatMap((run) =>
        run.status === "ready" && run.classroomId ? [run.classroomId] : [],
      ),
      ...adaptiveState.microLessons.flatMap((lesson) =>
        lesson.status === "ready" && lesson.classroomId
          ? [lesson.classroomId]
          : [],
      ),
    ])),
    [adaptiveState.branchRuns, adaptiveState.microLessons, plan],
  );
  const adaptiveInsertions = useMemo<AdaptiveSceneInsertion[]>(
    () => {
      const insertions = new Map<string, AdaptiveSceneInsertion>();
      for (const resource of insertedResources) {
        insertions.set(resource.run.id, {
          id: resource.run.id,
          classroomId: resource.run.classroomId,
          placement: resource.placement,
          anchorSceneId: resource.anchorSceneId,
        });
      }
      for (const run of adaptiveState.branchRuns) {
        if (run.status !== "ready" || !run.classroomId || insertions.has(run.id)) {
          continue;
        }
        const branch = plan?.branches.find((item) => item.id === run.branchOutlineId);
        insertions.set(run.id, {
          id: run.id,
          classroomId: run.classroomId,
          placement: branch?.trigger?.placement === "before-main-course"
            ? "before-current"
            : "after-current",
        });
      }
      for (const lesson of adaptiveState.microLessons) {
        if (lesson.status !== "ready" || !lesson.classroomId) continue;
        const id = `micro-lesson:${lesson.id}`;
        insertions.set(id, {
          id,
          classroomId: lesson.classroomId,
          placement: "after-current",
        });
      }
      return [...insertions.values()];
    },
    [adaptiveState.branchRuns, adaptiveState.microLessons, insertedResources, plan],
  );

  useEffect(() => {
    for (const preparedClassroomId of preparedClassroomIds) {
      void prefetchAdaptiveClassroom(preparedClassroomId).catch(() => undefined);
    }
  }, [preparedClassroomIds]);

  useEffect(() => {
    if (!remoteAdaptiveState) return;
    queueMicrotask(() => setAdaptiveState(remoteAdaptiveState));
  }, [remoteAdaptiveState]);

  function remainingAdaptiveBudgetSec(state: StudentAdaptiveLearningState): number {
    if (!plan) return 0;
    const timing = course.uiState?.classroomTiming;
    const runtimeStageRemainingSec =
      timing?.activeStageKey === "ai-learning"
        ? deriveClassroomTimingSnapshot(
            timing,
            new Date().toISOString(),
          ).activeStage?.remainingSec
        : undefined;
    return calculateAdaptiveRemainingBudgetSec(
      plan,
      state,
      runtimeStageRemainingSec,
    );
  }

  async function persistState(body: Record<string, unknown>) {
    const response = await fetch("/api/adaptive-learning/state", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student" },
      body: JSON.stringify({ courseId: course.id, studentId, ...body }),
    });
    const payload = await response.json() as { state?: StudentAdaptiveLearningState; error?: string };
    if (!response.ok || !payload.state) throw new Error(payload.error || "学习路径保存失败");
    setAdaptiveState(payload.state);
    return payload.state;
  }

  function toQueuedResource(
    branch: AdaptiveBranchOutline,
    reason: string,
    placement: AdaptiveSceneInsertion["placement"],
    anchorSceneId?: string,
  ): QueuedResource | null {
    const preparedClassroomId = branch.preparedResource?.status === "ready"
      ? branch.preparedResource.classroomId
      : undefined;
    if (!preparedClassroomId) return null;
    return {
      branch,
      run: {
        id: `resource-run-${branch.id}-${Date.now().toString(36)}`,
        branchOutlineId: branch.id,
        kind: branch.kind,
        status: "ready",
        classroomId: preparedClassroomId,
        reason,
        createdAt: new Date().toISOString(),
      },
      placement,
      anchorSceneId,
    };
  }

  async function insertResource(resource: QueuedResource) {
    switchingRef.current = true;
    try {
      await persistState({ action: "upsert-branch-run", run: resource.run });
      setInsertedResources((current) =>
        current.some((item) => item.run.id === resource.run.id)
          ? current
          : [...current, resource],
      );
    } finally {
      switchingRef.current = false;
    }
  }

  async function preparePreCourseResources(state: StudentAdaptiveLearningState) {
    if (!plan) return;
    let simulatedState = state;
    let budget = remainingAdaptiveBudgetSec(simulatedState);
    const queue: QueuedResource[] = [];
    for (const branch of plan.branches.filter((item) => item.enabled !== false && item.trigger?.placement === "before-main-course")) {
      const result = evaluateAdaptiveBranchDecision({
        plan,
        state: simulatedState,
        anchorKnowledgePointIds: [],
        candidateBranchIds: [branch.id],
        phase: "pre-course",
        remainingBudgetSec: budget,
      });
      if (result.evaluations.length) {
        await persistState({
          action: "record-trigger-evaluations",
          evaluations: result.evaluations,
        }).catch(() => simulatedState);
      }
      const hasMatchingGap = branch.prerequisiteKnowledgePointIds.some((id) =>
        state.pretestWeakKnowledgePointIds?.includes(id),
      );
      if (result.decision.action !== "insert") {
        if (hasMatchingGap) {
          throw new Error(
            `必需的先决知识补充“${branch.title}”尚未准备完成，请重试后再进入主课。`,
          );
        }
        continue;
      }
      const resource = toQueuedResource(
        result.decision.branch,
        result.decision.reason,
        "before-current",
      );
      if (!resource) continue;
      queue.push(resource);
      simulatedState = {
        ...simulatedState,
        branchRuns: [...simulatedState.branchRuns, resource.run],
      };
      budget = remainingAdaptiveBudgetSec(simulatedState);
    }
    if (!queue.length) return;
    for (const resource of queue) {
      await persistState({ action: "upsert-branch-run", run: resource.run });
    }
    setInsertedResources((current) => [...current, ...queue]);
  }

  async function handlePretestSubmit(answers: Record<string, AdaptiveAssessmentAnswer>) {
    setPreCoursePreparing(true);
    setPreCoursePreparationError(undefined);
    try {
      const nextState = await persistState({ action: "submit-pretest", answers });
      await preparePreCourseResources(nextState);
    } catch (cause) {
      setPreCoursePreparationError(cause instanceof Error ? cause.message : "先决知识补充准备失败");
      throw cause;
    } finally {
      setPreCoursePreparing(false);
    }
  }

  useEffect(() => {
    if (!preCoursePreparing || !hasUnqueuedPrerequisiteGap(plan, initialState)) return;
    if (restoredPreparationStartedRef.current) return;
    restoredPreparationStartedRef.current = true;
    void preparePreCourseResources(initialState)
      .catch((cause) => {
        setPreCoursePreparationError(
          cause instanceof Error ? cause.message : "先决知识补充准备失败",
        );
      })
      .finally(() => setPreCoursePreparing(false));
    // This is deliberately a one-shot recovery for a persisted pretest. Live
    // submissions run through handlePretestSubmit above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function recordLectureAttempt(scene: Scene): Promise<KnowledgeLectureAttempt | undefined> {
    const quizOutlineId = scene.outlineId?.trim() || scene.id;
    const existing = firstKnowledgeLectureAttempts(lectureProgress).find(
      (attempt) => attempt.quizOutlineId === quizOutlineId,
    );
    if (existing) return Promise.resolve(existing);
    const pending = lectureAttemptRequestsRef.current.get(scene.id);
    if (pending) return pending;

    const request = (async () => {
      if (scene.content?.type !== "quiz") return undefined;
      const section = lectureSections.find((item) => item.quizOutlineId === quizOutlineId);
      const submitted = readSubmittedState(scene.id);
      if (section && submitted?.kind === "reviewing") {
        const results = new Map(submitted.results.map((result) => [result.questionId, result]));
        const response = await fetch("/api/knowledge-lecture", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student" },
          body: JSON.stringify({
            action: "record-attempt",
            courseId: course.id,
            studentId,
            sectionId: section.id,
            quizOutlineId,
            runtimeSceneId: scene.id,
            questions: scene.content.questions.map((question) => {
              const result = results.get(question.id);
              const answer = submitted.answers[question.id];
              return {
                questionId: question.id,
                prompt: question.question,
                answer: Array.isArray(answer) ? answer.join("、") : answer ?? "",
                points: question.points ?? 1,
                earned: result?.earned ?? 0,
                correct: result?.correct ?? null,
                feedback: result?.aiComment ?? question.analysis ?? "AI 已完成批阅。",
                referenceAnswer: question.analysis,
                knowledgePointIds: question.knowledgePointIds ?? section.knowledgePointIds,
                teachingUnitIds: question.teachingUnitIds,
              };
            }),
          }),
        }).catch(() => undefined);
        if (response?.ok || response?.status === 409) {
          const payload = await response.json() as { attempt?: KnowledgeLectureAttempt; error?: string };
          return payload.attempt;
        } else {
          toast.error("小测结果同步失败", { description: "批阅结果仍显示在当前页面，请稍后重新进入讲解。" });
        }
      }
      return undefined;
    })().finally(() => lectureAttemptRequestsRef.current.delete(scene.id));
    lectureAttemptRequestsRef.current.set(scene.id, request);
    return request;
  }

  useEffect(() => {
    function sceneForEvent(sceneId: string): Scene | undefined {
      return activeSceneRef.current?.id === sceneId ? activeSceneRef.current : undefined;
    }
    const reviewed = (event: Event) => {
      const sceneId = (event as CustomEvent<{ sceneId?: string }>).detail?.sceneId;
      if (!sceneId) return;
      const scene = sceneForEvent(sceneId);
      if (scene) void recordLectureAttempt(scene);
    };
    const explain = (event: Event) => {
      const detail = (event as CustomEvent<{ sceneId?: string; questionId?: string }>).detail;
      if (!detail?.sceneId || !detail.questionId) return;
      const scene = sceneForEvent(detail.sceneId);
      if (!scene) return;
      void recordLectureAttempt(scene).then((attempt) => {
        if (attempt) setReviewAttempt({ attempt, questionId: detail.questionId });
      });
    };
    window.addEventListener(QUIZ_REVIEWED_EVENT, reviewed);
    window.addEventListener(EXPLAIN_QUESTION_EVENT, explain);
    return () => {
      window.removeEventListener(QUIZ_REVIEWED_EVENT, reviewed);
      window.removeEventListener(EXPLAIN_QUESTION_EVENT, explain);
    };
    // Course identity and persisted progress replace the runtime component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [course.id, studentId, lectureProgress?.knowledgeLectureAttempts]);

  async function handleMainSceneComplete(detail: { scene: Scene; quizScore?: number }) {
    if (detail.scene.content?.type === "quiz") {
      await recordLectureAttempt(detail.scene);
    }
    if (!plan || adaptiveState.enabled === false || switchingRef.current) return;
    const sceneIdentity = resolveAdaptiveSceneIdentity(detail.scene);
    const anchorKnowledgePointIds = detail.scene.knowledgePointIds ?? [];
    const submittedQuiz = readSubmittedState(sceneIdentity.runtimeSceneId);
    const questionResults = submittedQuiz?.kind === "reviewing"
      ? submittedQuiz.results.map((result) => ({ questionId: result.questionId, correct: result.correct }))
      : [];
    const quizQuestions = detail.scene.content?.type === "quiz"
      ? detail.scene.content.questions
      : [];
    const knowledgePointScores = calculateKnowledgePointAssessmentScores({
      questions: quizQuestions,
      results: questionResults,
      fallbackKnowledgePointIds: anchorKnowledgePointIds,
    });
    let evidenceState = adaptiveState;
    if (typeof detail.quizScore === "number") {
      const threshold = plan.thresholds.enrichmentMasteryMin ?? 80;
      const weakKnowledgePointIds = knowledgePointScores
        .filter((item) => item.score < threshold)
        .map((item) => item.knowledgePointId);
      const masteredKnowledgePointIds = knowledgePointScores
        .filter((item) => item.score >= threshold)
        .map((item) => item.knowledgePointId);
      evidenceState = await persistState({
        action: "record-node-assessment",
        evidence: {
          id: `evidence-node-${sceneIdentity.stableSceneId}`,
          source: "node-quiz",
          score: detail.quizScore,
          occurredAt: new Date().toISOString(),
          sceneId: sceneIdentity.stableSceneId,
          knowledgePointIds: anchorKnowledgePointIds,
          questionResults,
          knowledgePointScores,
          weakKnowledgePointIds,
          masteredKnowledgePointIds,
        },
      }).catch(() => adaptiveState);
    }
    // Only module mastery can add a resource here. Incorrect answers remain in
    // the quiz review/analysis flow and are surfaced to teacher analytics.
    const evaluation = evaluateAdaptiveBranchDecision({
      plan,
      state: evidenceState,
      nodeQuizScore: detail.quizScore,
      anchorKnowledgePointIds,
      completedSceneId: sceneIdentity.stableSceneId,
      runtimeSceneId: sceneIdentity.runtimeSceneId,
      completedSceneTitle: detail.scene.title,
      questionResults,
      knowledgePointScores,
      isAutomaticCheckpoint: checkpointSceneIds.has(sceneIdentity.stableSceneId),
      phase: "after-module",
      remainingBudgetSec: remainingAdaptiveBudgetSec(evidenceState),
    });
    if (evaluation.evaluations.length) {
      await persistState({
        action: "record-trigger-evaluations",
        evaluations: evaluation.evaluations,
      }).catch(() => evidenceState);
    }
    if (evaluation.decision.action !== "insert") return;
    const resource = toQueuedResource(
      evaluation.decision.branch,
      evaluation.decision.reason,
      "after-current",
      sceneIdentity.runtimeSceneId,
    );
    if (resource) await insertResource(resource);
  }

  const handleActiveSceneChange = useCallback((scene: Scene) => {
    activeSceneRef.current = scene;
  }, []);

  async function handleResourceComplete(scene: Scene) {
    const adaptiveScene = scene as Scene & {
      openpblAdaptiveInsertionId?: string;
      openpblAdaptiveLastScene?: boolean;
    };
    if (
      !adaptiveScene.openpblAdaptiveInsertionId ||
      !adaptiveScene.openpblAdaptiveLastScene ||
      switchingRef.current
    ) return;
    const insertionId = adaptiveScene.openpblAdaptiveInsertionId;
    const resource = insertedResources.find((item) => item.run.id === insertionId);
    switchingRef.current = true;
    try {
      if (resource) {
        await persistState({
          action: "upsert-branch-run",
          run: {
            ...resource.run,
            status: "completed",
            completedAt: new Date().toISOString(),
          },
        });
        return;
      }
      const persistedRun = adaptiveState.branchRuns.find(
        (run) => run.id === insertionId && run.status === "ready",
      );
      if (persistedRun) {
        await persistState({
          action: "upsert-branch-run",
          run: {
            ...persistedRun,
            status: "completed",
            completedAt: new Date().toISOString(),
          },
        });
        return;
      }
      if (insertionId.startsWith("micro-lesson:")) {
        await persistState({
          action: "complete-micro-lesson",
          lessonId: insertionId.slice("micro-lesson:".length),
        });
      }
    } catch {
      // The ready item stays in the persisted queue and can be retried safely.
    } finally {
      switchingRef.current = false;
    }
  }

  if (
    plan?.enabled
    && plan.status === "teacher-confirmed"
    && adaptiveState.enabled !== false
    && plan.pretest.questions.length > 0
    && !adaptiveState.pretestCompletedAt
  ) {
    return <AdaptivePretest plan={plan} onSubmit={handlePretestSubmit} variant={variant} />;
  }

  if (preCoursePreparing || preCoursePreparationError) {
    return (
      <div className={variant === "fullscreen"
        ? "grid h-dvh place-items-center overflow-y-auto bg-stone-50 p-6"
        : "grid h-full min-h-0 place-items-center overflow-y-auto bg-stone-50 p-6"}>
        <div className="max-w-md rounded-[12px] border border-cyan-200 bg-white p-6 text-center shadow-sm">
          {preCoursePreparing ? <Loader2 className="mx-auto animate-spin text-cyan-800" size={28} /> : null}
          <h2 className="mt-3 text-lg font-bold text-stone-950">
            {preCoursePreparing ? "正在准备必需的先决知识回顾" : "先决知识回顾暂未准备好"}
          </h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            {preCoursePreparationError
              ?? "准备完成后会直接从第一个回顾页面开始，连续学习完毕后再进入主课。"}
          </p>
          {preCoursePreparationError ? (
            <button
              className="mt-4 rounded-[8px] bg-cyan-950 px-4 py-2 text-sm font-bold text-white"
              onClick={() => {
                setPreCoursePreparationError(undefined);
                setPreCoursePreparing(true);
                void preparePreCourseResources(adaptiveState)
                  .catch((cause) => setPreCoursePreparationError(
                    cause instanceof Error ? cause.message : "先决知识补充准备失败",
                  ))
                  .finally(() => setPreCoursePreparing(false));
              }}
              type="button"
            >
              重新准备
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <span className="sr-only" aria-live="polite">
        Adaptive resources play in the main course player.
      </span>
      <div className="min-h-0 flex-1">
        <KnowledgeLectureQuizLockProvider attemptsBySceneId={lockedLectureAttempts}>
        <StudentStageHost
          adaptiveInsertions={adaptiveInsertions}
          backHref={backHref}
          classroomId={classroomId}
          className="rounded-none border-0 bg-[linear-gradient(180deg,#f8fbff_0%,#ffffff_42%)]"
          courseId={course.id}
          knowledgeGraph={course.content.knowledgeGraph}
          knowledgePoints={course.content.knowledgePoints ?? []}
          onActiveSceneChange={handleActiveSceneChange}
          onSceneComplete={(detail) => {
            if (
              (detail.scene as Scene & { openpblAdaptiveInsertionId?: string })
                .openpblAdaptiveInsertionId
            ) {
              void handleResourceComplete(detail.scene);
            } else {
              void handleMainSceneComplete(detail);
            }
          }}
          prefetchClassroomIds={preparedClassroomIds}
          studentId={studentId}
          studentName={studentName}
          variant={variant}
        />
        </KnowledgeLectureQuizLockProvider>
      </div>
      {reviewAttempt ? (
        <KnowledgeLectureBoard
          attempt={reviewAttempt.attempt}
          courseId={course.id}
          initialQuestionId={reviewAttempt.questionId}
          initialThreads={lectureProgress?.knowledgeLectureTutorThreads ?? []}
          knowledgePointNames={knowledgePointNames}
          onClose={() => setReviewAttempt(undefined)}
          studentId={studentId}
        />
      ) : null}
    </div>
  );
}

function AdaptivePretest({
  plan,
  onSubmit,
  variant,
}: {
  plan: NonNullable<Course["content"]["adaptiveLearningPlan"]>;
  onSubmit: (answers: Record<string, AdaptiveAssessmentAnswer>) => Promise<void>;
  variant: "embedded" | "fullscreen";
}) {
  const [answers, setAnswers] = useState<Record<string, AdaptiveAssessmentAnswer>>({});
  const [submitting, setSubmitting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [error, setError] = useState<string>();
  const questions = plan.pretest.questions.slice(0, 5);
  const durationSeconds = Math.max(60, Math.round(plan.pretest.estimatedMinutes * 60));
  const [remainingSeconds, setRemainingSeconds] = useState(durationSeconds);
  const answersRef = useRef(answers);
  const submitRef = useRef<(dueToTimeout?: boolean) => Promise<void>>(async () => undefined);
  const complete = questions.every((question) => {
    const answer = answers[question.id];
    if (question.type !== "matching") return typeof answer === "number";
    return Boolean(
      answer
      && typeof answer === "object"
      && (question.matchingPairs ?? []).every((pair) => answer[pair.left]),
    );
  });

  async function submitPretest(dueToTimeout = false) {
    if (submitting) return;
    const submittedAnswers = dueToTimeout
      ? Object.fromEntries(questions.map((question) => [
          question.id,
          answersRef.current[question.id] ?? (question.type === "matching" ? {} : -1),
        ]))
      : answersRef.current;
    if (dueToTimeout) {
      setTimedOut(true);
      setAnswers(submittedAnswers);
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit(submittedAnswers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    answersRef.current = answers;
    submitRef.current = submitPretest;
  });

  useEffect(() => {
    const deadline = Date.now() + durationSeconds * 1000;
    const timer = window.setInterval(() => {
      const next = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemainingSeconds(next);
      if (next === 0) {
        window.clearInterval(timer);
        void submitRef.current(true);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [durationSeconds]);

  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;

  return (
    <div className={`${variant === "fullscreen" ? "h-dvh" : "h-full min-h-0"} overflow-y-auto bg-[radial-gradient(circle_at_top_left,#cffafe_0,transparent_32%),linear-gradient(145deg,#f8fafc,#fff)] p-5 sm:p-8`}>
      <div className="mx-auto max-w-3xl">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] bg-cyan-950 text-white">
            <BookOpenCheck size={21} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-cyan-800">
              课前热身
            </p>
            <h2 className="font-editorial mt-1 text-2xl font-semibold text-stone-950">
              先来做{questions.length}道小题
            </h2>
            <p className="mt-1 text-sm leading-6 text-stone-600">按你的第一感觉作答即可。</p>
          </div>
          <div
            aria-label={`剩余时间 ${minutes} 分 ${seconds} 秒`}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-bold tabular-nums ${
              remainingSeconds <= 30
                ? "border-rose-200 bg-rose-50 text-rose-700"
                : "border-cyan-200 bg-white/80 text-cyan-900"
            }`}
            role="timer"
          >
            <Clock3 size={15} />
            {minutes}:{seconds.toString().padStart(2, "0")}
          </div>
        </div>
        <div className="mt-6 space-y-4">
          {questions.map((question, questionIndex) => (
            <fieldset className="rounded-[10px] border border-stone-200 bg-white p-4 shadow-sm" key={question.id}>
              <legend className="px-1 text-sm font-bold text-stone-900">
                {questionIndex + 1}. {question.prompt}
              </legend>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {question.type === "matching" ? (
                  (question.matchingPairs ?? []).map((pair) => {
                    const current = answers[question.id];
                    const matches = current && typeof current === "object" ? current : {};
                    return (
                      <label className="rounded-[8px] border border-stone-200 bg-stone-50/60 p-3 text-xs" key={`${question.id}-${pair.left}`}>
                        <span className="mb-2 block font-bold text-stone-800">{pair.left}</span>
                        <select
                          aria-label={`为${pair.left}选择匹配项`}
                          className="w-full rounded-[7px] border border-stone-200 bg-white px-2.5 py-2 text-stone-700 outline-none focus:border-cyan-600"
                          onChange={(event) => setAnswers((currentAnswers) => ({
                            ...currentAnswers,
                            [question.id]: { ...matches, [pair.left]: event.target.value },
                          }))}
                          value={matches[pair.left] ?? ""}
                        >
                          <option value="">请选择匹配项</option>
                          {question.options.map((option) => <option key={option} value={option}>{option}</option>)}
                        </select>
                      </label>
                    );
                  })
                ) : question.options.map((option, optionIndex) => {
                  const selected = answers[question.id] === optionIndex;
                  return (
                    <button
                      className={`rounded-[8px] border px-3 py-2.5 text-left text-xs leading-5 transition ${
                        selected
                          ? "border-cyan-700 bg-cyan-50 font-bold text-cyan-950 ring-1 ring-cyan-700"
                          : "border-stone-200 text-stone-600 hover:border-cyan-300 hover:bg-cyan-50/40"
                      }`}
                      key={`${question.id}-${optionIndex}`}
                      onClick={() => setAnswers((current) => ({ ...current, [question.id]: optionIndex }))}
                      type="button"
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-cyan-200 bg-white p-4">
          <p className="text-xs text-stone-500">
            {timedOut
              ? "时间已到，未完成的题目已标记为“不会”。"
              : complete
              ? "检查已完成。系统只会在确有必要时，于主课开始前连续播放相应回顾内容。"
              : `还需完成 ${questions.length - Object.keys(answers).length} 题。`}
          </p>
          <button
            className="inline-flex h-10 items-center gap-2 rounded-[8px] bg-cyan-950 px-5 text-sm font-bold text-white hover:bg-cyan-900 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={(!complete && !timedOut) || submitting}
            onClick={() => void submitPretest(timedOut)}
            type="button"
          >
            {submitting ? <Loader2 className="animate-spin" size={15} /> : <CheckCircle2 size={15} />}
            {submitting ? "正在提交" : timedOut ? "重新提交" : "开始学习"}
          </button>
        </div>
        {error ? <p className="mt-2 text-right text-xs text-rose-700">{error}</p> : null}
      </div>
    </div>
  );
}
