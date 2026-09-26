import type { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { requireTeacherUser, type PlatformDb } from "./access";
import { PlatformError } from "./repository";

const FINAL_STATUSES = new Set(["SUBMITTED", "COMPLETED", "PUBLISHED", "READY"]);
const ACTIVE_ENROLLMENT_STATUSES = ["ACTIVE", "active", "COMPLETED", "completed"];

export type StudentRecordActivity = {
  id: string;
  chapterId: string;
  chapterTitle: string;
  chapterPosition: number;
  position: number;
  title: string;
  type: string;
  isOpen: boolean;
  archived: boolean;
};

export type StudentAttentionReason = "not_participated" | "incomplete_open_activity" | "pending_teacher_evaluation";

export type OfferingStudentSummary = {
  id: string;
  enrollmentId: string;
  username: string;
  displayName: string;
  status: string;
  joinedAt: string;
  participated: boolean;
  completedOpenActivities: number;
  openActivityCount: number;
  classroomParticipationCount: number;
  lastLearningAt: string | null;
  activityStatuses: Record<string, string>;
  attentionReasons: StudentAttentionReason[];
};

export type OfferingStudentsSummary = {
  offering: { id: string; name: string; term: string | null };
  activities: StudentRecordActivity[];
  students: OfferingStudentSummary[];
  totals: { members: number; participated: number; incomplete: number; pendingEvaluation: number };
  updatedAt: string;
};

function isActuallyOpen(
  offeringStatus: string,
  chapter: { isOpen: boolean; opensAt: Date | null; archivedAt: Date | null },
  activity: { isOpen: boolean; opensAt: Date | null; archivedAt: Date | null },
  at: Date,
) {
  return offeringStatus.toUpperCase() === "OPEN"
    && !chapter.archivedAt
    && chapter.isOpen
    && (!chapter.opensAt || chapter.opensAt <= at)
    && !activity.archivedAt
    && activity.isOpen
    && (!activity.opensAt || activity.opensAt <= at);
}

function iso(value: Date | null | undefined): string | null {
  return value?.toISOString() ?? null;
}

function latest(values: Array<Date | null | undefined>): string | null {
  const dates = values.filter((value): value is Date => value instanceof Date);
  return dates.length ? new Date(Math.max(...dates.map((value) => value.getTime()))).toISOString() : null;
}

function hasFinalClassroomOutput(participation: {
  submissions: Array<{ status: string; submittedAt: Date | null }>;
  artifacts: Array<{ versions: Array<{ status: string; submittedAt: Date | null }> }>;
}) {
  return participation.submissions.some((item) => FINAL_STATUSES.has(item.status.toUpperCase()) && item.submittedAt)
    || participation.artifacts.some((artifact) => artifact.versions.some((version) => FINAL_STATUSES.has(version.status.toUpperCase()) && version.submittedAt));
}

function hasClassroomLearningEvidence(participation: {
  firstEnteredAt: Date | null;
  lastEnteredAt: Date | null;
  submissions: Array<{ status: string; submittedAt: Date | null }>;
  artifacts: Array<{ versions: Array<{ status: string; submittedAt: Date | null }> }>;
  reflections: Array<unknown>;
}) {
  return Boolean(participation.firstEnteredAt || participation.lastEnteredAt || participation.reflections.length || hasFinalClassroomOutput(participation));
}

async function requireOfferingTeacher(claims: AuthClaims, offeringId: string, db: PlatformDb) {
  const teacher = await requireTeacherUser(claims, db);
  if (!await db.courseTeacher.findFirst({ where: { userId: teacher.id, offeringId }, select: { id: true } })) {
    throw new PlatformError("FORBIDDEN", "无权查看该教学班", 403);
  }
  return teacher;
}

export async function getOfferingStudentsSummary(
  claims: AuthClaims,
  offeringId: string,
  db: PlatformDb = prisma,
  at = new Date(),
): Promise<OfferingStudentsSummary> {
  await requireOfferingTeacher(claims, offeringId, db);
  const offering = await db.courseOffering.findUnique({
    where: { id: offeringId },
    select: {
      id: true, name: true, term: true, status: true,
      chapters: {
        orderBy: { position: "asc" },
        select: {
          id: true, title: true, position: true, isOpen: true, opensAt: true, archivedAt: true,
          activities: { orderBy: { position: "asc" }, select: { id: true, title: true, type: true, position: true, isOpen: true, opensAt: true, archivedAt: true } },
        },
      },
      enrollments: {
        where: { status: { in: ACTIVE_ENROLLMENT_STATUSES } },
        orderBy: { joinedAt: "asc" },
        select: {
          id: true, status: true, joinedAt: true,
          user: { select: { id: true, username: true, displayName: true } },
          activityProgress: { select: { activityId: true, status: true, startedAt: true, completedAt: true, lastAccessedAt: true } },
          submissions: { select: { submittedAt: true } },
          participations: {
            select: {
              id: true, firstEnteredAt: true, lastEnteredAt: true,
              instance: { select: { activityId: true } },
              submissions: { select: { status: true, submittedAt: true } },
              artifacts: { select: { versions: { select: { status: true, submittedAt: true } } } },
              reflections: { select: { createdAt: true } },
              evaluations: { select: { evaluatorType: true } },
            },
          },
        },
      },
    },
  });
  if (!offering) throw new PlatformError("NOT_FOUND", "教学班不存在", 404);

  const activities = offering.chapters.flatMap((chapter) => chapter.activities.map((activity) => ({
    id: activity.id,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    chapterPosition: chapter.position,
    position: activity.position,
    title: activity.title,
    type: activity.type,
    isOpen: isActuallyOpen(offering.status, chapter, activity, at),
    archived: Boolean(chapter.archivedAt || activity.archivedAt),
  })));
  const openActivityIds = new Set(activities.filter((activity) => activity.isOpen && activity.type.toUpperCase() !== "CLASSROOM").map((activity) => activity.id));

  const students = offering.enrollments.map((enrollment): OfferingStudentSummary => {
    const progressByActivity = new Map(enrollment.activityProgress.map((progress) => [progress.activityId, progress]));
    const activityStatuses = Object.fromEntries(activities.map((activity) => {
      const progress = progressByActivity.get(activity.id);
      const classroomEntered = activity.type.toUpperCase() === "CLASSROOM" && enrollment.participations.some((participation) =>
        participation.instance.activityId === activity.id && (participation.firstEnteredAt || participation.lastEnteredAt));
      return [activity.id, progress?.status.toLowerCase() === "not_started" && classroomEntered ? "in_progress" : progress?.status.toLowerCase() ?? (classroomEntered ? "in_progress" : "not_started")];
    }));
    const completedOpenActivities = enrollment.activityProgress.filter((progress) => openActivityIds.has(progress.activityId) && progress.status.toUpperCase() === "COMPLETED").length;
    const progressEvidence = enrollment.activityProgress.some((progress) => progress.status.toUpperCase() !== "NOT_STARTED" || progress.startedAt || progress.lastAccessedAt || progress.completedAt);
    const classroomEvidence = enrollment.participations.some(hasClassroomLearningEvidence);
    const submissionEvidence = enrollment.submissions.length > 0 || enrollment.participations.some(hasFinalClassroomOutput);
    const participated = progressEvidence || classroomEvidence || submissionEvidence;
    const pendingEvaluation = enrollment.participations.some((participation) => hasFinalClassroomOutput(participation)
      && !participation.evaluations.some((evaluation) => evaluation.evaluatorType.toUpperCase() === "TEACHER"));
    const incomplete = openActivityIds.size > 0 && completedOpenActivities < openActivityIds.size;
    const attentionReasons: StudentAttentionReason[] = [];
    if (!participated) attentionReasons.push("not_participated");
    if (incomplete) attentionReasons.push("incomplete_open_activity");
    if (pendingEvaluation) attentionReasons.push("pending_teacher_evaluation");
    return {
      id: enrollment.user.id,
      enrollmentId: enrollment.id,
      username: enrollment.user.username,
      displayName: enrollment.user.displayName,
      status: enrollment.status.toLowerCase(),
      joinedAt: enrollment.joinedAt.toISOString(),
      participated,
      completedOpenActivities,
      openActivityCount: openActivityIds.size,
      classroomParticipationCount: enrollment.participations.filter(hasClassroomLearningEvidence).length,
      lastLearningAt: latest([
        ...enrollment.activityProgress.flatMap((progress) => [progress.startedAt, progress.lastAccessedAt, progress.completedAt]),
        ...enrollment.submissions.map((submission) => submission.submittedAt),
        ...enrollment.participations.flatMap((participation) => [
          participation.firstEnteredAt,
          participation.lastEnteredAt,
          ...participation.submissions.map((submission) => submission.submittedAt),
          ...participation.artifacts.flatMap((artifact) => artifact.versions.map((version) => version.submittedAt)),
          ...participation.reflections.map((reflection) => reflection.createdAt),
        ]),
      ]),
      activityStatuses,
      attentionReasons,
    };
  });

  return {
    offering: { id: offering.id, name: offering.name, term: offering.term },
    activities,
    students,
    totals: {
      members: students.length,
      participated: students.filter((student) => student.participated).length,
      incomplete: students.filter((student) => student.attentionReasons.includes("incomplete_open_activity")).length,
      pendingEvaluation: students.filter((student) => student.attentionReasons.includes("pending_teacher_evaluation")).length,
    },
    updatedAt: at.toISOString(),
  };
}

export async function withdrawOfferingStudent(
  claims: AuthClaims,
  offeringId: string,
  enrollmentId: string,
  db: PlatformDb = prisma,
  at = new Date(),
) {
  await requireOfferingTeacher(claims, offeringId, db);
  const enrollment = await db.enrollment.findFirst({
    where: { id: enrollmentId, offeringId, status: { in: ACTIVE_ENROLLMENT_STATUSES } },
    select: { id: true, user: { select: { id: true, username: true, displayName: true } } },
  });
  if (!enrollment) throw new PlatformError("NOT_FOUND", "学生不属于该教学班或已被移出", 404);
  const updated = await db.enrollment.update({
    where: { id: enrollment.id },
    data: { status: "WITHDRAWN", withdrawnAt: at },
    select: { id: true, status: true, withdrawnAt: true },
  });
  return {
    enrollmentId: updated.id,
    status: updated.status.toLowerCase(),
    withdrawnAt: updated.withdrawnAt?.toISOString() ?? at.toISOString(),
    student: enrollment.user,
  };
}

export async function getOfferingStudentDetail(claims: AuthClaims, offeringId: string, enrollmentId: string, db: PlatformDb = prisma) {
  await requireOfferingTeacher(claims, offeringId, db);
  const enrollment = await db.enrollment.findFirst({
    where: { id: enrollmentId, offeringId },
    select: {
      id: true, status: true, joinedAt: true,
      user: { select: { id: true, username: true, displayName: true } },
      offering: {
        select: {
          id: true, name: true, status: true,
          chapters: { orderBy: { position: "asc" }, select: { id: true, title: true, position: true, isOpen: true, opensAt: true, archivedAt: true, activities: { orderBy: { position: "asc" }, select: { id: true, title: true, type: true, position: true, isOpen: true, opensAt: true, archivedAt: true, config: true } } } },
        },
      },
      activityProgress: { select: { activityId: true, status: true, startedAt: true, completedAt: true, lastAccessedAt: true } },
      participations: {
        orderBy: { firstEnteredAt: "desc" },
        select: {
          id: true, firstEnteredAt: true, lastEnteredAt: true, completedAt: true, stageProgress: true,
          instance: { select: { id: true, status: true, runNo: true, startedAt: true, endedAt: true, activity: { select: { id: true, title: true } } } },
          submissions: { orderBy: { submittedAt: "desc" }, select: { id: true, stageKey: true, status: true, payload: true, submittedAt: true } },
          artifacts: { orderBy: { createdAt: "desc" }, select: { id: true, title: true, type: true, status: true, versions: { orderBy: { sequence: "desc" }, select: { id: true, sequence: true, status: true, sourceHtml: true, mimeType: true, submittedAt: true, createdAt: true } } } },
          reflections: { orderBy: { createdAt: "desc" }, select: { id: true, content: true, createdAt: true } },
          evaluations: { orderBy: { createdAt: "desc" }, select: { id: true, evaluatorType: true, type: true, score: true, content: true, createdAt: true } },
        },
      },
    },
  });
  if (!enrollment) throw new PlatformError("NOT_FOUND", "学生不属于该教学班", 404);
  const at = new Date();
  const progressByActivity = new Map(enrollment.activityProgress.map((progress) => [progress.activityId, progress]));
  const classroomByActivity = new Map<string, typeof enrollment.participations>();
  for (const participation of enrollment.participations) {
    const list = classroomByActivity.get(participation.instance.activity.id) ?? [];
    list.push(participation);
    classroomByActivity.set(participation.instance.activity.id, list);
  }
  const activities = enrollment.offering.chapters.flatMap((chapter) => chapter.activities.map((activity) => {
    const progress = progressByActivity.get(activity.id);
    const classroomParticipations = classroomByActivity.get(activity.id) ?? [];
    const classroomEntered = classroomParticipations.some((item) => item.firstEnteredAt || item.lastEnteredAt);
    let status = progress?.status.toLowerCase() ?? "not_started";
    if (status === "not_started" && classroomEntered) status = "in_progress";
    return {
      id: activity.id, chapterId: chapter.id, chapterTitle: chapter.title, chapterPosition: chapter.position,
      position: activity.position, title: activity.title, type: activity.type,
      isOpen: isActuallyOpen(enrollment.offering.status, chapter, activity, at),
      archived: Boolean(chapter.archivedAt || activity.archivedAt), config: activity.config,
      progress: { status, startedAt: iso(progress?.startedAt), completedAt: iso(progress?.completedAt), lastAccessedAt: iso(progress?.lastAccessedAt) },
    };
  }));
  return {
    student: { id: enrollment.user.id, enrollmentId: enrollment.id, username: enrollment.user.username, displayName: enrollment.user.displayName, status: enrollment.status.toLowerCase(), joinedAt: enrollment.joinedAt.toISOString() },
    activities,
    classrooms: enrollment.participations.filter(hasClassroomLearningEvidence).map((participation) => ({
      id: participation.id,
      instance: { ...participation.instance, status: participation.instance.status.toLowerCase(), startedAt: iso(participation.instance.startedAt), endedAt: iso(participation.instance.endedAt) },
      firstEnteredAt: iso(participation.firstEnteredAt), lastEnteredAt: iso(participation.lastEnteredAt), completedAt: iso(participation.completedAt), stageProgress: participation.stageProgress,
      submissions: participation.submissions.filter((item) => FINAL_STATUSES.has(item.status.toUpperCase())).map((item) => ({ ...item, status: item.status.toLowerCase(), submittedAt: iso(item.submittedAt) })),
      artifacts: participation.artifacts.map((artifact) => ({ ...artifact, status: artifact.status.toLowerCase(), versions: artifact.versions.filter((version) => FINAL_STATUSES.has(version.status.toUpperCase())).map((version) => ({ ...version, status: version.status.toLowerCase(), submittedAt: iso(version.submittedAt), createdAt: version.createdAt.toISOString() })) })).filter((artifact) => artifact.versions.length),
      reflections: participation.reflections.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
      evaluations: participation.evaluations.map((item) => ({ ...item, score: item.score?.toString() ?? null, createdAt: item.createdAt.toISOString() })),
      pendingTeacherEvaluation: hasFinalClassroomOutput(participation) && !participation.evaluations.some((item) => item.evaluatorType.toUpperCase() === "TEACHER"),
    })),
    updatedAt: at.toISOString(),
  };
}

export async function getStudentActivitySubmissions(
  claims: AuthClaims,
  offeringId: string,
  enrollmentId: string,
  activityId: string,
  page: number,
  db: PlatformDb = prisma,
) {
  await requireOfferingTeacher(claims, offeringId, db);
  const enrollment = await db.enrollment.findFirst({ where: { id: enrollmentId, offeringId }, select: { id: true } });
  if (!enrollment) throw new PlatformError("NOT_FOUND", "学生不属于该教学班", 404);
  const activity = await db.activity.findFirst({ where: { id: activityId, chapter: { offeringId } }, select: { id: true, title: true, type: true, config: true, version: true } });
  if (!activity) throw new PlatformError("NOT_FOUND", "学习活动不存在", 404);
  const where = { enrollmentId, activityId };
  const [total, records, progress] = await Promise.all([
    db.activitySubmission.count({ where }),
    db.activitySubmission.findMany({ where, orderBy: [{ submittedAt: "desc" }, { id: "desc" }], skip: (page - 1) * 20, take: 20, select: { id: true, activityVersion: true, activitySnapshot: true, payload: true, submittedAt: true } }),
    page === 1 ? db.activityProgress.findUnique({ where: { enrollmentId_activityId: { enrollmentId, activityId } }, select: { progressData: true, completedAt: true } }) : Promise.resolve(null),
  ]);
  const legacy = total === 0 && progress?.progressData ? [{
    id: `legacy:${enrollmentId}:${activityId}`, activityVersion: activity.version,
    activitySnapshot: { type: activity.type, title: activity.title, config: activity.config, version: activity.version },
    payload: progress.progressData as Prisma.JsonValue, submittedAt: progress.completedAt ?? new Date(0), snapshotSource: "legacy" as const,
  }] : [];
  return {
    activity: { id: activity.id, title: activity.title, type: activity.type, config: activity.config },
    submissions: [...records.map((record) => ({ ...record, submittedAt: record.submittedAt.toISOString(), snapshotSource: "submission" as const })), ...legacy.map((record) => ({ ...record, submittedAt: record.submittedAt.toISOString() }))],
    pagination: { page, pageSize: 20, total: total || legacy.length, hasMore: page * 20 < total },
  };
}
