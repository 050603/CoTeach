import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { type PlatformDb } from "./access";
import { requireParticipation } from "./participation";
import { isActivityOpen, PlatformError } from "./repository";

const identifier = z.string().trim().min(1).max(200);
const outcomeActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit_stage"), stageKey: identifier, payload: z.record(z.string(), z.json()) }),
  z.object({ action: z.literal("save_artifact"), artifactId: identifier.optional(), title: z.string().trim().min(1).max(200), type: z.enum(["HTML", "TEXT"]).default("HTML"), sourceHtml: z.string().min(1).max(500000) }),
  z.object({ action: z.literal("reflect"), content: z.string().trim().min(1).max(30000) }),
  z.object({ action: z.literal("evaluate"), type: z.enum(["FORMATIVE", "SUMMATIVE"]).default("FORMATIVE"), score: z.number().min(0).max(100).optional(), content: z.string().trim().min(1).max(30000) }),
  z.object({ action: z.literal("showcase"), artifactId: identifier, artifactVersionId: identifier, content: z.record(z.string(), z.json()).optional() }),
]);
export const classroomOutcomeSchema = outcomeActionSchema.and(z.object({ idempotencyKey: z.string().uuid() }));
export type ClassroomOutcomeInput = z.infer<typeof classroomOutcomeSchema>;

// JSON snapshots keep BigInt and Decimal values portable for exports and HTTP.
export function outcomeJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}

async function context(db: PlatformDb, claims: AuthClaims, participationId: string) {
  const { participation, user } = await requireParticipation(claims, participationId, db);
  const offeringId = participation.instance.activity.chapter.offeringId;
  return { participation, user, offeringId };
}

export async function getClassroomOutcomes(claims: AuthClaims, participationId: string) {
  await context(prisma, claims, participationId);
  const where = { participationId };
  const [submissions, artifacts, reflections, evaluations, showcases] = await Promise.all([
    prisma.classroomSubmission.findMany({ where, orderBy: { stageKey: "asc" } }),
    prisma.artifact.findMany({ where, orderBy: { createdAt: "desc" }, include: { versions: { orderBy: { sequence: "desc" } } } }),
    prisma.reflection.findMany({ where, orderBy: { createdAt: "desc" } }),
    prisma.evaluation.findMany({ where, orderBy: { createdAt: "desc" } }),
    prisma.showcasePresentation.findMany({ where, orderBy: { createdAt: "desc" } }),
  ]);
  return outcomeJson({ submissions, artifacts, reflections, evaluations, showcases });
}

export async function saveClassroomOutcome(claims: AuthClaims, participationId: string, raw: ClassroomOutcomeInput) {
  const input = classroomOutcomeSchema.parse(raw);
  if (JSON.stringify(input).length > 550000) throw new PlatformError("INVALID_INPUT", "提交内容过大", 400);
  return runMutationTransaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`outcomes:${participationId}`}, 0))`;
    const { participation, user, offeringId } = await context(tx, claims, participationId);
    const receiptKey = `classroom-outcome:${user.id}:${input.idempotencyKey}`;
    const receipt = await tx.domainEvent.findUnique({ where: { idempotencyKey: receiptKey } });
    if (receipt) {
      const payload = receipt.payload as { request?: unknown; result?: Prisma.InputJsonValue } | null;
      if (receipt.participationId !== participationId || (payload as { requestHash?: string } | null)?.requestHash !== createHash("sha256").update(JSON.stringify(input)).digest("hex")) throw new PlatformError("IDEMPOTENCY_CONFLICT", "同一请求标识不能提交不同内容", 409);
      return payload!.result!;
    }
    const { instance } = participation;
    const { activity } = instance;
    const offeringStatus = activity.chapter.offering.status.toLowerCase();
    const evaluation = input.action === "evaluate";
    if (user.role === "teacher" && !evaluation) throw new PlatformError("FORBIDDEN", "学生成果必须由学生本人提交", 403);
    if (evaluation && user.role === "teacher") {
      if (!["open", "finished"].includes(offeringStatus) || !["teaching", "finished"].includes(instance.status.toLowerCase())) throw new PlatformError("CLASSROOM_LOCKED", "当前课堂不可评价", 409);
    } else if (offeringStatus !== "open" || instance.status.toLowerCase() !== "teaching" || participation.completedAt || participation.enrollment.status.toLowerCase() !== "active" || !isActivityOpen(activity.chapter, activity)) {
      throw new PlatformError("CLASSROOM_LOCKED", "当前课堂未开放提交", 409);
    }
    const now = new Date();
    let result: unknown;
    if (input.action === "submit_stage") {
      result = await tx.classroomSubmission.upsert({
        where: { participationId_stageKey: { participationId, stageKey: input.stageKey } },
        create: { participationId, stageKey: input.stageKey, payload: outcomeJson(input.payload), status: "SUBMITTED", submittedAt: now },
        update: { payload: outcomeJson(input.payload), status: "SUBMITTED", submittedAt: now },
      });
    } else if (input.action === "save_artifact") {
      let artifact;
      if (input.artifactId) {
        artifact = await tx.artifact.findFirst({ where: { id: input.artifactId, participationId } });
        if (!artifact) throw new PlatformError("NOT_FOUND", "作品不存在", 404);
        artifact = await tx.artifact.update({ where: { id: artifact.id }, data: { title: input.title, type: input.type, status: "SUBMITTED" } });
      } else {
        artifact = await tx.artifact.create({ data: { participationId, title: input.title, type: input.type, status: "SUBMITTED" } });
      }
      const latest = await tx.artifactVersion.aggregate({ where: { artifactId: artifact.id }, _max: { sequence: true } });
      const version = await tx.artifactVersion.create({ data: {
        artifactId: artifact.id, sequence: (latest._max.sequence ?? 0) + 1,
        sourceHtml: input.sourceHtml, mimeType: input.type === "HTML" ? "text/html" : "text/plain",
        size: BigInt(Buffer.byteLength(input.sourceHtml)), sha256: createHash("sha256").update(input.sourceHtml).digest("hex"), status: "SUBMITTED", submittedAt: now,
      } });
      result = { ...artifact, version };
    } else if (input.action === "reflect") {
      result = await tx.reflection.create({ data: { participationId, activityId: activity.id, authorId: user.id, content: input.content } });
    } else if (input.action === "evaluate") {
      result = await tx.evaluation.create({ data: { participationId, activityId: activity.id, studentId: participation.enrollment.userId, evaluatorId: user.id, evaluatorType: user.role === "teacher" ? "TEACHER" : "SELF", type: input.type, score: input.score, content: input.content } });
    } else {
      const version = await tx.artifactVersion.findFirst({ where: { id: input.artifactVersionId, artifactId: input.artifactId, artifact: { participationId }, status: "SUBMITTED" } });
      if (!version) throw new PlatformError("INVALID_ARTIFACT_VERSION", "请选择本人已提交的作品版本", 400);
      result = await tx.showcasePresentation.create({ data: { participationId, artifactId: input.artifactId, artifactVersionId: version.id, status: "PRESENTED", presentedAt: now, content: input.content ? outcomeJson(input.content) : undefined } });
    }
    await tx.domainEvent.create({ data: {
      idempotencyKey: receiptKey, researchKey: participation.enrollment.researchKey, actorId: user.id, offeringId, classroomInstanceId: instance.id, participationId,
      eventType: `CLASSROOM_${input.action.toUpperCase()}`,
      payload: outcomeJson({ researchKey: participation.enrollment.researchKey, enrollmentId: participation.enrollmentId, activityId: activity.id, activityVersion: activity.version, templateVersionId: instance.templateVersionId, requestHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"), result }),
    } });
    return outcomeJson(result);
  });
}
