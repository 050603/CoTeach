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

export async function findLegacyParticipation(db: PlatformDb, offeringId: string, studentId: string): Promise<{ id: string } | null> {
  return db.classroomParticipation.findFirst({
    where: {
      instance: { activity: { chapter: { offeringId } } },
      enrollment: { userId: studentId, status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] } },
    },
    orderBy: { firstEnteredAt: "desc" },
    select: { id: true },
  });
}

/** Resolve a V2 offering for callers that still use the old authorization hook. */
export async function canAccessLegacyCourse(claims: AuthClaims, offeringId: string, mode: "read" | "write" = "read"): Promise<boolean> {
  const { prisma } = await import("@/lib/db/client");
  const userId = claimsUserId(claims);
  if (!userId) return false;
  const offering = await prisma.courseOffering.findUnique({
    where: { id: offeringId },
    select: { status: true, teachers: { select: { userId: true } }, enrollments: { where: { userId }, select: { status: true } } },
  });
  if (!offering) return false;
  if (claims.role === "teacher") return offering.teachers.some((row) => row.userId === userId);
  const status = offering.status.toLowerCase();
  const enrollment = offering.enrollments[0];
  const enrolled = enrollment && ["active", "completed"].includes(enrollment.status.toLowerCase());
  return Boolean(enrolled && (mode === "write" ? status === "open" : ["open", "finished", "archived"].includes(status)));
}

/** Legacy classroom URLs have no V2 data source and are intentionally closed. */
export async function authorizeLegacyClassroomRead(request: Request, _classroomId: string): Promise<Response | null> {
  void _classroomId;
  if (!isAuthConfigured()) return null;
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  return Response.json({ code: "V2_ROUTE_REQUIRED", message: "请使用 V2 课堂入口" }, { status: 410 });
}
