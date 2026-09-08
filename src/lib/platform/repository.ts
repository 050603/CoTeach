import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { normalizeInviteCode } from "@/lib/session/invite-code";
import { ActivityConfigSchema, ActivityTypeSchema, type ActivityType } from "./activity";
import {
  normalizeUsername,
  requireStudentUser,
  requireTeacherUser,
  type PlatformDb,
} from "./access";

const offeringInclude = {
  invitation: true,
  chapters: {
    where: { archivedAt: null },
    orderBy: { position: "asc" as const },
    include: {
      activities: {
        where: { archivedAt: null },
        orderBy: { position: "asc" as const },
        include: {
          instances: {
            orderBy: { createdAt: "desc" as const },
            select: {
              id: true,
              status: true,
              templateVersionId: true,
              legacyCourseId: true,
              legacySourceCourseId: true,
              startedAt: true,
              endedAt: true,
              createdAt: true,
              participations: {
                orderBy: { firstEnteredAt: "asc" as const },
                select: {
                  id: true,
                  firstEnteredAt: true,
                  lastEnteredAt: true,
                  completedAt: true,
                  enrollment: { select: { user: { select: { id: true, username: true, displayName: true } } } },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

function newInviteCode(): string {
  return randomBytes(5).toString("hex").toUpperCase().slice(0, 8);
}

function nowOr(value?: Date | string | null): Date | null | undefined {
  // `undefined` means "leave the column unchanged" while an explicit null
  // means "clear the scheduled time". Keeping those states distinct is
  // important for PATCH requests that remove a previously configured date.
  if (value === null) return null;
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export function isOfferingOpen(invitation: {
  disabledAt: Date | null;
  expiresAt: Date | null;
}, offeringStatus: string, at = new Date()): boolean {
  return offeringStatus === "open"
    && !invitation.disabledAt
    && (!invitation.expiresAt || invitation.expiresAt > at);
}

export function isChapterOpen(chapter: {
  isOpen: boolean;
  opensAt: Date | null;
  archivedAt: Date | null;
}, at = new Date()): boolean {
  return !chapter.archivedAt && chapter.isOpen && (!chapter.opensAt || chapter.opensAt <= at);
}

export function isActivityOpen(
  chapter: Parameters<typeof isChapterOpen>[0],
  activity: { isOpen: boolean; opensAt: Date | null; archivedAt: Date | null },
  at = new Date(),
): boolean {
  return isChapterOpen(chapter, at)
    && !activity.archivedAt
    && activity.isOpen
    && (!activity.opensAt || activity.opensAt <= at);
}

export async function validateInvitation(code: string, db: PlatformDb = prisma) {
  const normalized = normalizeInviteCode(code);
  const invitation = await db.courseInvitation.findUnique({
    where: { code: normalized },
    include: { offering: { select: { id: true, name: true, description: true, term: true, status: true, teacher: { select: { displayName: true } } } } },
  });
  if (!invitation || !isOfferingOpen(invitation, invitation.offering.status)) return null;
  return {
    id: invitation.id,
    code: invitation.code,
    expiresAt: invitation.expiresAt,
    offering: invitation.offering,
  };
}

export async function registerStudent(input: {
  invitationCode: string;
  username: string;
  displayName: string;
  password: string;
}) {
  const username = input.username.normalize("NFKC").trim();
  const usernameKey = normalizeUsername(username);
  const displayName = input.displayName.normalize("NFC").trim();
  if (usernameKey.length < 3 || displayName.length < 1 || input.password.length < 8) {
    throw new PlatformError("INVALID_INPUT", "用户名、姓名或密码不符合要求", 400);
  }
  const passwordHash = await hashPassword(input.password);
  return runMutationTransaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`platform-invite:${normalizeInviteCode(input.invitationCode)}`}, 0))`;
    const invitation = await tx.courseInvitation.findUnique({
      where: { code: normalizeInviteCode(input.invitationCode) },
      include: { offering: { include: { chapters: { where: { archivedAt: null }, include: { activities: { where: { archivedAt: null } } } } } } },
    });
    if (!invitation || !isOfferingOpen(invitation, invitation.offering.status)) {
      throw new PlatformError("INVITE_CODE_INVALID", "课程邀请码无效、已停用或已过期", 404);
    }
    const existing = await tx.user.findUnique({ where: { usernameKey } });
    if (existing) throw new PlatformError("USERNAME_TAKEN", "登录账号已存在", 409);
    const user = await tx.user.create({
      data: { username, usernameKey, displayName, passwordHash, role: "student" },
    });
    const enrollment = await tx.enrollment.create({
      data: { userId: user.id, offeringId: invitation.offeringId },
    });
    const activities = invitation.offering.chapters.flatMap((chapter) => chapter.activities);
    if (activities.length) {
      await tx.activityProgress.createMany({
        data: activities.map((activity) => ({
          id: randomUUID(),
          offeringId: invitation.offeringId,
          enrollmentId: enrollment.id,
          activityId: activity.id,
        })),
      });
    }
    return { user, enrollment, offering: invitation.offering };
  });
}

export async function loginStudent(username: string, password: string) {
  const account = await prisma.user.findUnique({
    where: { usernameKey: normalizeUsername(username) },
    include: { enrollments: { where: { status: "active" }, include: { offering: { select: { id: true, legacyCourseId: true } } } } },
  });
  if (!account || account.role !== "student" || account.status !== "active" || !(await verifyPassword(password, account.passwordHash))) {
    throw new PlatformError("INVALID_CREDENTIALS", "用户名或密码错误", 401);
  }
  await prisma.user.update({ where: { id: account.id }, data: { lastLoginAt: new Date() } });
  return account;
}

export async function listStudentOfferings(claims: AuthClaims) {
  const user = await requireStudentUser(claims);
  const rows = await prisma.enrollment.findMany({
    where: { userId: user.id, status: { in: ["active", "completed"] }, offering: { status: { in: ["open", "finished", "archived"] } } },
    include: {
      offering: {
        include: {
          teacher: { select: { displayName: true } },
          invitation: true,
          chapters: {
            where: { archivedAt: null }, orderBy: { position: "asc" },
            include: { activities: { where: { archivedAt: null }, orderBy: { position: "asc" } } },
          },
        },
      },
      progress: true,
    },
  });
  const at = new Date();
  return rows.map((row) => ({
    id: row.offering.id,
    name: row.offering.name,
    description: row.offering.description,
    term: row.offering.term,
    startsAt: row.offering.startsAt,
    endsAt: row.offering.endsAt,
    status: row.offering.status,
    teacher: row.offering.teacher,
    enrollment: { id: row.id, joinedAt: row.joinedAt, currentChapterId: row.currentChapterId, currentActivityId: row.currentActivityId },
    chapters: row.offering.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      description: chapter.description,
      position: chapter.position,
      isOpen: isChapterOpen(chapter, at),
      opensAt: chapter.opensAt,
      activities: chapter.activities.map((activity) => {
        const progress = row.progress.find((item) => item.activityId === activity.id);
        const open = isActivityOpen(chapter, activity, at);
        return {
          id: activity.id,
          type: activity.type,
          title: activity.title,
          description: activity.description,
          position: activity.position,
          opensAt: activity.opensAt,
          isOpen: open,
          progress: progress ? { status: progress.status, startedAt: progress.startedAt, completedAt: progress.completedAt, lastAccessedAt: progress.lastAccessedAt } : { status: "not_started" },
          // Locked activities expose catalogue metadata but no executable
          // configuration or classroom snapshot.
          ...(open ? { config: activity.config } : {}),
        };
      }),
    })),
  }));
}

export async function getStudentActivity(claims: AuthClaims, activityId: string) {
  const user = await requireStudentUser(claims);
  const activity = await prisma.activity.findUnique({
    where: { id: activityId },
    include: {
      chapter: true,
      offering: { select: { id: true, name: true, status: true, legacyCourseId: true } },
      instances: { where: { status: { in: ["scheduled", "teaching", "finished"] } }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!activity || activity.archivedAt) throw new PlatformError("NOT_FOUND", "活动不存在", 404);
  if (!["open", "finished", "archived"].includes(activity.offering.status)) throw new PlatformError("COURSE_NOT_OPEN", "教学班尚未开放", 403);
  const enrollment = await prisma.enrollment.findUnique({ where: { userId_offeringId: { userId: user.id, offeringId: activity.offeringId } }, include: { progress: { where: { activityId } } } });
  if (!enrollment || !["active", "completed"].includes(enrollment.status)) throw new PlatformError("ENROLLMENT_REQUIRED", "请先加入教学班", 403);
  const open = isActivityOpen(activity.chapter, activity, new Date());
  const instance = activity.instances[0];
  let progress = enrollment.progress[0] ? { status: enrollment.progress[0].status, startedAt: enrollment.progress[0].startedAt, completedAt: enrollment.progress[0].completedAt } : { status: "not_started" as const, startedAt: null, completedAt: null };
  if (open && activity.offering.status === "open" && enrollment.status === "active") {
    await runMutationTransaction(async (tx) => {
      const accessedAt = new Date();
      const existing = await tx.activityProgress.findUnique({ where: { enrollmentId_activityId: { enrollmentId: enrollment.id, activityId } }, select: { status: true, startedAt: true } });
      await tx.activityProgress.upsert({
        where: { enrollmentId_activityId: { enrollmentId: enrollment.id, activityId } },
        create: { id: randomUUID(), offeringId: activity.offeringId, enrollmentId: enrollment.id, activityId, status: "in_progress", startedAt: accessedAt, lastAccessedAt: accessedAt },
        update: { ...(existing?.status === "completed" ? {} : { status: "in_progress", startedAt: existing?.startedAt ?? accessedAt }), lastAccessedAt: accessedAt },
      });
      if (enrollment.currentChapterId !== activity.chapterId || enrollment.currentActivityId !== activity.id) {
        await tx.enrollment.update({ where: { id: enrollment.id }, data: { currentChapterId: activity.chapterId, currentActivityId: activity.id, version: { increment: 1 } } });
      }
      await appendEventTx(tx, { userId: user.id, offeringId: activity.offeringId, enrollmentId: enrollment.id, chapterId: activity.chapterId, activityId, type: "activity_opened", idempotencyKey: `activity-opened:${activity.id}:${enrollment.id}`, source: "platform" });
    });
    if (progress.status !== "completed") progress = { ...progress, status: "in_progress", startedAt: progress.startedAt ?? new Date() };
  }
  const instances = activity.instances.map((item) => ({
    id: item.id,
    status: item.status,
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    canWrite: item.status === "teaching" && activity.offering.status === "open" && enrollment.status === "active",
    legacyCourseId: item.legacyCourseId ?? activity.offering.legacyCourseId,
  }));
  return {
    id: activity.id,
    offering: activity.offering,
    chapter: { id: activity.chapter.id, title: activity.chapter.title, isOpen: isChapterOpen(activity.chapter) },
    type: activity.type,
    title: activity.title,
    description: activity.description,
    isOpen: open,
    progress,
    instances: open ? instances : [],
    instance: open && instance ? instances[0] : null,
    config: open ? activity.config : null,
  };
}

export async function joinOffering(claims: AuthClaims, invitationCode: string) {
  const user = await requireStudentUser(claims);
  return runMutationTransaction(async (tx) => {
    const invitation = await tx.courseInvitation.findUnique({ where: { code: normalizeInviteCode(invitationCode) }, include: { offering: true } });
    if (!invitation || !isOfferingOpen(invitation, invitation.offering.status)) throw new PlatformError("INVITE_CODE_INVALID", "课程邀请码无效、已停用或已过期", 404);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`enrollment:${user.id}:${invitation.offeringId}`}, 0))`;
    const existing = await tx.enrollment.findUnique({ where: { userId_offeringId: { userId: user.id, offeringId: invitation.offeringId } } });
    if (existing) return existing;
    const enrollment = await tx.enrollment.create({ data: { userId: user.id, offeringId: invitation.offeringId } });
    const activities = await tx.activity.findMany({ where: { offeringId: invitation.offeringId, archivedAt: null, chapter: { archivedAt: null } } });
    if (activities.length) await tx.activityProgress.createMany({ data: activities.map((activity) => ({ id: randomUUID(), offeringId: invitation.offeringId, enrollmentId: enrollment.id, activityId: activity.id })) });
    return enrollment;
  });
}

export async function listTeacherOfferings(claims: AuthClaims) {
  const teacher = await requireTeacherUser(claims);
  return prisma.courseOffering.findMany({ where: { teacherId: teacher.id }, include: offeringInclude, orderBy: { updatedAt: "desc" } });
}

export async function createOffering(claims: AuthClaims, input: {
  name: string; description?: string; term?: string; startsAt?: string; endsAt?: string; legacyCourseId?: string;
}) {
  const teacher = await requireTeacherUser(claims);
  if (!input.name.trim()) throw new PlatformError("INVALID_INPUT", "教学班名称不能为空", 400);
  if (input.legacyCourseId) {
    const course = await prisma.course.findUnique({ where: { id: input.legacyCourseId }, select: { id: true } });
    if (!course) throw new PlatformError("COURSE_NOT_FOUND", "关联课堂不存在", 404);
    const linked = await prisma.courseOffering.findFirst({ where: { legacyCourseId: input.legacyCourseId }, select: { teacherId: true } });
    if (linked && linked.teacherId !== teacher.id) throw new PlatformError("FORBIDDEN", "不能使用其他教师的课堂内容", 403);
    const ownedTemplate = await prisma.classroomTemplate.findFirst({ where: { legacyCourseId: input.legacyCourseId }, select: { teacherId: true } });
    if (ownedTemplate && ownedTemplate.teacherId !== teacher.id) throw new PlatformError("FORBIDDEN", "不能使用其他教师的课堂内容", 403);
  }
  return prisma.courseOffering.create({
    data: {
      teacherId: teacher.id,
      legacyCourseId: input.legacyCourseId,
      name: input.name.trim(), description: input.description?.trim() || null, term: input.term?.trim() || null,
      startsAt: nowOr(input.startsAt), endsAt: nowOr(input.endsAt),
      invitation: { create: { code: await uniqueInviteCode() } },
    },
    include: offeringInclude,
  });
}

export async function updateOffering(claims: AuthClaims, offeringId: string, data: {
  name?: string; description?: string; term?: string; status?: "draft" | "open" | "finished" | "archived"; startsAt?: string | null; endsAt?: string | null; coverImageUrl?: string | null; version?: number;
}) {
  const teacher = await requireTeacherUser(claims);
  const offering = await prisma.courseOffering.findFirst({ where: { id: offeringId, teacherId: teacher.id } });
  if (!offering) throw new PlatformError("NOT_FOUND", "教学班不存在", 404);
  if (offering.status === "archived" && data.status !== undefined && data.status !== "archived") throw new PlatformError("OFFERING_ARCHIVED", "已归档教学班不能重新开放", 409);
  if (data.version !== undefined && data.version !== offering.version) throw new PlatformError("STALE_VERSION", "教学班已被其他人修改，请刷新后重试", 409);
  const changes = {
    name: data.name,
    description: data.description,
    term: data.term,
    status: data.status,
    coverImageUrl: data.coverImageUrl,
  };
  return prisma.courseOffering.update({ where: { id: offeringId }, data: { ...changes, startsAt: data.startsAt === undefined ? undefined : nowOr(data.startsAt), endsAt: data.endsAt === undefined ? undefined : nowOr(data.endsAt), version: { increment: 1 } }, include: offeringInclude });
}

export async function createChapter(claims: AuthClaims, offeringId: string, input: { title: string; description?: string; position?: number }) {
  const teacher = await requireTeacherUser(claims);
  return runMutationTransaction(async (tx) => {
    const offering = await tx.courseOffering.findFirst({ where: { id: offeringId, teacherId: teacher.id } });
    if (!offering) throw new PlatformError("NOT_FOUND", "教学班不存在", 404);
    if (offering.status === "archived") throw new PlatformError("OFFERING_ARCHIVED", "已归档教学班不能继续编排", 409);
    if (!input.title.trim()) throw new PlatformError("INVALID_INPUT", "章节标题不能为空", 400);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`chapter-order:${offeringId}`}, 0))`;
    const last = await tx.chapter.findFirst({ where: { offeringId }, orderBy: { position: "desc" }, select: { position: true } });
    // Positions are intentionally monotonic because archived rows retain their
    // historical order. This prevents a newly created row from colliding with
    // an archived chapter under the database uniqueness constraint.
    const nextPosition = (last?.position ?? -1) + 1;
    return tx.chapter.create({ data: { offeringId, title: input.title.trim(), description: input.description?.trim() || null, position: input.position === undefined ? nextPosition : Math.max(nextPosition, input.position) } });
  });
}

export async function createActivity(claims: AuthClaims, offeringId: string, chapterId: string, input: { type: ActivityType; title: string; description?: string; position?: number; templateId?: string; config?: unknown }) {
  const teacher = await requireTeacherUser(claims);
  const parsedType = ActivityTypeSchema.safeParse(input.type);
  if (!parsedType.success) throw new PlatformError("INVALID_ACTIVITY_TYPE", "不支持的活动类型", 400);
  const templateId = input.templateId?.trim() || undefined;
  if (templateId && parsedType.data !== "Classroom") throw new PlatformError("INVALID_TEMPLATE_ACTIVITY", "只有 Classroom 活动可以绑定课堂模板", 400);
  const parsedConfig = ActivityConfigSchema.safeParse(input.config ?? { schemaVersion: 1 });
  if (!parsedConfig.success) throw new PlatformError("INVALID_CONFIG", "活动配置无效", 400, parsedConfig.error.flatten());
  const config = parsedConfig.data;
  return runMutationTransaction(async (tx) => {
    const chapter = await tx.chapter.findFirst({ where: { id: chapterId, offeringId, offering: { teacherId: teacher.id }, archivedAt: null } });
    if (!chapter) throw new PlatformError("NOT_FOUND", "章节不存在", 404);
    if (!chapter.title || !input.title.trim()) throw new PlatformError("INVALID_INPUT", "活动标题不能为空", 400);
    if ((await tx.courseOffering.findUnique({ where: { id: offeringId }, select: { status: true } }))?.status === "archived") throw new PlatformError("OFFERING_ARCHIVED", "已归档教学班不能继续编排", 409);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`activity-order:${chapterId}`}, 0))`;
    if (templateId) {
      const template = await tx.classroomTemplate.findFirst({ where: { id: templateId, teacherId: teacher.id, status: "ready" } });
      if (!template) throw new PlatformError("TEMPLATE_NOT_FOUND", "课堂模板不存在或尚未就绪", 404);
    }
    const last = await tx.activity.findFirst({ where: { chapterId }, orderBy: { position: "desc" }, select: { position: true } });
    const nextPosition = (last?.position ?? -1) + 1;
    const activity = await tx.activity.create({ data: { offeringId, chapterId, type: parsedType.data, title: input.title.trim(), description: input.description?.trim() || null, position: input.position === undefined ? nextPosition : Math.max(nextPosition, input.position), templateId, config: config as Prisma.InputJsonValue } });
    const enrollments = await tx.enrollment.findMany({ where: { offeringId, status: "active" }, select: { id: true } });
    if (enrollments.length) {
      await tx.activityProgress.createMany({ data: enrollments.map((enrollment) => ({ id: randomUUID(), offeringId, enrollmentId: enrollment.id, activityId: activity.id })) });
    }
    return activity;
  });
}

export async function updateChapter(claims: AuthClaims, chapterId: string, data: { title?: string; description?: string; isOpen?: boolean; opensAt?: string | null; position?: number; version?: number }) {
  const teacher = await requireTeacherUser(claims);
  return runMutationTransaction(async (tx) => {
    let chapter = await tx.chapter.findFirst({ where: { id: chapterId, offering: { teacherId: teacher.id }, archivedAt: null } });
    if (!chapter) throw new PlatformError("NOT_FOUND", "章节不存在", 404);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`chapter-order:${chapter.offeringId}`}, 0))`;
    chapter = await tx.chapter.findFirst({ where: { id: chapterId, offering: { teacherId: teacher.id }, archivedAt: null } });
    if (!chapter) throw new PlatformError("NOT_FOUND", "章节不存在", 404);
    if (data.version !== undefined && data.version !== chapter.version) throw new PlatformError("STALE_VERSION", "章节已被其他人修改，请刷新后重试", 409);
    const basicData = { title: data.title?.trim(), description: data.description, isOpen: data.isOpen, opensAt: data.opensAt === undefined ? undefined : nowOr(data.opensAt) };
    if (data.position === undefined) {
      return tx.chapter.update({ where: { id: chapterId }, data: { ...basicData, version: { increment: 1 } } });
    }
    const chapters = await tx.chapter.findMany({ where: { offeringId: chapter.offeringId, archivedAt: null }, orderBy: { position: "asc" }, select: { id: true, position: true } });
    const currentIndex = chapters.findIndex((item) => item.id === chapterId);
    const rest = chapters.filter((item) => item.id !== chapterId);
    const index = Math.max(0, Math.min(data.position, rest.length));
    if (index === currentIndex) {
      return tx.chapter.update({ where: { id: chapterId }, data: { ...basicData, version: { increment: 1 } } });
    }
    rest.splice(index, 0, { id: chapterId, position: chapter.position });
    const last = await tx.chapter.findFirst({ where: { offeringId: chapter.offeringId }, orderBy: { position: "desc" }, select: { position: true } });
    const base = (last?.position ?? -1) + 1;
    const temporaryBase = base + rest.length + 1000;
    for (let i = 0; i < rest.length; i += 1) {
      await tx.chapter.update({ where: { id: rest[i].id }, data: { position: temporaryBase + i } });
    }
    for (let i = 0; i < rest.length; i += 1) {
      await tx.chapter.update({ where: { id: rest[i].id }, data: { position: base + i, ...(rest[i].id === chapterId ? basicData : {}), version: { increment: 1 } } });
    }
    return tx.chapter.findUnique({ where: { id: chapterId } });
  });
}

export async function updateActivity(claims: AuthClaims, activityId: string, data: { title?: string; description?: string; isOpen?: boolean; opensAt?: string | null; position?: number; config?: unknown; templateId?: string | null; version?: number }) {
  const teacher = await requireTeacherUser(claims);
  return runMutationTransaction(async (tx) => {
    let activity = await tx.activity.findFirst({ where: { id: activityId, offering: { teacherId: teacher.id }, archivedAt: null } });
    if (!activity) throw new PlatformError("NOT_FOUND", "活动不存在", 404);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`activity-order:${activity.chapterId}`}, 0))`;
    activity = await tx.activity.findFirst({ where: { id: activityId, offering: { teacherId: teacher.id }, archivedAt: null } });
    if (!activity) throw new PlatformError("NOT_FOUND", "活动不存在", 404);
    if (data.version !== undefined && data.version !== activity.version) throw new PlatformError("STALE_VERSION", "活动已被其他人修改，请刷新后重试", 409);
    const templateId = data.templateId === undefined ? undefined : data.templateId?.trim() || null;
    if (templateId && activity.type !== "Classroom") throw new PlatformError("INVALID_TEMPLATE_ACTIVITY", "只有 Classroom 活动可以绑定课堂模板", 400);
    if (templateId) {
      const template = await tx.classroomTemplate.findFirst({ where: { id: templateId, teacherId: teacher.id, status: "ready" } });
      if (!template) throw new PlatformError("TEMPLATE_NOT_FOUND", "课堂模板不存在或尚未就绪", 404);
    }
    let nextConfig: Prisma.InputJsonValue | undefined;
    if (data.config !== undefined) {
      try { nextConfig = ActivityConfigSchema.parse(data.config) as Prisma.InputJsonValue; }
      catch { throw new PlatformError("INVALID_CONFIG", "活动配置无效", 400); }
    }
    const basicData = { title: data.title?.trim(), description: data.description, isOpen: data.isOpen, opensAt: data.opensAt === undefined ? undefined : nowOr(data.opensAt), config: nextConfig, templateId };
    if (data.position === undefined) {
      return tx.activity.update({ where: { id: activityId }, data: { ...basicData, version: { increment: 1 } } });
    }
    const activities = await tx.activity.findMany({ where: { chapterId: activity.chapterId, archivedAt: null }, orderBy: { position: "asc" }, select: { id: true, position: true } });
    const currentIndex = activities.findIndex((item) => item.id === activityId);
    const rest = activities.filter((item) => item.id !== activityId);
    const index = Math.max(0, Math.min(data.position, rest.length));
    if (index === currentIndex) {
      return tx.activity.update({ where: { id: activityId }, data: { ...basicData, version: { increment: 1 } } });
    }
    rest.splice(index, 0, { id: activityId, position: activity.position });
    const last = await tx.activity.findFirst({ where: { chapterId: activity.chapterId }, orderBy: { position: "desc" }, select: { position: true } });
    const base = (last?.position ?? -1) + 1;
    const temporaryBase = base + rest.length + 1000;
    for (let i = 0; i < rest.length; i += 1) {
      await tx.activity.update({ where: { id: rest[i].id }, data: { position: temporaryBase + i } });
    }
    for (let i = 0; i < rest.length; i += 1) {
      await tx.activity.update({ where: { id: rest[i].id }, data: { position: base + i, ...(rest[i].id === activityId ? basicData : {}), version: { increment: 1 } } });
    }
    return tx.activity.findUnique({ where: { id: activityId } });
  });
}

export async function archiveChapter(claims: AuthClaims, chapterId: string) {
  const teacher = await requireTeacherUser(claims);
  const chapter = await prisma.chapter.findFirst({ where: { id: chapterId, offering: { teacherId: teacher.id }, archivedAt: null } });
  if (!chapter) throw new PlatformError("NOT_FOUND", "章节不存在", 404);
  return prisma.$transaction(async (tx) => {
    const archivedAt = new Date();
    await tx.activity.updateMany({ where: { chapterId, archivedAt: null }, data: { archivedAt, version: { increment: 1 } } });
    return tx.chapter.update({ where: { id: chapterId }, data: { archivedAt, version: { increment: 1 } } });
  });
}

export async function archiveActivity(claims: AuthClaims, activityId: string) {
  const teacher = await requireTeacherUser(claims);
  const activity = await prisma.activity.findFirst({ where: { id: activityId, offering: { teacherId: teacher.id }, archivedAt: null } });
  if (!activity) throw new PlatformError("NOT_FOUND", "活动不存在", 404);
  return prisma.activity.update({ where: { id: activityId }, data: { archivedAt: new Date(), version: { increment: 1 } } });
}

export async function listOfferingStudents(claims: AuthClaims, offeringId: string) {
  const teacher = await requireTeacherUser(claims);
  const offering = await prisma.courseOffering.findFirst({ where: { id: offeringId, teacherId: teacher.id }, include: { enrollments: { where: { status: { in: ["active", "completed"] } }, include: { user: { select: { id: true, username: true, displayName: true, status: true } }, progress: { select: { activityId: true, status: true, completedAt: true } } }, orderBy: { joinedAt: "asc" } } } });
  if (!offering) throw new PlatformError("NOT_FOUND", "教学班不存在", 404);
  return offering.enrollments;
}

export async function listPrivateTemplates(claims: AuthClaims) {
  const teacher = await requireTeacherUser(claims);
  return prisma.classroomTemplate.findMany({ where: { teacherId: teacher.id, status: { not: "archived" } }, include: { versions: { where: { status: "ready" }, orderBy: { version: "desc" } } }, orderBy: { updatedAt: "desc" } });
}

export async function createPrivateTemplate(claims: AuthClaims, input: { title: string; description?: string; snapshot: unknown; mediaRefs?: unknown; legacyCourseId?: string | null }) {
  const teacher = await requireTeacherUser(claims);
  if (!input.title.trim() || input.snapshot === undefined || input.snapshot === null) throw new PlatformError("INVALID_INPUT", "课堂模板需要标题和内容快照", 400);
  return runMutationTransaction(async (tx) => {
    if (input.legacyCourseId) {
      const [course, linkedOfferings, linkedTemplates] = await Promise.all([
        tx.course.findUnique({ where: { id: input.legacyCourseId }, select: { id: true } }),
        tx.courseOffering.findMany({ where: { legacyCourseId: input.legacyCourseId }, select: { teacherId: true } }),
        tx.classroomTemplate.findMany({ where: { legacyCourseId: input.legacyCourseId }, select: { teacherId: true } }),
      ]);
      if (!course) throw new PlatformError("COURSE_NOT_FOUND", "课堂内容不存在", 404);
      if ([...linkedOfferings, ...linkedTemplates].some((item) => item.teacherId !== teacher.id)) {
        throw new PlatformError("FORBIDDEN", "不能复用其他教师的课堂内容", 403);
      }
    }
    const template = await tx.classroomTemplate.create({ data: { teacherId: teacher.id, legacyCourseId: input.legacyCourseId ?? null, title: input.title.trim(), description: input.description?.trim() || null, status: "ready" } });
    const version = await tx.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: "ready", snapshot: input.snapshot as Prisma.InputJsonValue, mediaRefs: input.mediaRefs === undefined ? undefined : input.mediaRefs as Prisma.InputJsonValue } });
    return { template, version };
  });
}

export async function importLegacyCourseTemplate(claims: AuthClaims, courseId: string, title?: string) {
  const teacher = await requireTeacherUser(claims);
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: {
      id: true,
      name: true,
      subject: true,
      grade: true,
      hours: true,
      summary: true,
      drivingQuestion: true,
      learningObjectives: true,
      expectedOutcome: true,
      learnerProfile: true,
      classConfig: true,
      stageWorkspacePolicies: true,
      aiLearningClassroomId: true,
      teacherClassroomId: true,
      content: true,
      stages: true,
      pblConfig: true,
      uiState: true,
      status: true,
    },
  });
  if (!course) throw new PlatformError("COURSE_NOT_FOUND", "课堂内容不存在", 404);
  const [linkedOfferings, linkedTemplates] = await Promise.all([
    prisma.courseOffering.findMany({ where: { legacyCourseId: courseId }, select: { teacherId: true } }),
    prisma.classroomTemplate.findMany({ where: { legacyCourseId: courseId }, select: { teacherId: true } }),
  ]);
  if ([...linkedOfferings, ...linkedTemplates].some((item) => item.teacherId !== teacher.id)) throw new PlatformError("FORBIDDEN", "不能复用其他教师的课堂内容", 403);
  return createPrivateTemplate(claims, {
    legacyCourseId: course.id,
    title: title?.trim() || course.name,
    description: course.summary,
    snapshot: {
      source: "legacy-course",
      courseId: course.id,
      status: course.status,
      name: course.name,
      subject: course.subject,
      grade: course.grade,
      hours: course.hours,
      summary: course.summary,
      drivingQuestion: course.drivingQuestion,
      learningObjectives: course.learningObjectives,
      expectedOutcome: course.expectedOutcome,
      learnerProfile: course.learnerProfile,
      classConfig: course.classConfig,
      stageWorkspacePolicies: course.stageWorkspacePolicies,
      aiLearningClassroomId: course.aiLearningClassroomId,
      teacherClassroomId: course.teacherClassroomId,
      content: course.content,
      stages: course.stages,
      pblConfig: course.pblConfig,
      uiState: course.uiState,
    },
  });
}

export async function createTemplateVersion(claims: AuthClaims, templateId: string, input: { snapshot: unknown; mediaRefs?: unknown }) {
  const teacher = await requireTeacherUser(claims);
  if (input.snapshot === undefined || input.snapshot === null) throw new PlatformError("INVALID_INPUT", "模板版本需要内容快照", 400);
  return runMutationTransaction(async (tx) => {
    const template = await tx.classroomTemplate.findFirst({ where: { id: templateId, teacherId: teacher.id, status: { not: "archived" } } });
    if (!template) throw new PlatformError("TEMPLATE_NOT_FOUND", "课堂模板不存在", 404);
    const latest = await tx.classroomTemplateVersion.findFirst({ where: { templateId }, orderBy: { version: "desc" }, select: { version: true } });
    const version = await tx.classroomTemplateVersion.create({ data: { templateId, version: (latest?.version ?? 0) + 1, status: "ready", snapshot: input.snapshot as Prisma.InputJsonValue, mediaRefs: input.mediaRefs === undefined ? undefined : input.mediaRefs as Prisma.InputJsonValue } });
    await tx.classroomTemplate.update({ where: { id: templateId }, data: { version: { increment: 1 }, updatedAt: new Date() } });
    return version;
  });
}

export async function archivePrivateTemplate(claims: AuthClaims, templateId: string) {
  const teacher = await requireTeacherUser(claims);
  const template = await prisma.classroomTemplate.findFirst({ where: { id: templateId, teacherId: teacher.id, status: { not: "archived" } } });
  if (!template) throw new PlatformError("TEMPLATE_NOT_FOUND", "课堂模板不存在", 404);
  return prisma.classroomTemplate.update({ where: { id: templateId }, data: { status: "archived", version: { increment: 1 } } });
}

type LegacyCourseRuntime = {
  id: string;
  sourceId: string;
};

/**
 * The legacy classroom UI still reads a Course aggregate. A platform
 * ClassroomInstance therefore receives a private runtime Course copy instead
 * of sharing the template's source course with another teaching class. The
 * copy contains only immutable classroom configuration; students and all
 * mutable classroom records are created against the runtime id as they enter.
 */
async function createLegacyRuntimeCourse(
  tx: PlatformDb,
  sourceId: string,
  snapshot: unknown,
): Promise<LegacyCourseRuntime> {
  const source = await tx.course.findUnique({
    where: { id: sourceId },
    select: {
      name: true,
      subject: true,
      grade: true,
      hours: true,
      summary: true,
      drivingQuestion: true,
      learningObjectives: true,
      expectedOutcome: true,
      learnerProfile: true,
      classConfig: true,
      stageWorkspacePolicies: true,
      content: true,
      stages: true,
      pblConfig: true,
      uiState: true,
      aiLearningClassroomId: true,
      teacherClassroomId: true,
    },
  });
  if (!source) throw new PlatformError("COURSE_NOT_FOUND", "课堂内容不存在", 404);
  const candidate = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : {};
  const json = (value: unknown) => value === null || value === undefined
    ? Prisma.JsonNull
    : value as Prisma.InputJsonValue;
  const runtimeId = randomUUID();
  await (tx as Prisma.TransactionClient).course.create({
    data: {
      id: runtimeId,
      name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name : source.name,
      subject: typeof candidate.subject === "string" ? candidate.subject : source.subject,
      grade: typeof candidate.grade === "string" ? candidate.grade : source.grade,
      hours: Number.isInteger(candidate.hours) ? Number(candidate.hours) : source.hours,
      summary: typeof candidate.summary === "string" ? candidate.summary : source.summary,
      drivingQuestion: typeof candidate.drivingQuestion === "string" ? candidate.drivingQuestion : source.drivingQuestion,
      learningObjectives: json(candidate.learningObjectives ?? source.learningObjectives),
      expectedOutcome: typeof candidate.expectedOutcome === "string" ? candidate.expectedOutcome : source.expectedOutcome,
      learnerProfile: json(candidate.learnerProfile ?? source.learnerProfile),
      status: "ready",
      currentStageIndex: 0,
      inviteCode: null,
      coverImageUrl: null,
      classConfig: json(candidate.classConfig ?? source.classConfig),
      pblConfig: json(candidate.pblConfig ?? source.pblConfig),
      stageWorkspacePolicies: json(candidate.stageWorkspacePolicies ?? source.stageWorkspacePolicies),
      content: json(candidate.content ?? source.content),
      stages: json(candidate.stages ?? source.stages),
      uiState: json(candidate.uiState ?? source.uiState),
      aiLearningClassroomId: typeof candidate.aiLearningClassroomId === "string"
        ? candidate.aiLearningClassroomId
        : source.aiLearningClassroomId,
      teacherClassroomId: typeof candidate.teacherClassroomId === "string"
        ? candidate.teacherClassroomId
        : source.teacherClassroomId,
    },
  });
  return { id: runtimeId, sourceId };
}

export async function createClassroomInstance(claims: AuthClaims, activityId: string, templateVersionId: string) {
  const teacher = await requireTeacherUser(claims);
  return runMutationTransaction(async (tx) => {
    // Serialize the active-instance check so two browser tabs cannot create
    // parallel teaching runs for the same Classroom Activity.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`classroom-instance:${activityId}`}, 0))`;
    const activity = await tx.activity.findFirst({ where: { id: activityId, type: "Classroom", offering: { teacherId: teacher.id }, archivedAt: null }, include: { offering: true } });
    if (!activity) throw new PlatformError("NOT_FOUND", "课堂活动不存在", 404);
    const active = await tx.classroomInstance.findFirst({ where: { activityId, status: { in: ["scheduled", "teaching"] } } });
    if (active) throw new PlatformError("INSTANCE_ALREADY_ACTIVE", "该活动已有未结束的课堂实例", 409);
    const templateVersion = await tx.classroomTemplateVersion.findFirst({ where: { id: templateVersionId, status: "ready", template: { teacherId: teacher.id, status: { not: "archived" } } }, include: { template: { select: { legacyCourseId: true } } } });
    if (!templateVersion) throw new PlatformError("TEMPLATE_VERSION_NOT_FOUND", "课堂模板版本不存在", 404);
    if (activity.templateId && activity.templateId !== templateVersion.templateId) {
      throw new PlatformError("TEMPLATE_MISMATCH", "课堂活动绑定的模板与所选版本不一致", 409);
    }
    const legacyRuntime = templateVersion.template.legacyCourseId
      ? await createLegacyRuntimeCourse(tx, templateVersion.template.legacyCourseId, templateVersion.snapshot)
      : null;
    return tx.classroomInstance.create({
      data: {
        offeringId: activity.offeringId,
        activityId,
        templateVersionId,
        legacyCourseId: legacyRuntime?.id ?? null,
        legacySourceCourseId: legacyRuntime?.sourceId ?? null,
        snapshot: templateVersion.snapshot as Prisma.InputJsonValue,
      },
      include: { activity: true },
    });
  });
}

export async function resetOfferingInvitation(claims: AuthClaims, offeringId: string, input: { expiresAt?: string | null; disabled?: boolean }) {
  const teacher = await requireTeacherUser(claims);
  return runMutationTransaction(async (tx) => {
    const offering = await tx.courseOffering.findFirst({ where: { id: offeringId, teacherId: teacher.id, status: { not: "archived" } }, include: { invitation: true } });
    if (!offering) throw new PlatformError("NOT_FOUND", "教学班不存在", 404);
    const code = await uniqueInviteCode(tx);
    const expiresAt = input.expiresAt === undefined ? offering.invitation?.expiresAt : nowOr(input.expiresAt);
    const disabledAt = input.disabled === undefined
      ? offering.invitation?.disabledAt
      : input.disabled ? new Date() : null;
    const invitation = offering.invitation
      ? await tx.courseInvitation.update({ where: { id: offering.invitation.id }, data: { code, expiresAt, disabledAt } })
      : await tx.courseInvitation.create({ data: { offeringId, code, expiresAt, disabledAt } });
    await appendEventTx(tx, { userId: teacher.id, offeringId, type: "course_invitation_rotated", idempotencyKey: `course-invitation:${offeringId}:${invitation.updatedAt.toISOString()}`, metadata: { disabled: Boolean(input.disabled), expiresAt: invitation.expiresAt?.toISOString() ?? null } as Prisma.InputJsonValue, source: "teacher-admin" });
    return invitation;
  });
}

export async function startClassroomInstance(claims: AuthClaims, instanceId: string) {
  const teacher = await requireTeacherUser(claims);
  return runMutationTransaction(async (tx) => {
    // All lifecycle transitions share one lock. This prevents a start or
    // enter transaction from racing with finish and creating a writable
    // participation after the instance has already been closed.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`classroom-lifecycle:${instanceId}`}, 0))`;
    const instance = await tx.classroomInstance.findFirst({ where: { id: instanceId, offering: { teacherId: teacher.id, status: "open" }, status: { in: ["scheduled", "teaching"] } }, include: { activity: { include: { chapter: true } } } });
    if (!instance) throw new PlatformError("NOT_FOUND", "可开始的课堂实例不存在", 404);
    if (!isActivityOpen(instance.activity.chapter, instance.activity)) throw new PlatformError("ACTIVITY_LOCKED", "课堂活动尚未开放", 403);
    if (instance.status === "teaching") return instance;
    const started = await tx.classroomInstance.update({ where: { id: instanceId }, data: { status: "teaching", startedAt: new Date(), version: { increment: 1 } } });
    if (instance.legacyCourseId) {
      await tx.course.update({ where: { id: instance.legacyCourseId }, data: { status: "teaching", currentStageIndex: 0, version: { increment: 1 } } });
    }
    return started;
  });
}

export async function enterClassroom(claims: AuthClaims, instanceId: string) {
  const user = await requireStudentUser(claims);
  return runMutationTransaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`classroom-lifecycle:${instanceId}`}, 0))`;
    const instance = await tx.classroomInstance.findFirst({ where: { id: instanceId, status: "teaching" }, include: { offering: { select: { status: true } }, activity: { include: { chapter: true } } } });
    if (!instance) throw new PlatformError("CLASSROOM_NOT_OPEN", "课堂尚未开放或已经结束", 403);
    if (instance.offering.status !== "open" || !isActivityOpen(instance.activity.chapter, instance.activity)) throw new PlatformError("CLASSROOM_NOT_OPEN", "课堂活动尚未开放", 403);
    const enrollment = await tx.enrollment.findUnique({ where: { userId_offeringId: { userId: user.id, offeringId: instance.offeringId } } });
    if (!enrollment || enrollment.status !== "active") throw new PlatformError("ENROLLMENT_REQUIRED", "请先加入教学班", 403);
    const current = await tx.classroomParticipation.findUnique({ where: { instanceId_enrollmentId: { instanceId, enrollmentId: enrollment.id } } });
    const participation = current
      ? await tx.classroomParticipation.update({ where: { id: current.id }, data: { lastEnteredAt: new Date(), version: { increment: 1 } } })
      : await tx.classroomParticipation.create({ data: { offeringId: instance.offeringId, instanceId, enrollmentId: enrollment.id } });
    const enteredAt = new Date();
    const progress = await tx.activityProgress.findUnique({ where: { enrollmentId_activityId: { enrollmentId: enrollment.id, activityId: instance.activityId } }, select: { status: true, startedAt: true } });
    await tx.activityProgress.upsert({
      where: { enrollmentId_activityId: { enrollmentId: enrollment.id, activityId: instance.activityId } },
      create: { id: randomUUID(), offeringId: instance.offeringId, enrollmentId: enrollment.id, activityId: instance.activityId, status: "in_progress", startedAt: enteredAt, lastAccessedAt: enteredAt },
      update: { ...(progress?.status === "completed" ? {} : { status: "in_progress", startedAt: progress?.startedAt ?? enteredAt }), lastAccessedAt: enteredAt },
    });
    if (enrollment.currentChapterId !== instance.activity.chapterId || enrollment.currentActivityId !== instance.activityId) {
      await tx.enrollment.update({ where: { id: enrollment.id }, data: { currentChapterId: instance.activity.chapterId, currentActivityId: instance.activityId, version: { increment: 1 } } });
    }
    await tx.studentProjectWorkspace.upsert({
      where: { participationId: participation.id },
      create: { id: randomUUID(), participationId: participation.id, status: "active", projectState: {}, aiMembers: {} },
      update: { status: "active", version: { increment: 1 } },
    });
    let legacyStudentId: string | undefined;
    if (instance.legacyCourseId) {
      legacyStudentId = legacyStudentIdFor(instance.legacyCourseId, user.id);
      await createLegacyStudentRecords(
        tx,
        instance.legacyCourseId,
        legacyStudentId,
        user.displayName,
        `platform-${instance.id}`,
      );
      const groupId = `platform-${instance.id}-${legacyStudentId}`;
      await tx.projectGroup.upsert({
        where: { id: groupId },
        create: {
          id: groupId,
          courseId: instance.legacyCourseId,
          name: `${user.displayName}的个人项目`,
          topic: "待确定选题方向",
          keywords: [],
          selectedForms: [],
          members: [{ studentId: legacyStudentId, name: user.displayName, role: "项目负责人" }],
        },
        update: {
          name: `${user.displayName}的个人项目`,
          members: [{ studentId: legacyStudentId, name: user.displayName, role: "项目负责人" }],
        },
      });
      await tx.groupMember.upsert({
        where: { courseId_groupId_studentId: { courseId: instance.legacyCourseId, groupId, studentId: legacyStudentId } },
        create: { courseId: instance.legacyCourseId, groupId, studentId: legacyStudentId, studentName: user.displayName, role: "项目负责人" },
        update: { studentName: user.displayName, role: "项目负责人" },
      });
    }
    await appendEventTx(tx, { userId: user.id, offeringId: instance.offeringId, enrollmentId: enrollment.id, chapterId: instance.activity.chapterId, activityId: instance.activityId, classroomInstanceId: instance.id, participationId: participation.id, type: "classroom_entered", idempotencyKey: `classroom-entered:${instance.id}:${enrollment.id}` });
    return { instance, participation, student: user, legacyStudentId, legacyCourseId: instance.legacyCourseId };
  });
}

export async function finishClassroomInstance(claims: AuthClaims, instanceId: string) {
  const teacher = await requireTeacherUser(claims);
  return runMutationTransaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`classroom-lifecycle:${instanceId}`}, 0))`;
    const instance = await tx.classroomInstance.findFirst({ where: { id: instanceId, offering: { teacherId: teacher.id }, status: { in: ["scheduled", "teaching"] } }, include: { activity: { include: { chapter: true } }, participations: true } });
    if (!instance) {
      const finished = await tx.classroomInstance.findFirst({ where: { id: instanceId, offering: { teacherId: teacher.id }, status: "finished" } });
      if (finished) return finished;
      throw new PlatformError("NOT_FOUND", "课堂实例不存在", 404);
    }
    const endedAt = new Date();
    await tx.classroomInstance.update({ where: { id: instance.id }, data: { status: "finished", endedAt, version: { increment: 1 } } });
    if (instance.legacyCourseId) {
      await tx.course.update({ where: { id: instance.legacyCourseId }, data: { status: "finished", version: { increment: 1 } } });
    }
    for (const participation of instance.participations) {
      if (!participation.completedAt) {
        await tx.classroomParticipation.update({ where: { id: participation.id }, data: { completedAt: endedAt, version: { increment: 1 } } });
        await tx.studentProjectWorkspace.updateMany({ where: { participationId: participation.id }, data: { status: "read_only", version: { increment: 1 } } });
        await tx.activityProgress.upsert({ where: { enrollmentId_activityId: { enrollmentId: participation.enrollmentId, activityId: instance.activityId } }, create: { id: randomUUID(), offeringId: instance.offeringId, enrollmentId: participation.enrollmentId, activityId: instance.activityId, status: "completed", startedAt: participation.firstEnteredAt, completedAt: endedAt, lastAccessedAt: endedAt }, update: { status: "completed", startedAt: participation.firstEnteredAt, completedAt: endedAt, lastAccessedAt: endedAt } });
        const user = await tx.enrollment.findUnique({ where: { id: participation.enrollmentId }, select: { userId: true } });
        if (user) await appendEventTx(tx, { userId: user.userId, offeringId: instance.offeringId, enrollmentId: participation.enrollmentId, chapterId: instance.activity.chapterId, activityId: instance.activityId, classroomInstanceId: instance.id, participationId: participation.id, type: "classroom_completed", idempotencyKey: `classroom-completed:${instance.id}:${participation.enrollmentId}` });
      }
    }
    return tx.classroomInstance.findUnique({ where: { id: instance.id } });
  });
}

export async function appendLearningEvents(claims: AuthClaims, events: Array<{ idempotencyKey: string; type: string; occurredAt?: string; offeringId?: string; activityId?: string; chapterId?: string; classroomInstanceId?: string; metadata?: unknown; source?: string }>) {
  const user = await requireStudentUser(claims);
  if (!events.length || events.length > 100) throw new PlatformError("INVALID_INPUT", "一次最多记录 100 个学习事件", 400);
  return runMutationTransaction(async (tx) => {
    const enrollments = await tx.enrollment.findMany({ where: { userId: user.id, status: "active" }, select: { id: true, offeringId: true } });
    if (!enrollments.length) throw new PlatformError("ENROLLMENT_REQUIRED", "没有有效的教学班关系", 403);
    const accepted: string[] = [];
    for (const event of events) {
      let offeringId = event.offeringId;
      let activityChapterId = event.chapterId;
      if (event.activityId) {
        const activity = await tx.activity.findUnique({ where: { id: event.activityId }, select: { offeringId: true, chapterId: true } });
        if (!activity) throw new PlatformError("ACTIVITY_NOT_FOUND", "学习事件关联的活动不存在", 404);
        if (offeringId && offeringId !== activity.offeringId) throw new PlatformError("EVENT_SCOPE_MISMATCH", "学习事件不属于该教学班", 403);
        offeringId = activity.offeringId;
        activityChapterId = activity.chapterId;
      }
      if (event.chapterId) {
        const chapter = await tx.chapter.findUnique({ where: { id: event.chapterId }, select: { id: true, offeringId: true } });
        if (!chapter) throw new PlatformError("CHAPTER_NOT_FOUND", "学习事件关联的章节不存在", 404);
        if (offeringId && offeringId !== chapter.offeringId) throw new PlatformError("EVENT_SCOPE_MISMATCH", "学习事件不属于该教学班", 403);
        if (activityChapterId && activityChapterId !== chapter.id) throw new PlatformError("EVENT_SCOPE_MISMATCH", "学习事件与章节不匹配", 403);
        offeringId = chapter.offeringId;
        activityChapterId = chapter.id;
      }
      if (event.classroomInstanceId) {
        const instance = await tx.classroomInstance.findUnique({ where: { id: event.classroomInstanceId }, select: { offeringId: true, activityId: true, status: true } });
        if (!instance) throw new PlatformError("CLASSROOM_NOT_FOUND", "学习事件关联的课堂不存在", 404);
        if (instance.status !== "teaching") throw new PlatformError("EVENT_WRITE_LOCKED", "课堂当前不接受学习事件", 403);
        if (offeringId && offeringId !== instance.offeringId) throw new PlatformError("EVENT_SCOPE_MISMATCH", "学习事件不属于该教学班", 403);
        if (event.activityId && event.activityId !== instance.activityId) throw new PlatformError("EVENT_SCOPE_MISMATCH", "学习事件与课堂实例不匹配", 403);
        offeringId = instance.offeringId;
        const activity = await tx.activity.findUnique({ where: { id: instance.activityId }, include: { chapter: true } });
        if (!activity || !isActivityOpen(activity.chapter, activity)) throw new PlatformError("EVENT_WRITE_LOCKED", "课堂活动当前未开放", 403);
        if (activityChapterId && activityChapterId !== activity.chapterId) throw new PlatformError("EVENT_SCOPE_MISMATCH", "学习事件与课堂章节不匹配", 403);
        activityChapterId = activity.chapterId;
      }
      const enrollment = offeringId ? enrollments.find((item) => item.offeringId === offeringId) : (enrollments.length === 1 ? enrollments[0] : undefined);
      if (!enrollment) throw new PlatformError("EVENT_SCOPE_MISMATCH", "无法确定学习事件所属教学班", 403);
      const offering = await tx.courseOffering.findUnique({ where: { id: enrollment.offeringId }, select: { status: true } });
      if (!offering || offering.status !== "open") throw new PlatformError("EVENT_WRITE_LOCKED", "教学班当前不接受学习事件", 403);
      if (event.activityId) {
        const scopedActivity = await tx.activity.findUnique({ where: { id: event.activityId }, include: { chapter: true } });
        if (!scopedActivity || !isActivityOpen(scopedActivity.chapter, scopedActivity)) throw new PlatformError("EVENT_WRITE_LOCKED", "活动当前未开放", 403);
      } else if (event.chapterId) {
        const scopedChapter = await tx.chapter.findUnique({ where: { id: event.chapterId } });
        if (!scopedChapter || !isChapterOpen(scopedChapter)) throw new PlatformError("EVENT_WRITE_LOCKED", "章节当前未开放", 403);
      }
      const record = await appendEventTx(tx, { userId: user.id, enrollmentId: enrollment.id, ...event, offeringId: enrollment.offeringId, chapterId: activityChapterId, occurredAt: nowOr(event.occurredAt) ?? undefined });
      if (record) accepted.push(record.id);
    }
    return accepted;
  });
}

/** Copy events emitted by the existing classroom UI into the durable platform
 * log when that legacy course is linked to a CourseOffering. The original
 * LearningEvent row remains available to the classroom analytics code. */
export async function mirrorLegacyLearningEvents(claims: AuthClaims, courseId: string, events: Array<{ id: string; idempotencyKey: string; type: string; occurredAt: string; metadata?: unknown; content?: unknown }>) {
  if (claims.role !== "student") return;
  const userId = claims.userId ?? claims.studentId;
  const [directOfferings, instanceOfferings] = await Promise.all([
    prisma.courseOffering.findMany({ where: { legacyCourseId: courseId }, select: { id: true } }),
    prisma.classroomInstance.findMany({
      where: { OR: [{ legacyCourseId: courseId }, { legacySourceCourseId: courseId }] },
      select: {
        id: true,
        offeringId: true,
        activityId: true,
        legacyCourseId: true,
        activity: { select: { chapterId: true } },
        participations: { where: { enrollment: { userId } }, select: { id: true } },
      },
    }),
  ]);
  const offeringIds = new Set([...directOfferings.map((item) => item.id), ...instanceOfferings.map((item) => item.offeringId)]);
  const offerings = [...offeringIds].map((id) => ({ id }));
  if (offerings.length !== 1) return;
  const offering = offerings[0];
  const enrollment = await prisma.enrollment.findUnique({ where: { userId_offeringId: { userId, offeringId: offering.id } }, select: { id: true } });
  if (!enrollment) return;
  // A generated runtime Course belongs to exactly one classroom instance.
  // Preserve that immutable context when copying legacy events so repeated
  // classroom runs remain distinguishable in the platform event stream.
  const runtimeInstance = instanceOfferings.find((item) => item.legacyCourseId === courseId)
    ?? (instanceOfferings.length === 1 ? instanceOfferings[0] : undefined);
  await runMutationTransaction(async (tx) => {
    for (const event of events) {
      let activityId: string | undefined = runtimeInstance?.activityId;
      const content = event.content;
      if (!activityId && content && typeof content === "object" && "activityId" in content && typeof content.activityId === "string") {
        const activity = await tx.activity.findFirst({ where: { id: content.activityId, offeringId: offering.id }, select: { id: true } });
        activityId = activity?.id;
      }
      await appendEventTx(tx, {
        userId,
        offeringId: offering.id,
        enrollmentId: enrollment.id,
        activityId,
        chapterId: runtimeInstance?.activity.chapterId,
        classroomInstanceId: runtimeInstance?.id,
        participationId: runtimeInstance?.participations[0]?.id,
        type: `legacy:${event.type}`,
        idempotencyKey: `legacy:${courseId}:${event.idempotencyKey}`,
        occurredAt: nowOr(event.occurredAt) ?? undefined,
        metadata: { legacyEventId: event.id, content: event.content, metadata: event.metadata },
        source: "legacy-classroom",
      });
    }
  });
}

export async function requestStudentPasswordReset(claims: AuthClaims, enrollmentId: string) {
  const teacher = await requireTeacherUser(claims);
  return runMutationTransaction(async (tx) => {
    const enrollment = await tx.enrollment.findFirst({ where: { id: enrollmentId, offering: { teacherId: teacher.id }, status: "active", user: { role: "student", status: "active" } }, include: { user: true } });
    if (!enrollment) throw new PlatformError("NOT_FOUND", "学生关系不存在", 404);
    const rawToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await tx.passwordResetToken.create({ data: { targetUserId: enrollment.userId, requestedById: teacher.id, tokenHash: createHash("sha256").update(rawToken).digest("hex"), expiresAt } });
    await appendEventTx(tx, { userId: enrollment.userId, offeringId: enrollment.offeringId, enrollmentId: enrollment.id, type: "student_password_reset_requested", idempotencyKey: `password-reset:${enrollment.id}:${rawToken.slice(0, 16)}`, metadata: { requestedBy: teacher.id, expiresAt: expiresAt.toISOString() } as Prisma.InputJsonValue, source: "teacher-admin" });
    return { token: rawToken, expiresAt, username: enrollment.user.username };
  });
}

export async function resetStudentPassword(rawToken: string, password: string) {
  if (password.length < 8) throw new PlatformError("INVALID_INPUT", "密码至少需要 8 位", 400);
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const passwordHash = await hashPassword(password);
  return runMutationTransaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`password-reset:${tokenHash}`}, 0))`;
    const token = await tx.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!token || token.usedAt || token.expiresAt <= new Date()) throw new PlatformError("RESET_TOKEN_INVALID", "密码重置链接无效或已过期", 400);
    await tx.user.update({ where: { id: token.targetUserId }, data: { passwordHash, sessionVersion: { increment: 1 } } });
    await tx.passwordResetToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
    const enrollments = await tx.enrollment.findMany({ where: { userId: token.targetUserId, status: { in: ["active", "completed"] } }, select: { id: true, offeringId: true } });
    for (const enrollment of enrollments) {
      await appendEventTx(tx, {
        userId: token.targetUserId,
        offeringId: enrollment.offeringId,
        enrollmentId: enrollment.id,
        type: "student_password_reset_completed",
        idempotencyKey: `password-reset-completed:${token.id}:${enrollment.id}`,
        source: "student-account",
      });
    }
    return { userId: token.targetUserId };
  });
}

async function appendEventTx(tx: PlatformDb, input: { userId: string; offeringId: string; enrollmentId?: string; chapterId?: string; activityId?: string; classroomInstanceId?: string; participationId?: string; type: string; idempotencyKey: string; occurredAt?: Date; metadata?: unknown; source?: string }) {
  return (tx as unknown as PrismaClient).learningEventRecord.upsert({
    where: { userId_offeringId_idempotencyKey: { userId: input.userId, offeringId: input.offeringId, idempotencyKey: input.idempotencyKey } },
    create: { id: randomUUID(), idempotencyKey: input.idempotencyKey, userId: input.userId, offeringId: input.offeringId, enrollmentId: input.enrollmentId, chapterId: input.chapterId, activityId: input.activityId, classroomInstanceId: input.classroomInstanceId, participationId: input.participationId, type: input.type, occurredAt: input.occurredAt ?? new Date(), metadata: input.metadata === undefined ? undefined : input.metadata as Prisma.InputJsonValue, source: input.source ?? "platform" },
    update: {},
  });
}

async function uniqueInviteCode(db: PlatformDb = prisma): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = newInviteCode();
    if (!(await db.courseInvitation.findUnique({ where: { code }, select: { id: true } }))) return code;
  }
  throw new PlatformError("INVITE_CODE_UNAVAILABLE", "暂时无法生成课程邀请码", 503);
}

async function createLegacyStudentRecords(db: PlatformDb, legacyCourseId: string | null, studentId: string, studentName: string, inviteCode: string) {
  if (!legacyCourseId) return;
  await db.student.upsert({ where: { courseId_id: { courseId: legacyCourseId, id: studentId } }, create: { id: studentId, courseId: legacyCourseId, name: studentName, progress: {} }, update: { name: studentName } });
  await db.studentAccount.upsert({ where: { courseId_studentId: { courseId: legacyCourseId, studentId } }, create: { courseId: legacyCourseId, studentId, studentName, nameKey: studentName.toLocaleLowerCase("zh-CN"), inviteCode }, update: { studentName, inviteCode } });
}

export function legacyStudentIdFor(legacyCourseId: string, userId: string): string {
  return `platform-${legacyCourseId}-${userId}`;
}

export class PlatformError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly details?: unknown) { super(message); }
}
