import type { Prisma, PrismaClient } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { getRequestedAuthRole, isAuthConfigured, type AuthRole } from "@/lib/auth/session";
import {
  OFFERING_COVER_MEDIA_PREFIX,
  TEMPLATE_COVER_MEDIA_PREFIX,
} from "./classroom-cover";
import { findCourseGenerationPreviewCourseId } from "@/lib/course-generation/generation-preview";

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
export async function canAccessLegacyCourse(claims: AuthClaims, courseId: string, mode: "read" | "write" = "read", db?: PlatformDb): Promise<boolean> {
  const database = db ?? (await import("@/lib/db/client")).prisma;
  const user = await getPlatformUser(claims, database); if (!user) return false;
  const template = await database.classroomTemplate.findUnique({ where: { id: courseId }, select: { ownerId: true, status: true } });
  if (template) return user.role === "teacher" && template.ownerId === user.id && template.status.toUpperCase() === "ACTIVE";
  const offering = await database.courseOffering.findUnique({ where: { id: courseId }, select: { id: true } });
  if (offering) {
    if (user.role === "teacher") return Boolean(await database.courseTeacher.findFirst({ where: { offeringId: offering.id, userId: user.id } }));
    if (mode === "write") return false;
    return Boolean(await database.enrollment.findFirst({ where: { offeringId: offering.id, userId: user.id, status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] } } }));
  }
  const instance = await database.classroomInstance.findUnique({ where: { id: courseId }, include: { activity: { include: { chapter: { include: { offering: true } } } } } });
  if (!instance) return false;
  const offeringId = instance.activity.chapter.offeringId;
  if (user.role === "teacher") return Boolean(await database.courseTeacher.findFirst({ where: { offeringId, userId: user.id } }));
  const participation = await database.classroomParticipation.findFirst({ where: { instanceId: courseId, enrollment: { userId: user.id, offeringId, status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] } } }, include: { enrollment: true } });
  if (!participation) return false;
  return mode === "read" || (instance.status.toUpperCase() === "TEACHING" && participation.enrollment.status.toUpperCase() === "ACTIVE" && instance.activity.chapter.offering.status.toUpperCase() === "OPEN");
}

export async function canReadOfferingCover(
  claims: AuthClaims,
  offeringId: string,
  db?: PlatformDb,
): Promise<boolean> {
  const database = db ?? (await import("@/lib/db/client")).prisma;
  const user = await getPlatformUser(claims, database);
  if (!user) return false;
  if (user.role === "teacher") {
    return Boolean(await database.courseTeacher.findFirst({
      where: { offeringId, userId: user.id },
      select: { id: true },
    }));
  }
  return Boolean(await database.enrollment.findFirst({
    where: {
      offeringId,
      userId: user.id,
      status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] },
    },
    select: { id: true },
  }));
}

export async function canReadTemplateCover(
  claims: AuthClaims,
  templateId: string,
  db?: PlatformDb,
): Promise<boolean> {
  const database = db ?? (await import("@/lib/db/client")).prisma;
  const user = await getPlatformUser(claims, database);
  if (!user) return false;
  if (user.role === "teacher") {
    return Boolean(await database.classroomTemplate.findFirst({
      where: { id: templateId, ownerId: user.id, status: { notIn: ["DELETED", "deleted"] } },
      select: { id: true },
    }));
  }
  const participation = await database.classroomParticipation.findFirst({
    where: {
      enrollment: {
        userId: user.id,
        status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] },
      },
      instance: { templateVersion: { templateId } },
    },
    select: { id: true },
  });
  if (participation) return true;
  return Boolean(await database.classroomInstance.findFirst({
    where: {
      templateVersion: { templateId },
      activity: {
        archivedAt: null,
        chapter: {
          archivedAt: null,
          offering: {
            enrollments: {
              some: {
                userId: user.id,
                status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] },
              },
            },
          },
        },
      },
    },
    select: { id: true },
  }));
}

export function preferredMediaAuthRole(request: Request): AuthRole | undefined {
  const requested = getRequestedAuthRole(request);
  if (requested) return requested;
  const referer = request.headers.get("referer");
  if (!referer) return undefined;
  try {
    const pathname = new URL(referer).pathname;
    if (pathname === "/student" || pathname.startsWith("/student/")) return "student";
    if (pathname === "/teacher" || pathname.startsWith("/teacher/")) return "teacher";
  } catch {
    // Invalid referrers fall back to the standard cookie lookup order.
  }
  return undefined;
}

/** OpenMAIC classrooms are content references of owned templates or enrolled runs. */
export async function authorizeLegacyClassroomRead(request: Request, classroomId: string): Promise<Response | null> {
  if (!isAuthConfigured()) return null;
  const auth = await authenticateRequest(request, preferredMediaAuthRole(request)); if ("response" in auth) return auth.response;
  if (classroomId.startsWith(OFFERING_COVER_MEDIA_PREFIX)) {
    const offeringId = classroomId.slice(OFFERING_COVER_MEDIA_PREFIX.length);
    if (offeringId && await canReadOfferingCover(auth.claims, offeringId)) return null;
    return Response.json({ code: "FORBIDDEN", message: "无权读取此课程封面" }, { status: 403 });
  }
  if (classroomId.startsWith(TEMPLATE_COVER_MEDIA_PREFIX)) {
    const templateId = classroomId.slice(TEMPLATE_COVER_MEDIA_PREFIX.length);
    if (templateId && await canReadTemplateCover(auth.claims, templateId)) return null;
    return Response.json({ code: "FORBIDDEN", message: "无权读取此课堂封面" }, { status: 403 });
  }
  const { prisma } = await import("@/lib/db/client");
  const generationPreviewCourseId = await findCourseGenerationPreviewCourseId(classroomId);
  if (generationPreviewCourseId) {
    if (auth.claims.role === "teacher" && await canAccessLegacyCourse(auth.claims, generationPreviewCourseId)) return null;
    return Response.json({ code: "FORBIDDEN", message: "无权读取课程生成预览" }, { status: 403 });
  }
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
