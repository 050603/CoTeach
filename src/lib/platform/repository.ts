import { publicResourcePackageSnapshot } from "@/lib/resource-package/privacy";
import { isValidNewPasswordLength, PASSWORD_LENGTH_HINT } from "@/lib/auth/password-policy";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { generateInviteCode, normalizeInviteCode } from "@/lib/session/invite-code";
import { ActivityConfigSchema, type ActivityType } from "./activity";
import { SurveyConfigSchema } from "./survey";
import { ExperimentConfigSchema, ExperimentQuestionSchema, experimentConfigFromActivity, publicActivityConfig, publicExperimentQuestions } from "./experiment";
import { buildSurveyAnalytics } from "./survey-analytics";
import { classroomCoverImageUrl } from "./classroom-cover";
import { CourseReferenceLinksSchema, type CourseReferenceLink } from "./course-reference";
import { normalizeUsername, requireStudentUser, requireTeacherUser, type PlatformDb, type PlatformUser } from "./access";

const ACTIVE_ENROLLMENT_STATUSES = ["ACTIVE", "active", "COMPLETED", "completed"];
const VISIBLE_OFFERING_STATUSES = ["DRAFT", "draft", "OPEN", "open", "FINISHED", "finished", "ARCHIVED", "archived"];
const ENROLLABLE_OFFERING_STATUSES = new Set(["draft", "open"]);

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function courseDetails(settings: unknown): { outline: string; referenceMaterials: string; referenceLinks: CourseReferenceLink[] } {
  const value = settings && typeof settings === "object" ? settings as Record<string, unknown> : {};
  const referenceLinks = CourseReferenceLinksSchema.safeParse(value.referenceLinks);
  return {
    outline: typeof value.outline === "string" ? value.outline : "",
    referenceMaterials: typeof value.referenceMaterials === "string" ? value.referenceMaterials : "",
    referenceLinks: referenceLinks.success ? referenceLinks.data : [],
  };
}

type CourseResourceRow = { title: string; fileAsset: { id: string; originalName: string; size: bigint; mimeType: string; deletedAt: Date | null } | null };

function formattedFileSize(bytes: bigint): string {
  const value = Number(bytes);
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function courseReferences(settings: unknown, resources: CourseResourceRow[] = []) {
  return [
    ...courseDetails(settings).referenceLinks.map((reference) => ({ ...reference, kind: "link" as const })),
    ...resources.flatMap((resource) => resource.fileAsset && !resource.fileAsset.deletedAt ? [{
      id: resource.fileAsset.id,
      kind: "file" as const,
      title: resource.title || resource.fileAsset.originalName,
      url: `/api/uploads/${resource.fileAsset.id}`,
      fileName: resource.fileAsset.originalName,
      fileSize: formattedFileSize(resource.fileAsset.size),
      mimeType: resource.fileAsset.mimeType,
    }] : []),
  ];
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

function parsedActivityConfig(type: string, input: unknown) {
  try {
    const config = ActivityConfigSchema.parse(input);
    if ("experiment" in config) {
      if (type.toUpperCase() !== "CLASSROOM") throw new Error("experiment is only available for classrooms");
      ExperimentConfigSchema.parse(config.experiment);
    }
    return type.toUpperCase() === "FORM" ? SurveyConfigSchema.parse(config) : config;
  } catch {
    throw new PlatformError("INVALID_ACTIVITY_CONFIG", type.toUpperCase() === "FORM" ? "请完善问卷题目与单选选项" : type.toUpperCase() === "CLASSROOM" ? "请检查实验模式的前后测题目配置" : "活动配置无效", 400);
  }
}

function activityResourceFileId(type: string, config: unknown): string | null {
  if (type.toUpperCase() !== "RESOURCE" || !config || typeof config !== "object" || Array.isArray(config)) return null;
  const fileId = (config as Record<string, unknown>).fileId;
  return typeof fileId === "string" && fileId.length > 0 ? fileId : null;
}

async function bindActivityResource(db: PlatformDb, input: { activityId: string; fileId: string; offeringId: string; teacherId: string }) {
  const resource = await db.resource.findFirst({ where: { id: input.fileId, fileAssetId: input.fileId, offeringId: input.offeringId, createdById: input.teacherId }, include: { fileAsset: true } });
  if (!resource || resource.fileAsset?.deletedAt || resource.fileAsset?.mimeType !== "application/pdf") throw new PlatformError("INVALID_ACTIVITY_RESOURCE", "请选择当前教学班中已上传的 PDF 参考资料", 400);
  await db.resource.updateMany({ where: { activityId: input.activityId, id: { not: resource.id } }, data: { activityId: null } });
  await db.resource.update({ where: { id: resource.id }, data: { activityId: input.activityId } });
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
  if (usernameKey.length < 3 || !displayName) throw new PlatformError("INVALID_INPUT", "学号、姓名或密码不符合要求", 400);
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
    if (existing) throw new PlatformError("USERNAME_TAKEN", "学号已存在", 409);
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
  if (!account || account.role.toLowerCase() !== "student" || account.status.toLowerCase() !== "active" || !(await verifyPassword(password, account.passwordHash))) throw new PlatformError("INVALID_CREDENTIALS", "学号或密码错误", 401);
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
          resources: { where: { activityId: null }, orderBy: { createdAt: "asc" }, include: { fileAsset: true } },
          chapters: { where: { archivedAt: null }, orderBy: { position: "asc" }, include: { activities: { where: { archivedAt: null }, orderBy: { position: "asc" } } } },
        },
      },
      activityProgress: true,
    },
    orderBy: { joinedAt: "asc" },
  });
  const singleClassroomActivityByOffering = new Map<string, string>();
  for (const row of rows) {
    if (row.offering.coverImageUrl) continue;
    const classroomActivities = row.offering.chapters.flatMap((chapter) =>
      chapter.activities.filter((activity) => activity.type.toUpperCase() === "CLASSROOM"),
    );
    if (classroomActivities.length === 1) {
      singleClassroomActivityByOffering.set(row.offering.id, classroomActivities[0].id);
    }
  }
  const classroomCovers = new Map<string, string>();
  if (singleClassroomActivityByOffering.size) {
    const instances = await prisma.classroomInstance.findMany({
      where: {
        activityId: { in: [...singleClassroomActivityByOffering.values()] },
        status: { in: ["SCHEDULED", "TEACHING", "FINISHED", "scheduled", "teaching", "finished"] },
      },
      orderBy: { createdAt: "desc" },
      select: { activityId: true, templateVersion: { select: { snapshot: true } } },
    });
    const seenActivityIds = new Set<string>();
    for (const instance of instances) {
      if (seenActivityIds.has(instance.activityId)) continue;
      seenActivityIds.add(instance.activityId);
      const coverImageUrl = classroomCoverImageUrl(instance.templateVersion.snapshot);
      if (coverImageUrl) classroomCovers.set(instance.activityId, coverImageUrl);
    }
  }
  const at = new Date();
  return rows.map((row) => {
    const courseReleased = normalizedStatus(row.offering.status) !== "draft";
    return {
      id: row.offering.id,
      name: row.offering.name,
      description: row.offering.description,
      coverImageUrl: row.offering.coverImageUrl ?? classroomCovers.get(singleClassroomActivityByOffering.get(row.offering.id) ?? "") ?? null,
      ...courseDetails(row.offering.settings),
      courseReferences: courseReferences(row.offering.settings, row.offering.resources),
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
          return { id: activity.id, type: activityTypeForApi(activity.type), title: activity.title, description: activity.description, position: activity.position, opensAt: activity.opensAt, isOpen: open, progress: progress ? { status: normalizedStatus(progress.status), startedAt: progress.startedAt, completedAt: progress.completedAt, lastAccessedAt: progress.lastAccessedAt } : { status: "not_started" }, ...(open ? { config: publicActivityConfig(activity.config) } : {}) };
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
  if (activity.type.toUpperCase() === "CLASSROOM" && open && normalizedStatus(offering.status) === "open" && normalizedStatus(enrollment.status) === "active" && activity.classroomInstances[0] && ["scheduled", "teaching"].includes(normalizedStatus(activity.classroomInstances[0].status)) && experimentConfigFromActivity(activity.config)) {
    const { ensureExperimentAssignment } = await import("./experiment-service");
    await ensureExperimentAssignment(activity.classroomInstances[0].id, enrollment.id);
  }
  const instanceIds = activity.classroomInstances.map((instance) => instance.id);
  const [experimentRows, assignments] = activity.type.toUpperCase() === "CLASSROOM" && instanceIds.length
    ? await Promise.all([
      prisma.experimentAssessmentSubmission.findMany({
        where: { instanceId: { in: instanceIds }, enrollmentId: enrollment.id },
        select: { instanceId: true, phase: true },
      }),
      prisma.experimentAssessmentAssignment.findMany({
        where: { instanceId: { in: instanceIds }, enrollmentId: enrollment.id },
        select: { instanceId: true, pretestForm: true, posttestForm: true },
      }),
    ]) : [[], []];
  const instanceExperiment = (instance: typeof activity.classroomInstances[number]) => {
    const assignment = assignments.find((row) => row.instanceId === instance.id);
    if (!assignment) return null;
    const pretest = ExperimentQuestionSchema.array().safeParse(assignment.pretestForm);
    const posttest = ExperimentQuestionSchema.array().safeParse(assignment.posttestForm);
    if (!pretest.success || !posttest.success) return null;
    return { enabled: true, pretest: publicExperimentQuestions(pretest.data), posttest: normalizedStatus(instance.status) === "finished" && submitted(instance.id, "pretest") ? publicExperimentQuestions(posttest.data) : [] };
  };
  const submitted = (instanceId: string, phase: string) => experimentRows.some((row) => row.instanceId === instanceId && row.phase === phase);
  return {
    id: activity.id,
    type: activityTypeForApi(activity.type),
    title: activity.title,
    description: activity.description,
    config: open ? publicActivityConfig(activity.config) : null,
    experiment: open && activity.classroomInstances[0] ? instanceExperiment(activity.classroomInstances[0]) : null,
    isOpen: open,
    chapter: { id: activity.chapter.id, title: activity.chapter.title, position: activity.chapter.position },
    offering: { id: offering.id, name: offering.name, status: normalizedStatus(offering.status) },
    enrollment: { id: enrollment.id },
    progress: progress ? { status: normalizedStatus(progress.status), startedAt: progress.startedAt, completedAt: progress.completedAt, lastAccessedAt: progress.lastAccessedAt, progressData: progress.progressData } : { status: "not_started", startedAt: null, completedAt: null, lastAccessedAt: null },
    instances: activity.classroomInstances.map((instance) => ({ id: instance.id, status: normalizedStatus(instance.status), startedAt: instance.startedAt, endedAt: instance.endedAt, coverImageUrl: classroomCoverImageUrl(instance.templateVersion.snapshot), experiment: open ? instanceExperiment(instance) : null, pretestSubmitted: submitted(instance.id, "pretest"), posttestSubmitted: submitted(instance.id, "posttest") })),
    instance: activity.classroomInstances[0] ? { ...activity.classroomInstances[0], templateVersion: { ...activity.classroomInstances[0].templateVersion, snapshot: publicResourcePackageSnapshot(activity.classroomInstances[0].templateVersion.snapshot) }, status: normalizedStatus(activity.classroomInstances[0].status), coverImageUrl: classroomCoverImageUrl(activity.classroomInstances[0].templateVersion.snapshot), canWrite: open && normalizedStatus(offering.status) === "open" && normalizedStatus(enrollment.status) === "active" && normalizedStatus(activity.classroomInstances[0].status) === "teaching", experiment: open ? instanceExperiment(activity.classroomInstances[0]) : null, pretestSubmitted: submitted(activity.classroomInstances[0].id, "pretest"), posttestSubmitted: submitted(activity.classroomInstances[0].id, "posttest") } : null,
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
    include: {
      invitations: { where: { status: { in: ["ACTIVE", "active"] } }, orderBy: { createdAt: "desc" }, take: 1 },
      resources: { where: { activityId: null }, orderBy: { createdAt: "asc" }, include: { fileAsset: true } },
      chapters: { where: { archivedAt: null }, orderBy: { position: "asc" }, include: { activities: { where: { archivedAt: null }, orderBy: { position: "asc" }, include: { classroomInstances: { orderBy: { runNo: "desc" }, take: 1, include: { templateVersion: { select: { id: true, templateId: true, version: true, status: true, snapshot: true } } } } } } } },
      _count: { select: { enrollments: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
  return offerings.map((offering) => ({ ...offering, ...courseDetails(offering.settings), courseReferences: courseReferences(offering.settings, offering.resources), resources: undefined, status: normalizedStatus(offering.status), invitation: offering.invitations[0] ?? null, invitations: undefined, studentCount: offering._count.enrollments, _count: undefined, chapters: offering.chapters.map((chapter) => ({ ...chapter, activities: chapter.activities.map((activity) => ({ ...activity, type: activityTypeForApi(activity.type), templateId: activity.classroomInstances[0]?.templateVersion.templateId ?? null, templateVersionId: activity.classroomInstances[0]?.templateVersion.id ?? null, instances: activity.classroomInstances.map((instance) => ({ ...instance, status: normalizedStatus(instance.status), templateId: instance.templateVersion.templateId, templateVersionId: instance.templateVersion.id, coverImageUrl: classroomCoverImageUrl(instance.templateVersion.snapshot) })) })) })) }));
}

export async function createOffering(claims: AuthClaims, input: { name: string; description?: string; term?: string; startsAt?: string; endsAt?: string; coverImageUrl?: string | null; outline?: string; referenceMaterials?: string; referenceLinks?: CourseReferenceLink[] }) {
  const teacher = await requireTeacherUser(claims);
  return prisma.courseOffering.create({
    data: {
      name: input.name,
      coverImageUrl: input.coverImageUrl,
      settings: { outline: input.outline ?? "", referenceMaterials: input.referenceMaterials ?? "", referenceLinks: input.referenceLinks ?? [] },
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

export async function updateOffering(claims: AuthClaims, offeringId: string, data: { name?: string; description?: string; term?: string; status?: string; startsAt?: string | null; endsAt?: string | null; coverImageUrl?: string | null; outline?: string; referenceMaterials?: string; referenceLinks?: CourseReferenceLink[]; version?: number }) {
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "CourseOffering" WHERE "id" = ${offeringId} FOR UPDATE`;
    await teacherForOffering(claims, offeringId, tx);
    const current = await tx.courseOffering.findUnique({ where: { id: offeringId } });
    if (!current) throw new PlatformError("NOT_FOUND", "教学班不存在", 404);
    if (data.version !== undefined && data.version !== current.version) throw new PlatformError("VERSION_CONFLICT", "教学班已被其他操作更新", 409);
    return tx.courseOffering.update({ where: { id: offeringId }, data: { name: data.name, description: data.description, term: data.term, status: data.status?.toUpperCase(), startsAt: dateOrNull(data.startsAt), endsAt: dateOrNull(data.endsAt), coverImageUrl: data.coverImageUrl, settings: { ...(current.settings && typeof current.settings === "object" && !Array.isArray(current.settings) ? current.settings : {}), ...courseDetails(current.settings), ...(data.outline !== undefined ? { outline: data.outline } : {}), ...(data.referenceMaterials !== undefined ? { referenceMaterials: data.referenceMaterials } : {}), ...(data.referenceLinks !== undefined ? { referenceLinks: data.referenceLinks } : {}) }, version: { increment: 1 } } });
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

async function readyTemplateVersion(claims: AuthClaims, templateVersionId: string, db: PlatformDb = prisma) {
  const teacher = await requireTeacherUser(claims, db);
  const version = await db.classroomTemplateVersion.findFirst({
    where: {
      id: templateVersionId,
      status: { in: ["PUBLISHED", "published"] },
      template: { ownerId: teacher.id, status: { in: ["ACTIVE", "active"] } },
    },
  });
  if (!version) throw new PlatformError("TEMPLATE_NOT_READY", "请选择课程库中已发布的课堂内容", 400);
  return version;
}

export async function createActivity(claims: AuthClaims, offeringId: string, chapterId: string, input: { type: ActivityType; title: string; description?: string; position?: number; templateVersionId?: string; config?: unknown }) {
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Chapter" WHERE "id" = ${chapterId} FOR UPDATE`;
    const teacher = await teacherForOffering(claims, offeringId, tx);
    const chapter = await tx.chapter.findFirst({ where: { id: chapterId, offeringId, archivedAt: null } });
    if (!chapter) throw new PlatformError("NOT_FOUND", "章节不存在", 404);
    if (input.type.toUpperCase() === "CLASSROOM" && !input.templateVersionId) throw new PlatformError("TEMPLATE_REQUIRED", "请选择要绑定的课程版本", 400);
    const position = input.position ?? ((await tx.activity.aggregate({ where: { chapterId }, _max: { position: true } }))._max.position ?? -1) + 1;
    const config = input.config === undefined ? undefined : parsedActivityConfig(input.type, input.config);
    const selectedVersion = input.templateVersionId ? await readyTemplateVersion(claims, input.templateVersionId, tx) : null;
    const created = await tx.activity.create({ data: { chapterId, type: input.type.toUpperCase(), title: input.title, description: input.description, position, isOpen: false, config: config === undefined ? undefined : jsonValue(config) } });
    if (input.type.toUpperCase() === "CLASSROOM" && input.templateVersionId) {
      if (selectedVersion) await tx.classroomInstance.create({ data: { activityId: created.id, templateVersionId: selectedVersion.id, runNo: 1, status: "SCHEDULED" } });
    }
    const resourceFileId = activityResourceFileId(input.type, config);
    if (resourceFileId) await bindActivityResource(tx, { activityId: created.id, fileId: resourceFileId, offeringId, teacherId: teacher.id });
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
    if (data.isOpen === false) {
      await tx.activity.updateMany({
        where: { chapterId, archivedAt: null, isOpen: true },
        data: { isOpen: false, version: { increment: 1 } },
      });
    }
    return tx.chapter.update({ where: { id: chapterId }, data: { title: data.title, description: data.description, isOpen: data.isOpen, opensAt: dateOrNull(data.opensAt), position: data.position, version: { increment: 1 } } });
  });
}

export async function updateActivity(claims: AuthClaims, activityId: string, data: { title?: string; description?: string; isOpen?: boolean; opensAt?: string | null; position?: number; config?: unknown; templateVersionId?: string | null; version?: number }) {
  return runMutationTransaction(async (tx) => {
    const activityParent = await tx.activity.findUnique({ where: { id: activityId }, select: { chapterId: true } });
    if (!activityParent) throw new PlatformError("NOT_FOUND", "活动不存在", 404);
    await tx.$queryRaw`SELECT "id" FROM "Chapter" WHERE "id" = ${activityParent.chapterId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} FOR UPDATE`;
    const activity = await activityForTeacher(claims, activityId, tx);
    if (data.version !== undefined && data.version !== activity.version) throw new PlatformError("VERSION_CONFLICT", "活动已被其他操作更新", 409);
    const config = data.config === undefined ? undefined : parsedActivityConfig(activity.type, data.config);
    if (activity.type.toUpperCase() === "CLASSROOM" && config !== undefined) {
      const previousExperiment = activity.config && typeof activity.config === "object" && !Array.isArray(activity.config) ? (activity.config as Record<string, unknown>).experiment : undefined;
      if (JSON.stringify(previousExperiment) !== JSON.stringify(config.experiment)) {
        const activeRuns = await tx.classroomInstance.findMany({ where: { activityId, status: { in: ["SCHEDULED", "scheduled", "TEACHING", "teaching"] } }, select: { id: true, status: true } });
        if (activeRuns.some((run) => run.status.toLowerCase() === "teaching") || await tx.experimentAssessmentAssignment.count({ where: { instanceId: { in: activeRuns.map((run) => run.id) } } })) {
          throw new PlatformError("EXPERIMENT_CONFIG_LOCKED", "本场课堂已开始或已有学生获取题目，请在结束后为下一场次修改实验题目", 409);
        }
      }
    }
    const selectedVersion = data.templateVersionId ? await readyTemplateVersion(claims, data.templateVersionId, tx) : null;
    if (data.isOpen === true && !activity.chapter.isOpen) {
      await tx.chapter.update({
        where: { id: activity.chapterId },
        data: { isOpen: true, version: { increment: 1 } },
      });
    }
    const updated = await tx.activity.update({ where: { id: activityId }, data: { title: data.title, description: data.description, isOpen: data.isOpen, opensAt: dateOrNull(data.opensAt), position: data.position, config: config === undefined ? undefined : jsonValue(config), version: { increment: 1 } } });
    const resourceFileId = activityResourceFileId(activity.type, config);
    if (resourceFileId) await bindActivityResource(tx, { activityId, fileId: resourceFileId, offeringId: activity.chapter.offeringId, teacherId: claims.sub! });
    else if (activity.type.toUpperCase() === "RESOURCE" && config !== undefined) await tx.resource.updateMany({ where: { activityId }, data: { activityId: null } });
    if (data.templateVersionId) {
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

export async function getSurveyAnalytics(claims: AuthClaims, activityId: string) {
  const activity = await activityForTeacher(claims, activityId);
  if (activity.type.toUpperCase() !== "FORM") throw new PlatformError("INVALID_ACTIVITY", "该活动不是问卷", 400);
  const config = SurveyConfigSchema.safeParse(activity.config);
  if (!config.success) throw new PlatformError("INVALID_ACTIVITY_CONFIG", "问卷配置不完整，请先编辑问卷", 400);
  const [totalStudents, rows] = await Promise.all([
    prisma.enrollment.count({
      where: { offeringId: activity.chapter.offeringId, status: { in: ACTIVE_ENROLLMENT_STATUSES } },
    }),
    prisma.activityProgress.findMany({
      where: { activityId, status: { in: ["COMPLETED", "completed"] }, enrollment: { status: { in: ACTIVE_ENROLLMENT_STATUSES } } },
      select: {
        progressData: true,
        completedAt: true,
        enrollment: { select: { user: { select: { id: true, displayName: true } } } },
      },
      orderBy: { completedAt: "desc" },
    }),
  ]);
  return {
    activity: {
      id: activity.id,
      title: activity.title,
      description: activity.description,
      isOpen: activity.isOpen,
      chapter: { id: activity.chapter.id, title: activity.chapter.title },
      offering: { id: activity.chapter.offering.id, name: activity.chapter.offering.name },
    },
    analytics: buildSurveyAnalytics(config.data, rows.map((row) => ({
      progressData: row.progressData,
      completedAt: row.completedAt,
      respondent: { studentId: row.enrollment.user.id, displayName: row.enrollment.user.displayName },
    })), totalStudents),
    updatedAt: new Date().toISOString(),
  };
}

export async function listPrivateTemplates(claims: AuthClaims) {
  const teacher = await requireTeacherUser(claims);
  const templates = await prisma.classroomTemplate.findMany({ where: { ownerId: teacher.id, status: { notIn: ["DELETED", "deleted"] } }, include: { versions: { orderBy: { version: "desc" } } }, orderBy: { updatedAt: "desc" } });
  if (!templates.length) return templates;

  const activeJobs = await prisma.generationJob.findMany({
    where: {
      targetType: "CLASSROOM_TEMPLATE",
      targetId: { in: templates.map((template) => template.id) },
      jobType: { in: ["COURSE_DESIGN", "COURSE_CONTENT"] },
      status: { in: ["QUEUED", "RUNNING", "REVIEW_AVAILABLE", "PAUSED", "CANCELLING"] },
    },
    select: { targetId: true, status: true },
    orderBy: { updatedAt: "desc" },
  });
  const generationStatusByTemplate = new Map<string, string>();
  for (const job of activeJobs) {
    if (!generationStatusByTemplate.has(job.targetId)) {
      generationStatusByTemplate.set(job.targetId, job.status.toLowerCase());
    }
  }
  return templates.map((template) => ({
    ...template,
    generationStatus: generationStatusByTemplate.get(template.id) ?? null,
  }));
}

export async function createPrivateTemplate(claims: AuthClaims, input: { title: string; description?: string; snapshot: unknown; mediaRefs?: unknown }) {
  const teacher = await requireTeacherUser(claims);
  await assertTemplateReviewForPublication(input.snapshot, teacher.id);
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
    const template = await tx.classroomTemplate.findFirst({ where: { id: templateId, ownerId: teacher.id, status: { in: ["ACTIVE", "active"] } }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
    if (!template) throw new PlatformError("NOT_FOUND", "课堂模板不存在", 404);
    await assertTemplateReviewForPublication(input.snapshot, teacher.id);
    const version = (template.versions[0]?.version ?? 0) + 1;
    const created = await tx.classroomTemplateVersion.create({ data: { templateId, version, status: "PUBLISHED", snapshot: jsonValue(input.snapshot), mediaRefs: input.mediaRefs === undefined ? undefined : jsonValue(input.mediaRefs) } });
    await tx.classroomTemplate.update({ where: { id: templateId }, data: { updatedAt: new Date() } });
    return created;
  });
}

export async function archivePrivateTemplate(claims: AuthClaims, templateId: string) {
  const teacher = await requireTeacherUser(claims);
  const template = await prisma.classroomTemplate.findFirst({ where: { id: templateId, ownerId: teacher.id, status: { notIn: ["DELETED", "deleted"] } } });
  if (!template) throw new PlatformError("NOT_FOUND", "课堂模板不存在", 404);
  return prisma.classroomTemplate.update({ where: { id: templateId }, data: { status: "ARCHIVED" } });
}

export async function restorePrivateTemplate(claims: AuthClaims, templateId: string) {
  const teacher = await requireTeacherUser(claims);
  const template = await prisma.classroomTemplate.findFirst({ where: { id: templateId, ownerId: teacher.id } });
  if (!template || template.status.toUpperCase() === "DELETED") throw new PlatformError("NOT_FOUND", "课堂模板不存在", 404);
  if (template.status.toUpperCase() !== "ARCHIVED") throw new PlatformError("TEMPLATE_NOT_ARCHIVED", "只有已归档课程可以恢复", 409);
  return prisma.classroomTemplate.update({ where: { id: templateId }, data: { status: "ACTIVE" } });
}

export async function deleteArchivedPrivateTemplate(claims: AuthClaims, templateId: string) {
  const teacher = await requireTeacherUser(claims);
  const template = await prisma.classroomTemplate.findFirst({ where: { id: templateId, ownerId: teacher.id } });
  if (!template || template.status.toUpperCase() === "DELETED") throw new PlatformError("NOT_FOUND", "课堂模板不存在", 404);
  if (template.status.toUpperCase() !== "ARCHIVED") throw new PlatformError("TEMPLATE_NOT_ARCHIVED", "请先归档课程，再进行删除", 409);
  // Keep immutable versions for classroom instances and research records, while
  // removing the template from every teacher-facing library/query surface.
  return prisma.classroomTemplate.update({ where: { id: templateId }, data: { status: "DELETED" } });
}

export async function createClassroomInstance(claims: AuthClaims, activityId: string, templateVersionId: string) {
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} FOR UPDATE`;
    const activity = await activityForTeacher(claims, activityId, tx);
    const version = await tx.classroomTemplateVersion.findUnique({ include: { template: true }, where: { id: templateVersionId } });
    if (!version || version.status.toUpperCase() !== "PUBLISHED" || version.template.status.toUpperCase() !== "ACTIVE" || version.template.ownerId !== (await requireTeacherUser(claims, tx)).id) throw new PlatformError("NOT_FOUND", "课堂模板版本不存在", 404);
    const active = await tx.classroomInstance.findFirst({ where: { activityId, templateVersionId, status: { in: ["SCHEDULED", "TEACHING", "scheduled", "teaching"] } }, orderBy: { runNo: "desc" }, include: { templateVersion: true } });
    if (active) return active;
    await assertTemplateReviewForPublication(version.snapshot, version.template.ownerId);
    const latest = await tx.classroomInstance.aggregate({ where: { activityId }, _max: { runNo: true } });
    return tx.classroomInstance.create({ data: { activityId: activity.id, templateVersionId, runNo: (latest._max.runNo ?? 0) + 1, status: "SCHEDULED" }, include: { templateVersion: true } });
  });
}

async function assertTemplateReviewForPublication(snapshot: unknown, teacherId: string): Promise<void> {
  const { decodePblTemplate, createPblTemplateCourse } = await import("./pbl-template");
  const design = decodePblTemplate(snapshot);
  if (!design) return;
  const { assertCourseTeacherReview, CourseReviewError } = await import("@/lib/course-quality-review/review-service");
  const course = createPblTemplateCourse(design.content.teacherReview?.courseId ?? 'new-template', design);
  try { await assertCourseTeacherReview(course, teacherId); }
  catch (error) { if (error instanceof CourseReviewError) throw new PlatformError(error.code, error.message, error.status); throw error; }
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
  if (normalizedStatus(instance.status) !== "finished" && experimentConfigFromActivity(instance.activity.config)) {
    const pretest = await prisma.experimentAssessmentSubmission.findUnique({ where: { instanceId_enrollmentId_phase: { instanceId, enrollmentId: enrollment.id, phase: "pretest" } }, select: { id: true } });
    if (!pretest) throw new PlatformError("PRETEST_REQUIRED", "请先完成本场课堂前测", 409);
  }
  const studentInstance = { ...instance, activity: { ...instance.activity, config: publicActivityConfig(instance.activity.config) } };
  if (normalizedStatus(instance.status) === "finished") {
    const participation = await prisma.classroomParticipation.findUnique({ where: { instanceId_enrollmentId: { instanceId, enrollmentId: enrollment.id } } });
    if (!participation) throw new PlatformError("PARTICIPATION_NOT_FOUND", "没有本次课堂的参与记录", 404);
    return { instance: { ...studentInstance, templateVersion: { ...instance.templateVersion, snapshot: publicResourcePackageSnapshot(instance.templateVersion.snapshot) }, coverImageUrl: classroomCoverImageUrl(instance.templateVersion.snapshot) }, participation, student };
  }
  const participation = await prisma.classroomParticipation.upsert({
    where: { instanceId_enrollmentId: { instanceId, enrollmentId: enrollment.id } },
    create: { id: randomUUID(), instanceId, enrollmentId: enrollment.id, firstEnteredAt: new Date(), lastEnteredAt: new Date() },
    update: { lastEnteredAt: new Date() },
  });
  await appendLearningEvents(claims, [{ idempotencyKey: `classroom-entered:${participation.id}:${Math.floor(Date.now() / 60_000)}`, type: "classroom_entered", offeringId: offering.id, activityId: instance.activityId, chapterId: instance.activity.chapterId, classroomInstanceId: instanceId, participationId: participation.id, source: "platform" }]);
  return { instance: { ...studentInstance, templateVersion: { ...instance.templateVersion, snapshot: publicResourcePackageSnapshot(instance.templateVersion.snapshot) }, coverImageUrl: classroomCoverImageUrl(instance.templateVersion.snapshot) }, participation, student };
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
