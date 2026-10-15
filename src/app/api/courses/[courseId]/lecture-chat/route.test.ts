// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformError } from '@/lib/platform/repository';
import type { LectureChatContext } from '@/lib/courses/lecture-chat-context';
import type { LectureChatInput, LectureChatStreamEvent, LectureChatThread } from '@/lib/courses/lecture-chat-types';
import type { LectureChatRequest } from '@/lib/courses/lecture-chat-store';
import { createLectureChatTextFilter, lectureChatAnswer } from '@/lib/courses/lecture-chat-answer';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), origin: vi.fn(), context: vi.fn(), evidence: vi.fn(),
  claim: vi.fn(), history: vi.fn(), retain: vi.fn(), finish: vi.fn(), fail: vi.fn(), model: vi.fn(), stream: vi.fn(), capacity: vi.fn() }));
vi.mock('@/lib/auth/request-guards', () => ({ authenticateRequest: mocks.auth, requireSameOrigin: mocks.origin }));
vi.mock('@/lib/courses/lecture-chat-context', () => ({ loadLectureChatContext: mocks.context, resolveLectureChatEvidence: mocks.evidence }));
vi.mock('@/lib/courses/lecture-chat-store', () => ({ claimLectureChatRequest: mocks.claim, readLectureChatHistory: mocks.history,
  retainLectureChatAnswer: mocks.retain, finishLectureChatRequest: mocks.finish, failLectureChatRequest: mocks.fail }));
vi.mock('@/lib/courses/knowledge-explanations', () => ({ resolveKnowledgeTutorModel: mocks.model }));
vi.mock('@openmaic/lib/ai/llm', () => ({ streamLLM: mocks.stream }));
vi.mock('@/lib/llm/classroom-capacity', () => ({ withClassroomAiCapacity: mocks.capacity }));
vi.mock('@/lib/observability/http', () => ({ withHttpMetrics: (_method: string, _route: string, handler: unknown) => handler }));
vi.mock('@/lib/observability/classroom-ai', () => ({ withClassroomAiUsage: (_scope: unknown, operation: () => unknown) => operation() }));
vi.mock('@/lib/observability/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));

import { GET, POST } from './route';
const route = { params: Promise.resolve({ courseId: 'course' }) };
const input: LectureChatInput = { classroomId: 'lecture', sceneId: 'scene', requestId: 'request',
  actionIndex: 3, mediaTimeMs: 600, message: '这里是什么意思？' };
const context: LectureChatContext = { courseId: 'course', studentId: 'authenticated-student', participationId: 'participation',
  offeringId: 'offering', templateVersionId: 'version', sessionVersion: 2, classroomId: 'lecture', sceneId: 'scene',
  pageTitle: '教材当前页', position: { actionIndex: 3, mediaTimeMs: 600 }, sceneFingerprint: 'page-fingerprint',
  writable: true, blockedByQuiz: false, knowledgePointNames: ['当前知识点'], knowledgePointIds: ['knowledge'],
  teachingUnitIds: ['unit'], pageText: '页面服务器内容', narration: '服务器讲稿', currentSpeech: '正在讲的句子',
  content: { _openmaicClassroomId: 'lecture' } };
const citation = { id: 'source-1234abcdef', textbookTitle: '课程教材', revisionId: 'revision', sectionPath: ['第一章'], quote: '真实教材原文' };
const thread: LectureChatThread = { id: 'private-thread', page: { classroomId: 'lecture', sceneId: 'scene' }, pageTitle: '教材当前页', messages: [] };
const tx = { transaction: 'fresh-scope' };

function request(body: unknown = input, extra: RequestInit = {}) {
  return new Request('https://app.test/api/courses/course/lecture-chat', { method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: 'https://app.test' }, body: JSON.stringify(body), ...extra });
}
async function events(response: Response): Promise<LectureChatStreamEvent[]> {
  return (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function answerStream(parts = ['教材解释[S', '1]。'], reason = 'stop', finished = true) {
  return { fullStream: (async function* () {
    for (const text of parts) yield { type: 'text-delta', text };
    if (finished) yield { type: 'finish', finishReason: reason };
  })(), finishReason: Promise.resolve(reason) };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ claims: { sub: 'authenticated-student', role: 'student', sv: 2 } });
  mocks.origin.mockReturnValue(null);
  mocks.context.mockResolvedValue(context);
  mocks.evidence.mockResolvedValue({ citations: [citation], prompt: '真实教材原文', degraded: false });
  mocks.claim.mockImplementation(async (_input: unknown, guard: (db: unknown) => Promise<void>) => {
    await guard(tx);
    return { run: true, token: 'owner' };
  });
  mocks.history.mockImplementation(async (_scope: unknown, writable: boolean) => ({ thread, requests: [], writable }));
  mocks.retain.mockImplementation(async (_input: unknown, _token: string, _answer: unknown, guard: (db: unknown) => Promise<void>) => guard(tx));
  mocks.finish.mockImplementation(async (stored: LectureChatRequest, _token: string, content: string, citations: unknown,
    _raw: string, guard: (db: unknown) => Promise<void>) => {
    await guard(tx);
    return { ...thread, messages: [{ id: 'assistant', role: 'assistant', content, requestId: stored.requestId,
      createdAt: new Date().toISOString(), position: stored.position, citations }] };
  });
  mocks.fail.mockResolvedValue(undefined);
  mocks.model.mockResolvedValue({ model: 'configured-tutor-model', thinkingConfig: { enabled: false } });
  mocks.stream.mockImplementation(() => answerStream());
  mocks.capacity.mockImplementation((operation: () => Promise<unknown>) => operation());
});

describe('private page-scoped lecture chat route', () => {
  it('requires a student session and same-origin requests before reading the course', async () => {
    mocks.auth.mockResolvedValueOnce({ response: new Response(null, { status: 401 }) });
    expect((await POST(request(), route)).status).toBe(401);
    mocks.origin.mockReturnValueOnce(new Response(null, { status: 403 }));
    expect((await POST(request(), route)).status).toBe(403);
    mocks.auth.mockResolvedValueOnce({ claims: { sub: 'teacher', role: 'teacher', sv: 2 } });
    expect((await GET(new Request('https://app.test/api/courses/course/lecture-chat?classroomId=lecture&sceneId=scene'), route)).status).toBe(403);
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), 'student');
  });

  it('loads private history for the authenticated identity, including read-only review', async () => {
    mocks.context.mockResolvedValue({ ...context, writable: false });
    const response = await GET(new Request('https://app.test/api/courses/course/lecture-chat?classroomId=lecture&sceneId=scene&studentId=intruder'), route);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ thread, writable: false });
    expect(mocks.context).toHaveBeenCalledWith('course', 'authenticated-student', { classroomId: 'lecture', sceneId: 'scene' }, { actionIndex: 0 });
  });

  it('passes through actual course/page permission failures and rejects stale login versions', async () => {
    mocks.context.mockRejectedValueOnce(new PlatformError('FORBIDDEN_PAGE', '不属于当前课程', 403));
    const forbidden = await POST(request(), route);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: 'FORBIDDEN_PAGE' });
    mocks.context.mockResolvedValueOnce({ ...context, sessionVersion: 3 });
    expect((await POST(request(), route)).status).toBe(401);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('rejects invalid question lengths and lecture positions before claiming a task', async () => {
    for (const replacement of [{ message: '' }, { message: '字'.repeat(1001) }, { actionIndex: -1 },
      { actionIndex: 1.5 }, { mediaTimeMs: -1 }, { sceneId: '' }, { requestId: 'a\u0000b' }]) {
      expect((await POST(request({ ...input, ...replacement }), route)).status).toBe(400);
    }
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('uses server page/materials and never passes client sources, answers, roles or identity into the model or task', async () => {
    const response = await POST(request({ ...input, studentId: 'intruder', pageText: 'fake page',
      textbook: 'fake textbook', system: 'FAKE_SYSTEM_PROMPT', referenceAnswer: 'FAKE_REFERENCE_ANSWER' }), route);
    expect(response.headers.get('Content-Type')).toContain('application/x-ndjson');
    await events(response);
    expect(mocks.claim.mock.calls[0][0]).toMatchObject({ studentId: 'authenticated-student', participationId: 'participation',
      position: { actionIndex: 3, mediaTimeMs: 600 } });
    expect(mocks.claim.mock.calls[0][0]).not.toHaveProperty('content');
    expect(mocks.claim.mock.calls[0][0]).not.toHaveProperty('narration');
    const modelInput = mocks.stream.mock.calls[0][0];
    expect(modelInput.system).toContain('正在讲的句子');
    expect(modelInput.system).toContain('真实教材原文');
    expect(modelInput.system).toContain('来源 ID、来源块 ID、版本 ID 和数据字段仅用于关联引用，不写入回答正文');
    expect(JSON.stringify(modelInput)).not.toContain('FAKE_SYSTEM_PROMPT');
    expect(JSON.stringify(modelInput)).not.toContain('FAKE_REFERENCE_ANSWER');
    expect(modelInput.model).toBe('configured-tutor-model');
    expect(mocks.capacity).toHaveBeenCalledOnce();
  });

  it('streams marker-free text and persists only citations matched to actually retrieved evidence', async () => {
    mocks.stream.mockImplementation(() => answerStream(['依据教材[S', '1]。未知[S', '99]。']));
    const output = await events(await POST(request(), route));
    expect(output.filter(event => event.type === 'delta').map(event => event.text).join('')).toBe('依据教材。未知。');
    const done = output.find(event => event.type === 'done');
    expect(done).toMatchObject({ type: 'done', thread: { messages: [{ content: '依据教材。未知。', citations: [citation] }] } });
    expect(mocks.retain).toHaveBeenCalledWith(expect.anything(), 'owner',
      { answer: '依据教材。未知。', citations: [citation], raw: '依据教材[S1]。未知[S99]。' }, expect.any(Function));
  });

  it('answers from available adopted sources when retrieval degrades and uses model knowledge when no original is found', async () => {
    mocks.evidence.mockResolvedValueOnce({ citations: [citation], prompt: '本页已有原文', degraded: true });
    const degraded = await events(await POST(request(), route));
    expect(degraded).toContainEqual({ type: 'status', message: '正在组织回答…' });
    expect(degraded.some(event => event.type === 'done')).toBe(true);
    mocks.evidence.mockResolvedValueOnce({ citations: [], prompt: '未找到足够相关教材原文', degraded: false });
    mocks.stream.mockImplementationOnce(() => answerStream(['劣构问题的目标、条件或解法不完全明确，通常需要比较多种合理方案。']));
    const missing = await events(await POST(request({ ...input, requestId: 'missing' }), route));
    expect(missing.find(event => event.type === 'done')).toMatchObject({ thread: { messages: [{ content: '劣构问题的目标、条件或解法不完全明确，通常需要比较多种合理方案。', citations: [] }] } });
    const prompt = mocks.stream.mock.calls.at(-1)![0].system;
    expect(prompt).toContain('仍可运用你掌握的可靠通用知识清楚解答');
    expect(prompt).toContain('无可用教材原文，不添加教材引用标记');
  });

  it('continues generating and saves a complete answer when retrieval has failed without any usable original', async () => {
    mocks.evidence.mockResolvedValue({ citations: [], prompt: '检索状态：本次查询发生故障，未取得的部分无法核实。', degraded: true });
    mocks.stream.mockImplementationOnce(() => answerStream(['可以先从目标、已知条件和评价标准是否明确来理解问题的结构。']));
    const output = await events(await POST(request(), route));
    expect(output.some(event => event.type === 'error')).toBe(false);
    expect(output.find(event => event.type === 'done')).toMatchObject({ thread: { messages: [{
      content: '可以先从目标、已知条件和评价标准是否明确来理解问题的结构。', citations: [],
    }] } });
    expect(mocks.stream.mock.calls[0][0].system).toContain('本次查询发生故障');
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it('cites only the actual textbook claim while retaining uncited supplementary explanation', async () => {
    mocks.stream.mockImplementationOnce(() => answerStream(['真实教材原文[S1]。', '补充解释可以用学生熟悉的生活例子。']));
    const output = await events(await POST(request(), route));
    expect(output.find(event => event.type === 'done')).toMatchObject({ thread: { messages: [{
      content: '真实教材原文。补充解释可以用学生熟悉的生活例子。', citations: [citation],
    }] } });
    expect(mocks.stream.mock.calls[0][0].system).toContain('通用解释和例子不添加教材引用');
  });

  it('keeps prior refusals as history while applying the current policy to a follow-up', async () => {
    const refusal = '课程教材暂未提供足够信息，所以我不能替劣构问题下定义。';
    mocks.history.mockResolvedValue({ thread: { ...thread, messages: [
      { id: 'old-question', role: 'student', requestId: 'old', content: '什么是劣构问题？', position: context.position, createdAt: '2026-01-01' },
      { id: 'old-answer', role: 'assistant', requestId: 'old', content: refusal, position: context.position, createdAt: '2026-01-01' },
    ] }, requests: [], writable: true });
    mocks.stream.mockImplementationOnce(() => answerStream(['劣构问题往往存在多种合理的解法，需要权衡不同标准。']));
    const followUp = '你可以解释这个概念吗？';
    const output = await events(await POST(request({ ...input, message: followUp }), route));
    const modelInput = mocks.stream.mock.calls[0][0];
    expect(modelInput.messages).toEqual([{ role: 'user', content: '什么是劣构问题？' },
      { role: 'assistant', content: refusal }, { role: 'user', content: followUp }]);
    expect(modelInput.system).toContain('即使之前因缺少教材而拒答，新的追问也按当前策略重新解答');
    expect(output.some(event => event.type === 'done')).toBe(true);
  });

  it('replays completed requests and returns running/final failures without calling the model', async () => {
    mocks.claim.mockResolvedValueOnce({ run: false, status: 'RUNNING' });
    const running = await POST(request(), route);
    expect(running.status).toBe(202);
    expect(await running.json()).toEqual({ status: 'RUNNING' });
    mocks.claim.mockResolvedValueOnce({ run: false, status: 'FAILED', error: 'REQUEST_INTERRUPTED' });
    const failed = await POST(request(), route);
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ error: 'REQUEST_INTERRUPTED' });
    mocks.claim.mockResolvedValueOnce({ run: false, status: 'COMPLETED', thread });
    expect(await events(await POST(request(), route))).toEqual([{ type: 'done', thread }]);
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('guards new questions against unsubmitted quizzes while allowing accepted answers to finish after navigation', async () => {
    mocks.context.mockResolvedValue({ ...context, blockedByQuiz: true, writable: false });
    const blocked = await POST(request(), route);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: 'QUIZ_NOT_SUBMITTED' });
    expect(mocks.stream).not.toHaveBeenCalled();
    mocks.context.mockResolvedValueOnce(context).mockResolvedValueOnce(context)
      .mockResolvedValue({ ...context, blockedByQuiz: true, writable: false });
    const finished = await events(await POST(request({ ...input, requestId: 'accepted' }), route));
    expect(finished.some(event => event.type === 'done')).toBe(true);
  });

  it('marks partial provider errors, missing finish signals and non-stop finishes as failures', async () => {
    const partial = { fullStream: (async function* () {
      yield { type: 'text-delta', text: '不完整的解释' };
      yield { type: 'error', error: new Error('upstream failed') };
    })(), finishReason: Promise.resolve('error') };
    mocks.stream.mockReturnValueOnce(partial);
    const failed = await events(await POST(request(), route));
    expect(failed.some(event => event.type === 'delta')).toBe(true);
    expect(failed.some(event => event.type === 'done')).toBe(false);
    expect(mocks.fail).toHaveBeenCalledWith(expect.anything(), 'owner', 'LECTURE_CHAT_GENERATION_FAILED', '不完整的解释', undefined);
    for (const [reason, finished] of [['stop', false], ['length', true], ['other', true]] as const) {
      mocks.stream.mockReturnValueOnce(answerStream(['不完整'], reason, finished));
      const output = await events(await POST(request({ ...input, requestId: reason }), route));
      expect(output.find(event => event.type === 'error')).toMatchObject({ error: 'LECTURE_CHAT_INCOMPLETE_OUTPUT' });
    }
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.retain).not.toHaveBeenCalled();
  });

  it('checks source/version again before completion and never marks a stale answer complete', async () => {
    mocks.context.mockResolvedValueOnce(context).mockResolvedValueOnce(context)
      .mockResolvedValue({ ...context, sceneFingerprint: 'updated-page' });
    const output = await events(await POST(request(), route));
    expect(output.some(event => event.type === 'done')).toBe(false);
    expect(output.find(event => event.type === 'error')).toMatchObject({ error: 'LECTURE_CHAT_CONTEXT_CHANGED' });
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it('retains a complete answer on save failure and resumes its checkpoint without another model call', async () => {
    mocks.finish.mockRejectedValueOnce(new Error('database save lost'));
    const failed = await events(await POST(request(), route));
    expect(failed.find(event => event.type === 'error')).toMatchObject({ error: 'LECTURE_CHAT_SAVE_FAILED' });
    expect(mocks.fail.mock.calls[0][4]).toEqual({ answer: '教材解释。', citations: [citation], raw: '教材解释[S1]。' });
    mocks.claim.mockResolvedValueOnce({ run: true, token: 'new-owner', retained: mocks.fail.mock.calls[0][4] });
    const resumed = await events(await POST(request(), route));
    expect(resumed.some(event => event.type === 'done')).toBe(true);
    expect(mocks.stream).toHaveBeenCalledOnce();
    expect(mocks.evidence).toHaveBeenCalledOnce();
  });

  it('continues generating and saving after the browser disconnects', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let saved!: () => void;
    const completed = new Promise<void>(resolve => { saved = resolve; });
    mocks.stream.mockImplementation(() => ({ fullStream: (async function* () {
      await waiting;
      yield { type: 'text-delta', text: '仍会保存[S1]' };
      yield { type: 'finish', finishReason: 'stop' };
    })(), finishReason: Promise.resolve('stop') }));
    mocks.finish.mockImplementation(async (_stored, _token, _content, _citations, _raw, guard) => {
      await guard(tx); saved(); return thread;
    });
    const browser = new AbortController();
    const response = await POST(request(input, { signal: browser.signal }), route);
    const reader = response.body!.getReader();
    await reader.read();
    browser.abort();
    await reader.cancel();
    release();
    await completed;
    expect(mocks.stream.mock.calls[0][0].abortSignal.aborted).toBe(false);
    expect(mocks.finish).toHaveBeenCalledOnce();
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it('uses only completed page-local history to resolve follow-up questions', async () => {
    const oldPosition = { actionIndex: 0 };
    mocks.history.mockResolvedValue({ thread: { ...thread, messages: [
      { id: '1', role: 'student', requestId: 'old', content: '上一个问题', position: oldPosition, createdAt: '2026-01-01' },
      { id: '2', role: 'assistant', requestId: 'old', content: '上一个教材回答', position: oldPosition, createdAt: '2026-01-01' },
      { id: '3', role: 'student', requestId: 'failed', content: '失败的问题', position: oldPosition, createdAt: '2026-01-01' },
      { id: '4', role: 'student', requestId: 'request', content: input.message, position: context.position, createdAt: '2026-01-01' },
    ] }, requests: [], writable: true });
    await events(await POST(request(), route));
    expect(mocks.stream.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: '上一个问题' }, { role: 'assistant', content: '上一个教材回答' }, { role: 'user', content: input.message },
    ]);
    expect(mocks.evidence).toHaveBeenCalledWith(context, `当前问题：${input.message}\n本页上一问题：上一个问题`, expect.any(AbortSignal));
  });
});

describe('lecture source marker validation', () => {
  it('deduplicates allowed sources and drops forged source ids', () => {
    const parsed = lectureChatAnswer('定义[S1]，再解释[source-1234abcdef]。伪造[source-bad]。', [citation]);
    expect(parsed).toEqual({ content: '定义，再解释。伪造。', citations: [citation], unknownReferences: true });
  });

  it('preserves ordinary math brackets and strips split source ids without flashing them', () => {
    const filter = createLectureChatTextFilter();
    const output = [filter.push('数列[1, 2]，解释['), filter.push('source-1234'), filter.push('abcdef]。'), filter.flush()].join('');
    expect(output).toBe('数列[1, 2]，解释。');
  });
});
