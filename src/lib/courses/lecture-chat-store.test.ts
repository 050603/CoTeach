// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformError } from '@/lib/platform/repository';
import type { LectureChatCitation } from './lecture-chat-types';

type Task = { id: string; conversationId: string; createdById: string; taskType: string;
  status: string; input: Record<string, unknown>; output?: unknown; error?: string | null;
  startedAt: Date; createdAt: Date; completedAt?: Date };
type Message = { id: string; conversationId: string; role: string; content: string; metadata: unknown; createdAt: Date };
const mocks = vi.hoisted(() => {
  const tasks = new Map<string, Task>();
  const conversations = new Map<string, Record<string, unknown>>();
  const messages: Message[] = [];
  const tx = {
    aiTask: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    aiConversation: { findFirst: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    aiMessage: { findMany: vi.fn(), create: vi.fn() },
  };
  return { tasks, conversations, messages, tx, lock: vi.fn(), transaction: vi.fn() };
});
vi.mock('@/lib/db/transaction-retry', () => ({ runMutationTransaction: mocks.transaction }));
vi.mock('@/lib/db/session-repository', () => ({ lockProjectedCourse: mocks.lock }));

import { claimLectureChatRequest, failLectureChatRequest, finishLectureChatRequest,
  lectureChatConversationId, readLectureChatHistory, retainLectureChatAnswer, type LectureChatRequest } from './lecture-chat-store';

const request: LectureChatRequest = {
  courseId: 'course', studentId: 'student', participationId: 'participation', offeringId: 'offering',
  templateVersionId: 'version', classroomId: 'lecture', sceneId: 'scene', sceneFingerprint: 'fingerprint',
  pageTitle: '当前页', sessionVersion: 2, requestId: 'request', message: '为什么这样？',
  position: { actionIndex: 4, mediaTimeMs: 800 },
};
const citations: LectureChatCitation[] = [{ id: 'source-a', textbookTitle: '测试教材', revisionId: 'revision',
  sectionPath: ['第一章'], quote: '教材完整原文' }];
const guard = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  mocks.tasks.clear(); mocks.conversations.clear(); mocks.messages.length = 0;
  let queue: Promise<unknown> = Promise.resolve();
  mocks.transaction.mockImplementation((operation: (tx: typeof mocks.tx) => Promise<unknown>) => {
    const run = queue.then(() => operation(mocks.tx));
    queue = run.catch(() => undefined);
    return run;
  });
  const matches = (row: Task, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => row[key as keyof Task] === value);
  mocks.tx.aiTask.findUnique.mockImplementation(async ({ where }) => mocks.tasks.get(where.id) ?? null);
  mocks.tx.aiTask.findFirst.mockImplementation(async ({ where }) => [...mocks.tasks.values()].find(row => matches(row, where)) ?? null);
  mocks.tx.aiTask.findMany.mockImplementation(async ({ where }) => [...mocks.tasks.values()].filter(row => matches(row, where)));
  mocks.tx.aiTask.create.mockImplementation(async ({ data }) => {
    const row = { ...data, createdAt: new Date() };
    mocks.tasks.set(data.id, row);
    return row;
  });
  mocks.tx.aiTask.update.mockImplementation(async ({ where, data }) => Object.assign(mocks.tasks.get(where.id)!, data));
  mocks.tx.aiConversation.upsert.mockImplementation(async ({ where, create }) => {
    if (!mocks.conversations.has(where.id)) mocks.conversations.set(where.id, create);
    return mocks.conversations.get(where.id);
  });
  mocks.tx.aiConversation.findFirst.mockImplementation(async ({ where }) => {
    const row = mocks.conversations.get(where.id);
    return row && row.userId === where.userId && row.participationId === where.participationId ? row : null;
  });
  mocks.tx.aiMessage.create.mockImplementation(async ({ data }) => {
    const row = { ...data, createdAt: new Date() };
    mocks.messages.push(row);
    return row;
  });
  mocks.tx.aiMessage.findMany.mockImplementation(async ({ where }) => mocks.messages.filter(row => row.conversationId === where.conversationId));
  guard.mockResolvedValue(undefined);
});

describe('durable private lecture questions', () => {
  it('coalesces concurrent duplicate requests before recording messages or calling the model', async () => {
    const claims = await Promise.all([claimLectureChatRequest(request, guard), claimLectureChatRequest(request, guard)]);
    expect(claims.filter(claim => claim.run)).toHaveLength(1);
    expect(claims.filter(claim => !claim.run)).toEqual([{ run: false, status: 'RUNNING' }]);
    expect(mocks.tx.aiTask.create).toHaveBeenCalledOnce();
    expect(mocks.messages).toHaveLength(1);
    expect(guard).toHaveBeenCalledOnce();
    expect(mocks.lock).toHaveBeenCalledWith(mocks.tx, 'course');
  });

  it('replays committed answers with exact content, references and lecture position', async () => {
    const claim = await claimLectureChatRequest(request, guard);
    if (!claim.run) throw new Error('not claimed');
    const answer = '完整解释'.repeat(1_500);
    const thread = await finishLectureChatRequest(request, claim.token, answer, citations, `${answer}[S1]`, guard);
    expect(thread.messages[1]).toMatchObject({ role: 'assistant', content: answer, citations, position: request.position });
    expect(await claimLectureChatRequest(request, guard)).toEqual({ run: false, status: 'COMPLETED', thread });
    expect(await finishLectureChatRequest(request, 'late-writer', '被替换的回答', [], 'invalid', guard)).toEqual(thread);
    expect(mocks.messages).toHaveLength(2);
    expect([...mocks.tasks.values()][0].output).toMatchObject({ raw: `${answer}[S1]`, citations });
  });

  it('isolates other students, pages, source classrooms, versions and changed page content', async () => {
    const claim = await claimLectureChatRequest(request, guard);
    if (!claim.run) throw new Error('not claimed');
    await finishLectureChatRequest(request, claim.token, '本人的解释', citations, '本人的解释[S1]', guard);
    for (const replacement of [ { studentId: 'other-student', participationId: 'other-participation' },
      { sceneId: 'other-scene' }, { classroomId: 'supplemental-lecture' },
      { templateVersionId: 'updated-version' }, { sceneFingerprint: 'edited-page' } ]) {
      const history = await readLectureChatHistory({ ...request, ...replacement }, true);
      expect(history.thread.messages).toEqual([]);
      expect(history.requests).toEqual([]);
    }
    expect(lectureChatConversationId(request)).not.toBe(lectureChatConversationId({ ...request, participationId: 'other-participation' }));
  });

  it('rejects reuse with another question, page, source or position', async () => {
    await claimLectureChatRequest(request, guard);
    for (const patch of [ { message: '另一道问题' }, { sceneId: 'different-scene' },
      { classroomId: 'different-classroom' }, { position: { actionIndex: 5 } }, { sessionVersion: 3 } ]) {
      await expect(claimLectureChatRequest({ ...request, ...patch }, guard)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    }
    expect(mocks.messages).toHaveLength(1);
  });

  it('stores only the necessary scope and request fields even when a caller supplies a rich context', async () => {
    const rich = { ...request, content: { textbookSource: '完整教材' }, narration: '完整讲稿', currentSpeech: '讲解' };
    await claimLectureChatRequest(rich, guard);
    expect([...mocks.tasks.values()][0].input).not.toHaveProperty('content');
    expect([...mocks.tasks.values()][0].input).not.toHaveProperty('narration');
    expect([...mocks.tasks.values()][0].input).toMatchObject({ message: request.message, position: request.position,
      templateVersionId: 'version', sessionVersion: 2 });
  });

  it('keeps one active answer per page but permits different pages to progress independently', async () => {
    await claimLectureChatRequest(request, guard);
    await expect(claimLectureChatRequest({ ...request, requestId: 'next' }, guard)).rejects.toMatchObject({ code: 'LECTURE_CHAT_BUSY' });
    expect(await claimLectureChatRequest({ ...request, requestId: 'other-page', sceneId: 'other-scene' }, guard)).toMatchObject({ run: true });
  });

  it('does not write a student question after fresh authorization rejects closure or an unsubmitted quiz', async () => {
    guard.mockRejectedValueOnce(new PlatformError('QUIZ_NOT_SUBMITTED', '先提交', 409));
    await expect(claimLectureChatRequest(request, guard)).rejects.toMatchObject({ code: 'QUIZ_NOT_SUBMITTED' });
    expect(mocks.messages).toHaveLength(0);
    expect(mocks.tasks.size).toBe(0);
    expect(mocks.conversations.size).toBe(0);
  });

  it('rejects stale source or identity on completion before inserting an assistant answer', async () => {
    const claim = await claimLectureChatRequest(request, guard);
    if (!claim.run) throw new Error('not claimed');
    const revoked = vi.fn().mockRejectedValue(new PlatformError('LECTURE_CHAT_CONTEXT_CHANGED', '版本已变', 409));
    await expect(finishLectureChatRequest(request, claim.token, '旧回答', citations, '旧回答', revoked))
      .rejects.toMatchObject({ code: 'LECTURE_CHAT_CONTEXT_CHANGED' });
    expect(mocks.messages).toHaveLength(1);
    expect([...mocks.tasks.values()][0].status).toBe('RUNNING');
  });

  it('retains partial failures separately and refuses a late or wrong owner completion', async () => {
    const claim = await claimLectureChatRequest(request, guard);
    if (!claim.run) throw new Error('not claimed');
    await failLectureChatRequest(request, 'another-worker', 'failure', 'wrong output');
    expect([...mocks.tasks.values()][0].status).toBe('RUNNING');
    await failLectureChatRequest(request, claim.token, 'LECTURE_CHAT_TIMEOUT', '不完整的答复');
    expect([...mocks.tasks.values()][0]).toMatchObject({ status: 'FAILED', output: { partial: '不完整的答复' } });
    const history = await readLectureChatHistory(request, true);
    expect(history.thread.messages).toHaveLength(1);
    expect(history.requests).toEqual([{ requestId: 'request', status: 'FAILED', error: 'LECTURE_CHAT_TIMEOUT' }]);
    await expect(finishLectureChatRequest(request, claim.token, '迟到的回答', [], '迟到的回答', guard))
      .rejects.toMatchObject({ code: 'LECTURE_CHAT_REQUEST_EXPIRED' });
  });

  it('recovers interrupted worker status on history refresh and keeps the old request final', async () => {
    await claimLectureChatRequest(request, guard);
    const task = [...mocks.tasks.values()][0];
    task.input.leaseUntil = new Date(Date.now() - 1).toISOString();
    const history = await readLectureChatHistory(request, false);
    expect(history.writable).toBe(false);
    expect(history.requests).toEqual([{ requestId: 'request', status: 'FAILED', error: 'REQUEST_INTERRUPTED' }]);
    expect(await claimLectureChatRequest(request, guard)).toMatchObject({ run: false, status: 'FAILED' });
    expect(await claimLectureChatRequest({ ...request, requestId: 'retry-new-id' }, guard)).toMatchObject({ run: true });
  });

  it('reclaims a complete saved answer with a new owner token without recording another student message', async () => {
    const claim = await claimLectureChatRequest(request, guard);
    if (!claim.run) throw new Error('not claimed');
    const retained = { answer: '已经生成的完整回答', citations, raw: '已经生成的完整回答[S1]' };
    await retainLectureChatAnswer(request, claim.token, retained, guard);
    await failLectureChatRequest(request, claim.token, 'LECTURE_CHAT_SAVE_FAILED', retained.raw);
    const newQuestionGuard = vi.fn().mockRejectedValue(new PlatformError('QUIZ_NOT_SUBMITTED', '当前是小测', 409));
    const resumeGuard = vi.fn().mockResolvedValue(undefined);
    const resumed = await claimLectureChatRequest(request, newQuestionGuard, resumeGuard);
    expect(resumed).toMatchObject({ run: true, retained });
    if (!resumed.run) throw new Error('not resumed');
    expect(resumed.token).not.toBe(claim.token);
    expect(newQuestionGuard).not.toHaveBeenCalled();
    expect(resumeGuard).toHaveBeenCalledOnce();
    expect(mocks.messages).toHaveLength(1);
    await expect(finishLectureChatRequest(request, claim.token, retained.answer, citations, retained.raw, guard))
      .rejects.toMatchObject({ code: 'LECTURE_CHAT_REQUEST_EXPIRED' });
    const final = await finishLectureChatRequest(request, resumed.token, retained.answer, citations, retained.raw, resumeGuard);
    expect(final.messages).toHaveLength(2);
    expect(final.messages[1].content).toBe(retained.answer);
    expect(mocks.tx.aiTask.create).toHaveBeenCalledOnce();
  });

  it('preserves history beyond the bounded model history window without truncating messages', async () => {
    for (let index = 0; index < 45; index++) {
      const input = { ...request, requestId: `question-${index}` };
      const claim = await claimLectureChatRequest(input, guard);
      if (!claim.run) throw new Error('not claimed');
      await finishLectureChatRequest(input, claim.token, `回答${index}`, citations, `回答${index}[S1]`, guard);
    }
    const history = await readLectureChatHistory(request, true);
    expect(history.thread.messages).toHaveLength(90);
    expect(history.thread.messages[1].content).toBe('回答0');
    expect(history.requests).toHaveLength(45);
  });
});
