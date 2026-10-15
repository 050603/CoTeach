import type { Prisma } from '@prisma/client';
import { authenticateRequest, requireSameOrigin } from '@/lib/auth/request-guards';
import { PlatformError } from '@/lib/platform/repository';
import { withHttpMetrics } from '@/lib/observability/http';
import { logger } from '@/lib/observability/logger';
import { withClassroomAiUsage } from '@/lib/observability/classroom-ai';
import { withClassroomAiCapacity } from '@/lib/llm/classroom-capacity';
import { streamLLM } from '@openmaic/lib/ai/llm';
import { resolveKnowledgeTutorModel } from '@/lib/courses/knowledge-explanations';
import { TUTOR_EXECUTION_MS } from '@/lib/courses/knowledge-tutor-payload';
import { loadLectureChatContext, resolveLectureChatEvidence } from '@/lib/courses/lecture-chat-context';
import type { LectureChatContext } from '@/lib/courses/lecture-chat-context';
import { claimLectureChatRequest, failLectureChatRequest, finishLectureChatRequest, readLectureChatHistory, retainLectureChatAnswer } from '@/lib/courses/lecture-chat-store';
import type { LectureChatRequest, RetainedLectureChatAnswer } from '@/lib/courses/lecture-chat-store';
import { createLectureChatTextFilter, lectureChatAnswer, lectureChatSystemPrompt } from '@/lib/courses/lecture-chat-answer';
import type { LectureChatInput, LectureChatStreamEvent } from '@/lib/courses/lecture-chat-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;
type RouteContext = { params: Promise<{ courseId: string }> };
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function errorResponse(error: unknown): Response {
  if (error instanceof PlatformError) return Response.json({ error: error.code, code: error.code, message: error.message },
    { status: error.status, headers: privateHeaders });
  logger.error({ event: 'lecture-chat-request-failed', errorName: error instanceof Error ? error.name : 'Unknown' }, 'Lecture chat request failed');
  return Response.json({ error: 'LECTURE_CHAT_UNAVAILABLE', message: '随课答疑暂时不可用，请稍后重试。' },
    { status: 503, headers: privateHeaders });
}
function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f]/.test(value)) {
    throw new PlatformError('INVALID_LECTURE_CHAT_INPUT', '页面或请求标识无效。', 400);
  }
  return value;
}
function parseInput(value: unknown): LectureChatInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlatformError('INVALID_LECTURE_CHAT_INPUT', '提问格式无效。', 400);
  const body = value as Record<string, unknown>;
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 1_000
    || !Number.isSafeInteger(body.actionIndex) || Number(body.actionIndex) < 0
    || (body.mediaTimeMs !== undefined && (!Number.isSafeInteger(body.mediaTimeMs) || Number(body.mediaTimeMs) < 0))) {
    throw new PlatformError('INVALID_LECTURE_CHAT_INPUT', '请输入问题，并提供有效的讲解位置（问题最多 1000 字）。', 400);
  }
  // Explicitly pick the contract: no client-supplied identity, source, answers or system prompt.
  return { classroomId: requiredId(body.classroomId), sceneId: requiredId(body.sceneId), requestId: requiredId(body.requestId),
    message: body.message.trim(), actionIndex: Number(body.actionIndex),
    ...(body.mediaTimeMs === undefined ? {} : { mediaTimeMs: Number(body.mediaTimeMs) }) };
}
function assertWritable(context: LectureChatContext): void {
  if (context.blockedByQuiz) throw new PlatformError('QUIZ_NOT_SUBMITTED', '请先完成并提交当前小测，再继续提问。', 409);
  if (!context.writable) throw new PlatformError('CLASSROOM_READ_ONLY', '课堂当前无法发起新问题，已有问答仍可回看。', 409);
}
function assertCurrent(context: LectureChatContext, expected: LectureChatContext): void {
  if (context.sessionVersion !== expected.sessionVersion) throw new PlatformError('UNAUTHORIZED', '登录状态已变化，请重新登录。', 401);
  if (context.templateVersionId !== expected.templateVersionId || context.sceneFingerprint !== expected.sceneFingerprint
    || context.participationId !== expected.participationId) {
    throw new PlatformError('LECTURE_CHAT_CONTEXT_CHANGED', '课程内容已更新，请回到当前页面重新提问。', 409);
  }
}

async function getHistory(request: Request, route: RouteContext): Promise<Response> {
  const auth = await authenticateRequest(request, 'student');
  if ('response' in auth) return auth.response;
  if (auth.claims.role !== 'student' || !auth.claims.sub) return new Response(null, { status: 403 });
  try {
    const { courseId } = await route.params;
    const query = new URL(request.url).searchParams;
    const context = await loadLectureChatContext(courseId, auth.claims.sub,
      { classroomId: requiredId(query.get('classroomId')), sceneId: requiredId(query.get('sceneId')) }, { actionIndex: 0 });
    if (context.sessionVersion !== auth.claims.sv) throw new PlatformError('UNAUTHORIZED', '登录状态已变化，请重新登录。', 401);
    return Response.json(await readLectureChatHistory(context, context.writable), { headers: privateHeaders });
  } catch (error) { return errorResponse(error); }
}

async function postQuestion(request: Request, route: RouteContext): Promise<Response> {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const auth = await authenticateRequest(request, 'student');
  if ('response' in auth) return auth.response;
  if (auth.claims.role !== 'student' || !auth.claims.sub) return new Response(null, { status: 403 });
  try {
    const { courseId } = await route.params;
    let rawInput: unknown;
    try { rawInput = await request.json(); }
    catch { throw new PlatformError('INVALID_LECTURE_CHAT_INPUT', '提问格式无效。', 400); }
    const input = parseInput(rawInput);
    const context = await loadLectureChatContext(courseId, auth.claims.sub, input,
      { actionIndex: input.actionIndex, ...(input.mediaTimeMs === undefined ? {} : { mediaTimeMs: input.mediaTimeMs }) });
    if (context.sessionVersion !== auth.claims.sv) throw new PlatformError('UNAUTHORIZED', '登录状态已变化，请重新登录。', 401);
    const stored: LectureChatRequest = { courseId, studentId: context.studentId, participationId: context.participationId,
      offeringId: context.offeringId, templateVersionId: context.templateVersionId, classroomId: context.classroomId,
      sceneId: context.sceneId, sceneFingerprint: context.sceneFingerprint, pageTitle: context.pageTitle,
      sessionVersion: context.sessionVersion, position: context.position, message: input.message, requestId: input.requestId };
    const guard = (newQuestion: boolean) => async (tx: Prisma.TransactionClient) => {
      const fresh = await loadLectureChatContext(courseId, stored.studentId, input, stored.position, tx);
      assertCurrent(fresh, context);
      if (newQuestion) assertWritable(fresh);
    };
    // Replay accepted requests even after page navigation or classroom closure.
    const claim = await claimLectureChatRequest(stored, guard(true), guard(false));
    if (!claim.run && claim.status !== 'COMPLETED') {
      if (claim.status === 'RUNNING') return Response.json({ status: 'RUNNING' }, { status: 202, headers: privateHeaders });
      return Response.json({ error: claim.error ?? 'LECTURE_CHAT_REQUEST_FAILED',
        message: '上次答复未完成，请重新发送问题。' }, { status: 409, headers: privateHeaders });
    }
    const encoder = new TextEncoder();
    let disconnected = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: LectureChatStreamEvent) => {
          if (disconnected) return;
          try { controller.enqueue(encoder.encode(JSON.stringify(event) + '\n')); }
          catch { disconnected = true; }
        };
        const close = () => { if (!disconnected) { try { controller.close(); } catch { /* Browser already closed. */ } } };
        if (!claim.run) { emit({ type: 'done', thread: claim.thread! }); close(); return; }
        // A browser disconnect stops delivery, while a server-owned deadline controls execution.
        void (async () => {
          const signal = AbortSignal.timeout(TUTOR_EXECUTION_MS);
          let raw = claim.retained?.raw ?? '';
          let retained: RetainedLectureChatAnswer | undefined = claim.retained;
          let saving = Boolean(retained);
          try {
            if (retained) {
              emit({ type: 'status', message: '正在恢复已经生成的答复…' });
              const thread = await finishLectureChatRequest(stored, claim.token, retained.answer, retained.citations, retained.raw, guard(false));
              emit({ type: 'done', thread });
              return;
            }
            emit({ type: 'status', message: '正在组织回答…' });
            const history = await readLectureChatHistory(context, context.writable);
            const completeRequests = new Set(history.thread.messages.filter(message => message.role === 'assistant').map(message => message.requestId));
            const priorQuestion = history.thread.messages.filter(message => message.role === 'student'
              && completeRequests.has(message.requestId) && message.requestId !== input.requestId).at(-1);
            const evidenceQuery = priorQuestion ? `当前问题：${input.message}\n本页上一问题：${priorQuestion.content}` : input.message;
            const evidence = await resolveLectureChatEvidence(context, evidenceQuery, signal);
            signal.throwIfAborted();
            const messages = history.thread.messages.filter(message => completeRequests.has(message.requestId) && message.requestId !== input.requestId)
              .slice(-80).map(message => ({ role: message.role === 'student' ? 'user' as const : 'assistant' as const, content: message.content }));
            const model = await resolveKnowledgeTutorModel();
            const filter = createLectureChatTextFilter();
            await withClassroomAiUsage({ feature: 'lecture-chat', courseId, studentId: stored.studentId, requestId: input.requestId },
              () => withClassroomAiCapacity(async () => {
                const result = streamLLM({ model: model.model,
                  system: lectureChatSystemPrompt(context, evidence),
                  messages: [...messages, { role: 'user', content: input.message }], abortSignal: signal, maxRetries: 0 }, 'lecture-chat', model.thinkingConfig);
                let finished = false;
                for await (const part of result.fullStream) {
                  signal.throwIfAborted();
                  if (part.type === 'error') throw part.error;
                  if (part.type === 'finish') finished = true;
                  if (part.type === 'text-delta') {
                    raw += part.text;
                    const text = filter.push(part.text);
                    if (text) emit({ type: 'delta', text });
                  }
                }
                if (!finished) throw new PlatformError('LECTURE_CHAT_INCOMPLETE_OUTPUT', '答复未完整生成，请重新提问。', 502);
                const reason = await result.finishReason;
                signal.throwIfAborted();
                if (reason !== 'stop') {
                  throw new PlatformError('LECTURE_CHAT_INCOMPLETE_OUTPUT', '答复未完整生成，请重新提问。', 502);
                }
                const tail = filter.flush();
                if (tail) emit({ type: 'delta', text: tail });
                const answer = lectureChatAnswer(raw, evidence.citations);
                if (!answer.content) throw new PlatformError('LECTURE_CHAT_EMPTY_OUTPUT', '没有生成完整答复，请重新提问。', 502);
                if (answer.unknownReferences) logger.warn({ event: 'lecture-chat-reference-removed', courseId, requestId: input.requestId }, 'Unknown source marker removed');
                retained = { answer: answer.content, citations: answer.citations, raw };
                saving = true;
                await retainLectureChatAnswer(stored, claim.token, retained, guard(false));
                const thread = await finishLectureChatRequest(stored, claim.token, answer.content, answer.citations, raw, guard(false));
                emit({ type: 'done', thread });
              }, signal));
          } catch (error) {
            const code = error instanceof PlatformError ? error.code : saving ? 'LECTURE_CHAT_SAVE_FAILED'
              : signal.aborted ? 'LECTURE_CHAT_TIMEOUT' : 'LECTURE_CHAT_GENERATION_FAILED';
            let persisted = true;
            try { await failLectureChatRequest(stored, claim.token, code, raw, retained); }
            catch { persisted = false; logger.error({ event: 'lecture-chat-failure-save-failed', courseId, requestId: input.requestId }, 'Lecture chat failure could not be saved'); }
            emit({ type: 'error', error: persisted ? code : 'LECTURE_CHAT_SAVE_FAILED',
              message: !persisted ? '答复状态保存失败，请稍后回看本页问答确认结果。'
                : code === 'LECTURE_CHAT_SAVE_FAILED' ? '答复保存失败，请重试以恢复已经生成的回答。'
                : signal.aborted ? '答复超时，请重新发送问题。'
                : error instanceof PlatformError ? error.message : '答复未完成，请重新发送问题。' });
          } finally { close(); }
        })();
      },
      cancel() { disconnected = true; },
    });
    return new Response(stream, { headers: { ...privateHeaders, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' } });
  } catch (error) { return errorResponse(error); }
}

export const GET = withHttpMetrics('GET', '/api/courses/:courseId/lecture-chat', getHistory);
export const POST = withHttpMetrics('POST', '/api/courses/:courseId/lecture-chat', postQuestion);
