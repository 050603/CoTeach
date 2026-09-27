import { createHash, randomUUID } from "node:crypto";
import { isDatabaseConfigured } from "@/lib/db/client";
import { appendDurableAiInteractionEvents } from "@/lib/ai-collaboration/audit-outbox";
import type { AiInteractionEventInput } from "@/lib/ai-collaboration/audit-store";
import type { KnowledgeLectureQuestionReview } from "@/lib/session/types";
import { callLLM } from "@openmaic/lib/ai/llm";
import type { resolveModelFromRequest } from "@openmaic/lib/server/resolve-model";
import { parseQuizGradeResponse } from "@openmaic/lib/quiz/grade-response";

type Model = Awaited<ReturnType<typeof resolveModelFromRequest>>;
type Input = {
  courseId: string; studentId: string; classroomId: string; attemptId: string;
  question: KnowledgeLectureQuestionReview; signal: AbortSignal; resolveModel: () => Promise<Model>;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Only fixed categories are persisted: provider exceptions may contain credentials or URLs. */
export function gradingFailureCode(error: unknown, phase: "resolve" | "model" | "parse", signal: AbortSignal): string {
  const chain: Array<{ name?: unknown; code?: unknown; message?: unknown; statusCode?: unknown }> = [];
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    chain.push(current); current = "cause" in current ? current.cause : undefined;
  }
  if (signal.aborted || chain.some(item => item.name === "AbortError")) return "CANCELLED";
  if (phase === "resolve") return "MODEL_RESOLUTION_FAILED";
  if (phase === "parse") {
    return chain.some(item => item.message === "QUIZ_GRADE_INVALID_SCORE") ? "INVALID_SCORE" : "INVALID_JSON";
  }
  if (chain.some(item => item.name === "TimeoutError" || ["ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(String(item.code)))) return "PROVIDER_TIMEOUT";
  if (chain.some(item => item.statusCode === 429 || item.name === "LlmRateLimitError")) return "CAPACITY_OR_RATE_LIMIT";
  return "PROVIDER_REQUEST_FAILED";
}

/** A new invocation gets new immutable facts; durable retries reuse the IDs in each batch. */
export async function gradeKnowledgeLectureQuestion(input: Input): Promise<KnowledgeLectureQuestionReview> {
  const { question } = input;
  const callAttemptId = randomUUID();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const system = '你是教育评估专家。仅依据题目、评分要点和学生实际答案评分，不推测未写内容。严格输出 JSON：{"score": 0 到题目满分之间的数字, "comment": "简短评语"}。';
  const prompt = `题目：${question.prompt}\n满分：${question.points}\n评分要点：${question.gradingRubric || "按准确性、相关性、完整性与推理质量评分"}\n学生答案：${question.answer}`;
  const detail = { kind: "knowledge-quiz-grading", callAttemptId, attemptId: input.attemptId,
    questionId: question.questionId, classroomId: input.classroomId, startedAt, answerSha256: digest(question.answer) };
  const event = (suffix: string, eventType: AiInteractionEventInput["eventType"], content: string, payload: Record<string, unknown>): AiInteractionEventInput => ({
    id: `knowledge-grade:${callAttemptId}:${suffix}`, requestId: callAttemptId,
    courseId: input.courseId, studentId: input.studentId, stageKey: "ai-learning", conversationId: input.attemptId,
    source: "submission", eventType, actorRole: suffix === "request" ? "student" : "system",
    content, payload: { ...detail, visibility: "teacher-only", ...payload }, createdAt: new Date().toISOString(),
  });
  const retain = async (events: AiInteractionEventInput[]) => {
    if (isDatabaseConfigured()) await appendDurableAiInteractionEvents(events);
  };
  // If neither the database nor durable outbox accepts the input, do not call the model.
  await retain([event("request", "request", question.answer, { status: "started", system, prompt, points: question.points })]);
  let phase: "resolve" | "model" | "parse" = "resolve";
  let raw: string | undefined;
  let modelId: string | undefined;
  let review: KnowledgeLectureQuestionReview;
  let errorCode: string | undefined;
  try {
    input.signal.throwIfAborted();
    const model = await input.resolveModel();
    modelId = typeof model.model === "object" && "modelId" in model.model ? String(model.model.modelId) : undefined;
    phase = "model";
    const output = await callLLM({ model: model.model, abortSignal: input.signal, maxRetries: 0, system, prompt }, "quiz-grade", undefined, model.thinkingConfig);
    raw = output.text;
    phase = "parse";
    input.signal.throwIfAborted();
    const grade = parseQuizGradeResponse(raw.trim(), question.points);
    review = { ...question, earned: grade.score, correct: null, gradingStatus: "graded", feedback: grade.comment || "AI 已完成批阅。" };
  } catch (error) {
    errorCode = gradingFailureCode(error, phase, input.signal);
    review = { ...question, gradingStatus: "failed", feedback: "批阅服务暂时不可用，请稍后重试。" };
  }
  const status = errorCode === "CANCELLED" ? "cancelled" : errorCode ? "failed" : "success";
  const outcome = { status, ...(errorCode ? { errorCode } : {}), elapsedMs: Math.round(performance.now() - start),
    ...(modelId ? { modelId } : {}), ...(raw !== undefined ? { rawSha256: digest(raw), rawLength: raw.length } : {}) };
  // Never put this persistence inside the model catch: a full disk must not become an acknowledged failed grade.
  await retain([
    ...(raw !== undefined ? [event("raw", "response", raw, { kind: "model-output", ...outcome })] : []),
    event("terminal", errorCode ? "error" : "policy", errorCode || "AI 批阅完成。", {
      ...outcome, gradingStatus: review.gradingStatus, earned: review.earned, points: question.points, feedback: review.feedback,
    }),
  ]);
  return review;
}
