// V2 persistence boundary. Course is an application projection of template/instance entities.
import { Prisma } from "@prisma/client";
import { prisma } from "./client";
import { runMutationTransaction } from "./transaction-retry";
import { loadInstanceCourse, persistInstanceCourse, json } from "./v2-course-projection";
import { loadPblTemplateCourse, savePblTemplateCourse } from "@/lib/platform/pbl-template-repository";
import { applySessionAction, initialSessionState, type SessionAction, type SessionState } from "@/lib/session/actions";
import type { Course } from "@/lib/session/types";
import { actionCourseId } from "@/lib/courses/contracts";

export class CourseNotFoundError extends Error { constructor(public readonly courseId: string) { super(`Course not found: ${courseId}`); this.name = "CourseNotFoundError"; } }
export class CourseVersionConflictError extends Error { constructor(public readonly courseId: string, public readonly expectedVersion: number) { super(`Course version conflict: ${courseId}`); this.name = "CourseVersionConflictError"; } }
export async function retryCourseVersionConflict<T>(operation: () => Promise<T>, attempts = 5, delayMs = 10): Promise<T> {
  for (let attempt = 1; ; attempt++) { try { return await operation(); } catch (error) { if (!(error instanceof CourseVersionConflictError) || attempt >= attempts) throw error; if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs)); } }
}
export async function loadCourse(courseId: string, db: Prisma.TransactionClient = prisma): Promise<Course | undefined> { return await loadInstanceCourse(courseId, db) ?? await loadPblTemplateCourse(courseId, db) ?? undefined; }
export function stateFor(courses: Course[]): SessionState { return { ...initialSessionState(), courses, hydrated: true, updatedAt: new Date().toISOString() }; }
export async function loadSessionState(ownerId?: string): Promise<SessionState> {
  const [templates, instances] = await Promise.all([
    prisma.classroomTemplate.findMany({ where: { ...(ownerId ? { ownerId } : {}), status: { not: "ARCHIVED" } }, select: { id: true } }),
    prisma.classroomInstance.findMany({ where: ownerId ? { activity: { chapter: { offering: { teachers: { some: { userId: ownerId } } } } } } : {}, select: { id: true } }),
  ]);
  const courses = await Promise.all([...templates, ...instances].map(t => loadCourse(t.id)));
  return stateFor(courses.filter((c): c is Course => Boolean(c)));
}
export async function loadCourseByInviteCode(inviteCode: string): Promise<Course | undefined> {
  const invitation = await prisma.courseInvitation.findUnique({ where: { code: inviteCode } });
  if (!invitation || invitation.status !== "ACTIVE") return undefined;
  const instance = await prisma.classroomInstance.findFirst({ where: { activity: { chapter: { offeringId: invitation.offeringId } }, status: "TEACHING" }, orderBy: { startedAt: "desc" } });
  return instance ? loadCourse(instance.id) : undefined;
}
export async function lockProjectedCourse(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`v2-course:${id}`}, 0))::text`;
}
export async function saveCourse(course: Course): Promise<Course> {
  return runMutationTransaction(async tx => { await lockProjectedCourse(tx, course.id); const before = await loadCourse(course.id, tx); if (!before) throw new CourseNotFoundError(course.id); if (course.version !== undefined && before.version !== course.version) throw new CourseVersionConflictError(course.id, course.version); const instance = await tx.classroomInstance.findUnique({ where: { id: course.id }, select: { id: true } }); if (instance) await persistInstanceCourse(tx, before, course); else return savePblTemplateCourse(course, undefined, tx); return (await loadCourse(course.id, tx))!; });
}
export async function mutateProjectedCourse(tx: Prisma.TransactionClient, action: SessionAction, ownerId?: string, actor?: { id: string; role: string }): Promise<Course | undefined> {
  const id = actionCourseId(action); if (!id) return undefined;
  await lockProjectedCourse(tx, id);
  if (action.type === "CREATE_COURSE") return savePblTemplateCourse(action.payload, ownerId, tx);
  const before = await loadCourse(id, tx); if (!before) throw new CourseNotFoundError(id);
  const instance = await tx.classroomInstance.findUnique({ where: { id }, select: { id: true } });
  if (action.type === "DELETE_COURSE") {
    if (instance) throw new Error("归档课堂请结束当前场次，不可删除研究记录");
    await tx.classroomTemplate.update({ where: { id }, data: { status: "ARCHIVED" } }); return undefined;
  }
  if (!instance && ["START_TEACHING", "RESTART_TEACHING"].includes(action.type)) throw new Error("请先将模板绑定到教学班活动，再从课堂场次开始授课");
  if (instance && action.type === "RESTART_TEACHING") throw new Error("请创建新的课堂场次，原场次历史将保留");
  const after = applySessionAction(stateFor([before]), action).courses.find(c => c.id === id)!;
  if (instance) await persistInstanceCourse(tx, before, after, actor); else await savePblTemplateCourse(after, ownerId, tx);
  return (await loadCourse(id, tx))!;
}
export async function dispatchAction(action: SessionAction): Promise<SessionState> {
  const course = await runMutationTransaction(tx => mutateProjectedCourse(tx, action));
  return stateFor(course ? [course] : []);
}
export async function updateCourse(id: string, updater: (course: Course) => Course, actor?: { id: string; role: string }): Promise<SessionState> {
  return runMutationTransaction(async tx => { await lockProjectedCourse(tx, id); const before = await loadCourse(id, tx); if (!before) throw new CourseNotFoundError(id); const after = updater(before); if (after.id !== id) throw new Error("COURSE_SCOPE_MISMATCH"); const instance = await tx.classroomInstance.findUnique({ where: { id }, select: { id: true } }); if (instance) await persistInstanceCourse(tx, before, after, actor); else await savePblTemplateCourse(after, actor?.role === "teacher" ? actor.id : undefined, tx); return stateFor([(await loadCourse(id, tx))!]); });
}
export async function deleteCourse(courseId: string) { await dispatchAction({ type: "DELETE_COURSE", payload: { id: courseId } }); }
export async function archiveAndClearCourseSession(courseId: string) {
  // V2 archives the run, not its evidence. A fresh run is a new ClassroomInstance.
  await prisma.classroomInstance.update({ where: { id: courseId }, data: { status: "FINISHED", endedAt: new Date() } });
  return getCourseSession(courseId);
}
export async function listCourseSessions(courseId: string) {
  const instance = await prisma.classroomInstance.findUnique({ where: { id: courseId } });
  if (!instance) return [];
  const runs = await prisma.classroomInstance.findMany({ where: { activityId: instance.activityId, status: "FINISHED" }, orderBy: { runNo: "desc" }, include: { participations: { select: { _count: { select: { submissions: true } } } } } });
  return runs.map(run => ({ id: run.id, courseId, inviteCode: "", startedAt: run.startedAt?.toISOString() ?? run.createdAt.toISOString(), endedAt: run.endedAt?.toISOString() ?? run.updatedAt.toISOString(), studentCount: run.participations.length, submissionCount: run.participations.reduce((sum, participation) => sum + participation._count.submissions, 0), createdAt: run.createdAt.toISOString() }));
}
export async function getCourseSession(sessionId: string, anchorId = sessionId) {
  if (anchorId !== sessionId) {
    const [anchor, target] = await Promise.all([prisma.classroomInstance.findUnique({ where: { id: anchorId } }), prisma.classroomInstance.findUnique({ where: { id: sessionId } })]);
    if (!anchor || !target || anchor.activityId !== target.activityId || target.status !== "FINISHED") return null;
  }
  const course = await loadInstanceCourse(sessionId); if (!course) return null;
  const instance = await prisma.classroomInstance.findUniqueOrThrow({ where: { id: sessionId } });
  return { id: sessionId, courseId: anchorId, inviteCode: course.inviteCode ?? "", startedAt: instance.startedAt?.toISOString() ?? course.createdAt, endedAt: instance.endedAt?.toISOString() ?? course.updatedAt, studentCount: course.students.length, submissionCount: course.submissions?.length ?? 0, createdAt: course.createdAt, archivedData: json(course) };
}
