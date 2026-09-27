import type { Prisma } from "@prisma/client";
import { isDatabaseConfigured, prisma } from "@/lib/db/client";
import { readStudentCourseCommon } from "@/lib/db/student-read-coalescing";
import { createPblTemplateCourse, decodePblTemplate } from "@/lib/platform/pbl-template";
import { loadPblTemplateCourse } from "@/lib/platform/pbl-template-repository";
import { projectGroupViewId } from "@/lib/platform/group-identity";
import { getCourse } from "@/lib/session/server-store";
import type { Course, StudentAiProgress, TeacherAgentDirective } from "@/lib/session/types";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Preserve the full projection's last-value/first-position Map semantics.
 * Target/stage filtering and trailing windows belong to the prompt builders. */
function collection<T extends { id: string }>(rows: Array<{ metadata: unknown }>, name: string): T[] {
  return Array.from(new Map(rows.filter(row => object(row.metadata).collection === name).map(row => {
    const value = object(row.metadata).view as T;
    return [value.id, value];
  })).values());
}

/** Read-only prompt projection. Call only AFTER authenticating the student.
 * Never use this incomplete Course as a reducer or persistence snapshot. The
 * route still reads live conversation/task/memory records independently. */
export async function loadDocumentCourseContext(
  courseId: string,
  studentId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<Course | undefined> {
  // Retain in-flight sharing for identical classroom-visible reads. This does
  // not share authentication, private workspace data, or a settled snapshot.
  const common = <T>(operation: string, parameters: unknown, query: () => PromiseLike<T>) =>
    readStudentCourseCommon(db, studentId, courseId, `document-context:${operation}`, parameters, query);
  const instance = await common("instance", { courseId }, () => db.classroomInstance.findUnique({ where: { id: courseId }, select: {
    id: true, status: true, runtimeConfig: true, createdAt: true, updatedAt: true,
    templateVersion: { select: { snapshot: true } },
    activity: { select: { title: true, chapter: { select: { offeringId: true } } } },
    participations: { select: { id: true, firstEnteredAt: true, lastEnteredAt: true, stageProgress: true,
      enrollment: { select: { userId: true, joinedAt: true, user: { select: { displayName: true } } } },
    } },
  } }));
  if (!instance) return undefined;
  const offeringId = instance.activity.chapter.offeringId;
  const participationIds = instance.participations.map(participation => participation.id);
  const ownParticipationIds = instance.participations.filter(participation => participation.enrollment.userId === studentId).map(participation => participation.id);
  const [groups, evaluations, directives, evidence, workspaces] = await Promise.all([
    common("groups", { offeringId }, () => db.projectGroup.findMany({ where: { offeringId }, include: {
      members: { where: { leftAt: null }, include: { user: { select: { displayName: true } } } },
      board: { select: { snapshot: true } },
    } })),
    common("feedback", { participationIds }, () => db.evaluation.findMany({ where: { participationId: { in: participationIds } }, select: { metadata: true } })),
    common("directives", { offeringId, participationIds }, () => db.teacherAgentDirective.findMany({ where: { offeringId, OR: [
      { participationId: { in: participationIds } }, { payload: { path: ["instanceId"], equals: courseId } },
    ] }, select: { payload: true } })),
    // Every learningEvidence collection row is classroom-visible in the full
    // student projection. Do not filter view.studentId/stage before deduping.
    common("evidence", { participationIds }, () => db.classroomSubmission.findMany({ where: { participationId: { in: participationIds },
      payload: { path: ["collection"], equals: "learningEvidence" },
    }, select: { payload: true } })),
    db.studentProjectWorkspace.findMany({ where: { participationId: { in: ownParticipationIds } }, select: { participationId: true, projectState: true } }),
  ]);
  const runtime = object(instance.runtimeConfig);
  const base = createPblTemplateCourse(courseId,
    decodePblTemplate(instance.templateVersion.snapshot) ?? { name: instance.activity.title },
    { createdAt: instance.createdAt.toISOString(), updatedAt: instance.updatedAt.toISOString() });
  return {
    ...base,
    name: instance.activity.title,
    version: Number(runtime.version ?? 1),
    status: instance.status.toUpperCase() === "TEACHING" ? "teaching" : instance.status.toUpperCase() === "FINISHED" ? "finished" : "ready",
    currentStageIndex: Number(runtime.currentStageIndex ?? 0),
    pblConfig: {
      ...base.pblConfig,
      ...(runtime.makeArtifactMode ? { makeArtifactMode: runtime.makeArtifactMode } : {}),
      ...(typeof runtime.practiceWebSearchEnabled === "boolean" ? { practiceWebSearchEnabled: runtime.practiceWebSearchEnabled } : {}),
    } as Course["pblConfig"],
    students: instance.participations.map(participation => ({
      id: participation.enrollment.userId, name: participation.enrollment.user.displayName,
      joinedAt: (participation.firstEnteredAt ?? participation.enrollment.joinedAt).toISOString(),
      stageProgress: object(participation.stageProgress).progress as Record<string, number> ?? {},
      lastSeenAt: participation.lastEnteredAt?.toISOString(),
    })),
    groups: groups.map(group => ({
      ...object(object(group.board?.snapshot).proposal), id: projectGroupViewId(offeringId, group.id), name: group.name,
      topic: String(object(object(group.board?.snapshot).proposal).topic ?? ""),
      keywords: object(object(group.board?.snapshot).proposal).keywords as string[] ?? [],
      selectedForms: object(object(group.board?.snapshot).proposal).selectedForms as string[] ?? [],
      members: group.members.map(member => ({ studentId: member.userId, name: member.user.displayName, role: member.role })),
      createdAt: group.createdAt.toISOString(), updatedAt: group.updatedAt.toISOString(),
    })),
    feedback: collection<NonNullable<Course["feedback"]>[number]>(evaluations, "feedback"),
    learningEvidence: collection<NonNullable<Course["learningEvidence"]>[number]>(evidence.map(row => ({ metadata: row.payload })), "learningEvidence"),
    teacherAgentDirectives: directives.map(row => object(row.payload).view as TeacherAgentDirective).filter(Boolean),
    aiLearningProgress: Object.fromEntries(workspaces.flatMap(workspace => {
      const userId = instance.participations.find(participation => participation.id === workspace.participationId)?.enrollment.userId;
      const progress = object(workspace.projectState).aiLearningProgress as StudentAiProgress | undefined;
      return userId && progress ? [[userId, progress]] : [];
    })),
  };
}

export async function getDocumentCourseContext(courseId: string, studentId: string): Promise<Course | undefined> {
  if (!isDatabaseConfigured()) return getCourse(courseId, { studentId });
  // Keep getCourse's namespace fallback; authentication remains the route's
  // responsibility and still rejects a missing classroom before this read.
  return await loadDocumentCourseContext(courseId, studentId) ?? await loadPblTemplateCourse(courseId) ?? undefined;
}
