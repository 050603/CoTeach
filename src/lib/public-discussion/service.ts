import { Prisma } from "@prisma/client";
import { callLLM } from "@openmaic/lib/ai/llm";
import { resolveModel } from "@openmaic/lib/server/resolve-model";
import type { AuthClaims } from "@/lib/auth/session";
import { getCourse } from "@/lib/session/server-store";
import type { Course, Student } from "@/lib/session/types";
import { firstKnowledgeLectureAttempts } from "@/lib/knowledge-lecture";
import { prisma } from "@/lib/db/client";
import { getRedisClient } from "@/lib/redis/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { encodeEventCursor } from "@/lib/realtime/event-cursor";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import { getPublicDiscussionSettings } from "./settings";
import type {
  PublicDiscussionCandidate,
  PublicDiscussionMode,
  PublicDiscussionRecommendation,
  PublicDiscussionSnapshot,
  PublicDiscussionStatus,
  PublicDiscussionSummary,
} from "./types";

const ACTIVE_STATUSES = [
  "INVITING",
  "AWAITING_STUDENT",
  "RECORDING",
  "TRANSCRIBING",
  "AWAITING_RETRY",
  "AWAITING_CONFIRMATION",
  "AI_GENERATING",
  "AI_READY",
  "AI_COMPLETION_READY",
  "AWAITING_TEACHER_CONFIRMATION",
  "AI_FAILED",
  "AWAITING_REPLACEMENT",
  "PAUSED",
  "SUMMARIZING",
] as const;
const SOUND_LEASE_MS = 30_000;
const PRESENCE_TTL_MS = 60_000;

type Db = Prisma.TransactionClient | typeof prisma;
type SessionRow = Prisma.PublicDiscussionSessionGetPayload<{
  include: {
    currentStudent: { select: { id: true; displayName: true } };
    turns: {
      include: { student: { select: { displayName: true } } };
      orderBy: { sequence: "asc" };
    };
  };
}>;

export class PublicDiscussionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "PublicDiscussionError";
  }
}

export function isPublicDiscussionEnabled(): boolean {
  return process.env.ENABLE_PUBLIC_DISCUSSION === "true";
}

function statusFromDb(status: string): PublicDiscussionStatus {
  return status.toLowerCase().replaceAll("_", "-") as PublicDiscussionStatus;
}

function modeFromDb(mode: string): PublicDiscussionMode {
  return mode === "DEBATE" ? "debate" : "inquiry";
}

function candidateEvidence(value: Prisma.JsonValue | null): PublicDiscussionCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.studentId !== "string" || typeof row.studentName !== "string") return [];
    return [{
      studentId: row.studentId,
      studentName: row.studentName,
      online: row.online === true,
      reason: typeof row.reason === "string" ? row.reason : "教师手动选择",
      evidence: typeof row.evidence === "string" ? row.evidence : "暂无可展示证据",
      participationCount: Number.isSafeInteger(row.participationCount)
        ? Number(row.participationCount)
        : 0,
    }];
  }).slice(0, 20);
}

function summaryFromRow(row: SessionRow): PublicDiscussionSummary | undefined {
  if (!row.keyConclusion && !row.misconceptionRepair && !row.transferQuestion) return undefined;
  return {
    keyConclusion: row.keyConclusion ?? "本次讨论已结束。",
    misconceptionRepair: row.misconceptionRepair ?? "请根据课堂讨论继续核对自己的理解。",
    transferQuestion: row.transferQuestion ?? "这个结论在新的情境中是否仍然成立？",
  };
}

function snapshotFromRow(
  row: SessionRow | null,
  claims: AuthClaims,
  soundClientId?: string,
): PublicDiscussionSnapshot {
  if (!row) return { enabled: true };
  const teacher = claims.role === "teacher";
  const now = Date.now();
  return {
    enabled: true,
    session: {
      id: row.id,
      courseId: row.classroomInstanceId,
      knowledgePointId: row.knowledgePointId,
      topic: row.topic,
      mode: modeFromDb(row.mode),
      openingPrompt: row.openingPrompt,
      status: statusFromDb(row.status),
      version: row.version,
      roundCount: row.roundCount,
      currentStudent: row.currentStudent
        ? { id: row.currentStudent.id, name: row.currentStudent.displayName }
        : undefined,
      isCurrentStudent: claims.role === "student" && row.currentStudentId === claims.sub,
      turns: row.turns.map((turn) => ({
        id: turn.id,
        sequence: turn.sequence,
        role: turn.role.toLowerCase() as "student" | "assistant" | "teacher",
        content: turn.content,
        source: turn.source.toLowerCase() as "voice" | "text" | "system",
        studentId: turn.studentId ?? undefined,
        studentName: turn.student?.displayName,
        createdAt: turn.createdAt.toISOString(),
      })),
      summary: summaryFromRow(row),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      endedAt: row.endedAt?.toISOString(),
      shouldSuggestSummary: row.roundCount >= 3 && row.status !== "ENDED",
    },
    ...(teacher ? {
      teacher: {
        candidates: candidateEvidence(row.candidateEvidence),
        soundOwner: Boolean(
          soundClientId
          && row.soundClientId === soundClientId
          && row.soundLeaseUntil
          && row.soundLeaseUntil.getTime() > now
        ),
        soundLeaseUntil: row.soundLeaseUntil?.toISOString(),
      },
    } : {}),
  };
}

const sessionInclude = {
  currentStudent: { select: { id: true, displayName: true } },
  turns: {
    include: { student: { select: { displayName: true } } },
    orderBy: { sequence: "asc" as const },
  },
} satisfies Prisma.PublicDiscussionSessionInclude;

async function latestSession(courseId: string, db: Db = prisma): Promise<SessionRow | null> {
  const active = await db.publicDiscussionSession.findFirst({
    where: { classroomInstanceId: courseId, status: { in: [...ACTIVE_STATUSES] } },
    include: sessionInclude,
    orderBy: { updatedAt: "desc" },
  });
  return active ?? db.publicDiscussionSession.findFirst({
    where: { classroomInstanceId: courseId },
    include: sessionInclude,
    orderBy: { updatedAt: "desc" },
  });
}

export async function getPublicDiscussionSnapshot(
  courseId: string,
  claims: AuthClaims,
  soundClientId?: string,
): Promise<PublicDiscussionSnapshot> {
  if (!isPublicDiscussionEnabled()) return { enabled: false };
  return snapshotFromRow(await latestSession(courseId), claims, soundClientId);
}

async function onlineStudentIds(courseId: string): Promise<Set<string>> {
  try {
    const redis = await getRedisClient();
    if (redis) {
      const now = Date.now();
      const key = `openpbl:presence:${courseId}`;
      await redis.zRemRangeByScore(key, 0, now - PRESENCE_TTL_MS);
      const members = await redis.zRangeByScore(key, now - PRESENCE_TTL_MS, "+inf");
      return new Set(members.flatMap((member) => member.startsWith("student:")
        ? [member.slice("student:".length)]
        : []));
    }
  } catch {
    // Database heartbeats are the intended presence fallback.
  }
  const recent = await prisma.classroomParticipation.findMany({
    where: {
      instanceId: courseId,
      lastEnteredAt: { gte: new Date(Date.now() - PRESENCE_TTL_MS) },
      enrollment: { status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] } },
    },
    select: { enrollment: { select: { userId: true } } },
  });
  return new Set(recent.map((item) => item.enrollment.userId));
}

function studentEvidence(
  course: Course,
  student: Student,
  knowledgePointId: string,
  mode: PublicDiscussionMode,
): { evidence: string; score: number } {
  const questions = firstKnowledgeLectureAttempts(course.aiLearningProgress?.[student.id])
    .flatMap((attempt) => attempt.questions)
    .filter((question) => question.knowledgePointIds.includes(knowledgePointId));
  const incorrect = questions.filter((question) =>
    question.points <= 0 || question.earned / question.points < 0.8,
  );
  const representative = (mode === "inquiry" ? incorrect[0] : questions.find((item) => item.answer.trim()))
    ?? questions[0];
  if (!representative) {
    return { evidence: "尚无该知识点的公开作答证据", score: 0 };
  }
  const answer = representative.answer.trim();
  const evidence = answer
    ? `回答“${answer.slice(0, 90)}${answer.length > 90 ? "…" : ""}”`
    : `该题未作答；反馈：${representative.feedback.slice(0, 90)}`;
  const ratio = representative.points > 0 ? representative.earned / representative.points : 0;
  const score = mode === "inquiry"
    ? (incorrect.length * 40) + Math.round((1 - ratio) * 30) + (answer ? 10 : 0)
    : Math.min(50, answer.length) + Math.round((1 - Math.abs(0.55 - ratio)) * 20);
  return { evidence, score };
}

export function rankDiscussionCandidates(
  course: Course,
  knowledgePointId: string,
  mode: PublicDiscussionMode,
  online: ReadonlySet<string>,
  participationCounts: ReadonlyMap<string, number> = new Map(),
): Array<PublicDiscussionCandidate & { score: number }> {
  return course.students.flatMap((student) => {
    if (!online.has(student.id)) return [];
    const evidence = studentEvidence(course, student, knowledgePointId, mode);
    return [{
      studentId: student.id,
      studentName: student.name,
      online: true,
      evidence: evidence.evidence,
      participationCount: participationCounts.get(student.id) ?? 0,
      reason: mode === "inquiry"
        ? "该生的作答能代表当前需要澄清的理解路径"
        : "该生已有可供检验的观点或论据",
      score: evidence.score - (participationCounts.get(student.id) ?? 0) * 15,
    }];
  }).sort((left, right) => right.score - left.score || left.studentName.localeCompare(right.studentName, "zh-CN"));
}

function parseRecommendation(
  raw: string,
  ranked: Array<PublicDiscussionCandidate & { score: number }>,
): { ids: string[]; reasons: Map<string, string>; openingPrompt?: string } {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match?.[0] ?? "{}") as {
      candidates?: Array<{ studentId?: unknown; reason?: unknown }>;
      openingPrompt?: unknown;
    };
    const allowed = new Set(ranked.map((item) => item.studentId));
    const ids: string[] = [];
    const reasons = new Map<string, string>();
    for (const item of parsed.candidates ?? []) {
      if (typeof item.studentId !== "string" || !allowed.has(item.studentId) || ids.includes(item.studentId)) continue;
      ids.push(item.studentId);
      if (typeof item.reason === "string" && item.reason.trim()) {
        reasons.set(item.studentId, item.reason.trim().slice(0, 240));
      }
    }
    return {
      ids,
      reasons,
      openingPrompt: typeof parsed.openingPrompt === "string"
        ? parsed.openingPrompt.trim().slice(0, 1_000)
        : undefined,
    };
  } catch {
    return { ids: [], reasons: new Map() };
  }
}

export async function recommendDiscussionCandidates(
  courseId: string,
  knowledgePointId: string,
  mode: PublicDiscussionMode,
): Promise<PublicDiscussionRecommendation> {
  const course = await getCourse(courseId);
  if (!course) throw new PublicDiscussionError("COURSE_NOT_FOUND", "课堂不存在。", 404);
  const point = course.content.knowledgePoints.find((item) => item.id === knowledgePointId);
  if (!point) throw new PublicDiscussionError("KNOWLEDGE_POINT_NOT_FOUND", "知识点不存在。", 404);
  const [online, counts] = await Promise.all([
    onlineStudentIds(courseId),
    prisma.publicDiscussionTurn.groupBy({
      by: ["studentId"],
      where: { session: { classroomInstanceId: courseId }, role: "STUDENT", studentId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const participationCounts = new Map(counts.flatMap((item) =>
    item.studentId ? [[item.studentId, item._count._all] as const] : [],
  ));
  const ranked = rankDiscussionCandidates(course, knowledgePointId, mode, online, participationCounts);
  const fallbackPrompt = mode === "inquiry"
    ? `请你先用自己的话解释“${point.name}”，并说明判断时最关键的依据是什么。`
    : `围绕“${point.name}”，请提出一个你认同的观点，并给出能够支持它的理由。`;
  if (!ranked.length) {
    return { knowledgePointId, topic: point.name, openingPrompt: fallbackPrompt, candidates: [] };
  }

  let parsed: ReturnType<typeof parseRecommendation> = { ids: [], reasons: new Map() };
  try {
    const settings = await getPublicDiscussionSettings();
    const { model, thinkingConfig } = await resolveModel({
      modelString: settings.modelString,
      stage: "quiz-grade",
    });
    const result = await callLLM({
      model,
      system: `你是课堂主持助手。请从在线候选中推荐最多3名学生参加全班公开${mode === "inquiry" ? "追问" : "辩论"}。追问优先选择能代表共性误区的学生；辩论优先选择已有明确观点或论据的学生；证据相当时优先历史参与次数较少者。只能使用给出的 studentId。理由不得公开分数或羞辱学生。严格返回 JSON：{"candidates":[{"studentId":"...","reason":"给教师看的简短理由"}],"openingPrompt":"面向学生的开场问题"}。`,
      prompt: `知识点：${point.name}\n候选：${JSON.stringify(ranked.slice(0, 12).map((item) => ({
        studentId: item.studentId,
        studentName: item.studentName,
        evidence: item.evidence,
        participationCount: item.participationCount,
      })))}`,
    }, "quiz-grade", undefined, thinkingConfig);
    parsed = parseRecommendation(result.text, ranked);
  } catch (error) {
    console.error("[public-discussion] AI recommendation failed; deterministic order used", error);
  }
  const ids = parsed.ids.length ? parsed.ids : ranked.map((item) => item.studentId);
  const byId = new Map(ranked.map((item) => [item.studentId, item]));
  const candidates = ids.slice(0, 3).flatMap((id) => {
    const candidate = byId.get(id);
    if (!candidate) return [];
    const publicCandidate: PublicDiscussionCandidate = {
      studentId: candidate.studentId,
      studentName: candidate.studentName,
      online: candidate.online,
      reason: parsed.reasons.get(id) ?? candidate.reason,
      evidence: candidate.evidence,
      participationCount: candidate.participationCount,
    };
    return [publicCandidate];
  });
  return {
    knowledgePointId,
    topic: point.name,
    openingPrompt: parsed.openingPrompt || fallbackPrompt,
    candidates,
  };
}

async function lockCourse(db: Prisma.TransactionClient, courseId: string): Promise<void> {
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`public-discussion:${courseId}`}, 0))::text`;
}

async function writeDomainEvent(
  db: Prisma.TransactionClient,
  input: {
    courseId: string;
    actorId: string;
    requestId: string;
    action: string;
    sessionId: string;
    version: number;
    status: string;
  },
): Promise<{ id: string; createdAt: Date }> {
  const instance = await db.classroomInstance.findUniqueOrThrow({
    where: { id: input.courseId },
    select: { activity: { select: { chapter: { select: { offeringId: true } } } } },
  });
  return db.domainEvent.create({
    data: {
      idempotencyKey: `public-discussion:${input.requestId}`,
      actorId: input.actorId,
      offeringId: instance.activity.chapter.offeringId,
      classroomInstanceId: input.courseId,
      eventType: "public-discussion",
      payload: {
        action: input.action,
        sessionId: input.sessionId,
        version: input.version,
        status: input.status,
        scope: "course",
      },
    },
    select: { id: true, createdAt: true },
  });
}

async function publishDiscussionEvent(
  courseId: string,
  event: { id: string; createdAt: Date },
  payload: { action: string; sessionId: string; version: number; status: string },
): Promise<void> {
  await publishCourseEvent(courseId, {
    type: "public-discussion",
    courseId,
    at: event.createdAt.toISOString(),
    payload: {
      ...payload,
      eventCursor: encodeEventCursor(event),
      scope: "course",
    },
  });
}

async function enrolledStudent(
  db: Db,
  courseId: string,
  studentId: string,
): Promise<{ id: string; displayName: string } | null> {
  const participation = await db.classroomParticipation.findFirst({
    where: {
      instanceId: courseId,
      enrollment: {
        userId: studentId,
        status: { in: ["ACTIVE", "active"] },
      },
    },
    select: { enrollment: { select: { user: { select: { id: true, displayName: true } } } } },
  });
  return participation?.enrollment.user ?? null;
}

function validateVersion(current: number, expected: number): void {
  if (current !== expected) {
    throw new PublicDiscussionError(
      "VERSION_CONFLICT",
      "课堂讨论已在其他设备更新，请刷新后重试。",
      409,
    );
  }
}

export function canApplyDiscussionAsyncResult(
  current: { version: number; status: string; currentStudentId: string | null },
  expected: { version: number; status: string; studentId?: string },
): boolean {
  return current.version === expected.version
    && current.status === expected.status
    && (expected.studentId === undefined || current.currentStudentId === expected.studentId);
}

export function canStartDiscussionRecording(status: string): boolean {
  return ["AWAITING_STUDENT", "AWAITING_RETRY", "AWAITING_CONFIRMATION"].includes(status);
}

export function discussionStatusAfterPlayback(
  status: string,
): "AWAITING_STUDENT" | "AWAITING_TEACHER_CONFIRMATION" | undefined {
  if (status === "AI_READY") return "AWAITING_STUDENT";
  if (status === "AI_COMPLETION_READY") return "AWAITING_TEACHER_CONFIRMATION";
  return undefined;
}

async function activeSessionLocked(
  db: Prisma.TransactionClient,
  courseId: string,
): Promise<SessionRow> {
  await lockCourse(db, courseId);
  const row = await db.publicDiscussionSession.findFirst({
    where: { classroomInstanceId: courseId, status: { in: [...ACTIVE_STATUSES] } },
    include: sessionInclude,
    orderBy: { updatedAt: "desc" },
  });
  if (!row) throw new PublicDiscussionError("NO_ACTIVE_SESSION", "当前没有进行中的公开讨论。", 404);
  return row;
}

async function idempotentSnapshot(
  db: Prisma.TransactionClient,
  requestId: string,
  courseId: string,
  claims: AuthClaims,
  soundClientId?: string,
): Promise<PublicDiscussionSnapshot | null> {
  const existing = await db.domainEvent.findUnique({
    where: { idempotencyKey: `public-discussion:${requestId}` },
    select: { classroomInstanceId: true },
  });
  if (!existing) return null;
  if (existing.classroomInstanceId !== courseId) {
    throw new PublicDiscussionError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他课堂。", 409);
  }
  return snapshotFromRow(await latestSession(courseId, db), claims, soundClientId);
}

export async function startPublicDiscussion(input: {
  courseId: string;
  claims: AuthClaims;
  requestId: string;
  knowledgePointId: string;
  topic: string;
  mode: PublicDiscussionMode;
  openingPrompt: string;
  studentId: string;
  candidates?: PublicDiscussionCandidate[];
}): Promise<PublicDiscussionSnapshot> {
  const course = await getCourse(input.courseId);
  if (!course) throw new PublicDiscussionError("COURSE_NOT_FOUND", "课堂不存在。", 404);
  const point = course.content.knowledgePoints.find((item) => item.id === input.knowledgePointId);
  if (!point) throw new PublicDiscussionError("KNOWLEDGE_POINT_NOT_FOUND", "知识点不存在。", 404);
  const result = await runMutationTransaction(async (tx) => {
    await lockCourse(tx, input.courseId);
    const replay = await idempotentSnapshot(tx, input.requestId, input.courseId, input.claims);
    if (replay) return { snapshot: replay };
    const instance = await tx.classroomInstance.findUnique({
      where: { id: input.courseId },
      select: { status: true },
    });
    if (!instance) throw new PublicDiscussionError("COURSE_NOT_FOUND", "课堂不存在。", 404);
    if (instance.status.toUpperCase() !== "TEACHING") {
      throw new PublicDiscussionError("COURSE_NOT_TEACHING", "只有授课中的课堂可以开始公开讨论。", 409);
    }
    const current = await tx.publicDiscussionSession.findFirst({
      where: { classroomInstanceId: input.courseId, status: { in: [...ACTIVE_STATUSES] } },
      select: { id: true },
    });
    if (current) throw new PublicDiscussionError("SESSION_ALREADY_ACTIVE", "课堂已有进行中的公开讨论。", 409);
    const student = await enrolledStudent(tx, input.courseId, input.studentId);
    if (!student) throw new PublicDiscussionError("STUDENT_NOT_ENROLLED", "所选学生不在当前课堂中。", 422);
    const candidates = (input.candidates ?? []).filter((item) =>
      typeof item.studentId === "string" && typeof item.studentName === "string",
    ).slice(0, 20);
    if (!candidates.some((item) => item.studentId === student.id)) {
      candidates.push({
        studentId: student.id,
        studentName: student.displayName,
        online: false,
        reason: "教师手动选择",
        evidence: "由教师结合现场情况选择",
        participationCount: 0,
      });
    }
    const created = await tx.publicDiscussionSession.create({
      data: {
        classroomInstanceId: input.courseId,
        createdById: input.claims.sub!,
        currentStudentId: student.id,
        knowledgePointId: point.id,
        topic: input.topic.trim().slice(0, 200) || point.name,
        mode: input.mode.toUpperCase(),
        openingPrompt: input.openingPrompt.trim().slice(0, 2_000),
        status: "INVITING",
        candidateEvidence: candidates as unknown as Prisma.InputJsonValue,
      },
      include: sessionInclude,
    });
    const event = await writeDomainEvent(tx, {
      courseId: input.courseId,
      actorId: input.claims.sub!,
      requestId: input.requestId,
      action: "start",
      sessionId: created.id,
      version: created.version,
      status: created.status,
    });
    return {
      snapshot: snapshotFromRow(created, input.claims),
      event,
      payload: { action: "start", sessionId: created.id, version: created.version, status: created.status },
    };
  });
  if (result.event && result.payload) {
    await publishDiscussionEvent(input.courseId, result.event, result.payload);
  }
  return result.snapshot;
}

type SimpleMutationInput = {
  courseId: string;
  claims: AuthClaims;
  requestId: string;
  expectedVersion: number;
  soundClientId?: string;
};

async function updateSessionState(
  input: SimpleMutationInput & { action: string },
  mutate: (
    row: SessionRow,
    tx: Prisma.TransactionClient,
  ) => Promise<Prisma.PublicDiscussionSessionUpdateInput> | Prisma.PublicDiscussionSessionUpdateInput,
): Promise<PublicDiscussionSnapshot> {
  const result = await runMutationTransaction(async (tx) => {
    await lockCourse(tx, input.courseId);
    const replay = await idempotentSnapshot(
      tx,
      input.requestId,
      input.courseId,
      input.claims,
      input.soundClientId,
    );
    if (replay) return { snapshot: replay };
    const row = await activeSessionLocked(tx, input.courseId);
    validateVersion(row.version, input.expectedVersion);
    const data = await mutate(row, tx);
    const updated = await tx.publicDiscussionSession.update({
      where: { id: row.id },
      data: { ...data, version: { increment: 1 } },
      include: sessionInclude,
    });
    const event = await writeDomainEvent(tx, {
      courseId: input.courseId,
      actorId: input.claims.sub!,
      requestId: input.requestId,
      action: input.action,
      sessionId: updated.id,
      version: updated.version,
      status: updated.status,
    });
    return {
      snapshot: snapshotFromRow(updated, input.claims, input.soundClientId),
      event,
      payload: {
        action: input.action,
        sessionId: updated.id,
        version: updated.version,
        status: updated.status,
      },
    };
  });
  if (result.event && result.payload) {
    await publishDiscussionEvent(input.courseId, result.event, result.payload);
  }
  return result.snapshot;
}

export async function respondToInvitation(
  input: SimpleMutationInput & { response: "accept" | "decline" },
): Promise<PublicDiscussionSnapshot> {
  return updateSessionState({ ...input, action: input.response }, async (row, tx) => {
    if (input.claims.role !== "student" || row.currentStudentId !== input.claims.sub) {
      throw new PublicDiscussionError("NOT_CURRENT_STUDENT", "当前未点名你参与讨论。", 403);
    }
    if (row.status !== "INVITING") {
      throw new PublicDiscussionError("INVALID_STATE", "当前邀请已经处理。", 409);
    }
    if (input.response === "decline") return { status: "AWAITING_REPLACEMENT" };
    await tx.publicDiscussionTurn.create({
      data: {
        sessionId: row.id,
        clientRequestId: `${input.requestId}:opening`,
        sequence: (row.turns.at(-1)?.sequence ?? 0) + 1,
        role: "ASSISTANT",
        content: row.openingPrompt,
        source: "SYSTEM",
      },
    });
    return { status: "AI_READY" };
  });
}

export async function setRecordingState(
  input: SimpleMutationInput & { recording: boolean },
): Promise<PublicDiscussionSnapshot> {
  return updateSessionState({ ...input, action: input.recording ? "start-recording" : "cancel-recording" }, (row) => {
    if (input.claims.role !== "student" || row.currentStudentId !== input.claims.sub) {
      throw new PublicDiscussionError("NOT_CURRENT_STUDENT", "当前未点名你发言。", 403);
    }
    if (input.recording && !canStartDiscussionRecording(row.status)) {
      throw new PublicDiscussionError("INVALID_STATE", "当前不能开始录音。", 409);
    }
    if (!input.recording && row.status !== "RECORDING") {
      throw new PublicDiscussionError("INVALID_STATE", "当前没有进行中的录音。", 409);
    }
    return { status: input.recording ? "RECORDING" : "AWAITING_STUDENT" };
  });
}

export async function beginTranscription(input: SimpleMutationInput): Promise<{ sessionId: string; generationVersion: number }> {
  const result = await runMutationTransaction(async (tx) => {
    await lockCourse(tx, input.courseId);
    const row = await activeSessionLocked(tx, input.courseId);
    validateVersion(row.version, input.expectedVersion);
    if (input.claims.role !== "student" || row.currentStudentId !== input.claims.sub) {
      throw new PublicDiscussionError("NOT_CURRENT_STUDENT", "当前未点名你发言。", 403);
    }
    if (row.status !== "RECORDING") {
      throw new PublicDiscussionError("INVALID_STATE", "录音状态已经改变，请重新录音。", 409);
    }
    const updated = await tx.publicDiscussionSession.update({
      where: { id: row.id },
      data: { status: "TRANSCRIBING", version: { increment: 1 } },
      select: { id: true, version: true, status: true },
    });
    const event = await writeDomainEvent(tx, {
      courseId: input.courseId,
      actorId: input.claims.sub!,
      requestId: input.requestId,
      action: "transcribe",
      sessionId: updated.id,
      version: updated.version,
      status: updated.status,
    });
    return { sessionId: updated.id, generationVersion: updated.version, event, updated };
  });
  await publishDiscussionEvent(input.courseId, result.event, {
    action: "transcribe",
    sessionId: result.updated.id,
    version: result.updated.version,
    status: result.updated.status,
  });
  return { sessionId: result.sessionId, generationVersion: result.generationVersion };
}

export async function finishTranscription(input: {
  courseId: string;
  claims: AuthClaims;
  requestId: string;
  sessionId: string;
  generationVersion: number;
  success: boolean;
  text?: string;
}): Promise<PublicDiscussionSnapshot> {
  const result = await runMutationTransaction(async (tx) => {
    await lockCourse(tx, input.courseId);
    const current = await tx.publicDiscussionSession.findUnique({
      where: { id: input.sessionId },
      include: sessionInclude,
    });
    if (!current || current.classroomInstanceId !== input.courseId) {
      throw new PublicDiscussionError("NO_ACTIVE_SESSION", "讨论已经结束。", 404);
    }
    if (!canApplyDiscussionAsyncResult(current, {
      version: input.generationVersion,
      status: "TRANSCRIBING",
      studentId: input.claims.sub!,
    })) {
      return { row: current, shouldGenerate: false as const };
    }
    const content = input.text?.trim().slice(0, 3_000) ?? "";
    const succeeded = input.success && Boolean(content);
    if (succeeded) {
      await tx.publicDiscussionTurn.create({
        data: {
          sessionId: current.id,
          studentId: input.claims.sub,
          clientRequestId: `${input.requestId}:transcript:${input.generationVersion}`,
          sequence: (current.turns.at(-1)?.sequence ?? 0) + 1,
          role: "STUDENT",
          content,
          source: "VOICE",
        },
      });
    }
    const updated = await tx.publicDiscussionSession.update({
      where: { id: current.id },
      data: {
        status: succeeded ? "AI_GENERATING" : "AWAITING_RETRY",
        ...(succeeded ? { roundCount: { increment: 1 } } : {}),
        version: { increment: 1 },
      },
      include: sessionInclude,
    });
    const action = succeeded ? "student-answer" : "transcription-failed";
    const event = await writeDomainEvent(tx, {
      courseId: input.courseId,
      actorId: input.claims.sub!,
      requestId: `${input.requestId}:${action}:${input.generationVersion}`,
      action,
      sessionId: updated.id,
      version: updated.version,
      status: updated.status,
    });
    return { row: updated, event, action, shouldGenerate: succeeded };
  });
  if (result.event && result.action) {
    await publishDiscussionEvent(input.courseId, result.event, {
      action: result.action,
      sessionId: result.row.id,
      version: result.row.version,
      status: result.row.status,
    });
  }
  if (result.shouldGenerate) {
    return completeAssistantGeneration({
      courseId: input.courseId,
      claims: input.claims,
      sessionId: result.row.id,
      expectedGenerationVersion: result.row.version,
      requestId: `${input.requestId}:voice-answer`,
      studentId: input.claims.sub!,
    });
  }
  return snapshotFromRow(result.row, input.claims);
}

type AssistantDecision = {
  reply: string;
  decision: "continue" | "recommend_end";
};

export function parseAssistantDecision(
  raw: string,
  roundCount: number,
  forceContinue = false,
): AssistantDecision {
  let reply = raw.trim().slice(0, 3_000);
  let decision: AssistantDecision["decision"] = "continue";
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match?.[0] ?? "{}") as { reply?: unknown; decision?: unknown };
    if (typeof parsed.reply === "string" && parsed.reply.trim()) {
      reply = parsed.reply.trim().slice(0, 3_000);
    }
    if (parsed.decision === "recommend_end") {
      decision = "recommend_end";
    }
  } catch {
    // Accept plain-text provider responses below.
  }
  if (forceContinue) decision = "continue";
  if (roundCount >= 3) decision = "recommend_end";
  return { reply, decision };
}

async function generateAssistantReply(
  row: SessionRow,
  options: { forceContinue?: boolean } = {},
): Promise<AssistantDecision> {
  const [settings, course] = await Promise.all([
    getPublicDiscussionSettings(),
    getCourse(row.classroomInstanceId),
  ]);
  const { model } = await resolveModel({
    modelString: settings.modelString,
    stage: "quiz-grade",
  });
  const mode = modeFromDb(row.mode);
  const point = course?.content.knowledgePoints.find((item) => item.id === row.knowledgePointId);
  const transcript = row.turns.slice(-10).map((turn) => {
    const label = turn.role === "STUDENT" ? "学生" : turn.role === "TEACHER" ? "教师" : "AI";
    return `${label}：${turn.content}`;
  }).join("\n");
  const decisionRule = options.forceContinue
    ? "教师已决定继续追问。必须返回 continue，并针对尚可深化之处提出一个新的短问题。"
    : row.roundCount >= 3
      ? "这是第3轮回答，已达到轮次上限。必须返回 recommend_end，用简短肯定和概念总结收尾，不得再提出问题。"
      : "如果学生已准确解释核心概念，并给出与问题匹配的充分理由或例证，返回 recommend_end，用简短肯定和概念总结收尾且不要再提问；否则返回 continue，只追问一个最关键的理解缺口。";
  const result = await callLLM({
    model,
    system: mode === "inquiry"
      ? `你正在主持一场面向全班的公开追问。根据知识点目标判断当前学生是否已理解；继续时先回应一个核心点，再提出一个短问题，依次帮助学生解释概念、举出例子、迁移应用。${decisionRule}尊重学生，不公开成绩，不声称全班已经掌握。回答适合口头播报，控制在180字内。严格返回 JSON：{\"reply\":\"口头回应\",\"decision\":\"continue或recommend_end\"}。`
      : `你正在主持一场面向全班的公开辩论。根据知识点目标判断当前学生是否已形成有依据的观点；继续时先准确复述学生观点，再提出一个反例或检验问题。${decisionRule}尊重学生，不公开成绩，不声称全班已经掌握。回答适合口头播报，控制在180字内。严格返回 JSON：{\"reply\":\"口头回应\",\"decision\":\"continue或recommend_end\"}。`,
    prompt: `知识点：${point?.name ?? row.topic}\n知识点说明：${point?.description || "未提供，请结合主题与开场问题判断"}\n讨论主题：${row.topic}\n开场问题：${row.openingPrompt}\n当前学生回答轮次：${row.roundCount}\n公开对话：\n${transcript}`,
  }, "quiz-grade");
  const decision = parseAssistantDecision(result.text, row.roundCount, options.forceContinue);
  if (!decision.reply) throw new Error("AI returned an empty public-discussion reply");
  return decision;
}

async function completeAssistantGeneration(input: {
  courseId: string;
  claims: AuthClaims;
  sessionId: string;
  expectedGenerationVersion: number;
  requestId: string;
  studentId: string;
  forceContinue?: boolean;
}): Promise<PublicDiscussionSnapshot> {
  const source = await prisma.publicDiscussionSession.findUnique({
    where: { id: input.sessionId },
    include: sessionInclude,
  });
  if (!source) throw new PublicDiscussionError("NO_ACTIVE_SESSION", "讨论已经结束。", 404);
  let assistant: AssistantDecision;
  try {
    assistant = await generateAssistantReply(source, { forceContinue: input.forceContinue });
  } catch (error) {
    console.error("[public-discussion] assistant reply failed", error);
    const failed = await runMutationTransaction(async (tx) => {
      await lockCourse(tx, input.courseId);
      const current = await tx.publicDiscussionSession.findUnique({
        where: { id: input.sessionId },
        include: sessionInclude,
      });
      if (!current) throw new PublicDiscussionError("NO_ACTIVE_SESSION", "讨论已经结束。", 404);
      if (!canApplyDiscussionAsyncResult(current, {
        version: input.expectedGenerationVersion,
        status: "AI_GENERATING",
        studentId: input.studentId,
      })) return { row: current };
      const updated = await tx.publicDiscussionSession.update({
        where: { id: current.id },
        data: { status: "AI_FAILED", version: { increment: 1 } },
        include: sessionInclude,
      });
      const event = await writeDomainEvent(tx, {
        courseId: input.courseId,
        actorId: input.claims.sub!,
        requestId: `${input.requestId}:ai-failed:${input.expectedGenerationVersion}`,
        action: "ai-failed",
        sessionId: updated.id,
        version: updated.version,
        status: updated.status,
      });
      return { row: updated, event };
    });
    if (failed.event) {
      await publishDiscussionEvent(input.courseId, failed.event, {
        action: "ai-failed",
        sessionId: failed.row.id,
        version: failed.row.version,
        status: failed.row.status,
      });
    }
    return snapshotFromRow(failed.row, input.claims);
  }

  const result = await runMutationTransaction(async (tx) => {
    await lockCourse(tx, input.courseId);
    const current = await tx.publicDiscussionSession.findUnique({
      where: { id: input.sessionId },
      include: sessionInclude,
    });
    if (!current) throw new PublicDiscussionError("NO_ACTIVE_SESSION", "讨论已经结束。", 404);
    if (!canApplyDiscussionAsyncResult(current, {
      version: input.expectedGenerationVersion,
      status: "AI_GENERATING",
      studentId: input.studentId,
    })) {
      return { row: current };
    }
    const sequence = (current.turns.at(-1)?.sequence ?? 0) + 1;
    await tx.publicDiscussionTurn.create({
      data: {
        sessionId: current.id,
        studentId: null,
        clientRequestId: `${input.requestId}:assistant:${input.expectedGenerationVersion}`,
        sequence,
        role: "ASSISTANT",
        content: assistant.reply,
        source: "SYSTEM",
      },
    });
    const completionRecommended = assistant.decision === "recommend_end";
    const updated = await tx.publicDiscussionSession.update({
      where: { id: current.id },
      data: {
        status: completionRecommended ? "AI_COMPLETION_READY" : "AI_READY",
        version: { increment: 1 },
      },
      include: sessionInclude,
    });
    const event = await writeDomainEvent(tx, {
      courseId: input.courseId,
      actorId: input.claims.sub!,
      requestId: `${input.requestId}:ai:${input.expectedGenerationVersion}`,
      action: completionRecommended ? "ai-completion-ready" : "ai-ready",
      sessionId: updated.id,
      version: updated.version,
      status: updated.status,
    });
    return { row: updated, event };
  });
  if (result.event) {
    await publishDiscussionEvent(input.courseId, result.event, {
      action: assistant.decision === "recommend_end" ? "ai-completion-ready" : "ai-ready",
      sessionId: result.row.id,
      version: result.row.version,
      status: result.row.status,
    });
  }
  return snapshotFromRow(result.row, input.claims);
}

export async function submitStudentAnswer(input: SimpleMutationInput & {
  content: string;
  source: "voice" | "text";
}): Promise<PublicDiscussionSnapshot> {
  const prepared = await runMutationTransaction(async (tx) => {
    await lockCourse(tx, input.courseId);
    const previous = await tx.publicDiscussionTurn.findUnique({
      where: { clientRequestId: input.requestId },
      select: { session: { select: { classroomInstanceId: true } } },
    });
    if (previous) {
      if (previous.session.classroomInstanceId !== input.courseId) {
        throw new PublicDiscussionError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他课堂。", 409);
      }
      return { replay: snapshotFromRow(await latestSession(input.courseId, tx), input.claims) };
    }
    const row = await activeSessionLocked(tx, input.courseId);
    validateVersion(row.version, input.expectedVersion);
    if (input.claims.role !== "student" || row.currentStudentId !== input.claims.sub) {
      throw new PublicDiscussionError("NOT_CURRENT_STUDENT", "当前未点名你发言。", 403);
    }
    if (!["AWAITING_STUDENT", "AWAITING_RETRY", "AWAITING_CONFIRMATION"].includes(row.status)) {
      throw new PublicDiscussionError("INVALID_STATE", "当前不能提交回答。", 409);
    }
    const content = input.content.trim().slice(0, 3_000);
    if (!content) throw new PublicDiscussionError("EMPTY_ANSWER", "回答不能为空。", 422);
    const sequence = (row.turns.at(-1)?.sequence ?? 0) + 1;
    await tx.publicDiscussionTurn.create({
      data: {
        sessionId: row.id,
        studentId: input.claims.sub,
        clientRequestId: input.requestId,
        sequence,
        role: "STUDENT",
        content,
        source: input.source.toUpperCase(),
      },
    });
    const updated = await tx.publicDiscussionSession.update({
      where: { id: row.id },
      data: {
        status: "AI_GENERATING",
        roundCount: { increment: 1 },
        version: { increment: 1 },
      },
      include: sessionInclude,
    });
    const event = await writeDomainEvent(tx, {
      courseId: input.courseId,
      actorId: input.claims.sub!,
      requestId: input.requestId,
      action: "student-answer",
      sessionId: updated.id,
      version: updated.version,
      status: updated.status,
    });
    return { row: updated, event };
  });
  if ("replay" in prepared) return prepared.replay!;
  await publishDiscussionEvent(input.courseId, prepared.event!, {
    action: "student-answer",
    sessionId: prepared.row!.id,
    version: prepared.row!.version,
    status: prepared.row!.status,
  });
  return completeAssistantGeneration({
    courseId: input.courseId,
    claims: input.claims,
    sessionId: prepared.row!.id,
    expectedGenerationVersion: prepared.row!.version,
    requestId: input.requestId,
    studentId: input.claims.sub!,
  });
}

export async function retryAssistantReply(input: SimpleMutationInput): Promise<PublicDiscussionSnapshot> {
  const prepared = await runMutationTransaction(async (tx) => {
    await lockCourse(tx, input.courseId);
    const replay = await idempotentSnapshot(tx, input.requestId, input.courseId, input.claims);
    if (replay) return { replay };
    const row = await activeSessionLocked(tx, input.courseId);
    validateVersion(row.version, input.expectedVersion);
    if (row.status !== "AI_FAILED" || !row.currentStudentId) {
      throw new PublicDiscussionError("INVALID_STATE", "当前没有可重试的 AI 回答。", 409);
    }
    const updated = await tx.publicDiscussionSession.update({
      where: { id: row.id },
      data: { status: "AI_GENERATING", version: { increment: 1 } },
      include: sessionInclude,
    });
    const event = await writeDomainEvent(tx, {
      courseId: input.courseId,
      actorId: input.claims.sub!,
      requestId: input.requestId,
      action: "retry-ai",
      sessionId: updated.id,
      version: updated.version,
      status: updated.status,
    });
    return { row: updated, event };
  });
  if ("replay" in prepared) return prepared.replay!;
  await publishDiscussionEvent(input.courseId, prepared.event!, {
    action: "retry-ai",
    sessionId: prepared.row!.id,
    version: prepared.row!.version,
    status: prepared.row!.status,
  });
  return completeAssistantGeneration({
    courseId: input.courseId,
    claims: input.claims,
    sessionId: prepared.row!.id,
    expectedGenerationVersion: prepared.row!.version,
    requestId: input.requestId,
    studentId: prepared.row!.currentStudentId!,
  });
}

export async function continueDiscussionQuestioning(
  input: SimpleMutationInput,
): Promise<PublicDiscussionSnapshot> {
  const prepared = await runMutationTransaction(async (tx) => {
    await lockCourse(tx, input.courseId);
    const replay = await idempotentSnapshot(tx, input.requestId, input.courseId, input.claims);
    if (replay) return { replay };
    const row = await activeSessionLocked(tx, input.courseId);
    validateVersion(row.version, input.expectedVersion);
    if (row.status !== "AWAITING_TEACHER_CONFIRMATION" || !row.currentStudentId) {
      throw new PublicDiscussionError("INVALID_STATE", "当前没有等待教师决定的 AI 建议。", 409);
    }
    if (row.roundCount >= 3) {
      throw new PublicDiscussionError("ROUND_LIMIT_REACHED", "本次对话已达到三轮上限，请结束并生成总结。", 409);
    }
    const updated = await tx.publicDiscussionSession.update({
      where: { id: row.id },
      data: { status: "AI_GENERATING", version: { increment: 1 } },
      include: sessionInclude,
    });
    const event = await writeDomainEvent(tx, {
      courseId: input.courseId,
      actorId: input.claims.sub!,
      requestId: input.requestId,
      action: "continue-questioning",
      sessionId: updated.id,
      version: updated.version,
      status: updated.status,
    });
    return { row: updated, event };
  });
  if ("replay" in prepared) return prepared.replay!;
  await publishDiscussionEvent(input.courseId, prepared.event!, {
    action: "continue-questioning",
    sessionId: prepared.row!.id,
    version: prepared.row!.version,
    status: prepared.row!.status,
  });
  return completeAssistantGeneration({
    courseId: input.courseId,
    claims: input.claims,
    sessionId: prepared.row!.id,
    expectedGenerationVersion: prepared.row!.version,
    requestId: input.requestId,
    studentId: prepared.row!.currentStudentId!,
    forceContinue: true,
  });
}

export async function inviteDiscussionStudent(input: SimpleMutationInput & {
  studentId: string;
}): Promise<PublicDiscussionSnapshot> {
  return updateSessionState({ ...input, action: "invite" }, async (row, tx) => {
    const student = await enrolledStudent(tx, input.courseId, input.studentId);
    if (!student) throw new PublicDiscussionError("STUDENT_NOT_ENROLLED", "所选学生不在当前课堂中。", 422);
    if (row.status === "SUMMARIZING") {
      throw new PublicDiscussionError("INVALID_STATE", "讨论正在生成总结。", 409);
    }
    return {
      currentStudent: { connect: { id: student.id } },
      status: "INVITING",
      resumeStatus: null,
      soundOwner: { disconnect: true },
      soundClientId: null,
      soundLeaseUntil: null,
    };
  });
}

export async function pausePublicDiscussion(
  input: SimpleMutationInput & { paused: boolean },
): Promise<PublicDiscussionSnapshot> {
  return updateSessionState({ ...input, action: input.paused ? "pause" : "resume" }, (row) => {
    if (input.paused) {
      if (["SUMMARIZING", "ENDED", "PAUSED"].includes(row.status)) {
        throw new PublicDiscussionError("INVALID_STATE", "当前不能暂停讨论。", 409);
      }
      const resumeStatus = ["RECORDING", "TRANSCRIBING", "AWAITING_CONFIRMATION", "AI_GENERATING"].includes(row.status)
        ? "AWAITING_STUDENT"
        : row.status;
      return {
        status: "PAUSED",
        resumeStatus,
        soundOwner: { disconnect: true },
        soundClientId: null,
        soundLeaseUntil: null,
      };
    }
    if (row.status !== "PAUSED") {
      throw new PublicDiscussionError("INVALID_STATE", "讨论当前没有暂停。", 409);
    }
    return { status: row.resumeStatus ?? "AWAITING_STUDENT", resumeStatus: null };
  });
}

export async function addTeacherGuidance(input: SimpleMutationInput & {
  content: string;
}): Promise<PublicDiscussionSnapshot> {
  return updateSessionState({ ...input, action: "teacher-guide" }, async (row, tx) => {
    const content = input.content.trim().slice(0, 1_500);
    if (!content) throw new PublicDiscussionError("EMPTY_GUIDANCE", "引导文字不能为空。", 422);
    if (["SUMMARIZING", "ENDED"].includes(row.status)) {
      throw new PublicDiscussionError("INVALID_STATE", "讨论已经结束。", 409);
    }
    await tx.publicDiscussionTurn.create({
      data: {
        sessionId: row.id,
        clientRequestId: `${input.requestId}:teacher`,
        sequence: (row.turns.at(-1)?.sequence ?? 0) + 1,
        role: "TEACHER",
        content,
        source: "TEXT",
      },
    });
    return { status: "AWAITING_STUDENT", resumeStatus: null };
  });
}

export async function completeDiscussionPlayback(
  input: SimpleMutationInput & { clientId: string },
): Promise<PublicDiscussionSnapshot> {
  return updateSessionState({ ...input, action: "complete-playback", soundClientId: input.clientId }, (row) => {
    const nextStatus = discussionStatusAfterPlayback(row.status);
    if (!nextStatus) {
      throw new PublicDiscussionError("INVALID_STATE", "当前没有等待播放的 AI 回答。", 409);
    }
    const now = Date.now();
    if (
      row.soundOwnerId !== input.claims.sub
      || row.soundClientId !== input.clientId
      || !row.soundLeaseUntil
      || row.soundLeaseUntil.getTime() <= now
    ) {
      throw new PublicDiscussionError("SOUND_LEASE_REQUIRED", "此教师页面没有课堂声音控制权。", 409);
    }
    return {
      status: nextStatus,
    };
  });
}

export async function acquireDiscussionSound(input: {
  courseId: string;
  claims: AuthClaims;
  clientId: string;
}): Promise<PublicDiscussionSnapshot> {
  const row = await runMutationTransaction(async (tx) => {
    const current = await activeSessionLocked(tx, input.courseId);
    const now = new Date();
    const available = !current.soundLeaseUntil
      || current.soundLeaseUntil.getTime() <= now.getTime()
      || (current.soundOwnerId === input.claims.sub && current.soundClientId === input.clientId);
    if (!available) return current;
    return tx.publicDiscussionSession.update({
      where: { id: current.id },
      data: {
        soundOwnerId: input.claims.sub,
        soundClientId: input.clientId,
        soundLeaseUntil: new Date(now.getTime() + SOUND_LEASE_MS),
      },
      include: sessionInclude,
    });
  });
  return snapshotFromRow(row, input.claims, input.clientId);
}

function fallbackSummary(row: SessionRow): PublicDiscussionSummary {
  const lastStudent = [...row.turns].reverse().find((turn) => turn.role === "STUDENT")?.content;
  return {
    keyConclusion: `围绕“${row.topic}”，课堂完成了公开${row.mode === "DEBATE" ? "辩论" : "追问"}。`,
    misconceptionRepair: lastStudent
      ? `可从学生最后的解释继续核对判断依据：${lastStudent.slice(0, 160)}`
      : "需要继续区分结论、判断依据与适用条件。",
    transferQuestion: `如果题目情境发生变化，“${row.topic}”的判断方法还成立吗？为什么？`,
  };
}

function parseSummary(raw: string, fallback: PublicDiscussionSummary): PublicDiscussionSummary {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const value = JSON.parse(match?.[0] ?? "{}") as Record<string, unknown>;
    const read = (key: keyof PublicDiscussionSummary, fallbackValue: string) =>
      typeof value[key] === "string" && value[key].trim()
        ? value[key].trim().slice(0, 1_500)
        : fallbackValue;
    return {
      keyConclusion: read("keyConclusion", fallback.keyConclusion),
      misconceptionRepair: read("misconceptionRepair", fallback.misconceptionRepair),
      transferQuestion: read("transferQuestion", fallback.transferQuestion),
    };
  } catch {
    return fallback;
  }
}

async function generateSummary(row: SessionRow): Promise<PublicDiscussionSummary> {
  const fallback = fallbackSummary(row);
  try {
    const settings = await getPublicDiscussionSettings();
    const { model, thinkingConfig } = await resolveModel({
      modelString: settings.modelString,
      stage: "quiz-grade",
    });
    const transcript = row.turns.map((turn) => `${turn.role}：${turn.content}`).join("\n");
    const result = await callLLM({
      model,
      system: "你是课堂讨论记录员。基于公开对话形成简洁、可投屏的教学总结，不评价个人，不声称全班已经掌握。严格返回 JSON：{\"keyConclusion\":\"关键结论\",\"misconceptionRepair\":\"误解澄清\",\"transferQuestion\":\"迁移问题\"}。",
      prompt: `主题：${row.topic}\n开场问题：${row.openingPrompt}\n对话：\n${transcript}`,
    }, "quiz-grade", undefined, thinkingConfig);
    return parseSummary(result.text, fallback);
  } catch (error) {
    console.error("[public-discussion] summary generation failed; fallback used", error);
    return fallback;
  }
}

export async function finishPublicDiscussion(input: SimpleMutationInput): Promise<PublicDiscussionSnapshot> {
  const prepared = await runMutationTransaction(async (tx) => {
    await lockCourse(tx, input.courseId);
    const replay = await idempotentSnapshot(tx, input.requestId, input.courseId, input.claims);
    if (replay) return { replay };
    const row = await activeSessionLocked(tx, input.courseId);
    validateVersion(row.version, input.expectedVersion);
    const updated = await tx.publicDiscussionSession.update({
      where: { id: row.id },
      data: {
        status: "SUMMARIZING",
        resumeStatus: null,
        soundLeaseUntil: null,
        version: { increment: 1 },
      },
      include: sessionInclude,
    });
    const event = await writeDomainEvent(tx, {
      courseId: input.courseId,
      actorId: input.claims.sub!,
      requestId: input.requestId,
      action: "finish",
      sessionId: updated.id,
      version: updated.version,
      status: updated.status,
    });
    return { row: updated, event };
  });
  if ("replay" in prepared) return prepared.replay!;
  await publishDiscussionEvent(input.courseId, prepared.event!, {
    action: "finish",
    sessionId: prepared.row!.id,
    version: prepared.row!.version,
    status: prepared.row!.status,
  });
  const summary = await generateSummary(prepared.row!);
  const ended = await runMutationTransaction(async (tx) => {
    await lockCourse(tx, input.courseId);
    const current = await tx.publicDiscussionSession.findUnique({
      where: { id: prepared.row!.id },
      include: sessionInclude,
    });
    if (!current) throw new PublicDiscussionError("NO_ACTIVE_SESSION", "讨论不存在。", 404);
    if (!canApplyDiscussionAsyncResult(current, {
      version: prepared.row!.version,
      status: "SUMMARIZING",
    })) return { row: current };
    const updated = await tx.publicDiscussionSession.update({
      where: { id: current.id },
      data: {
        status: "ENDED",
        endedAt: new Date(),
        keyConclusion: summary.keyConclusion,
        misconceptionRepair: summary.misconceptionRepair,
        transferQuestion: summary.transferQuestion,
        version: { increment: 1 },
      },
      include: sessionInclude,
    });
    const event = await writeDomainEvent(tx, {
      courseId: input.courseId,
      actorId: input.claims.sub!,
      requestId: `${input.requestId}:ended:${prepared.row!.version}`,
      action: "ended",
      sessionId: updated.id,
      version: updated.version,
      status: updated.status,
    });
    return { row: updated, event };
  });
  if (ended.event) {
    await publishDiscussionEvent(input.courseId, ended.event, {
      action: "ended",
      sessionId: ended.row.id,
      version: ended.row.version,
      status: ended.row.status,
    });
  }
  return snapshotFromRow(ended.row, input.claims);
}
