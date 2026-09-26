import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { lockProjectedCourse } from "@/lib/db/session-repository";
import { PlatformError } from "@/lib/platform/repository";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import type { KnowledgeLectureTutorThread, StudentAiProgress } from "@/lib/session/types";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type TutorRequest = { courseId: string; studentId: string; classroomId: string; requestId: string; threadId: string; attemptId: string; questionId: string; message: string; initial: boolean };
const taskId = (input: TutorRequest) => `lecture-tutor:${hash([input.courseId, input.studentId, input.requestId])}`;

/** Durable claim survives response loss and records the question before contacting AI. */
export async function claimTutorRequest(input: TutorRequest): Promise<{ run: true; token: string } | { run: false; status: string; thread?: KnowledgeLectureTutorThread }> {
  return runMutationTransaction(async tx => {
    await lockProjectedCourse(tx, input.courseId);
    const id = taskId(input);
    const fingerprint = hash(input);
    const previous = await tx.aiTask.findUnique({ where: { id } });
    if (previous) {
      if (object(previous.input).fingerprint !== fingerprint) throw new PlatformError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他问题", 409);
      if (previous.status === "RUNNING" && (!previous.startedAt || Date.now() - previous.startedAt.getTime() > 180_000)) {
        await tx.aiTask.update({ where: { id }, data: { status: "FAILED", error: "REQUEST_INTERRUPTED", completedAt: new Date() } });
        return { run: false, status: "FAILED" };
      }
      return { run: false, status: previous.status, thread: object(previous.output).thread as KnowledgeLectureTutorThread | undefined };
    }
    const participation = await tx.classroomParticipation.findFirst({ where: { instanceId: input.courseId, enrollment: { userId: input.studentId } }, include: { enrollment: true, instance: { include: { activity: { include: { chapter: { include: { offering: true } } } } } } } });
    if (!participation || participation.enrollment.status !== "ACTIVE" || participation.instance.status !== "TEACHING" || participation.instance.activity.chapter.offering.status !== "OPEN") throw new PlatformError("CLASSROOM_READ_ONLY", "课堂已结束，无法发起新问题", 409);
    const conversationId = `lecture-tutor:${hash([participation.id, input.threadId])}`;
    await tx.aiConversation.upsert({ where: { id: conversationId }, create: { id: conversationId, userId: input.studentId, participationId: participation.id, offeringId: participation.enrollment.offeringId, title: "知识讲授伴学", metadata: { threadId: input.threadId, stageKey: "ai-learning" } }, update: {} });
    const token = randomUUID();
    await tx.aiTask.create({ data: { id, conversationId, offeringId: participation.enrollment.offeringId, createdById: input.studentId, taskType: "KNOWLEDGE_LECTURE_TUTOR", status: "RUNNING", input: json({ ...input, fingerprint, token }), startedAt: new Date() } });
    await tx.aiMessage.create({ data: { id: `${id}:student`, conversationId, userId: input.studentId, role: "user", content: input.message, metadata: { requestId: input.requestId, initial: input.initial } } });
    return { run: true, token };
  });
}

export async function finishTutorRequest(input: TutorRequest, token: string, additions: KnowledgeLectureTutorThread): Promise<KnowledgeLectureTutorThread> {
  const result = await runMutationTransaction(async tx => {
    await lockProjectedCourse(tx, input.courseId);
    const id = taskId(input);
    const task = await tx.aiTask.findUniqueOrThrow({ where: { id } });
    if (task.status === "COMPLETED") return { thread: object(task.output).thread as KnowledgeLectureTutorThread, version: 0 };
    if (task.status !== "RUNNING" || object(task.input).token !== token) throw new PlatformError("TUTOR_REQUEST_EXPIRED", "本次请求已结束，请重新提问", 409);
    const participation = await tx.classroomParticipation.findFirstOrThrow({ where: { instanceId: input.courseId, enrollment: { userId: input.studentId } }, include: { workspace: true, enrollment: true, instance: true } });
    const state = object(participation.workspace?.projectState);
    const progress = state.aiLearningProgress as StudentAiProgress | undefined;
    if (!progress || progress.classroomId !== input.classroomId) throw new PlatformError("QUIZ_SCENE_CHANGED", "课堂学习内容已变化", 409);
    const threads = progress.knowledgeLectureTutorThreads ?? [];
    const current = threads.find(thread => thread.id === input.threadId);
    const thread = { ...additions, messages: [...(current?.messages ?? []), ...additions.messages].slice(-30), boardNotes: [...(current?.boardNotes ?? []), ...additions.boardNotes].slice(-12), createdAt: current?.createdAt ?? additions.createdAt };
    // The UI cache is bounded; all messages and board notes remain in immutable AiMessage rows.
    const assistant = additions.messages.find(message => message.role === "assistant")!;
    await tx.aiMessage.create({ data: { id: `${id}:assistant`, conversationId: task.conversationId!, role: "assistant", content: assistant.content, metadata: json({ requestId: input.requestId, boardNotes: additions.boardNotes }) } });
    await tx.studentProjectWorkspace.update({ where: { participationId: participation.id }, data: { version: { increment: 1 }, projectState: json({ ...state, aiLearningProgress: { ...progress, knowledgeLectureTutorThreads: [...threads.filter(item => item.id !== thread.id), thread].slice(-60), lastActiveAt: thread.updatedAt } }) } });
    await tx.aiTask.update({ where: { id }, data: { status: "COMPLETED", output: json({ thread }), completedAt: new Date() } });
    const runtime = object(participation.instance.runtimeConfig);
    const version = Number(runtime.version ?? 1) + 1;
    await tx.classroomInstance.update({ where: { id: input.courseId }, data: { runtimeConfig: json({ ...runtime, version }) } });
    await tx.domainEvent.create({ data: { idempotencyKey: `${id}:completed`, actorId: input.studentId, offeringId: participation.enrollment.offeringId, classroomInstanceId: input.courseId, participationId: participation.id, researchKey: participation.enrollment.researchKey, eventType: "KNOWLEDGE_TUTOR_COMPLETED", payload: { courseVersion: version, scope: "student", studentId: input.studentId, requestId: input.requestId } } });
    return { thread, version };
  });
  try { await publishCourseEvent(input.courseId, { type: "course-updated", courseId: input.courseId, at: new Date().toISOString(), payload: { scope: "student", studentId: input.studentId, courseVersion: result.version } }); } catch (error) { console.error("[knowledge-tutor] notification failed", error); }
  return result.thread;
}

export async function failTutorRequest(input: TutorRequest, token: string, cancelled: boolean): Promise<void> {
  await runMutationTransaction(async tx => {
    await lockProjectedCourse(tx, input.courseId);
    const id = taskId(input);
    const task = await tx.aiTask.findUnique({ where: { id } });
    if (task?.status === "RUNNING" && object(task.input).token === token) await tx.aiTask.update({ where: { id }, data: { status: cancelled ? "CANCELLED" : "FAILED", error: cancelled ? "CLIENT_CANCELLED" : "TUTOR_GENERATION_FAILED", completedAt: new Date() } });
  });
}
