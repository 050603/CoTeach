import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { getPlatformUser, type PlatformDb } from "./access";
import { PlatformError } from "./repository";

export async function requireParticipation(claims: AuthClaims, id: string, db: PlatformDb = prisma) {
  const user = await getPlatformUser(claims, db);
  if (!user) throw new PlatformError("UNAUTHORIZED", "请重新登录", 401);
  const participation = await db.classroomParticipation.findUnique({
    where: { id },
    include: { enrollment: { include: { user: { select: { id: true, displayName: true } } } }, instance: { include: { templateVersion: true, activity: { include: { chapter: { include: { offering: true } } } } } } },
  });
  if (!participation) throw new PlatformError("NOT_FOUND", "课堂参与记录不存在", 404);
  const offeringId = participation.instance.activity.chapter.offeringId;
  if (participation.enrollment.offeringId !== offeringId) throw new PlatformError("SCOPE_MISMATCH", "课堂参与归属不一致", 409);
  const isTeacher = user.role === "teacher";
  if (isTeacher) {
    if (!await db.courseTeacher.findFirst({ where: { userId: user.id, offeringId } })) throw new PlatformError("FORBIDDEN", "无权访问该课堂", 403);
  } else if (participation.enrollment.userId !== user.id || !["active", "completed"].includes(participation.enrollment.status.toLowerCase())) {
    throw new PlatformError("FORBIDDEN", "无权访问其他学生的课堂", 403);
  }
  return { participation, user, isTeacher };
}

export function requireParticipationWrite(context: Awaited<ReturnType<typeof requireParticipation>>) {
  const { participation, isTeacher } = context;
  if (isTeacher) throw new PlatformError("FORBIDDEN", "只有学生本人可修改学习工作区", 403);
  if (participation.enrollment.status.toUpperCase() !== "ACTIVE" || participation.instance.status.toUpperCase() !== "TEACHING" || participation.instance.activity.chapter.offering.status.toUpperCase() !== "OPEN") {
    throw new PlatformError("CLASSROOM_READ_ONLY", "课堂已结束或尚未开始，当前仅可查看", 409);
  }
}
