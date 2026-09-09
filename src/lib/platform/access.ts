import type { Prisma, PrismaClient } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { isAuthConfigured } from "@/lib/auth/session";

export type PlatformDb = PrismaClient | Prisma.TransactionClient;

export type PlatformUser = {
  id: string;
  username: string;
  displayName: string;
  role: "student" | "teacher";
  status: string;
  sessionVersion: number;
};

export function normalizeUsername(username: string): string {
  return username.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function claimsUserId(claims: AuthClaims): string | null {
  return typeof claims.sub === "string" ? claims.sub : null;
}

function toPlatformUser(user: {
  id: string;
  username: string;
  displayName: string;
  role: string;
  status: string;
  sessionVersion: number;
}): PlatformUser | null {
  const role = user.role.toLowerCase();
  if (role !== "student" && role !== "teacher") return null;
  return { ...user, role, status: user.status.toLowerCase() };
}

export async function getPlatformUser(claims: AuthClaims, db?: PlatformDb): Promise<PlatformUser | null> {
  const database = db ?? (await import("@/lib/db/client")).prisma;
  const id = claimsUserId(claims);
  if (!id) return null;
  const user = await database.user.findUnique({ where: { id } });
  if (!user || user.status.toLowerCase() !== "active" || user.role.toLowerCase() !== claims.role) return null;
  return toPlatformUser(user);
}

export async function ensureTeacherPlatformUser(teacherId: string, db?: PlatformDb): Promise<PlatformUser> {
  const database = db ?? (await import("@/lib/db/client")).prisma;
  const user = await database.user.findUnique({ where: { id: teacherId } });
  const platformUser = user && toPlatformUser(user);
  if (!platformUser || platformUser.role !== "teacher" || platformUser.status !== "active") throw new Error("TEACHER_NOT_FOUND");
  return platformUser;
}

export async function requireTeacherUser(claims: AuthClaims, db?: PlatformDb): Promise<PlatformUser> {
  if (claims.role !== "teacher" || !claims.sub) throw new Error("FORBIDDEN");
  return ensureTeacherPlatformUser(claims.sub, db);
}

export async function requireStudentUser(claims: AuthClaims, db?: PlatformDb): Promise<PlatformUser> {
  if (claims.role !== "student") throw new Error("FORBIDDEN");
  const user = await getPlatformUser(claims, db);
  if (!user || user.role !== "student") throw new Error("FORBIDDEN");
  return user;
}

/** V2 IDs are direct offering IDs; this helper only protects old callers from manufacturing an ID. */
export function platformUserIdFromLegacyStudentId(_offeringId: string, studentId: string): string {
  return studentId;
}

export async function findLegacyParticipation(db: PlatformDb, instanceId: string, studentId: string): Promise<{ id: string } | null> {
  return db.classroomParticipation.findFirst({ where: { instanceId, enrollment: { userId: studentId, status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] } } }, select: { id: true } });
}

/** Resolve the teaching view to its existing V2 template or classroom run. */
export async function canAccessLegacyCourse(claims: AuthClaims, courseId: string, mode: "read" | "write" = "read"): Promise<boolean> {
  const { prisma } = await import("@/lib/db/client");
  const user = await getPlatformUser(claims, prisma); if (!user) return false;
  const template = await prisma.classroomTemplate.findUnique({ where: { id: courseId }, select: { ownerId: true, status: true } });
  if (template) return user.role === "teacher" && template.ownerId === user.id && template.status !== "ARCHIVED";
  const instance = await prisma.classroomInstance.findUnique({ where: { id: courseId }, include: { activity: { include: { chapter: { include: { offering: true } } } } } });
  if (!instance) return false;
  const offeringId = instance.activity.chapter.offeringId;
  if (user.role === "teacher") return Boolean(await prisma.courseTeacher.findFirst({ where: { offeringId, userId: user.id } }));
  const participation = await prisma.classroomParticipation.findFirst({ where: { instanceId: courseId, enrollment: { userId: user.id, offeringId, status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] } } }, include: { enrollment: true } });
  if (!participation) return false;
  return mode === "read" || (instance.status.toUpperCase() === "TEACHING" && participation.enrollment.status.toUpperCase() === "ACTIVE" && instance.activity.chapter.offering.status.toUpperCase() === "OPEN");
}

/** OpenMAIC classrooms are content references of owned templates or enrolled runs. */
export async function authorizeLegacyClassroomRead(request: Request, classroomId: string): Promise<Response | null> {
  if (!isAuthConfigured()) return null;
  const auth = await authenticateRequest(request); if ("response" in auth) return auth.response;
  const { prisma } = await import("@/lib/db/client");
  const references = await prisma.classroomTemplateVersion.findMany({ where: { OR: [
    { snapshot: { path: ["design", "aiLearningClassroomId"], equals: classroomId } },
    { snapshot: { path: ["design", "teacherClassroomId"], equals: classroomId } },
    { snapshot: { path: ["design", "content", "_openmaicClassroomId"], equals: classroomId } },
  ] }, select: { template: { select: { ownerId: true } }, instances: { select: { id: true } } } });
  for (const reference of references) {
    if (auth.claims.role === "teacher" && reference.template.ownerId === auth.claims.sub) return null;
    for (const instance of reference.instances) if (await canAccessLegacyCourse(auth.claims, instance.id)) return null;
  }
  return Response.json({ code: "FORBIDDEN", message: "无权读取此课堂内容" }, { status: 403 });
}
