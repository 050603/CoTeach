import { randomInt, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { requireStudentUser, requireTeacherUser } from "./access";
import { ExperimentConfigSchema, ExperimentPhaseSchema, composeExperimentForms, experimentConfigFromActivity, gradeExperimentAnswers, type ExperimentVariant } from "./experiment";
import { PlatformError } from "./repository";

const ENROLLED = ["ACTIVE", "active", "COMPLETED", "completed"];

/** Assign on first student access. Parent locks serialize this with teacher edits. */
export async function ensureExperimentAssignment(instanceId: string, enrollmentId: string) {
  return runMutationTransaction(async (tx) => {
    const ref = await tx.classroomInstance.findUnique({ where: { id: instanceId }, select: { activityId: true, activity: { select: { chapterId: true } } } });
    if (!ref) return null;
    await tx.$queryRaw`SELECT "id" FROM "Chapter" WHERE "id" = ${ref.activity.chapterId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${ref.activityId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "ClassroomInstance" WHERE "id" = ${instanceId} FOR UPDATE`;
    const instance = await tx.classroomInstance.findUnique({ where: { id: instanceId }, include: { activity: { include: { chapter: { include: { offering: true } } } } } });
    const now = new Date();
    if (!instance || !["scheduled", "teaching"].includes(instance.status.toLowerCase()) || instance.activity.archivedAt || instance.activity.chapter.archivedAt || !instance.activity.isOpen || !instance.activity.chapter.isOpen || instance.activity.opensAt && instance.activity.opensAt > now || instance.activity.chapter.opensAt && instance.activity.chapter.opensAt > now || instance.activity.chapter.offering.status.toLowerCase() !== "open") return null;
    const enrollment = await tx.enrollment.findUnique({ where: { id: enrollmentId }, select: { offeringId: true, status: true } });
    if (!enrollment || enrollment.offeringId !== instance.activity.chapter.offeringId || !ENROLLED.includes(enrollment.status)) return null;
    const experiment = experimentConfigFromActivity(instance.activity.config);
    if (!experiment) return null;
    const existing = await tx.experimentAssessmentAssignment.findUnique({ where: { instanceId_enrollmentId: { instanceId, enrollmentId } } });
    if (existing) return existing;
    let variant: ExperimentVariant = "none";
    if (experiment.scenarioPair) {
      const [aCount, bCount] = await Promise.all([
        tx.experimentAssessmentAssignment.count({ where: { instanceId, variant: "A_PRE_B_POST" } }),
        tx.experimentAssessmentAssignment.count({ where: { instanceId, variant: "B_PRE_A_POST" } }),
      ]);
      variant = aCount < bCount ? "A_PRE_B_POST" : bCount < aCount ? "B_PRE_A_POST" : randomInt(2) === 0 ? "A_PRE_B_POST" : "B_PRE_A_POST";
    }
    const forms = composeExperimentForms(experiment, variant, randomInt);
    return tx.experimentAssessmentAssignment.create({ data: {
      id: randomUUID(), instanceId, enrollmentId, variant,
      pretestForm: forms.pretest as Prisma.InputJsonValue,
      posttestForm: forms.posttest as Prisma.InputJsonValue,
    } });
  });
}

export async function submitExperimentAssessment(
  claims: AuthClaims,
  instanceId: string,
  input: { phase: unknown; answers: unknown },
) {
  const phase = ExperimentPhaseSchema.safeParse(input.phase);
  if (!phase.success) throw new PlatformError("INVALID_INPUT", "请选择前测或后测", 400);
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ClassroomInstance" WHERE "id" = ${instanceId} FOR UPDATE`;
    const student = await requireStudentUser(claims, tx);
    const instance = await tx.classroomInstance.findUnique({
      where: { id: instanceId },
      include: { activity: { include: { chapter: { include: { offering: true } } } } },
    });
    if (!instance) throw new PlatformError("NOT_FOUND", "课堂不存在", 404);
    const offering = instance.activity.chapter.offering;
    const enrollment = await tx.enrollment.findUnique({ where: { userId_offeringId: { userId: student.id, offeringId: offering.id } } });
    if (!enrollment || !ENROLLED.includes(enrollment.status)) throw new PlatformError("ENROLLMENT_REQUIRED", "请先加入教学班", 403);
    if (instance.activity.archivedAt || instance.activity.chapter.archivedAt) throw new PlatformError("ACTIVITY_LOCKED", "课堂已归档", 403);
    const status = instance.status.toLowerCase();
    if (phase.data === "pretest") {
      const now = new Date();
      if (!["scheduled", "teaching"].includes(status) || offering.status.toLowerCase() !== "open" || !instance.activity.isOpen || !instance.activity.chapter.isOpen || instance.activity.opensAt && instance.activity.opensAt > now || instance.activity.chapter.opensAt && instance.activity.chapter.opensAt > now) {
        throw new PlatformError("PRETEST_UNAVAILABLE", "当前无法提交课前测", 409);
      }
    } else if (status !== "finished") {
      throw new PlatformError("POSTTEST_UNAVAILABLE", "课堂结束后才可提交课后测", 409);
    }
    const assignment = await tx.experimentAssessmentAssignment.findUnique({ where: { instanceId_enrollmentId: { instanceId, enrollmentId: enrollment.id } } });
    if (!assignment) throw new PlatformError("ASSESSMENT_ASSIGNMENT_REQUIRED", "请重新打开课堂活动，获取本人的测验题目", 409);
    const experiment = ExperimentConfigSchema.safeParse({ enabled: true, pretest: assignment.pretestForm, posttest: assignment.posttestForm });
    if (!experiment.success) throw new PlatformError("INVALID_ASSESSMENT_ASSIGNMENT", "测验题目配置有误，请联系教师", 409);
    const questionnaire = { enabled: true, pretest: experiment.data.pretest, posttest: experiment.data.posttest };
    if (phase.data === "posttest") {
      const [pretest, participation] = await Promise.all([
        tx.experimentAssessmentSubmission.findUnique({ where: { instanceId_enrollmentId_phase: { instanceId, enrollmentId: enrollment.id, phase: "pretest" } }, select: { id: true } }),
        tx.classroomParticipation.findUnique({ where: { instanceId_enrollmentId: { instanceId, enrollmentId: enrollment.id } }, select: { id: true } }),
      ]);
      if (!pretest || !participation) throw new PlatformError("CLASSROOM_PARTICIPATION_REQUIRED", "请先完成前测并参与本场课堂", 409);
    }
    const graded = gradeExperimentAnswers(experiment.data[phase.data], input.answers);
    if (!graded) throw new PlatformError("INVALID_ANSWERS", "请完成所有题目并检查选项后提交", 400);
    const existing = await tx.experimentAssessmentSubmission.findUnique({ where: { instanceId_enrollmentId_phase: { instanceId, enrollmentId: enrollment.id, phase: phase.data } } });
    if (existing) {
      if (JSON.stringify(existing.answers) === JSON.stringify(graded.answers)) return existing;
      throw new PlatformError("ASSESSMENT_SUBMITTED", "本场测验已提交，不能重复作答", 409);
    }
    return tx.experimentAssessmentSubmission.create({ data: {
      id: randomUUID(), instanceId, enrollmentId: enrollment.id, assignmentId: assignment.id, phase: phase.data,
      researchKey: enrollment.researchKey,
      questionnaire: questionnaire as Prisma.InputJsonValue,
      answers: graded.answers as Prisma.InputJsonValue,
      objectiveScore: graded.objectiveScore,
      objectiveTotal: graded.objectiveTotal,
    } });
  });
}

export async function getClassroomExperimentResults(claims: AuthClaims, instanceId: string) {
  const teacher = await requireTeacherUser(claims);
  const instance = await prisma.classroomInstance.findUnique({ where: { id: instanceId }, include: { activity: { include: { chapter: true } } } });
  if (!instance) throw new PlatformError("NOT_FOUND", "课堂不存在", 404);
  const offeringId = instance.activity.chapter.offeringId;
  if (!await prisma.courseTeacher.findFirst({ where: { offeringId, userId: teacher.id }, select: { id: true } })) throw new PlatformError("FORBIDDEN", "无权查看该课堂", 403);
  const [submissions, assignments, enrollmentCount] = await Promise.all([
    prisma.experimentAssessmentSubmission.findMany({
      where: { instanceId, enrollment: { offeringId } }, orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      include: { enrollment: { select: { user: { select: { displayName: true, username: true } } } }, assignment: { select: { variant: true } } },
    }),
    prisma.experimentAssessmentAssignment.findMany({ where: { instanceId }, select: { variant: true } }),
    prisma.enrollment.count({ where: { offeringId, status: { in: ENROLLED } } }),
  ]);
  const snapshot = submissions[0] ? ExperimentConfigSchema.safeParse(submissions[0].questionnaire) : null;
  const experiment = snapshot?.success ? snapshot.data : assignments.length ? { enabled: true } : instance.status.toLowerCase() === "finished" ? null : experimentConfigFromActivity(instance.activity.config);
  return {
    instanceId,
    activityId: instance.activityId,
    runNo: instance.runNo,
    status: instance.status.toLowerCase(),
    enabled: Boolean(experiment),
    enrollmentCount,
    pretestCount: submissions.filter((row) => row.phase === "pretest").length,
    posttestCount: submissions.filter((row) => row.phase === "posttest").length,
    variantCounts: {
      aPreBPost: assignments.filter((row) => row.variant === "A_PRE_B_POST").length,
      bPreAPost: assignments.filter((row) => row.variant === "B_PRE_A_POST").length,
    },
    submissions: submissions.map((row) => ({
      id: row.id, phase: row.phase,
      variant: row.assignment.variant,
      student: row.enrollment.user, submittedAt: row.submittedAt,
      questionnaire: row.questionnaire, answers: row.answers,
      objectiveScore: row.objectiveScore, objectiveTotal: row.objectiveTotal,
    })),
  };
}
