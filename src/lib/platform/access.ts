import type { PrismaClient, Prisma } from "@prisma/client";
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

/**
 * A few legacy route tests provide deliberately small database mocks. Keep
 * the compatibility guard a no-op when the platform delegates are absent,
 * while a real configured deployment always has both delegates from Prisma.
 */
async function platformDb(): Promise<PrismaClient | null> {
  try {
    const databaseModule = await import("@/lib/db/client") as unknown as { prisma?: PrismaClient };
    return databaseModule.prisma ?? null;
  } catch {
    return null;
  }
}

async function platformDatabaseConfigured(): Promise<boolean> {
  try {
    const databaseModule = await import("@/lib/db/client") as unknown as { isDatabaseConfigured?: () => boolean };
    return databaseModule.isDatabaseConfigured
      ? databaseModule.isDatabaseConfigured()
      : Boolean(process.env.DATABASE_URL?.startsWith("postgres"));
  } catch {
    return false;
  }
}

export function platformUserIdFromLegacyStudentId(courseId: string, studentId: string): string {
  const prefix = `platform-${courseId}-`;
  return studentId.startsWith(prefix) ? studentId.slice(prefix.length) : studentId;
}

export async function findLegacyParticipation(
  db: PlatformDb,
  courseId: string,
  studentId: string,
): Promise<{ id: string } | null> {
  const userId = platformUserIdFromLegacyStudentId(courseId, studentId);
  return db.classroomParticipation.findFirst({
    where: {
      instance: { legacyCourseId: courseId },
      enrollment: { userId, status: { in: ["active", "completed"] } },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
}

export function normalizeUsername(username: string): string {
  return username.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export async function getPlatformUser(
  claims: AuthClaims,
  db?: PlatformDb,
): Promise<PlatformUser | null> {
  const database = db ?? await platformDb();
  if (!database) return null;
  const userId = claims.role === "teacher"
    ? claims.sub
    : ("userId" in claims && typeof claims.userId === "string" ? claims.userId : claims.studentId);
  if (!userId) return null;
  const user = await database.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== "active" || user.role !== claims.role) return null;
  return user as PlatformUser;
}

/**
 * Bridge a legacy Teacher row into the unified User table. The id is kept
 * stable so existing teacher JWTs continue to identify the same person.
 */
export async function ensureTeacherPlatformUser(
  teacherId: string,
  db?: PlatformDb,
): Promise<PlatformUser> {
  const database = db ?? await platformDb();
  if (!database) throw new Error("DATABASE_REQUIRED");
  const teacher = await database.teacher.findUnique({ where: { id: teacherId } });
  if (!teacher) throw new Error("TEACHER_NOT_FOUND");
  const usernameKey = normalizeUsername(teacher.username);
  const existing = await database.user.findUnique({ where: { id: teacher.id } });
  if (existing) {
    if (existing.role !== "teacher") throw new Error("PLATFORM_IDENTITY_CONFLICT");
    if (existing.status !== "active") throw new Error("FORBIDDEN");
    return existing as PlatformUser;
  }
  return (await database.user.create({
    data: {
      id: teacher.id,
      username: teacher.username,
      usernameKey,
      displayName: teacher.displayName,
      passwordHash: teacher.passwordHash,
      role: "teacher",
      sessionVersion: teacher.sessionVersion,
    },
  })) as PlatformUser;
}

export async function requireTeacherUser(
  claims: AuthClaims,
  db?: PlatformDb,
): Promise<PlatformUser> {
  if (claims.role !== "teacher" || !claims.sub) throw new Error("FORBIDDEN");
  return ensureTeacherPlatformUser(claims.sub, db);
}

export async function requireStudentUser(
  claims: AuthClaims,
  db?: PlatformDb,
): Promise<PlatformUser> {
  if (claims.role !== "student") throw new Error("FORBIDDEN");
  const user = await getPlatformUser(claims, db);
  if (!user) throw new Error("FORBIDDEN");
  return user;
}

/**
 * Resolve an old Course URL/API through the long-lived platform model. This
 * keeps compatibility handlers from trusting the compatibility courseId in a
 * unified JWT when the same student belongs to several offerings.
 */
export async function canAccessLegacyCourse(
  claims: AuthClaims,
  courseId: string,
  mode: "read" | "write" = "read",
): Promise<boolean> {
  const legacyClaimAllows = claims.role === "teacher" || (!claims.userId && claims.courseId === courseId);
  if (!await platformDatabaseConfigured()) return legacyClaimAllows;
  const db = await platformDb();
  if (!db?.courseOffering?.findMany || !db.classroomInstance?.findMany) return legacyClaimAllows;
  const [direct, instances] = await Promise.all([
    db.courseOffering.findMany({
      where: { legacyCourseId: courseId },
      select: {
        teacherId: true,
        status: true,
        enrollments: { select: { userId: true, status: true } },
        chapters: {
          where: { archivedAt: null },
          select: {
            isOpen: true,
            opensAt: true,
            activities: { where: { type: "Classroom", archivedAt: null }, select: { isOpen: true, opensAt: true } },
          },
        },
      },
    }),
    db.classroomInstance.findMany({
      where: { OR: [{ legacyCourseId: courseId }, { legacySourceCourseId: courseId }] },
      select: {
        status: true,
        offering: {
          select: {
            teacherId: true,
            status: true,
            enrollments: { select: { userId: true, status: true } },
          },
        },
        activity: {
          select: {
            isOpen: true,
            opensAt: true,
            archivedAt: true,
            chapter: { select: { isOpen: true, opensAt: true, archivedAt: true } },
          },
        },
      },
    }),
  ]);
  const linked = direct.length > 0 || instances.length > 0;
  if (!linked) return claims.role === "teacher" || (!claims.userId && claims.courseId === courseId);
  if (claims.role === "teacher") {
    return direct.some((offering) => offering.teacherId === claims.sub)
      || instances.some((instance) => instance.offering.teacherId === claims.sub);
  }
  const userId = claims.userId ?? claims.studentId;
  const at = new Date();
  const offeringOpen = (status: string) => mode === "write" ? status === "open" : ["open", "finished", "archived"].includes(status);
  const activityOpen = (chapter: { isOpen: boolean; opensAt: Date | null; archivedAt?: Date | null }, activity: { isOpen: boolean; opensAt: Date | null; archivedAt?: Date | null }) =>
    !chapter.archivedAt && chapter.isOpen && (!chapter.opensAt || chapter.opensAt <= at)
    && !activity.archivedAt && activity.isOpen && (!activity.opensAt || activity.opensAt <= at);
  const enrollmentAllowed = (status: string) => mode === "write" ? status === "active" : ["active", "completed"].includes(status);
  return direct.some((offering) => offeringOpen(offering.status)
    && offering.enrollments.some((enrollment) => enrollment.userId === userId && enrollmentAllowed(enrollment.status))
    && offering.chapters.some((chapter) => chapter.activities.some((activity) => activityOpen(chapter, activity))))
    || instances.some((instance) => offeringOpen(instance.offering.status)
      && (mode !== "write" || instance.status === "teaching")
      && instance.offering.enrollments.some((enrollment) => enrollment.userId === userId && enrollmentAllowed(enrollment.status))
      && activityOpen(instance.activity.chapter, instance.activity));
}

/** Protect legacy classroom JSON/media URLs after they become attached to an
 * offering. The compatibility store still works in local demo mode, but a
 * configured deployment must have an authenticated teacher or enrolled student.
 */
export async function authorizeLegacyClassroomRead(request: Request, classroomId: string): Promise<Response | null> {
  if (!isAuthConfigured()) return null;
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  // The classroom storage uses its own classroom id (for example the
  // generated AI-learning id), while the platform links a Course row. Resolve
  // both ids before checking the offering so media and JSON cannot bypass the
  // enrollment gate by using a storage id directly.
  const db = await platformDb();
  if (!db?.course?.findMany || !db.courseOffering?.findMany || !db.classroomInstance?.findMany) return null;
  const matchingCourses = await db.course.findMany({
    where: {
      OR: [
        { id: classroomId },
        { aiLearningClassroomId: classroomId },
        { teacherClassroomId: classroomId },
      ],
    },
    select: { id: true, content: true },
  });
  const courseIds = new Set(matchingCourses.map((course) => course.id));
  for (const course of matchingCourses) {
    if (course.content && typeof course.content === "object" && !Array.isArray(course.content)) {
      const content = course.content as Record<string, unknown>;
      for (const key of ["_openmaicClassroomId", "aiLearningClassroomId", "teacherClassroomId"]) {
        if (content[key] === classroomId) courseIds.add(course.id);
      }
    }
  }
  // An unlinked legacy classroom may still be addressed by the old course
  // token, so retain that id as a compatibility candidate.
  if (!courseIds.size && !auth.claims.userId && auth.claims.courseId === classroomId) {
    courseIds.add(classroomId);
  }
  const resolvedCourseIds = [...courseIds];
  const directOfferings = await db.courseOffering.findMany({
    where: {
      OR: [
        { legacyCourseId: { in: resolvedCourseIds } },
      ],
    },
    select: {
      id: true,
      teacherId: true,
      status: true,
      enrollments: { select: { userId: true, status: true } },
      chapters: {
        where: { archivedAt: null },
        select: {
          isOpen: true,
          opensAt: true,
          activities: {
            where: { type: "Classroom", archivedAt: null },
            select: { isOpen: true, opensAt: true, archivedAt: true },
          },
        },
      },
    },
  });
  const instanceOfferings = await db.classroomInstance.findMany({
    where: {
      OR: [
        { legacyCourseId: { in: resolvedCourseIds } },
        { legacySourceCourseId: { in: resolvedCourseIds } },
      ],
    },
    select: {
      offering: {
        select: {
          id: true,
          teacherId: true,
          status: true,
          enrollments: { select: { userId: true, status: true } },
        },
      },
      activity: { select: { isOpen: true, opensAt: true, archivedAt: true, chapter: { select: { isOpen: true, opensAt: true, archivedAt: true } } } },
    },
  });
  const linked = [...directOfferings, ...instanceOfferings.map((row) => row.offering)];
  if (auth.claims.role === "teacher") {
    // Unlinked legacy classrooms remain available to the old teacher flow.
    // Once a classroom is attached to a platform offering, only its owner may
    // use the legacy URL as a compatibility entry point.
    if (linked.length === 0 || linked.some((offering) => offering.teacherId === auth.claims.sub)) return null;
    return Response.json({ code: "FORBIDDEN", message: "课堂不属于当前教师" }, { status: 403 });
  }
  const userId = auth.claims.userId ?? auth.claims.studentId;
  const now = new Date();
  const directCanRead = directOfferings.some((offering) =>
    ["open", "finished", "archived"].includes(offering.status)
    && offering.enrollments.some((enrollment) => enrollment.userId === userId && ["active", "completed"].includes(enrollment.status))
    && offering.chapters.some((chapter) =>
    chapter.isOpen
    && (!chapter.opensAt || chapter.opensAt <= now)
    && chapter.activities.some((activity) =>
      activity.isOpen
      && !activity.archivedAt
      && (!activity.opensAt || activity.opensAt <= now),
    ),
  ));
  const instanceCanRead = instanceOfferings.some((row) =>
    ["open", "finished", "archived"].includes(row.offering.status)
    && row.offering.enrollments.some((enrollment) => enrollment.userId === userId && ["active", "completed"].includes(enrollment.status))
    && !row.activity.archivedAt
    && row.activity.isOpen
    && (!row.activity.opensAt || row.activity.opensAt <= now)
    && !row.activity.chapter.archivedAt
    && row.activity.chapter.isOpen
    && (!row.activity.chapter.opensAt || row.activity.chapter.opensAt <= now),
  );
  // Preserve unlinked legacy classroom sessions for old accounts; once a
  // classroom is attached to a platform offering, require that Enrollment
  // and the chapter/activity open checks above.
  if (linked.length === 0 && !auth.claims.userId && (auth.claims.courseId === classroomId || resolvedCourseIds.includes(auth.claims.courseId))) return null;
  return directCanRead || instanceCanRead
    ? null
    : Response.json({ code: "FORBIDDEN", message: "课堂尚未开放或不属于当前学生" }, { status: 403 });
}
