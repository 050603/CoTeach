import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { requireTeacherUser } from "./access";
import { PlatformError } from "./repository";
import { requireParticipation, requireParticipationWrite } from "./participation";

export const workspaceSchema = z.object({
  version: z.number().int().min(0),
  idempotencyKey: z.string().min(1).max(200),
  document: z.string().max(200_000),
  code: z.string().max(200_000).default(""),
  stageKey: z.string().max(160).optional(),
});

export async function readClassroom(claims: AuthClaims, participationId: string) {
  const context = await requireParticipation(claims, participationId);
  const { participation, isTeacher } = context;
  const workspace = await prisma.studentProjectWorkspace.findUnique({ where: { participationId } });
  const { instance, enrollment } = participation;
  return {
    participation: { id: participation.id, firstEnteredAt: participation.firstEnteredAt, lastEnteredAt: participation.lastEnteredAt, completedAt: participation.completedAt, stageProgress: participation.stageProgress },
    student: { displayName: enrollment.user.displayName },
    instance: { id: instance.id, status: instance.status.toLowerCase(), activityId: instance.activityId, runNo: instance.runNo, title: instance.activity.title, offeringId: instance.activity.chapter.offeringId, offeringName: instance.activity.chapter.offering.name, templateVersion: instance.templateVersion.version, snapshot: instance.templateVersion.snapshot, runtimeConfig: instance.runtimeConfig },
    workspace: workspace ? { version: workspace.version, projectState: workspace.projectState, updatedAt: workspace.updatedAt } : { version: 0, projectState: null, updatedAt: null },
    isTeacher,
    canWrite: !isTeacher && enrollment.status.toUpperCase() === "ACTIVE" && instance.status.toUpperCase() === "TEACHING" && instance.activity.chapter.offering.status.toUpperCase() === "OPEN",
  };
}

export async function saveWorkspace(claims: AuthClaims, participationId: string, input: unknown) {
  const parsed = workspaceSchema.safeParse(input);
  if (!parsed.success) throw new PlatformError("INVALID_INPUT", "工作区内容或版本无效", 400);
  const data = parsed.data;
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ClassroomParticipation" WHERE "id" = ${participationId} FOR UPDATE`;
    const context = await requireParticipation(claims, participationId, tx);
    requireParticipationWrite(context);
    const { participation, user } = context;
    const key = `workspace:${participationId}:${user.id}:${data.idempotencyKey}`;
    const digest = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    const receipt = await tx.domainEvent.findUnique({ where: { idempotencyKey: key } });
    if (receipt) {
      const payload = receipt.payload as { digest?: string; version?: number } | null;
      if (payload?.digest !== digest) throw new PlatformError("IDEMPOTENCY_CONFLICT", "请为新的修改生成新的请求标识", 409);
      return { version: payload.version, duplicate: true };
    }
    const existing = await tx.studentProjectWorkspace.findUnique({ where: { participationId } });
    if ((existing?.version ?? 0) !== data.version) throw new PlatformError("VERSION_CONFLICT", "工作区已在其他窗口更新，请先重新加载", 409);
    const state = { document: data.document, code: data.code, stageKey: data.stageKey ?? "" };
    const workspace = await tx.studentProjectWorkspace.upsert({
      where: { participationId }, create: { participationId, projectState: state },
      update: { projectState: state, version: { increment: 1 } },
    });
    await tx.domainEvent.create({ data: { actorId: user.id, offeringId: participation.enrollment.offeringId, classroomInstanceId: participation.instanceId, participationId, researchKey: participation.enrollment.researchKey, idempotencyKey: key, eventType: "workspace_saved", payload: { digest, version: workspace.version, templateVersionId: participation.instance.templateVersionId, state } } });
    return { version: workspace.version, duplicate: false };
  });
}

export async function listClassroomParticipants(claims: AuthClaims, instanceId: string) {
  const teacher = await requireTeacherUser(claims);
  const instance = await prisma.classroomInstance.findUnique({ where: { id: instanceId }, include: { activity: { include: { chapter: true } }, templateVersion: true } });
  if (!instance) throw new PlatformError("NOT_FOUND", "课堂不存在", 404);
  if (!await prisma.courseTeacher.findFirst({ where: { userId: teacher.id, offeringId: instance.activity.chapter.offeringId } })) throw new PlatformError("FORBIDDEN", "无权查看该课堂", 403);
  const participants = await prisma.classroomParticipation.findMany({ where: { instanceId }, orderBy: { firstEnteredAt: "asc" }, select: { id: true, firstEnteredAt: true, lastEnteredAt: true, completedAt: true, stageProgress: true, enrollment: { select: { user: { select: { displayName: true } } } }, workspace: { select: { updatedAt: true, version: true } }, _count: { select: { artifacts: true, reflections: true, evaluations: true } } } });
  return { instance: { id: instance.id, status: instance.status.toLowerCase(), title: instance.activity.title, offeringId: instance.activity.chapter.offeringId, snapshot: instance.templateVersion.snapshot }, participants: participants.map(({ enrollment, ...row }) => ({ ...row, displayName: enrollment.user.displayName })) };
}

export async function changeClassroomState(claims: AuthClaims, instanceId: string, action: "start" | "finish") {
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ClassroomInstance" WHERE "id" = ${instanceId} FOR UPDATE`;
    const teacher = await requireTeacherUser(claims, tx);
    const instance = await tx.classroomInstance.findUnique({ where: { id: instanceId }, include: { activity: { include: { chapter: true } } } });
    if (!instance) throw new PlatformError("NOT_FOUND", "课堂不存在", 404);
    const offeringId = instance.activity.chapter.offeringId;
    if (!await tx.courseTeacher.findFirst({ where: { userId: teacher.id, offeringId } })) throw new PlatformError("FORBIDDEN", "无权操作该课堂", 403);
    const status = instance.status.toUpperCase();
    const next = action === "start" ? "TEACHING" : "FINISHED";
    if (status === next) return instance;
    if (status !== (action === "start" ? "SCHEDULED" : "TEACHING")) throw new PlatformError("STATE_CONFLICT", "课堂状态已变化，结束的课堂请创建新场次", 409);
    const now = new Date();
    const updated = await tx.classroomInstance.update({ where: { id: instanceId }, data: { status: next, ...(action === "start" ? { startedAt: now } : { endedAt: now }) } });
    if (action === "finish") {
      await tx.classroomParticipation.updateMany({ where: { instanceId, completedAt: null }, data: { completedAt: now } });
    }
    await tx.domainEvent.create({ data: { id: randomUUID(), idempotencyKey: `classroom:${instanceId}:${action}`, actorId: teacher.id, offeringId, classroomInstanceId: instanceId, eventType: `classroom_${action === "start" ? "started" : "finished"}`, payload: { previousStatus: status, status: next } as Prisma.InputJsonValue } });
    return updated;
  });
}
