import { isAuthConfigured, readAuthFromRequest } from "@/lib/auth/session";
import {
  derivePretestKnowledgeEvidence,
  isAdaptiveAnswerCorrect,
  scoreAdaptiveAssessment,
} from "@/lib/adaptive-learning";
import { getCourse, updateCourse } from "@/lib/session/server-store";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import type {
  AdaptiveAssessmentEvidence,
  AdaptiveAssessmentAnswer,
  AdaptiveBranchRun,
  AdaptiveMicroLesson,
  AdaptiveTriggerEvaluation,
  StudentAdaptiveLearningState,
  StudentAiProgress,
} from "@/lib/session/types";
import { requireSameOrigin } from "@/lib/auth/request-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StateAction =
  | {
      action: "submit-pretest";
      courseId: string;
      studentId: string;
      answers: Record<string, AdaptiveAssessmentAnswer>;
    }
  | {
      action: "record-node-assessment";
      courseId: string;
      studentId: string;
      evidence: AdaptiveAssessmentEvidence;
    }
  | {
      action: "upsert-branch-run";
      courseId: string;
      studentId: string;
      run: AdaptiveBranchRun;
    }
  | {
      action: "record-trigger-evaluations";
      courseId: string;
      studentId: string;
      evaluations: AdaptiveTriggerEvaluation[];
    }
  | {
      action: "upsert-micro-lesson";
      courseId: string;
      studentId: string;
      lesson: AdaptiveMicroLesson;
    }
  | {
      action: "complete-micro-lesson";
      courseId: string;
      studentId: string;
      lessonId: string;
    };

function emptyAdaptiveState(): StudentAdaptiveLearningState {
  return { evidence: [], branchRuns: [], microLessons: [] };
}

function emptyProgress(studentId: string, classroomId: string): StudentAiProgress {
  return {
    classroomId,
    studentId,
    currentSceneIndex: 0,
    totalScenes: 0,
    completedScenes: [],
    lastActiveAt: new Date().toISOString(),
    masteryLevel: "not-started",
  };
}

async function authorize(request: Request, courseId: string, studentId: string) {
  if (!isAuthConfigured()) return true;
  const claims = await readAuthFromRequest(request, "student");
  if (!claims) return false;
  if (claims.role === "teacher") return canAccessLegacyCourse(claims, courseId, "read");
  return claims.courseId === courseId
    && claims.studentId === studentId
    && canAccessLegacyCourse(claims, courseId, "write");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const courseId = url.searchParams.get("courseId") || "";
  const studentId = url.searchParams.get("studentId") || "";
  if (!courseId || !studentId) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (!await authorize(request, courseId, studentId)) {
    return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  const course = await getCourse(courseId);
  if (!course) return Response.json({ error: "COURSE_NOT_FOUND" }, { status: 404 });
  return Response.json({
    state: course.aiLearningProgress?.[studentId]?.adaptiveLearning ?? emptyAdaptiveState(),
  });
}

export async function POST(request: Request) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const body = await request.json().catch(() => null) as StateAction | null;
  if (!body?.courseId || !body.studentId || !body.action) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (!await authorize(request, body.courseId, body.studentId)) {
    return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  const course = await getCourse(body.courseId);
  if (!course || !course.students.some((student) => student.id === body.studentId)) {
    return Response.json({ error: "STUDENT_NOT_FOUND" }, { status: 404 });
  }
  const plan = course.content.adaptiveLearningPlan;
  const now = new Date().toISOString();
  let nextState: StudentAdaptiveLearningState | undefined;

  await updateCourse(body.courseId, (current) => {
    const currentProgress =
      current.aiLearningProgress?.[body.studentId] ??
      emptyProgress(body.studentId, current.aiLearningClassroomId ?? "");
    const adaptive = currentProgress.adaptiveLearning ?? emptyAdaptiveState();

    if (body.action === "submit-pretest") {
      if (!plan?.enabled || plan.status !== "teacher-confirmed") return current;
      const score = scoreAdaptiveAssessment(plan.pretest.questions, body.answers);
      const knowledgeEvidence = derivePretestKnowledgeEvidence(
        plan.pretest.questions,
        body.answers,
      );
      nextState = {
        ...adaptive,
        enabled: adaptive.enabled ?? true,
        tier: undefined,
        tierSource: undefined,
        tierUpdatedAt: undefined,
        pretestScore: score,
        pretestCompletedAt: now,
        pretestWeakKnowledgePointIds: knowledgeEvidence.weakKnowledgePointIds,
        pretestMasteredKnowledgePointIds: knowledgeEvidence.masteredKnowledgePointIds,
        startedAt: adaptive.startedAt ?? now,
        evidence: [
          ...adaptive.evidence.filter((item) => item.source !== "pretest"),
          {
            id: `evidence-pretest-${body.studentId}`,
            source: "pretest",
            score,
            occurredAt: now,
            knowledgePointIds: [...new Set(plan.pretest.questions.flatMap(
              (question) => question.knowledgePointIds,
            ))],
            weakKnowledgePointIds: knowledgeEvidence.weakKnowledgePointIds,
            masteredKnowledgePointIds: knowledgeEvidence.masteredKnowledgePointIds,
            questionResults: plan.pretest.questions.map((question) => ({
              questionId: question.id,
              correct: isAdaptiveAnswerCorrect(question, body.answers[question.id]),
            })),
          },
        ],
      };
    } else if (body.action === "record-node-assessment") {
      nextState = {
        ...adaptive,
        evidence: [
          ...adaptive.evidence.filter((item) => item.id !== body.evidence.id),
          body.evidence,
        ].slice(-30),
      };
    } else if (body.action === "upsert-branch-run") {
      nextState = {
        ...adaptive,
        branchRuns: [
          ...adaptive.branchRuns.filter((run) => run.id !== body.run.id),
          body.run,
        ],
      };
    } else if (body.action === "record-trigger-evaluations") {
      const incomingIds = new Set(body.evaluations.map((evaluation) => evaluation.id));
      nextState = {
        ...adaptive,
        triggerEvaluations: [
          ...(adaptive.triggerEvaluations ?? []).filter(
            (evaluation) => !incomingIds.has(evaluation.id),
          ),
          ...body.evaluations,
        ].slice(-100),
      };
    } else if (body.action === "upsert-micro-lesson") {
      nextState = {
        ...adaptive,
        microLessons: [
          ...adaptive.microLessons.filter((lesson) => lesson.id !== body.lesson.id),
          body.lesson,
        ].slice(-20),
      };
    } else {
      nextState = {
        ...adaptive,
        microLessons: adaptive.microLessons.map((lesson) =>
          lesson.id === body.lessonId
            ? { ...lesson, status: "completed", completedAt: now }
            : lesson,
        ),
      };
    }
    return {
      ...current,
      aiLearningProgress: {
        ...(current.aiLearningProgress ?? {}),
        [body.studentId]: {
          ...currentProgress,
          adaptiveLearning: nextState,
          lastActiveAt: now,
        },
      },
    };
  }, { targetStudentId: body.studentId });

  if (!nextState) {
    return Response.json({ error: "ADAPTIVE_PLAN_NOT_READY" }, { status: 409 });
  }
  return Response.json({ state: nextState });
}
