import { callLLM } from "@openmaic/lib/ai/llm";
import { resolveModel, resolveModelFromRequest } from "@openmaic/lib/server/resolve-model";
import type { NextRequest } from "next/server";
import { isAuthConfigured, readAuthFromRequest } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/auth/request-guards";
import { getCourse, updateCourse } from "@/lib/session/server-store";
import type {
  KnowledgeLectureAttempt,
  KnowledgeLectureBoardNote,
  KnowledgeLectureQuestionReview,
  KnowledgeLectureTutorMessage,
  KnowledgeLectureTutorThread,
  StudentAiProgress,
} from "@/lib/session/types";
import { getKnowledgeLectureTutorSettings } from "@/lib/knowledge-lecture-settings";
import { canAccessLegacyCourse } from "@/lib/platform/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IncomingReview = Partial<KnowledgeLectureQuestionReview> & {
  questionId?: string;
  prompt?: string;
  answer?: string;
};

type KnowledgeLectureRequest = {
  action?: "record-attempt" | "tutor-message" | "tutor-explain";
  courseId?: string;
  studentId?: string;
  sectionId?: string;
  quizOutlineId?: string;
  runtimeSceneId?: string;
  questions?: IncomingReview[];
  attemptId?: string;
  questionId?: string;
  message?: string;
};

class QuizAlreadySubmittedError extends Error {
  constructor(readonly attempt: KnowledgeLectureAttempt) {
    super("QUIZ_ALREADY_SUBMITTED");
  }
}

function text(value: unknown, max = 4_000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

async function authorized(request: Request, courseId: string, studentId: string): Promise<boolean> {
  if (!isAuthConfigured()) return true;
  const claims = await readAuthFromRequest(request, "student");
  if (!claims) return false;
  if (claims.role === "teacher") return canAccessLegacyCourse(claims, courseId, "read");
  return claims.sub === studentId
    && canAccessLegacyCourse(claims, courseId, "write");
}

function sanitizeAttemptQuestions(
  questions: IncomingReview[],
  allowedKnowledgePointIds: ReadonlySet<string>,
  fallbackKnowledgePointIds: readonly string[],
  allowedTeachingUnitIds: ReadonlySet<string>,
  fallbackTeachingUnitIds: readonly string[],
): KnowledgeLectureQuestionReview[] {
  return questions.slice(0, 3).flatMap((question, index) => {
    const prompt = text(question.prompt, 1_500);
    const questionId = text(question.questionId, 160) || `question-${index + 1}`;
    if (!prompt) return [];
    const points = Math.max(1, Math.min(100, number(question.points, 10)));
    const earned = Math.max(0, Math.min(points, number(question.earned)));
    const requestedKnowledgePointIds = Array.isArray(question.knowledgePointIds)
      ? question.knowledgePointIds.map((id) => text(id, 160)).filter((id) => allowedKnowledgePointIds.has(id))
      : [];
    const requestedTeachingUnitIds = Array.isArray(question.teachingUnitIds)
      ? question.teachingUnitIds.map((id) => text(id, 160)).filter((id) => allowedTeachingUnitIds.has(id))
      : [];
    return [{
      questionId,
      prompt,
      answer: text(question.answer, 2_000),
      points,
      earned,
      correct: typeof question.correct === "boolean" ? question.correct : null,
      feedback: text(question.feedback, 1_500) || "AI 已完成批阅，可打开助教讲解继续梳理。",
      referenceAnswer: text(question.referenceAnswer, 2_000) || undefined,
      knowledgePointIds: requestedKnowledgePointIds.length
        ? Array.from(new Set(requestedKnowledgePointIds))
        : [...fallbackKnowledgePointIds],
      teachingUnitIds: requestedTeachingUnitIds.length
        ? Array.from(new Set(requestedTeachingUnitIds))
        : [...fallbackTeachingUnitIds],
    }];
  });
}

function parseTutorPayload(raw: string, now: string): { answer: string; notes: KnowledgeLectureBoardNote[] } {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match?.[0] ?? "{}") as {
      answer?: unknown;
      boardNotes?: Array<{ title?: unknown; body?: unknown; kind?: unknown }>;
    };
    const answer = text(parsed.answer, 3_000);
    const notes = (Array.isArray(parsed.boardNotes) ? parsed.boardNotes : []).slice(0, 3).flatMap((note, index) => {
      const title = text(note.title, 80);
      const body = text(note.body, 500);
      if (!title || !body) return [];
      const kind = ["concept", "evidence", "correction", "example"].includes(String(note.kind))
        ? note.kind as KnowledgeLectureBoardNote["kind"]
        : "concept";
      return [{ id: `board-${Date.now()}-${index}`, title, body, kind, createdAt: now }];
    });
    if (answer) return { answer, notes };
  } catch {
    // Fall through to a concise recovery response.
  }
  return {
    answer: "我们先抓住题目中的核心概念，再逐句对照你的答案：结论要准确，理由要能说明为什么。你也可以指出最不确定的一步，我会继续拆解。",
    notes: [{
      id: `board-${Date.now()}-fallback`,
      title: "再看一步",
      body: "先写结论，再补上能够支撑结论的概念或依据。",
      kind: "correction",
      createdAt: now,
    }],
  };
}

export async function POST(request: NextRequest) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const body = await request.json().catch(() => null) as KnowledgeLectureRequest | null;
  const courseId = text(body?.courseId, 160);
  const studentId = text(body?.studentId, 160);
  if (!body?.action || !courseId || !studentId) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (!await authorized(request, courseId, studentId)) {
    return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  const course = await getCourse(courseId);
  if (!course || !course.students.some((student) => student.id === studentId)) {
    return Response.json({ error: "STUDENT_NOT_FOUND" }, { status: 404 });
  }

  if (body.action === "record-attempt") {
    const sectionId = text(body.sectionId, 160);
    const quizOutlineId = text(body.quizOutlineId, 160);
    const runtimeSceneId = text(body.runtimeSceneId, 160);
    const section = course.content.knowledgeLectureSections?.find((item) => item.id === sectionId);
    if (!section || section.quizOutlineId !== quizOutlineId || !runtimeSceneId) {
      return Response.json({ error: "SECTION_NOT_FOUND" }, { status: 404 });
    }
    const allowedKnowledgePointIds = new Set(section.knowledgePointIds);
    const blueprintSection = course.content.teachingBlueprint?.sections.find((item) => item.id === sectionId);
    const teachingUnitIds = blueprintSection?.units.map((unit) => unit.id) ?? [];
    const questions = sanitizeAttemptQuestions(
      Array.isArray(body.questions) ? body.questions : [],
      allowedKnowledgePointIds,
      section.knowledgePointIds,
      new Set(teachingUnitIds),
      teachingUnitIds,
    );
    if (questions.length < 1) {
      return Response.json({ error: "QUIZ_RESULTS_INCOMPLETE" }, { status: 400 });
    }
    const now = new Date().toISOString();
    const attempt: KnowledgeLectureAttempt = {
      id: `lecture-attempt-${studentId}-${quizOutlineId}`,
      sectionId,
      quizOutlineId,
      runtimeSceneId,
      submittedAt: now,
      score: questions.reduce((sum, question) => sum + question.earned, 0),
      maxScore: questions.reduce((sum, question) => sum + question.points, 0),
      knowledgePointIds: section.knowledgePointIds,
      questions,
    };
    try {
      await updateCourse(courseId, (current) => {
        const currentProgress = current.aiLearningProgress?.[studentId]
          ?? emptyProgress(studentId, current.aiLearningClassroomId ?? "");
        const existingAttempt = (currentProgress.knowledgeLectureAttempts ?? [])
          .filter((item) => item.quizOutlineId === quizOutlineId)
          .sort((left, right) => Date.parse(left.submittedAt) - Date.parse(right.submittedAt))[0];
        if (existingAttempt) throw new QuizAlreadySubmittedError(existingAttempt);
        return {
          ...current,
          aiLearningProgress: {
            ...(current.aiLearningProgress ?? {}),
            [studentId]: {
              ...currentProgress,
              knowledgeLectureAttempts: [
                ...(currentProgress.knowledgeLectureAttempts ?? []),
                attempt,
              ].slice(-40),
              lastActiveAt: now,
            },
          },
        };
      }, { targetStudentId: studentId });
    } catch (error) {
      if (error instanceof QuizAlreadySubmittedError) {
        return Response.json({ error: error.message, attempt: error.attempt }, { status: 409 });
      }
      throw error;
    }
    return Response.json({ attempt });
  }

  const attemptId = text(body.attemptId, 200);
  const questionId = text(body.questionId, 160);
  const initialExplanation = body.action === "tutor-explain";
  const message = initialExplanation
    ? "请开始讲解这道题，先指出作答中最关键的问题，再用简短板书给出正确理解路径。"
    : text(body.message, 1_000);
  const progress = course.aiLearningProgress?.[studentId];
  const attempt = progress?.knowledgeLectureAttempts?.find((item) => item.id === attemptId);
  const question = attempt?.questions.find((item) => item.questionId === questionId);
  if (!attempt || !question || !message) {
    return Response.json({ error: "QUESTION_CONTEXT_NOT_FOUND" }, { status: 404 });
  }
  const threadId = `lecture-tutor-${attempt.id}-${question.questionId}`;
  const existingThread = progress?.knowledgeLectureTutorThreads?.find((thread) => thread.id === threadId);
  const recentConversation = (existingThread?.messages ?? []).slice(-8)
    .map((item) => `${item.role === "student" ? "学生" : "助教"}：${item.content}`)
    .join("\n");
  const knowledgePointNames = question.knowledgePointIds.map((id) =>
    course.content.knowledgePoints.find((point) => point.id === id)?.name ?? id,
  );
  const tutorSettings = await getKnowledgeLectureTutorSettings();
  const { model, thinkingConfig } = tutorSettings.modelString
    ? await resolveModel({ modelString: tutorSettings.modelString })
    : await resolveModelFromRequest(request, body, "quiz-grade");
  const result = await callLLM({
    model,
    abortSignal: request.signal,
    system: `你是知识讲授阶段的伴学助教。学生已经完成节末小测，你需要围绕具体题目进行清楚、短而有层次的讲解，并回应追问。不要长篇讲课；优先指出判断依据、纠正误区、补充一个最小例子。answer 是聊天区中自然完整的口头回答。boardNotes 不是回答全文，而是老师真正会留在黑板上的核心知识、关键判断依据、整体思路或可复用方法；普通问答、寒暄、重复题干和一次性细节不要写入板书。只有确实值得长期保留的内容才生成 boardNotes，可以返回空数组；每次最多2条，每条只写一个要点，并避免与已有板书重复。严格返回 JSON：{"answer":"给学生的回答","boardNotes":[{"title":"简短板书标题","body":"精炼的核心内容","kind":"concept|evidence|correction|example"}]}。`,
    prompt: `知识点：${knowledgePointNames.join("、")}\n题目：${question.prompt}\n学生答案：${question.answer || "未作答"}\nAI批阅：${question.feedback}\n参考讲解：${question.referenceAnswer || "未提供"}\n已有对话：\n${recentConversation || "无"}\n学生追问：${message}`,
  }, "quiz-grade", undefined, thinkingConfig);
  const now = new Date().toISOString();
  const tutorPayload = parseTutorPayload(result.text.trim(), now);
  const studentMessage: KnowledgeLectureTutorMessage = {
    id: `tutor-message-student-${Date.now()}`,
    role: "student",
    content: message,
    createdAt: now,
  };
  const assistantMessage: KnowledgeLectureTutorMessage = {
    id: `tutor-message-assistant-${Date.now()}`,
    role: "assistant",
    content: tutorPayload.answer,
    createdAt: now,
  };
  let savedThread: KnowledgeLectureTutorThread | undefined;
  await updateCourse(courseId, (current) => {
    const currentProgress = current.aiLearningProgress?.[studentId]
      ?? emptyProgress(studentId, current.aiLearningClassroomId ?? "");
    const threads = currentProgress.knowledgeLectureTutorThreads ?? [];
    const currentThread = threads.find((thread) => thread.id === threadId);
    savedThread = {
      id: threadId,
      attemptId: attempt.id,
      questionId: question.questionId,
      messages: [
        ...(currentThread?.messages ?? []),
        ...(initialExplanation ? [] : [studentMessage]),
        assistantMessage,
      ].slice(-30),
      boardNotes: [...(currentThread?.boardNotes ?? []), ...tutorPayload.notes].slice(-12),
      createdAt: currentThread?.createdAt ?? now,
      updatedAt: now,
    };
    return {
      ...current,
      aiLearningProgress: {
        ...(current.aiLearningProgress ?? {}),
        [studentId]: {
          ...currentProgress,
          knowledgeLectureTutorThreads: [
            ...threads.filter((thread) => thread.id !== threadId),
            savedThread,
          ].slice(-60),
          lastActiveAt: now,
        },
      },
    };
  }, { targetStudentId: studentId });
  return Response.json({ thread: savedThread });
}
