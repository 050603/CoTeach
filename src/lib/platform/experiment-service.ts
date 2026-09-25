import { randomInt, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import { requireStudentUser, requireTeacherUser } from "./access";
import { ExperimentConfigSchema, ExperimentPhaseSchema, ExperimentQuestionSchema, composeExperimentForms, experimentConfigFromActivity, gradeExperimentAnswers, isPosttestOpen, normalizeExperimentDraftAnswers, posttestOpenedAt, publicExperimentQuestions, type ExperimentVariant } from "./experiment";
import { PlatformError } from "./repository";

const ENROLLED = ["ACTIVE", "active", "COMPLETED", "completed"];
const assignedFormSchema = z.array(ExperimentQuestionSchema).max(61);

function isPretestAvailable(instance: {
  status: string;
  activity: { archivedAt: Date | null; isOpen: boolean; opensAt: Date | null; chapter: { archivedAt: Date | null; isOpen: boolean; opensAt: Date | null; offering: { status: string } } };
}) {
  const now = new Date();
  return ["scheduled", "teaching"].includes(instance.status.toLowerCase())
    && !instance.activity.archivedAt && !instance.activity.chapter.archivedAt
    && instance.activity.isOpen && instance.activity.chapter.isOpen
    && (!instance.activity.opensAt || instance.activity.opensAt <= now)
    && (!instance.activity.chapter.opensAt || instance.activity.chapter.opensAt <= now)
    && instance.activity.chapter.offering.status.toLowerCase() === "open";
}

function assignedQuestions(assignment: { pretestForm: unknown; posttestForm: unknown }, phase: "pretest" | "posttest") {
  const parsed = assignedFormSchema.safeParse(phase === "pretest" ? assignment.pretestForm : assignment.posttestForm);
  if (!parsed.success) throw new PlatformError("INVALID_ASSESSMENT_ASSIGNMENT", "测验题目配置有误，请联系教师", 409);
  return parsed.data;
}

function draftView(draft: { answers: unknown; currentPage: number; version: number; updatedAt: Date } | null) {
  return draft ? { answers: draft.answers, currentPage: draft.currentPage, version: draft.version, updatedAt: draft.updatedAt } : null;
}

async function notifyExperimentChanged(instanceId: string, studentId: string) {
  if (!studentId) return;
  try {
    await publishCourseEvent(instanceId, { type: "submission-updated", courseId: instanceId, at: new Date().toISOString(), payload: { scope: "student", studentId } });
  } catch (error) {
    console.error("[experiment] realtime notification failed", error);
  }
}

export async function getStudentExperimentAssessment(claims: AuthClaims, instanceId: string, phase: "pretest" | "posttest") {
  const student = await requireStudentUser(claims);
  const instance = await prisma.classroomInstance.findUnique({ where: { id: instanceId }, include: { activity: { include: { chapter: { include: { offering: true } } } } } });
  if (!instance) throw new PlatformError("NOT_FOUND", "课堂不存在", 404);
  const enrollment = await prisma.enrollment.findUnique({ where: { userId_offeringId: { userId: student.id, offeringId: instance.activity.chapter.offeringId } } });
  if (!enrollment || !ENROLLED.includes(enrollment.status)) throw new PlatformError("ENROLLMENT_REQUIRED", "请先加入教学班", 403);
  const assignment = await prisma.experimentAssessmentAssignment.findUnique({ where: { instanceId_enrollmentId: { instanceId, enrollmentId: enrollment.id } } });
  const enabled = Boolean(assignment || experimentConfigFromActivity(instance.activity.config));
  const available = phase === "posttest"
    ? isPosttestOpen(instance.status, instance.runtimeConfig)
    : isPretestAvailable(instance);
  const [draft, submission, pretest, participation] = await Promise.all([
    assignment ? prisma.experimentAssessmentDraft.findUnique({ where: { assignmentId_phase: { assignmentId: assignment.id, phase } } }) : null,
    prisma.experimentAssessmentSubmission.findUnique({ where: { instanceId_enrollmentId_phase: { instanceId, enrollmentId: enrollment.id, phase } } }),
    phase === "posttest" ? prisma.experimentAssessmentSubmission.findUnique({ where: { instanceId_enrollmentId_phase: { instanceId, enrollmentId: enrollment.id, phase: "pretest" } }, select: { id: true } }) : null,
    phase === "posttest" ? prisma.classroomParticipation.findUnique({ where: { instanceId_enrollmentId: { instanceId, enrollmentId: enrollment.id } }, select: { id: true } }) : null,
  ]);
  const canAnswer = enabled && available && Boolean(assignment) && (phase !== "posttest" || Boolean(pretest && participation));
  const questions = (canAnswer || submission) && assignment ? publicExperimentQuestions(assignedQuestions(assignment, phase)) : [];
  const config = experimentConfigFromActivity(instance.activity.config);
  return {
    enabled, available: canAnswer, questions, variant: assignment?.variant ?? "none",
    introduction: phase === "pretest" ? config?.pretestIntroduction : config?.posttestIntroduction,
    minutes: phase === "pretest" ? config?.pretestMinutes : config?.posttestMinutes,
    skipReasonPrompt: config?.skipReasonPrompt,
    blockedReason: !enabled ? "本课堂未开启后测" : !available ? phase === "posttest" && instance.status.toLowerCase() === "finished" ? "本场课堂结束前未开放后测" : "教师进入第 5 阶段后开放后测" : !assignment ? "请先打开课堂活动，获取本人的测验题目" : phase === "posttest" && (!pretest || !participation) ? "请先完成前测并参与本场课堂" : null,
    draft: canAnswer ? draftView(draft) : null,
    submission: submission ? { id: submission.id, answers: submission.answers, submittedAt: submission.submittedAt } : null,
    studentKey: enrollment.id,
  };
}

export async function saveExperimentAssessmentDraft(claims: AuthClaims, instanceId: string, input: { phase: "pretest" | "posttest"; answers: unknown; currentPage: number; version: number }) {
  if (!Number.isInteger(input.currentPage) || input.currentPage < 0 || input.currentPage > 100 || !Number.isInteger(input.version) || input.version < 0) throw new PlatformError("INVALID_INPUT", "草稿页码或版本无效", 400);
  const result = await runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ClassroomInstance" WHERE "id" = ${instanceId} FOR UPDATE`;
    const student = await requireStudentUser(claims, tx);
    const instance = await tx.classroomInstance.findUnique({ where: { id: instanceId }, include: { activity: { include: { chapter: { include: { offering: true } } } } } });
    if (!instance) throw new PlatformError("NOT_FOUND", "课堂不存在", 404);
    const enrollment = await tx.enrollment.findUnique({ where: { userId_offeringId: { userId: student.id, offeringId: instance.activity.chapter.offeringId } } });
    if (!enrollment || !ENROLLED.includes(enrollment.status)) throw new PlatformError("ENROLLMENT_REQUIRED", "请先加入教学班", 403);
    const available = input.phase === "posttest" ? isPosttestOpen(instance.status, instance.runtimeConfig) : isPretestAvailable(instance);
    if (!available) throw new PlatformError("ASSESSMENT_UNAVAILABLE", "当前无法保存测验草稿", 409);
    const assignment = await tx.experimentAssessmentAssignment.findUnique({ where: { instanceId_enrollmentId: { instanceId, enrollmentId: enrollment.id } } });
    if (!assignment) throw new PlatformError("ASSESSMENT_ASSIGNMENT_REQUIRED", "请重新打开课堂活动，获取本人的测验题目", 409);
    if (input.phase === "posttest") {
      const [pretest, participation] = await Promise.all([
        tx.experimentAssessmentSubmission.findUnique({ where: { instanceId_enrollmentId_phase: { instanceId, enrollmentId: enrollment.id, phase: "pretest" } }, select: { id: true } }),
        tx.classroomParticipation.findUnique({ where: { instanceId_enrollmentId: { instanceId, enrollmentId: enrollment.id } }, select: { id: true } }),
      ]);
      if (!pretest || !participation) throw new PlatformError("CLASSROOM_PARTICIPATION_REQUIRED", "请先完成前测并参与本场课堂", 409);
    }
    const submission = await tx.experimentAssessmentSubmission.findUnique({ where: { instanceId_enrollmentId_phase: { instanceId, enrollmentId: enrollment.id, phase: input.phase } }, select: { id: true } });
    if (submission) throw new PlatformError("ASSESSMENT_SUBMITTED", "本场测验已提交，不能修改草稿", 409);
    const answers = normalizeExperimentDraftAnswers(assignedQuestions(assignment, input.phase), input.answers);
    if (!answers) throw new PlatformError("INVALID_ANSWERS", "草稿包含无效题目或选项", 400);
    const key = { assignmentId_phase: { assignmentId: assignment.id, phase: input.phase } };
    const existing = await tx.experimentAssessmentDraft.findUnique({ where: key });
    if ((existing?.version ?? 0) !== input.version) throw new PlatformError("DRAFT_VERSION_CONFLICT", "草稿已在其他页面更新，请刷新后查看最新内容", 409);
    const draft = existing
      ? await tx.experimentAssessmentDraft.update({ where: key, data: { answers: answers as Prisma.InputJsonValue, currentPage: input.currentPage, version: { increment: 1 } } })
      : await tx.experimentAssessmentDraft.create({ data: { id: randomUUID(), assignmentId: assignment.id, phase: input.phase, answers: answers as Prisma.InputJsonValue, currentPage: input.currentPage } });
    await tx.domainEvent.create({ data: { id: randomUUID(), idempotencyKey: randomUUID(), actorId: student.id, offeringId: instance.activity.chapter.offeringId, classroomInstanceId: instanceId, researchKey: enrollment.researchKey, eventType: "experiment-draft-updated", payload: { scope: "student", studentId: student.id, phase: input.phase } } });
    return { draft: draftView(draft) };
  });
  await notifyExperimentChanged(instanceId, claims.sub ?? "");
  return result;
}

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
  const result = await runMutationTransaction(async (tx) => {
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
    } else if (!isPosttestOpen(instance.status, instance.runtimeConfig)) {
      throw new PlatformError("POSTTEST_UNAVAILABLE", "教师进入后测阶段后才可提交", 409);
    }
    const assignment = await tx.experimentAssessmentAssignment.findUnique({ where: { instanceId_enrollmentId: { instanceId, enrollmentId: enrollment.id } } });
    if (!assignment) throw new PlatformError("ASSESSMENT_ASSIGNMENT_REQUIRED", "请重新打开课堂活动，获取本人的测验题目", 409);
    const questionnaire = { enabled: true, pretest: assignedQuestions(assignment, "pretest"), posttest: assignedQuestions(assignment, "posttest") };
    if (phase.data === "posttest") {
      const [pretest, participation] = await Promise.all([
        tx.experimentAssessmentSubmission.findUnique({ where: { instanceId_enrollmentId_phase: { instanceId, enrollmentId: enrollment.id, phase: "pretest" } }, select: { id: true } }),
        tx.classroomParticipation.findUnique({ where: { instanceId_enrollmentId: { instanceId, enrollmentId: enrollment.id } }, select: { id: true } }),
      ]);
      if (!pretest || !participation) throw new PlatformError("CLASSROOM_PARTICIPATION_REQUIRED", "请先完成前测并参与本场课堂", 409);
    }
    const graded = gradeExperimentAnswers(questionnaire[phase.data], input.answers);
    if (!graded) throw new PlatformError("INVALID_ANSWERS", "请完成所有题目并检查选项后提交", 400);
    const existing = await tx.experimentAssessmentSubmission.findUnique({ where: { instanceId_enrollmentId_phase: { instanceId, enrollmentId: enrollment.id, phase: phase.data } } });
    if (existing) {
      if (JSON.stringify(existing.answers) === JSON.stringify(graded.answers)) return existing;
      throw new PlatformError("ASSESSMENT_SUBMITTED", "本场测验已提交，不能重复作答", 409);
    }
    const submitted = await tx.experimentAssessmentSubmission.create({ data: {
      id: randomUUID(), instanceId, enrollmentId: enrollment.id, assignmentId: assignment.id, phase: phase.data,
      researchKey: enrollment.researchKey,
      questionnaire: questionnaire as Prisma.InputJsonValue,
      answers: graded.answers as Prisma.InputJsonValue,
      objectiveScore: graded.objectiveScore,
      objectiveTotal: graded.objectiveTotal,
    } });
    await tx.experimentAssessmentDraft.deleteMany({ where: { assignmentId: assignment.id, phase: phase.data } });
    if (phase.data === "posttest") {
      const participation = await tx.classroomParticipation.findUnique({ where: { instanceId_enrollmentId: { instanceId, enrollmentId: enrollment.id } }, select: { id: true, stageProgress: true } });
      if (participation) {
        const current = participation.stageProgress && typeof participation.stageProgress === "object" && !Array.isArray(participation.stageProgress) ? participation.stageProgress as Record<string, unknown> : {};
        const progress = current.progress && typeof current.progress === "object" && !Array.isArray(current.progress) ? current.progress as Record<string, number> : {};
        await tx.classroomParticipation.update({ where: { id: participation.id }, data: { stageProgress: { ...current, progress: { ...progress, reflection: 100 } } as Prisma.InputJsonValue } });
      }
    }
    await tx.domainEvent.create({ data: { id: randomUUID(), idempotencyKey: randomUUID(), actorId: student.id, offeringId: offering.id, classroomInstanceId: instanceId, researchKey: enrollment.researchKey, eventType: "experiment-assessment-submitted", payload: { scope: "student", studentId: student.id, phase: phase.data } } });
    return submitted;
  });
  await notifyExperimentChanged(instanceId, claims.sub ?? "");
  return result;
}

export async function getClassroomExperimentResults(claims: AuthClaims, instanceId: string) {
  const teacher = await requireTeacherUser(claims);
  const instance = await prisma.classroomInstance.findUnique({ where: { id: instanceId }, include: { activity: { include: { chapter: true } } } });
  if (!instance) throw new PlatformError("NOT_FOUND", "课堂不存在", 404);
  const offeringId = instance.activity.chapter.offeringId;
  if (!await prisma.courseTeacher.findFirst({ where: { offeringId, userId: teacher.id }, select: { id: true } })) throw new PlatformError("FORBIDDEN", "无权查看该课堂", 403);
  const [submissions, assignments, enrollments, drafts] = await Promise.all([
    prisma.experimentAssessmentSubmission.findMany({
      where: { instanceId, enrollment: { offeringId } }, orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      include: { enrollment: { select: { user: { select: { id: true, displayName: true, username: true } } } }, assignment: { select: { variant: true } } },
    }),
    prisma.experimentAssessmentAssignment.findMany({ where: { instanceId }, select: { variant: true, enrollmentId: true } }),
    prisma.enrollment.findMany({ where: { offeringId, status: { in: ENROLLED } }, select: { id: true, user: { select: { id: true, displayName: true } } } }),
    prisma.experimentAssessmentDraft.findMany({ where: { phase: "posttest", assignment: { instanceId } }, select: { assignment: { select: { enrollmentId: true } } } }),
  ]);
  const snapshot = submissions[0] ? ExperimentConfigSchema.safeParse(submissions[0].questionnaire) : null;
  const experiment = snapshot?.success ? snapshot.data : assignments.length ? { enabled: true } : experimentConfigFromActivity(instance.activity.config);
  const submittedIds = new Set(submissions.filter((row) => row.phase === "posttest").map((row) => row.enrollmentId));
  const draftingIds = new Set(drafts.map((row) => row.assignment.enrollmentId));
  return {
    instanceId,
    activityId: instance.activityId,
    runNo: instance.runNo,
    status: instance.status.toLowerCase(),
    enabled: Boolean(experiment),
    posttestAvailable: isPosttestOpen(instance.status, instance.runtimeConfig),
    enrollmentCount: enrollments.length,
    posttestOpenedAt: posttestOpenedAt(instance.runtimeConfig),
    posttestDraftCount: enrollments.filter((row) => draftingIds.has(row.id) && !submittedIds.has(row.id)).length,
    studentRows: enrollments.map((row) => ({ student: row.user, status: submittedIds.has(row.id) ? "submitted" as const : draftingIds.has(row.id) ? "in-progress" as const : "not-started" as const, ...(submissions.find((item) => item.phase === "posttest" && item.enrollmentId === row.id)?.submittedAt ? { submittedAt: submissions.find((item) => item.phase === "posttest" && item.enrollmentId === row.id)!.submittedAt } : {}) })),
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
