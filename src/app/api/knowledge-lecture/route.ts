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
  KnowledgeLectureSection,
  KnowledgeLectureTutorMessage,
  KnowledgeLectureTutorThread,
  StudentAiProgress,
} from "@/lib/session/types";
import { getKnowledgeLectureTutorSettings } from "@/lib/knowledge-lecture-settings";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { readClassroom } from "@openmaic/lib/server/classroom-storage";
import { gradeChoiceQuestions } from "@openmaic/lib/quiz/grading";
import { parseQuizGradeResponse } from "@openmaic/lib/quiz/grade-response";
import type { QuizQuestion, Scene } from "@openmaic/lib/types/stage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type KnowledgeLectureRequest = {
  action?: "record-attempt" | "retry-grading" | "tutor-message" | "tutor-explain";
  courseId?: string;
  studentId?: string;
  sectionId?: string;
  quizOutlineId?: string;
  runtimeSceneId?: string;
  answers?: Record<string, unknown>;
  attemptId?: string;
  questionId?: string;
  options?: KnowledgeLectureQuestionReview["options"];
  matchingOptions?: KnowledgeLectureQuestionReview["matchingOptions"];
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

function sanitizeQuestionOptions(value: unknown): KnowledgeLectureQuestionReview["options"] {
  if (!Array.isArray(value)) return undefined;
  const options = value.slice(0, 12).flatMap((option) => {
    const label = text(option?.label, 500);
    const key = text(option?.value, 40);
    return label && key ? [{ label, value: key }] : [];
  });
  return options.length ? options : undefined;
}

function sanitizeMatchingOptions(value: unknown): KnowledgeLectureQuestionReview["matchingOptions"] {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { left?: unknown; right?: unknown };
  if (!Array.isArray(candidate.left) || !Array.isArray(candidate.right)) return undefined;
  const left = candidate.left.slice(0, 12).map((item) => text(item, 500)).filter(Boolean);
  const right = candidate.right.slice(0, 12).map((item) => text(item, 500)).filter(Boolean);
  return left.length && right.length ? { left, right } : undefined;
}

function questionChoicesText(question: Pick<KnowledgeLectureQuestionReview, "options" | "matchingOptions">): string {
  if (question.options?.length) {
    return `选项：\n${question.options.map((option) => `${option.value}. ${option.label}`).join("\n")}`;
  }
  if (question.matchingOptions) {
    return `匹配项：\n左侧：${question.matchingOptions.left.join("；")}\n右侧候选：${question.matchingOptions.right.join("；")}`;
  }
  return "";
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

async function authorized(request: Request, courseId: string, studentId: string, submitting: boolean): Promise<boolean> {
  if (!isAuthConfigured()) return true;
  const claims = await readAuthFromRequest(request, "student");
  if (!claims) return false;
  if (claims.role === "teacher") return !submitting && canAccessLegacyCourse(claims, courseId, "read");
  return claims.sub === studentId
    && canAccessLegacyCourse(claims, courseId, "write");
}

function submittedAnswers(
  questions: readonly QuizQuestion[],
  raw: unknown,
): Record<string, string | string[]> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !questions.length || questions.length > 12) return null;
  const input = raw as Record<string, unknown>;
  const ids = new Set(questions.map((question) => question.id));
  if (ids.size !== questions.length || Object.keys(input).length !== questions.length
    || Object.keys(input).some((id) => !ids.has(id))) return null;
  const answers: Record<string, string | string[]> = {};
  for (const question of questions) {
    const value = input[question.id];
    if (question.type === "multiple" || question.type === "matching") {
      if (!Array.isArray(value) || value.length > 12
        || value.some((item) => typeof item !== "string" || item.length > 500)) return null;
      answers[question.id] = value;
    } else {
      if (typeof value !== "string" || value.length > 4_000) return null;
      answers[question.id] = value;
    }
  }
  return answers;
}

function attemptedAnswer(question: KnowledgeLectureQuestionReview): string | string[] {
  return question.rawAnswer ?? question.answer;
}

function sameSubmittedAnswers(attempt: KnowledgeLectureAttempt, answers: Record<string, string | string[]>): boolean {
  return attempt.questions.length === Object.keys(answers).length
    && attempt.questions.every((question) => JSON.stringify(attemptedAnswer(question)) === JSON.stringify(answers[question.questionId]));
}

function withGradeSummary(attempt: KnowledgeLectureAttempt): KnowledgeLectureAttempt {
  const graded = attempt.questions.filter((question) => question.gradingStatus === "graded");
  return {
    ...attempt,
    gradingStatus: attempt.questions.some((question) => question.gradingStatus === "failed")
      ? "failed"
      : attempt.questions.some((question) => question.gradingStatus !== "graded") ? "pending" : "graded",
    score: graded.reduce((sum, question) => sum + question.earned, 0),
    maxScore: graded.reduce((sum, question) => sum + question.points, 0),
  };
}

function createAttempt(
  scene: Scene,
  section: KnowledgeLectureSection,
  teachingUnitIds: readonly string[],
  studentId: string,
  answers: Record<string, string | string[]>,
): KnowledgeLectureAttempt {
  if (scene.content?.type !== "quiz") throw new Error("QUIZ_SCENE_NOT_FOUND");
  const allowedKnowledgePointIds = new Set(section.knowledgePointIds);
  const allowedTeachingUnitIds = new Set(teachingUnitIds);
  const questions = scene.content.questions.map((question): KnowledgeLectureQuestionReview => {
    const points = question.points ?? 1;
    if (!Number.isFinite(points) || points <= 0 || points > 100 || !question.question.trim()
      || (question.type !== "short_answer" && !question.answer?.length)) {
      throw new Error("QUIZ_QUESTION_INVALID");
    }
    const rawAnswer = answers[question.id];
    const answer = Array.isArray(rawAnswer) ? rawAnswer.join("、") : rawAnswer;
    const objective = question.type !== "short_answer";
    const empty = !objective && !answer.trim();
    const grade = objective ? gradeChoiceQuestions([question], answers)[0] : undefined;
    const knowledgePointIds = (question.knowledgePointIds ?? []).filter((id) => allowedKnowledgePointIds.has(id));
    const units = (question.teachingUnitIds ?? []).filter((id) => allowedTeachingUnitIds.has(id));
    const matchingPairs = question.matchingPairs;
    return {
      questionId: question.id,
      prompt: question.question,
      options: sanitizeQuestionOptions(question.options),
      matchingOptions: matchingPairs ? {
        left: matchingPairs.map((pair) => pair.left),
        right: matchingPairs.map((pair) => pair.right),
      } : undefined,
      answer,
      rawAnswer,
      questionType: question.type,
      gradingRubric: question.commentPrompt,
      points,
      earned: grade?.earned ?? 0,
      correct: objective ? grade?.correct ?? false : null,
      gradingStatus: objective || empty ? "graded" : "pending",
      feedback: objective
        ? (question.analysis || (grade?.correct ? "回答正确。" : "请对照题目解析复习。"))
        : empty ? "未作答。" : "答案已提交，等待 AI 批阅。",
      referenceAnswer: question.analysis,
      knowledgePointIds: knowledgePointIds.length ? knowledgePointIds : [...section.knowledgePointIds],
      teachingUnitIds: units.length ? units : [...teachingUnitIds],
    };
  });
  return withGradeSummary({
    id: `lecture-attempt-${studentId}-${section.quizOutlineId}`,
    sectionId: section.id,
    quizOutlineId: section.quizOutlineId,
    runtimeSceneId: scene.id,
    submittedAt: new Date().toISOString(),
    gradingSource: "server",
    gradingStatus: "pending",
    score: 0,
    maxScore: 0,
    knowledgePointIds: section.knowledgePointIds,
    questions,
  });
}

const gradingJobs = new Map<string, Promise<KnowledgeLectureAttempt>>();

async function finishGrading(
  request: NextRequest,
  body: KnowledgeLectureRequest,
  courseId: string,
  studentId: string,
  attempt: KnowledgeLectureAttempt,
): Promise<KnowledgeLectureAttempt> {
  const ungraded = attempt.questions.filter((question) => question.gradingStatus === "pending" || question.gradingStatus === "failed");
  if (!ungraded.length) return attempt;
  const key = `${courseId}:${studentId}:${attempt.id}`;
  const pending = gradingJobs.get(key);
  if (pending) return pending;
  const job = (async () => {
    const results = new Map<string, KnowledgeLectureQuestionReview>();
    let model: Awaited<ReturnType<typeof resolveModelFromRequest>> | undefined;
    try {
      model = await resolveModelFromRequest(request, body, "quiz-grade");
    } catch {
      // Keep submitted answers for a later retry.
    }
    for (const question of ungraded) {
      if (!model) {
        results.set(question.questionId, { ...question, gradingStatus: "failed", feedback: "批阅服务暂时不可用，请稍后重试。" });
        continue;
      }
      try {
        const output = await callLLM({
          model: model.model,
          abortSignal: request.signal,
          system: `你是教育评估专家。仅依据题目、评分要点和学生实际答案评分，不推测未写内容。严格输出 JSON：{"score": 0 到题目满分之间的数字, "comment": "简短评语"}。`,
          prompt: `题目：${question.prompt}\n满分：${question.points}\n评分要点：${question.gradingRubric || "按准确性、相关性、完整性与推理质量评分"}\n学生答案：${question.answer}`,
        }, "quiz-grade", undefined, model.thinkingConfig);
        const grade = parseQuizGradeResponse(output.text.trim(), question.points);
        results.set(question.questionId, {
          ...question,
          earned: grade.score,
          correct: null,
          gradingStatus: "graded",
          feedback: grade.comment || "AI 已完成批阅。",
        });
      } catch {
        results.set(question.questionId, { ...question, gradingStatus: "failed", feedback: "批阅服务暂时不可用，请稍后重试。" });
      }
    }
    let saved = attempt;
    await updateCourse(courseId, (current) => {
      const progress = current.aiLearningProgress?.[studentId];
      const attempts = progress?.knowledgeLectureAttempts ?? [];
      const currentAttempt = attempts.find((item) => item.id === attempt.id);
      if (!progress || progress.classroomId !== (current.aiLearningClassroomId || current.content._openmaicClassroomId)
        || !currentAttempt || currentAttempt.gradingSource !== "server") return current;
      saved = withGradeSummary({
        ...currentAttempt,
        questions: currentAttempt.questions.map((question) =>
          question.gradingStatus === "graded" ? question : results.get(question.questionId) ?? question),
      });
      return {
        ...current,
        aiLearningProgress: {
          ...current.aiLearningProgress,
          [studentId]: {
            ...progress,
            knowledgeLectureAttempts: attempts.map((item) => item.id === attempt.id ? saved : item),
            lastActiveAt: new Date().toISOString(),
          },
        },
      };
    }, { targetStudentId: studentId });
    return saved;
  })();
  gradingJobs.set(key, job);
  try {
    return await job;
  } finally {
    gradingJobs.delete(key);
  }
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
  if (!await authorized(request, courseId, studentId,
    body.action === "record-attempt" || body.action === "retry-grading")) {
    return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  const course = await getCourse(courseId);
  if (!course || !course.students.some((student) => student.id === studentId)) {
    return Response.json({ error: "STUDENT_NOT_FOUND" }, { status: 404 });
  }

  if (body.action === "retry-grading") {
    const quizOutlineId = text(body.quizOutlineId, 160);
    const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
    const currentProgress = course.aiLearningProgress?.[studentId];
    const attempt = currentProgress && currentProgress.classroomId === classroomId
      ? currentProgress.knowledgeLectureAttempts?.find((item) => item.quizOutlineId === quizOutlineId && item.gradingSource === "server")
      : undefined;
    if (!attempt) return Response.json({ error: "QUIZ_ATTEMPT_NOT_FOUND" }, { status: 404 });
    return Response.json({ attempt: await finishGrading(request, body, courseId, studentId, attempt) });
  }

  if (body.action === "record-attempt") {
    const sectionId = text(body.sectionId, 160);
    const quizOutlineId = text(body.quizOutlineId, 160);
    const runtimeSceneId = text(body.runtimeSceneId, 160);
    const section = course.content.knowledgeLectureSections?.find((item) => item.id === sectionId);
    if (!section || section.quizOutlineId !== quizOutlineId || !runtimeSceneId) {
      return Response.json({ error: "SECTION_NOT_FOUND" }, { status: 404 });
    }
    const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
    if (!classroomId) return Response.json({ error: "QUIZ_SCENE_NOT_FOUND" }, { status: 404 });
    const classroom = await readClassroom(classroomId);
    const scene = classroom?.scenes.find((item) => item.id === runtimeSceneId);
    if (!scene || scene.content?.type !== "quiz"
      || (scene.outlineId || scene.id) !== quizOutlineId
      || (scene.lectureSectionId && scene.lectureSectionId !== sectionId)) {
      return Response.json({ error: "QUIZ_SCENE_NOT_FOUND" }, { status: 404 });
    }
    const answers = submittedAnswers(scene.content.questions, body.answers);
    if (!answers) return Response.json({ error: "QUIZ_ANSWERS_INVALID" }, { status: 400 });
    const blueprintSection = course.content.teachingBlueprint?.sections.find((item) => item.id === sectionId);
    const teachingUnitIds = blueprintSection?.units.map((unit) => unit.id) ?? [];
    let attempt: KnowledgeLectureAttempt;
    try {
      attempt = createAttempt(scene, section, teachingUnitIds, studentId, answers);
    } catch {
      return Response.json({ error: "QUIZ_QUESTION_INVALID" }, { status: 400 });
    }
    let savedAttempt = attempt;
    try {
      await updateCourse(courseId, (current) => {
        if ((current.aiLearningClassroomId || current.content._openmaicClassroomId) !== classroomId) {
          throw new Error("QUIZ_SCENE_CHANGED");
        }
        const storedProgress = current.aiLearningProgress?.[studentId];
        const currentProgress = storedProgress?.classroomId === classroomId
          ? storedProgress
          : emptyProgress(studentId, classroomId);
        const existingAttempt = (currentProgress.knowledgeLectureAttempts ?? [])
          .filter((item) => item.quizOutlineId === quizOutlineId)
          .sort((left, right) => Date.parse(left.submittedAt) - Date.parse(right.submittedAt))[0];
        if (existingAttempt) {
          if (existingAttempt.gradingSource !== "server" || !sameSubmittedAnswers(existingAttempt, answers)) {
            throw new QuizAlreadySubmittedError(existingAttempt);
          }
          savedAttempt = existingAttempt;
          return current;
        }
        return {
          ...current,
          aiLearningProgress: {
            ...(current.aiLearningProgress ?? {}),
            [studentId]: {
              ...currentProgress,
              knowledgeLectureAttempts: [
                ...(currentProgress.knowledgeLectureAttempts ?? []),
                attempt,
              ],
              lastActiveAt: attempt.submittedAt,
            },
          },
        };
      }, { targetStudentId: studentId });
    } catch (error) {
      if (error instanceof QuizAlreadySubmittedError) {
        return Response.json({ error: error.message, attempt: error.attempt }, { status: 409 });
      }
      if (error instanceof Error && error.message === "QUIZ_SCENE_CHANGED") {
        return Response.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }
    return Response.json({ attempt: await finishGrading(request, body, courseId, studentId, savedAttempt) });
  }

  const attemptId = text(body.attemptId, 200);
  const questionId = text(body.questionId, 160);
  const initialExplanation = body.action === "tutor-explain";
  const message = initialExplanation
    ? "请开始讲解这道题，先指出作答中最关键的问题，再用简短板书给出正确理解路径。"
    : text(body.message, 1_000);
  const storedProgress = course.aiLearningProgress?.[studentId];
  const progress = storedProgress?.classroomId === (course.aiLearningClassroomId || course.content._openmaicClassroomId)
    ? storedProgress
    : undefined;
  const attempt = progress?.knowledgeLectureAttempts?.find((item) => item.id === attemptId);
  const question = attempt?.questions.find((item) => item.questionId === questionId);
  if (!attempt || !question || !message) {
    return Response.json({ error: "QUESTION_CONTEXT_NOT_FOUND" }, { status: 404 });
  }
  const choices = questionChoicesText({
    options: question.options ?? sanitizeQuestionOptions(body.options),
    matchingOptions: question.matchingOptions ?? sanitizeMatchingOptions(body.matchingOptions),
  });
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
    prompt: `知识点：${knowledgePointNames.join("、")}\n题目：${question.prompt}${choices ? `\n${choices}` : ""}\n学生答案：${question.answer || "未作答"}\n批阅状态：${question.gradingStatus || "历史记录未核验"}\n批阅反馈：${question.feedback}\n参考讲解：${question.referenceAnswer || "未提供"}\n已有对话：\n${recentConversation || "无"}\n学生追问：${message}`,
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
    const classroomId = current.aiLearningClassroomId || current.content._openmaicClassroomId || "";
    const storedProgress = current.aiLearningProgress?.[studentId];
    const currentProgress = storedProgress?.classroomId === classroomId
      ? storedProgress
      : emptyProgress(studentId, classroomId);
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
