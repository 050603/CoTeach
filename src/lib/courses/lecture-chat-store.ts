import { createHash, randomUUID } from 'node:crypto';
import type { AiMessage, AiTask, Prisma } from '@prisma/client';
import { lockProjectedCourse } from '@/lib/db/session-repository';
import { runMutationTransaction } from '@/lib/db/transaction-retry';
import { PlatformError } from '@/lib/platform/repository';
import { TUTOR_LEASE_MS } from './knowledge-tutor-payload';
import type {
  LectureChatCitation, LectureChatHistory, LectureChatMessage,
  LectureChatPosition, LectureChatRequestState, LectureChatThread,
} from './lecture-chat-types';

export type LectureChatStoreScope = {
  courseId: string;
  studentId: string;
  participationId: string;
  offeringId: string;
  templateVersionId: string;
  classroomId: string;
  sceneId: string;
  sceneFingerprint: string;
  pageTitle: string;
};
export type LectureChatRequest = LectureChatStoreScope & {
  requestId: string;
  message: string;
  position: LectureChatPosition;
  sessionVersion: number;
};
/** Fresh authorization runs under the course lock in the same write transaction. */
export type LectureChatWriteGuard = (tx: Prisma.TransactionClient) => Promise<void>;
export type RetainedLectureChatAnswer = { answer: string; citations: LectureChatCitation[]; raw: string };
type Claim = { run: true; token: string; retained?: RetainedLectureChatAnswer } | {
  run: false;
  status: LectureChatRequestState['status'];
  error?: string;
  thread?: LectureChatThread;
};

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const feature = 'lecture-chat';
export function lectureChatConversationId(scope: LectureChatStoreScope): string {
  return `${feature}:${hash([scope.participationId, scope.templateVersionId, scope.classroomId, scope.sceneId, scope.sceneFingerprint])}`;
}
function taskId(input: LectureChatRequest): string {
  // The same id cannot be silently reused on a different page or course version.
  return `${feature}-request:${hash([input.courseId, input.studentId, input.requestId])}`;
}
function requestFingerprint(input: LectureChatRequest): string {
  return hash({ conversationId: lectureChatConversationId(input), studentId: input.studentId,
    message: input.message, position: input.position, sessionVersion: input.sessionVersion });
}
function savedRequest(input: LectureChatRequest) {
  return { courseId: input.courseId, studentId: input.studentId, participationId: input.participationId,
    offeringId: input.offeringId, templateVersionId: input.templateVersionId, classroomId: input.classroomId,
    sceneId: input.sceneId, sceneFingerprint: input.sceneFingerprint, pageTitle: input.pageTitle,
    sessionVersion: input.sessionVersion, requestId: input.requestId, message: input.message, position: input.position };
}
function retainedAnswer(output: unknown): RetainedLectureChatAnswer | undefined {
  const draft = object(object(output).draft);
  if (typeof draft.answer !== 'string' || !draft.answer.trim() || typeof draft.raw !== 'string' || !Array.isArray(draft.citations)) return;
  return { answer: draft.answer, raw: draft.raw, citations: draft.citations as LectureChatCitation[] };
}
function expired(task: Pick<AiTask, 'input' | 'startedAt'>): boolean {
  const until = object(task.input).leaseUntil;
  const deadline = typeof until === 'string' ? Date.parse(until) : NaN;
  return Number.isFinite(deadline) ? deadline <= Date.now()
    : !task.startedAt || task.startedAt.getTime() + TUTOR_LEASE_MS <= Date.now();
}
function position(value: unknown): LectureChatPosition {
  const data = object(value);
  return { actionIndex: typeof data.actionIndex === 'number' ? data.actionIndex : 0,
    ...(typeof data.mediaTimeMs === 'number' ? { mediaTimeMs: data.mediaTimeMs } : {}) };
}
function publicMessage(row: AiMessage): LectureChatMessage {
  const metadata = object(row.metadata);
  return { id: row.id, role: row.role === 'assistant' ? 'assistant' : 'student', content: row.content,
    createdAt: row.createdAt.toISOString(), requestId: String(metadata.requestId ?? ''),
    position: position(metadata.position),
    ...(Array.isArray(metadata.citations) ? { citations: metadata.citations as LectureChatCitation[] } : {}) };
}
function emptyThread(scope: LectureChatStoreScope): LectureChatThread {
  return { id: lectureChatConversationId(scope), page: { classroomId: scope.classroomId, sceneId: scope.sceneId },
    pageTitle: scope.pageTitle, messages: [] };
}
async function readThread(tx: Prisma.TransactionClient, scope: LectureChatStoreScope): Promise<LectureChatThread> {
  const thread = emptyThread(scope);
  const conversation = await tx.aiConversation.findFirst({ where: { id: thread.id, userId: scope.studentId,
    participationId: scope.participationId } });
  if (!conversation) return thread;
  const rows = await tx.aiMessage.findMany({ where: { conversationId: thread.id }, orderBy: [{ createdAt: 'asc' }, { id: 'desc' }] });
  return { ...thread, messages: rows.map(publicMessage) };
}
async function expireTasks(tx: Prisma.TransactionClient, scope: LectureChatStoreScope): Promise<void> {
  const tasks = await tx.aiTask.findMany({ where: { conversationId: lectureChatConversationId(scope),
    createdById: scope.studentId, taskType: 'LECTURE_CHAT', status: 'RUNNING' } });
  for (const task of tasks) if (expired(task)) {
    await tx.aiTask.update({ where: { id: task.id }, data: { status: 'FAILED', error: 'REQUEST_INTERRUPTED', completedAt: new Date() } });
  }
}

/** Private durable messages stay complete, including answers older than the model's history window. */
export async function readLectureChatHistory(scope: LectureChatStoreScope, writable: boolean): Promise<LectureChatHistory> {
  return runMutationTransaction(async tx => {
    await lockProjectedCourse(tx, scope.courseId);
    await expireTasks(tx, scope);
    const [thread, tasks] = await Promise.all([
      readThread(tx, scope),
      tx.aiTask.findMany({ where: { conversationId: lectureChatConversationId(scope), createdById: scope.studentId,
        taskType: 'LECTURE_CHAT' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    ]);
    const requests = tasks.map(task => ({ requestId: String(object(task.input).requestId ?? ''),
      status: task.status as LectureChatRequestState['status'], ...(task.error ? { error: task.error } : {}) }));
    return { thread, requests, writable };
  }, { lowPriorityCourseId: scope.courseId });
}

/** The durable claim and student message commit together, before any paid model call. */
export async function claimLectureChatRequest(input: LectureChatRequest, guard: LectureChatWriteGuard,
  resumeGuard: LectureChatWriteGuard = guard): Promise<Claim> {
  return runMutationTransaction(async tx => {
    await lockProjectedCourse(tx, input.courseId);
    const id = taskId(input);
    const fingerprint = requestFingerprint(input);
    const previous = await tx.aiTask.findUnique({ where: { id } });
    if (previous) {
      if (previous.createdById !== input.studentId || previous.conversationId !== lectureChatConversationId(input)
        || object(previous.input).fingerprint !== fingerprint) {
        throw new PlatformError('IDEMPOTENCY_CONFLICT', '请求标识已用于其他问题，请重新发送。', 409);
      }
      if (previous.status === 'RUNNING' && expired(previous)) {
        await tx.aiTask.update({ where: { id }, data: { status: 'FAILED', error: 'REQUEST_INTERRUPTED', completedAt: new Date() } });
        previous.status = 'FAILED';
        previous.error = 'REQUEST_INTERRUPTED';
      }
      const retained = retainedAnswer(previous.output);
      if (previous.status === 'FAILED' && retained) {
        await resumeGuard(tx);
        const token = randomUUID();
        const startedAt = new Date();
        await tx.aiTask.update({ where: { id }, data: { status: 'RUNNING', error: null, completedAt: null, startedAt,
          input: json({ ...object(previous.input), token, leaseUntil: new Date(startedAt.getTime() + TUTOR_LEASE_MS).toISOString() }) } });
        return { run: true, token, retained };
      }
      return { run: false, status: previous.status as LectureChatRequestState['status'],
        ...(previous.error ? { error: previous.error } : {}),
        ...(previous.status === 'COMPLETED' ? { thread: await readThread(tx, input) } : {}) };
    }
    await guard(tx);
    await expireTasks(tx, input);
    const active = await tx.aiTask.findFirst({ where: { conversationId: lectureChatConversationId(input),
      createdById: input.studentId, taskType: 'LECTURE_CHAT', status: 'RUNNING' } });
    if (active) throw new PlatformError('LECTURE_CHAT_BUSY', '上一条问题还在回答，请稍等。', 409);
    const conversationId = lectureChatConversationId(input);
    await tx.aiConversation.upsert({ where: { id: conversationId }, create: { id: conversationId,
      userId: input.studentId, participationId: input.participationId, offeringId: input.offeringId,
      title: input.pageTitle, metadata: json({ schemaVersion: 1, feature, courseId: input.courseId,
        templateVersionId: input.templateVersionId, classroomId: input.classroomId,
        sceneId: input.sceneId, sceneFingerprint: input.sceneFingerprint }) }, update: {} });
    const token = randomUUID();
    const startedAt = new Date();
    await tx.aiTask.create({ data: { id, conversationId, offeringId: input.offeringId,
      createdById: input.studentId, taskType: 'LECTURE_CHAT', status: 'RUNNING', startedAt,
      input: json({ ...savedRequest(input), feature, fingerprint, token, leaseUntil: new Date(startedAt.getTime() + TUTOR_LEASE_MS).toISOString() }) } });
    await tx.aiMessage.create({ data: { id: `${id}:student`, conversationId, userId: input.studentId,
      role: 'user', content: input.message, metadata: json({ feature, requestId: input.requestId, position: input.position }) } });
    return { run: true, token };
  }, { lowPriorityCourseId: input.courseId });
}

/** Checkpoint a complete, validated answer so a lost save ACK never needs another model call. */
export async function retainLectureChatAnswer(input: LectureChatRequest, token: string,
  answer: RetainedLectureChatAnswer, guard: LectureChatWriteGuard): Promise<void> {
  await runMutationTransaction(async tx => {
    await lockProjectedCourse(tx, input.courseId);
    const task = await tx.aiTask.findUnique({ where: { id: taskId(input) } });
    if (!task || task.status !== 'RUNNING' || object(task.input).token !== token || expired(task)) {
      throw new PlatformError('LECTURE_CHAT_REQUEST_EXPIRED', '本次请求已结束，请重新提问。', 409);
    }
    await guard(tx);
    await tx.aiTask.update({ where: { id: task.id }, data: { output: json({ draft: answer }) } });
  }, { lowPriorityCourseId: input.courseId });
}

export async function finishLectureChatRequest(input: LectureChatRequest, token: string,
  answer: string, citations: LectureChatCitation[], raw: string, guard: LectureChatWriteGuard): Promise<LectureChatThread> {
  if (!answer.trim()) throw new PlatformError('LECTURE_CHAT_EMPTY_OUTPUT', '没有生成完整答复，请重新提问。', 502);
  return runMutationTransaction(async tx => {
    await lockProjectedCourse(tx, input.courseId);
    const id = taskId(input);
    const task = await tx.aiTask.findUnique({ where: { id } });
    if (task?.status === 'COMPLETED' && task.conversationId === lectureChatConversationId(input)) return readThread(tx, input);
    if (!task || task.status !== 'RUNNING' || object(task.input).token !== token || expired(task)) {
      throw new PlatformError('LECTURE_CHAT_REQUEST_EXPIRED', '本次请求已结束，请重新提问。', 409);
    }
    await guard(tx);
    await tx.aiMessage.create({ data: { id: `${id}:assistant`, conversationId: task.conversationId!, role: 'assistant',
      content: answer, metadata: json({ feature, requestId: input.requestId, position: input.position, citations }) } });
    await tx.aiTask.update({ where: { id }, data: { status: 'COMPLETED', completedAt: new Date(), error: null,
      output: json({ messageId: `${id}:assistant`, raw, citations }) } });
    await tx.aiConversation.update({ where: { id: task.conversationId! }, data: { updatedAt: new Date() } });
    return readThread(tx, input);
  }, { lowPriorityCourseId: input.courseId });
}

/** Partial output is retained as a failure diagnostic, never as an assistant message. */
export async function failLectureChatRequest(input: LectureChatRequest, token: string, code: string, partial = '',
  retained?: RetainedLectureChatAnswer): Promise<void> {
  await runMutationTransaction(async tx => {
    await lockProjectedCourse(tx, input.courseId);
    const id = taskId(input);
    const task = await tx.aiTask.findUnique({ where: { id } });
    if (task?.status !== 'RUNNING' || object(task.input).token !== token) return;
    await tx.aiTask.update({ where: { id }, data: { status: 'FAILED', error: code, completedAt: new Date(),
      ...(partial || retained ? { output: json({ ...object(task.output), ...(partial ? { partial } : {}), ...(retained ? { draft: retained } : {}) }) } : {}) } });
  }, { lowPriorityCourseId: input.courseId });
}
