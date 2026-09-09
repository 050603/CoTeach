import { isValidNewPasswordLength, PASSWORD_LENGTH_HINT } from "@/lib/auth/password-policy";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { generateInviteCode, normalizeInviteCode } from "@/lib/session/invite-code";
import { ActivityConfigSchema, type ActivityType } from "./activity";
import { normalizeUsername, requireStudentUser, requireTeacherUser, type PlatformDb, type PlatformUser } from "./access";

const ACTIVE_ENROLLMENT_STATUSES = ["ACTIVE", "active", "COMPLETED", "completed"];
const VISIBLE_OFFERING_STATUSES = ["DRAFT", "draft", "OPEN", "open", "FINISHED", "finished", "ARCHIVED", "archived"];
const ENROLLABLE_OFFERING_STATUSES = new Set(["draft", "open"]);

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function courseDetails(settings: unknown): { outline: string; referenceMaterials: string } {
  const value = settings && typeof settings === "object" ? settings as Record<string, unknown> : {};
  return { outline: typeof value.outline === "string" ? value.outline : "", referenceMaterials: typeof value.referenceMaterials === "string" ? value.referenceMaterials : "" };
}

function normalizedStatus(value: string): string {
  return value.toLowerCase();
}

function activityTypeForApi(value: string): string {
  const map: Record<string, string> = { CLASSROOM: "Classroom", ASSIGNMENT: "Assignment", QUIZ: "Quiz", FORM: "Form", RESOURCE: "Resource" };
  return map[value.toUpperCase()] ?? value;
}

function dateOrNull(value?: string | Date | null): Date | null | undefined {
  if (value === null) return null;
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function newToken(): string {
  return randomBytes(32).toString("hex");
}


async function teacherForOffering(claims: AuthClaims, offeringId: string, db: PlatformDb = prisma): Promise<PlatformUser> {
  const teacher = await requireTeacherUser(claims, db);
  const link = await db.courseTeacher.findFirst({ where: { offeringId, userId: teacher.id } });
  if (!link) throw new PlatformError("FORBIDDEN", "无权操作该教学班", 403);
  return teacher;
}

async function activityForTeacher(claims: AuthClaims, activityId: string, db: PlatformDb = prisma) {
  const teacher = await requireTeacherUser(claims, db);
  const activity = await db.activity.findUnique({ include: { chapter: { include: { offering: true } } }, where: { id: activityId } });
  if (!activity) throw new PlatformError("NOT_FOUND", "活动不存在", 404);
  const owns = await db.courseTeacher.findFirst({ where: { offeringId: activity.chapter.offeringId, userId: teacher.id } });
  if (!owns) throw new PlatformError("FORBIDDEN", "无权操作该活动", 403);
  return activity;
}

function isChapterOpen(chapter: { isOpen: boolean; opensAt: Date | null; archivedAt: Date | null }, at = new Date()): boolean {
  return !chapter.archivedAt && chapter.isOpen && (!chapter.opensAt || chapter.opensAt <= at);
}

function isActivityOpen(chapter: { isOpen: boolean; opensAt: Date | null; archivedAt: Date | null }, activity: { isOpen: boolean; opensAt: Date | null; archivedAt: Date | null }, at = new Date()): boolean {
  return isChapterOpen(chapter, at) && !activity.archivedAt && activity.isOpen && (!activity.opensAt || activity.opensAt <= at);
}

export function isOfferingOpen(invitation: { status?: string; disabledAt: Date | null; expiresAt: Date | null }, offeringStatus: string, at = new Date()): boolean {
  return ENROLLABLE_OFFERING_STATUSES.has(normalizedStatus(offeringStatus))
    && (!invitation.status || normalizedStatus(invitation.status) === "active")
    && !invitation.disabledAt
    && (!invitation.expiresAt || invitation.expiresAt > at);
}

export { isChapterOpen, isActivityOpen };

export async function validateInvitation(code: string, db: PlatformDb = prisma) {
  const invitation = await db.courseInvitation.findUnique({
    where: { code: normalizeInviteCode(code) },
    include: { offering: { include: { teachers: { include: { user: { select: { displayName: true } } } } } } },
  });
  if (!invitation || !isOfferingOpen(invitation, invitation.offering.status)) return null;
  return {
    id: invitation.id,
    code: invitation.code,
    expiresAt: invitation.expiresAt,
    offering: {
      id: invitation.offering.id,
      name: invitation.offering.name,
      description: invitation.offering.description,
      term: invitation.offering.term,
      status: normalizedStatus(invitation.offering.status),
      teacher: invitation.offering.teachers[0]?.user ?? null,
    },
  };
}

export async function registerStudent(input: { invitationCode: string; username: string; displayName: string; password: string }) {
  const username = input.username.normalize("NFKC").trim();
  const usernameKey = normalizeUsername(username);
  const displayName = input.displayName.normalize("NFC").trim();
  if (usernameKey.length < 3 || !displayName) throw new PlatformError("INVALID_INPUT", "用户名、姓名或密码不符合要求", 400);
  if (!isValidNewPasswordLength(input.password)) throw new PlatformError("INVALID_INPUT", PASSWORD_LENGTH_HINT, 400);
  const passwordHash = await hashPassword(input.password);
  return runMutationTransaction(async (tx) => {
    // Lock the quota row before checking it; READ COMMITTED alone allows
    // concurrent registrations to spend the same final invitation use.
    const code = normalizeInviteCode(input.invitationCode);
    await tx.$queryRaw`SELECT "id" FROM "CourseInvitation" WHERE "code" = ${code} FOR UPDATE`;
    const invitation = await tx.courseInvitation.findUnique({
      where: { code: normalizeInviteCode(input.invitationCode) },
      include: { offering: { include: { chapters: { where: { archivedAt: null }, include: { activities: { where: { archivedAt: null } } } } } } },
    });
    if (!invitation || !isOfferingOpen(invitation, invitation.offering.status)) throw new PlatformError("INVITE_CODE_INVALID", "课程邀请码无效、已停用或已过期", 404);
    if (invitation.maxUses !== null && invitation.useCount >= invitation.maxUses) throw new PlatformError("INVITE_CODE_EXHAUSTED", "邀请码使用次数已达上限", 409);
    const existing = await tx.user.findUnique({ where: { usernameKey } });
    if (existing) throw new PlatformError("USERNAME_TAKEN", "登录账号已存在", 409);
    const user = await tx.user.create({ data: { username, usernameKey, displayName, passwordHash, role: "STUDENT", status: "ACTIVE" } });
    const enrollment = await tx.enrollment.create({ data: { userId: user.id, offeringId: invitation.offeringId, status: "ACTIVE" } });
    const activities = invitation.offering.chapters.flatMap((chapter) => chapter.activities);
    if (activities.length) await tx.activityProgress.createMany({ data: activities.map((activity) => ({ id: randomUUID(), enrollmentId: enrollment.id, activityId: activity.id, status: "NOT_STARTED" })) });
    await tx.courseInvitation.update({ where: { id: invitation.id }, data: { useCount: { increment: 1 } } });
    return { user, enrollment, offering: invitation.offering };
  });
}

export async function loginStudent(username: string, password: string) {
  const account = await prisma.user.findUnique({
    where: { usernameKey: normalizeUsername(username) },
    include: { enrollments: { where: { status: { in: ACTIVE_ENROLLMENT_STATUSES } }, include: { offering: { select: { id: true, name: true, status: true } } } } },
  });
  if (!account || account.role.toLowerCase() !== "student" || account.status.toLowerCase() !== "active" || !(await verifyPassword(password, account.passwordHash))) throw new PlatformError("INVALID_CREDENTIALS", "用户名或密码错误", 401);
  await prisma.user.update({ where: { id: account.id }, data: { lastLoginAt: new Date() } });
  return account;
}

export async function listStudentOfferings(claims: AuthClaims) {
  const user = await requireStudentUser(claims);
  const rows = await prisma.enrollment.findMany({
    where: { userId: user.id, status: { in: ACTIVE_ENROLLMENT_STATUSES }, offering: { status: { in: VISIBLE_OFFERING_STATUSES } } },
    include: {
      offering: {
        include: {
          teachers: { include: { user: { select: { displayName: true } } } },
          chapters: { where: { archivedAt: null }, orderBy: { position: "asc" }, include: { activities: { where: { archivedAt: null }, orderBy: { position: "asc" } } } },
        },
      },
      activityProgress: true,
    },
    orderBy: { joinedAt: "asc" },
  });
  const at = new Date();
  return rows.map((row) => {
    const courseReleased = normalizedStatus(row.offering.status) !== "draft";
    return {
      id: row.offering.id,
      name: row.offering.name,
      description: row.offering.description,
      coverImageUrl: row.offering.coverImageUrl,
      ...courseDetails(row.offering.settings),
      term: row.offering.term,
      startsAt: row.offering.startsAt,
      endsAt: row.offering.endsAt,
      status: normalizedStatus(row.offering.status),
      teacher: row.offering.teachers[0]?.user ?? null,
      enrollment: { id: row.id, joinedAt: row.joinedAt },
      chapters: row.offering.chapters.map((chapter) => ({
        id: chapter.id, title: chapter.title, description: chapter.description, position: chapter.position,
        isOpen: courseReleased && isChapterOpen(chapter, at), opensAt: chapter.opensAt,
        activities: chapter.activities.map((activity) => {
          const progress = row.activityProgress.find((item) => item.activityId === activity.id);
          const open = courseReleased && isActivityOpen(chapter, activity, at);
          return { id: activity.id, type: activityTypeForApi(activity.type), title: activity.title, description: activity.description, position: activity.position, opensAt: activity.opensAt, isOpen: open, progress: progress ? { status: normalizedStatus(progress.status), startedAt: progress.startedAt, completedAt: progress.completedAt, lastAccessedAt: progress.lastAccessedAt } : { status: "not_started" }, ...(open ? { config: activity.config } : {}) };
        }),
      })),
    };
  });
}

export async function getStudentActivity(claims: AuthClaims, activityId: string) {
  const user = await requireStudentUser(claims);
  const activity = await prisma.activity.findUnique({
    where: { id: activityId },
    include: { chapter: { include: { offering: true } }, classroomInstances: { where: { status: { in: ["SCHEDULED", "TEACHING", "FINISHED", "scheduled", "teaching", "finished"] } }, orderBy: { createdAt: "desc" }, include: { templateVersion: { select: { id: true, version: true, snapshot: true, mediaRefs: true } } } } },
  });
  if (!activity || activity.archivedAt) throw new PlatformError("NOT_FOUND", "活动不存在", 404);
  const offering = activity.chapter.offering;
  if (!VISIBLE_OFFERING_STATUSES.includes(offering.status) || normalizedStatus(offering.status) === "draft") throw new PlatformError("COURSE_NOT_OPEN", "课程尚未开放学习", 403);
  const enrollment = await prisma.enrollment.findUnique({ where: { userId_offeringId: { userId: user.id, offeringId: offering.id } }, include: { activityProgress: { where: { activityId } } } });
  if (!enrollment || !ACTIVE_ENROLLMENT_STATUSES.includes(enrollment.status)) throw new PlatformError("ENROLLMENT_REQUIRED", "请先加入教学班", 403);
  const open = isActivityOpen(activity.chapter, activity, new Date());
  let progress = enrollment.activityProgress[0] ?? null;
  if (open && normalizedStatus(offering.status) === "open" && normalizedStatus(enrollment.status) === "active") {
    const accessedAt = new Date();
    progress = await runMutationTransaction(async (tx) => {
      const key = { enrollmentId: enrollment.id, activityId };
      // Access only touches the timestamp on existing rows. A submission may
      // have completed since the activity/enrollment snapshot was loaded.
      await tx.activityProgress.upsert({
        where: { enrollmentId_activityId: key },
        create: { id: randomUUID(), ...key, status: "IN_PROGRESS", startedAt: accessedAt, lastAccessedAt: accessedAt },
        update: { lastAccessedAt: accessedAt },
      });
      await tx.activityProgress.updateMany({
        where: { ...key, status: { in: ["NOT_STARTED", "not_started"] } },
        data: { status: "IN_PROGRESS", startedAt: accessedAt },
      });
      return tx.activityProgress.findUniqueOrThrow({ where: { enrollmentId_activityId: key } });
    });
    await appendLearningEvents(claims, [{ idempotencyKey: `activity-opened:${activity.id}:${enrollment.id}`, type: "activity_opened", occurredAt: accessedAt.toISOString(), offeringId: offering.id, chapterId: activity.chapterId, activityId, source: "platform" }]);
  }
  return {
    id: activity.id,
    type: activityTypeForApi(activity.type),
    title: activity.title,
    description: activity.description,
    config: open ? activity.config : null,
    isOpen: open,
    chapter: { id: activity.chapter.id, title: activity.chapter.title, position: activity.chapter.position },
    offering: { id: offering.id, name: offering.name, status: normalizedStatus(offering.status) },
    enrollment: { id: enrollment.id },
    progress: progress ? { status: normalizedStatus(progress.status), startedAt: progress.startedAt, completedAt: progress.completedAt, lastAccessedAt: progress.lastAccessedAt, progressData: progress.progressData } : { status: "not_started", startedAt: null, completedAt: null, lastAccessedAt: null },
    instances: activity.classroomInstances.map((instance) => ({ id: instance.id, status: normalizedStatus(instance.status), startedAt: instance.startedAt, endedAt: instance.endedAt })),
    instance: activity.classroomInstances[0] ? { ...activity.classroomInstances[0], status: normalizedStatus(activity.classroomInstances[0].status), canWrite: open && normalizedStatus(offering.status) === "open" && normalizedStatus(enrollment.status) === "active" && normalizedStatus(activity.classroomInstances[0].status) === "teaching" } : null,
  };
}

export async function joinOffering(claims: AuthClaims, invitationCode: string) {
  return runMutationTransaction(async (tx) => {
    const user = await requireStudentUser(claims, tx);
    const code = normalizeInviteCode(invitationCode);
    await tx.$queryRaw`SELECT "id" FROM "CourseInvitation" WHERE "code" = ${code} FOR UPDATE`;
    // A user can join through different invitations concurrently. Serialize
    // their enrollment creation as well as consumption of this invitation.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
    const invitation = await tx.courseInvitation.findUnique({ where: { code }, include: { offering: { include: { chapters: { where: { archivedAt: null }, include: { activities: { where: { archivedAt: null } } } } } } } });
    if (!invitation || !isOfferingOpen(invitation, invitation.offering.status)) throw new PlatformError("INVITE_CODE_INVALID", "课程邀请码无效、已停用或已过期", 404);
    const existing = await tx.enrollment.findUnique({ where: { userId_offeringId: { userId: user.id, offeringId: invitation.offeringId } } });
    if (existing) return { id: existing.id, offeringId: existing.offeringId, status: normalizedStatus(existing.status) };
    if (invitation.maxUses !== null && invitation.useCount >= invitation.maxUses) throw new PlatformError("INVITE_CODE_EXHAUSTED", "邀请码使用次数已达上限", 409);
    const enrollment = await tx.enrollment.create({ data: { userId: user.id, offeringId: invitation.offeringId, status: "ACTIVE" } });
    const activities = invitation.offering.chapters.flatMap((chapter) => chapter.activities);
    if (activities.length) await tx.activityProgress.createMany({ data: activities.map((activity) => ({ id: randomUUID(), enrollmentId: enrollment.id, activityId: activity.id, status: "NOT_STARTED" })) });
    await tx.courseInvitation.update({ where: { id: invitation.id }, data: { useCount: { increment: 1 } } });
    return { id: enrollment.id, offeringId: enrollment.offeringId, status: normalizedStatus(enrollment.status) };
  });
}

export async function listTeacherOfferings(claims: AuthClaims) {
  const teacher = await requireTeacherUser(claims);
  const offerings = await prisma.courseOffering.findMany({
    where: { teachers: { some: { userId: teacher.id } } },
    include: { invitations: { where: { status: { in: ["ACTIVE", "active"] } }, orderBy: { createdAt: "desc" }, take: 1 }, chapters: { where: { archivedAt: null }, orderBy: { position: "asc" }, include: { activities: { where: { archivedAt: null }, orderBy: { position: "asc" }, include: { classroomInstances: { orderBy: { createdAt: "desc" }, take: 1, include: { templateVersion: { select: { id: true, templateId: true, version: true, status: true } } } } } } } }, _count: { select: { enrollments: true } } },
    orderBy: { updatedAt: "desc" },
  });
  return offerings.map((offering) => ({ ...offering, ...courseDetails(offering.settings), status: normalizedStatus(offering.status), invitation: offering.invitations[0] ?? null, invitations: undefined, studentCount: offering._count.enrollments, _count: undefined, chapters: offering.chapters.map((chapter) => ({ ...chapter, activities: chapter.activities.map((activity) => ({ ...activity, type: activityTypeForApi(activity.type), templateId: activity.classroomInstances[0]?.templateVersion.templateId ?? null, instances: activity.classroomInstances.map((instance) => ({ ...instance, status: normalizedStatus(instance.status), templateId: instance.templateVersion.templateId })) })) })) }));
}

export async function createOffering(claims: AuthClaims, input: { name: string; description?: string; term?: string; startsAt?: string; endsAt?: string; coverImageUrl?: string | null; outline?: string; referenceMaterials?: string }) {
  const teacher = await requireTeacherUser(claims);
  return prisma.courseOffering.create({
    data: {
      name: input.name,
      coverImageUrl: input.coverImageUrl,
      settings: { outline: input.outline ?? "", referenceMaterials: input.referenceMaterials ?? "" },
      description: input.description,
      term: input.term,
      startsAt: dateOrNull(input.startsAt),
      endsAt: dateOrNull(input.endsAt),
      status: "DRAFT",
      teachers: { create: { userId: teacher.id, role: "OWNER" } },
    },
    include: { teachers: { include: { user: { select: { id: true, displayName: true, username: true } } } } },
  });
}

export async function updateOffering(claims: AuthClaims, offeringId: string, data: { name?: string; description?: string; term?: string; status?: string; startsAt?: string | null; endsAt?: string | null; coverImageUrl?: string | null; outline?: string; referenceMaterials?: string; version?: number }) {
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "CourseOffering" WHERE "id" = ${offeringId} FOR UPDATE`;
    await teacherForOffering(claims, offeringId, tx);
    const current = await tx.courseOffering.findUnique({ where: { id: offeringId } });
    if (!current) throw new PlatformError("NOT_FOUND", "教学班不存在", 404);
    if (data.version !== undefined && data.version !== current.version) throw new PlatformError("VERSION_CONFLICT", "教学班已被其他操作更新", 409);
    return tx.courseOffering.update({ where: { id: offeringId }, data: { name: data.name, description: data.description, term: data.term, status: data.status?.toUpperCase(), startsAt: dateOrNull(data.startsAt), endsAt: dateOrNull(data.endsAt), coverImageUrl: data.coverImageUrl, settings: { ...(current.settings && typeof current.settings === "object" && !Array.isArray(current.settings) ? current.settings : {}), ...courseDetails(current.settings), ...(data.outline !== undefined ? { outline: data.outline } : {}), ...(data.referenceMaterials !== undefined ? { referenceMaterials: data.referenceMaterials } : {}) }, version: { increment: 1 } } });
  });
}

export async function createChapter(claims: AuthClaims, offeringId: string, input: { title: string; description?: string; position?: number }) {
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "CourseOffering" WHERE "id" = ${offeringId} FOR UPDATE`;
    await teacherForOffering(claims, offeringId, tx);
    const position = input.position ?? ((await tx.chapter.aggregate({ where: { offeringId }, _max: { position: true } }))._max.position ?? -1) + 1;
    return tx.chapter.create({ data: { offeringId, title: input.title, description: input.description, position, isOpen: false } });
  });
}

async function readyTemplateVersion(claims: AuthClaims, templateId: string, db: PlatformDb = prisma) {
  const teacher = await requireTeacherUser(claims, db);
  const template = await db.classroomTemplate.findFirst({ where: { id: templateId, ownerId: teacher.id, status: { not: "ARCHIVED" } }, include: { versions: { where: { status: { in: ["PUBLISHED", "published", "ACTIVE", "active"] } }, orderBy: { version: "desc" }, take: 1 } } });
  const version = template?.versions[0];
  if (!version) throw new PlatformError("TEMPLATE_NOT_READY", "请选择课程库中已发布的课堂内容", 400);
  return version;
}

export async function createActivity(claims: AuthClaims, offeringId: string, chapterId: string, input: { type: ActivityType; title: string; description?: string; position?: number; templateId?: string; config?: unknown }) {
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Chapter" WHERE "id" = ${chapterId} FOR UPDATE`;
    await teacherForOffering(claims, offeringId, tx);
    const chapter = await tx.chapter.findFirst({ where: { id: chapterId, offeringId, archivedAt: null } });
    if (!chapter) throw new PlatformError("NOT_FOUND", "章节不存在", 404);
    const position = input.position ?? ((await tx.activity.aggregate({ where: { chapterId }, _max: { position: true } }))._max.position ?? -1) + 1;
    const config = input.config === undefined ? undefined : ActivityConfigSchema.parse(input.config);
    const selectedVersion = input.templateId ? await readyTemplateVersion(claims, input.templateId, tx) : null;
    const created = await tx.activity.create({ data: { chapterId, type: input.type.toUpperCase(), title: input.title, description: input.description, position, isOpen: false, config: config === undefined ? undefined : jsonValue(config) } });
    if (input.type.toUpperCase() === "CLASSROOM" && input.templateId) {
      if (selectedVersion) await tx.classroomInstance.create({ data: { activityId: created.id, templateVersionId: selectedVersion.id, runNo: 1, status: "SCHEDULED" } });
    }
    return created;
  });
}

export async function updateChapter(claims: AuthClaims, chapterId: string, data: { title?: string; description?: string; isOpen?: boolean; opensAt?: string | null; position?: number; version?: number }) {
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Chapter" WHERE "id" = ${chapterId} FOR UPDATE`;
    const chapter = await tx.chapter.findUnique({ where: { id: chapterId } });
    if (!chapter) throw new PlatformError("NOT_FOUND", "章节不存在", 404);
    await teacherForOffering(claims, chapter.offeringId, tx);
    if (data.version !== undefined && data.version !== chapter.version) throw new PlatformError("VERSION_CONFLICT", "章节已被其他操作更新", 409);
    return tx.chapter.update({ where: { id: chapterId }, data: { title: data.title, description: data.description, isOpen: data.isOpen, opensAt: dateOrNull(data.opensAt), position: data.position, version: { increment: 1 } } });
  });
}

export async function updateActivity(claims: AuthClaims, activityId: string, data: { title?: string; description?: string; isOpen?: boolean; opensAt?: string | null; position?: number; config?: unknown; templateId?: string | null; version?: number }) {
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} FOR UPDATE`;
    const activity = await activityForTeacher(claims, activityId, tx);
    if (data.version !== undefined && data.version !== activity.version) throw new PlatformError("VERSION_CONFLICT", "活动已被其他操作更新", 409);
    const config = data.config === undefined ? undefined : ActivityConfigSchema.parse(data.config);
    const selectedVersion = data.templateId ? await readyTemplateVersion(claims, data.templateId, tx) : null;
    const updated = await tx.activity.update({ where: { id: activityId }, data: { title: data.title, description: data.description, isOpen: data.isOpen, opensAt: dateOrNull(data.opensAt), position: data.position, config: config === undefined ? undefined : jsonValue(config), version: { increment: 1 } } });
    if (data.templateId) {
      const version = selectedVersion;
      if (version) {
        const latest = await tx.classroomInstance.findFirst({ where: { activityId }, orderBy: { runNo: "desc" } });
        if (!latest || latest.status.toLowerCase() === "finished" || latest.templateVersionId !== version.id) {
          await tx.classroomInstance.create({ data: { activityId, templateVersionId: version.id, runNo: (latest?.runNo ?? 0) + 1, status: "SCHEDULED" } });
        }
      }
    }
    return updated;
  });
}

export async function archiveChapter(claims: AuthClaims, chapterId: string) {
  const chapter = await prisma.chapter.findUnique({ where: { id: chapterId } });
  if (!chapter) throw new PlatformError("NOT_FOUND", "章节不存在", 404);
  await teacherForOffering(claims, chapter.offeringId);
  return prisma.chapter.update({ where: { id: chapterId }, data: { archivedAt: new Date(), isOpen: false, version: { increment: 1 } } });
}

export async function archiveActivity(claims: AuthClaims, activityId: string) {
  await activityForTeacher(claims, activityId);
  return prisma.activity.update({ where: { id: activityId }, data: { archivedAt: new Date(), isOpen: false, version: { increment: 1 } } });
}

export async function listOfferingStudents(claims: AuthClaims, offeringId: string) {
  await teacherForOffering(claims, offeringId);
  const rows = await prisma.enrollment.findMany({ where: { offeringId }, include: { user: { select: { id: true, username: true, displayName: true, status: true } }, activityProgress: { select: { activityId: true, status: true, completedAt: true, lastAccessedAt: true, progressData: true, activity: { select: { title: true, type: true, config: true } } } } }, orderBy: { joinedAt: "asc" } });
  return rows.map((row) => ({ id: row.user.id, enrollmentId: row.id, username: row.user.username, displayName: row.user.displayName, status: normalizedStatus(row.status), joinedAt: row.joinedAt, progress: row.activityProgress.map((item) => ({ ...item, status: normalizedStatus(item.status) })) }));
}

export async function listPrivateTemplates(claims: AuthClaims) {
  const teacher = await requireTeacherUser(claims);
  return prisma.classroomTemplate.findMany({ where: { ownerId: teacher.id }, include: { versions: { orderBy: { version: "desc" } } }, orderBy: { updatedAt: "desc" } });
}

export async function createPrivateTemplate(claims: AuthClaims, input: { title: string; description?: string; snapshot: unknown; mediaRefs?: unknown }) {
  const teacher = await requireTeacherUser(claims);
  return prisma.classroomTemplate.create({ data: { ownerId: teacher.id, title: input.title, description: input.description, status: "ACTIVE", versions: { create: { version: 1, status: "PUBLISHED", snapshot: jsonValue(input.snapshot), mediaRefs: input.mediaRefs === undefined ? undefined : jsonValue(input.mediaRefs) } } }, include: { versions: true } });
}

/** V2 deliberately does not import legacy Course rows. */
export async function importLegacyCourseTemplate(_claims: AuthClaims, _courseId: string, _title?: string): Promise<never> {
  void _claims;
  void _courseId;
  void _title;
  throw new PlatformError("LEGACY_NOT_SUPPORTED", "V2 不支持导入旧课程，请直接创建课堂模板", 410);
}

export async function createTemplateVersion(claims: AuthClaims, templateId: string, input: { snapshot: unknown; mediaRefs?: unknown }) {
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ClassroomTemplate" WHERE "id" = ${templateId} FOR UPDATE`;
    const teacher = await requireTeacherUser(claims, tx);
    const template = await tx.classroomTemplate.findFirst({ where: { id: templateId, ownerId: teacher.id, status: { not: "ARCHIVED" } }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
    if (!template) throw new PlatformError("NOT_FOUND", "课堂模板不存在", 404);
    const version = (template.versions[0]?.version ?? 0) + 1;
    return tx.classroomTemplateVersion.create({ data: { templateId, version, status: "PUBLISHED", snapshot: jsonValue(input.snapshot), mediaRefs: input.mediaRefs === undefined ? undefined : jsonValue(input.mediaRefs) } });
  });
}

export async function archivePrivateTemplate(claims: AuthClaims, templateId: string) {
  const teacher = await requireTeacherUser(claims);
  const template = await prisma.classroomTemplate.findFirst({ where: { id: templateId, ownerId: teacher.id } });
  if (!template) throw new PlatformError("NOT_FOUND", "课堂模板不存在", 404);
  return prisma.classroomTemplate.update({ where: { id: templateId }, data: { status: "ARCHIVED" } });
}

export async function createClassroomInstance(claims: AuthClaims, activityId: string, templateVersionId: string) {
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} FOR UPDATE`;
    const activity = await activityForTeacher(claims, activityId, tx);
    const version = await tx.classroomTemplateVersion.findUnique({ include: { template: true }, where: { id: templateVersionId } });
    if (!version || version.status.toUpperCase() !== "PUBLISHED" || version.template.status.toUpperCase() === "ARCHIVED" || version.template.ownerId !== (await requireTeacherUser(claims, tx)).id) throw new PlatformError("NOT_FOUND", "课堂模板版本不存在", 404);
    const active = await tx.classroomInstance.findFirst({ where: { activityId, status: { in: ["SCHEDULED", "TEACHING", "scheduled", "teaching"] } }, orderBy: { runNo: "desc" }, include: { templateVersion: true } });
    if (active) return active;
    const latest = await tx.classroomInstance.aggregate({ where: { activityId }, _max: { runNo: true } });
    return tx.classroomInstance.create({ data: { activityId: activity.id, templateVersionId, runNo: (latest._max.runNo ?? 0) + 1, status: "SCHEDULED" }, include: { templateVersion: true } });
  });
}

export async function startClassroomInstance(claims: AuthClaims, instanceId: string) {
  const { changeClassroomState } = await import("./classroom");
  return changeClassroomState(claims, instanceId, "start");
}

export async function finishClassroomInstance(claims: AuthClaims, instanceId: string) {
  const { changeClassroomState } = await import("./classroom");
  return changeClassroomState(claims, instanceId, "finish");
}

export async function enterClassroom(claims: AuthClaims, instanceId: string) {
  const student = await requireStudentUser(claims);
  const instance = await prisma.classroomInstance.findUnique({ where: { id: instanceId }, include: { activity: { include: { chapter: { include: { offering: true } } } }, templateVersion: true } });
  if (!instance) throw new PlatformError("NOT_FOUND", "课堂实例不存在", 404);
  if (!["SCHEDULED", "TEACHING", "FINISHED", "scheduled", "teaching", "finished"].includes(instance.status)) throw new PlatformError("CLASSROOM_CLOSED", "课堂当前不可进入", 403);
  const offering = instance.activity.chapter.offering;
  if (!VISIBLE_OFFERING_STATUSES.includes(offering.status) || normalizedStatus(offering.status) === "draft") throw new PlatformError("COURSE_NOT_OPEN", "课程尚未开放学习", 403);
  if (!isActivityOpen(instance.activity.chapter, instance.activity)) throw new PlatformError("ACTIVITY_LOCKED", "活动尚未开放学习", 403);
  const enrollment = await prisma.enrollment.findUnique({ where: { userId_offeringId: { userId: student.id, offeringId: offering.id } } });
  if (!enrollment || !ACTIVE_ENROLLMENT_STATUSES.includes(enrollment.status)) throw new PlatformError("ENROLLMENT_REQUIRED", "请先加入教学班", 403);
  if (normalizedStatus(instance.status) === "finished") {
    const participation = await prisma.classroomParticipation.findUnique({ where: { instanceId_enrollmentId: { instanceId, enrollmentId: enrollment.id } } });
    if (!participation) throw new PlatformError("PARTICIPATION_NOT_FOUND", "没有本次课堂的参与记录", 404);
    return { instance, participation, student };
  }
  const participation = await prisma.classroomParticipation.upsert({
    where: { instanceId_enrollmentId: { instanceId, enrollmentId: enrollment.id } },
    create: { id: randomUUID(), instanceId, enrollmentId: enrollment.id, firstEnteredAt: new Date(), lastEnteredAt: new Date() },
    update: { lastEnteredAt: new Date() },
  });
  await appendLearningEvents(claims, [{ idempotencyKey: `classroom-entered:${participation.id}:${Math.floor(Date.now() / 60_000)}`, type: "classroom_entered", offeringId: offering.id, activityId: instance.activityId, chapterId: instance.activity.chapterId, classroomInstanceId: instanceId, participationId: participation.id, source: "platform" }]);
  return { instance, participation, student };
}

export async function appendLearningEvents(claims: AuthClaims, events: unknown) {
  const { appendValidatedLearningEvents } = await import("./learning-events");
  return appendValidatedLearningEvents(claims, events);
}

export async function resetOfferingInvitation(claims: AuthClaims, offeringId: string, input: { expiresAt?: string | null; disabled?: boolean }) {
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "CourseOffering" WHERE "id" = ${offeringId} FOR UPDATE`;
    const teacher = await teacherForOffering(claims, offeringId, tx);
    await tx.courseInvitation.updateMany({ where: { offeringId, status: { in: ["ACTIVE", "active"] } }, data: { status: "DISABLED", disabledAt: new Date() } });
    const code = generateInviteCode(6);
    return tx.courseInvitation.create({ data: { offeringId, code: normalizeInviteCode(code), status: input.disabled ? "DISABLED" : "ACTIVE", expiresAt: dateOrNull(input.expiresAt), disabledAt: input.disabled ? new Date() : null, createdById: teacher.id } });
  });
}

export async function requestStudentPasswordReset(claims: AuthClaims, enrollmentId: string) {
  const teacher = await requireTeacherUser(claims);
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId }, include: { offering: { include: { teachers: true } } } });
  if (!enrollment || !enrollment.offering.teachers.some((link) => link.userId === teacher.id)) throw new PlatformError("NOT_FOUND", "学生关系不存在", 404);
  const rawToken = newToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await prisma.passwordResetToken.create({ data: { id: randomUUID(), userId: enrollment.userId, tokenHash: createHash("sha256").update(rawToken).digest("hex"), expiresAt } });
  return { token: rawToken, expiresAt };
}

export async function resetStudentPassword(rawToken: string, password: string) {
  if (!isValidNewPasswordLength(password)) throw new PlatformError("INVALID_INPUT", PASSWORD_LENGTH_HINT, 400);
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const passwordHash = await hashPassword(password);
  await runMutationTransaction(async (tx) => {
    const token = await tx.passwordResetToken.findUnique({ where: { tokenHash } });
    const now = new Date();
    if (!token || token.usedAt || token.expiresAt <= now) throw new PlatformError("RESET_TOKEN_INVALID", "重置链接无效或已过期", 400);
    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: token.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) throw new PlatformError("RESET_TOKEN_INVALID", "重置链接无效或已过期", 400);
    await tx.user.update({ where: { id: token.userId }, data: { passwordHash, sessionVersion: { increment: 1 } } });
  });
  return { ok: true };
}

/** Removed compatibility write path. */
export async function mirrorLegacyLearningEvents(_claims: AuthClaims, _offeringId: string, _events: unknown[]): Promise<never> {
  void _claims;
  void _offeringId;
  void _events;
  throw new PlatformError("LEGACY_NOT_SUPPORTED", "请使用 V2 学习事件接口", 410);
}

/** Kept as a harmless alias for callers being removed from the UI. */
export function legacyStudentIdFor(_offeringId: string, userId: string): string {
  return userId;
}

export class PlatformError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly details?: unknown) {
    super(message);
    this.name = "PlatformError";
  }
}
