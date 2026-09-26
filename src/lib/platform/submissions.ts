import { z } from "zod";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { requireStudentUser } from "./access";
import { isActivityOpen, PlatformError } from "./repository";
import { selectedSurveyOptionIds, SurveyConfigSchema, type SurveyAnswer } from "./survey";

const surveyChoiceAnswerSchema = z.object({
  selected: z.union([
    z.string().trim().min(1).max(80),
    z.array(z.string().trim().min(1).max(80)).max(10),
  ]),
  optionText: z.record(z.string().trim().min(1).max(80), z.string().trim().max(200)).optional(),
}).strict().superRefine((answer, context) => {
  if (answer.optionText && Object.keys(answer.optionText).length > 10) {
    context.addIssue({ code: "custom", message: "补充回答数量过多", path: ["optionText"] });
  }
});

export const submissionSchema = z.object({
  answer: z.string().trim().max(30000).optional(),
  answers: z.record(z.string(), z.union([
    z.string().trim().max(10000),
    z.array(z.string().trim().min(1).max(80)).max(10),
    surveyChoiceAnswerSchema,
  ])).optional(),
});

function hasAnswer(value: SurveyAnswer | undefined): boolean {
  if (value && typeof value === "object" && !Array.isArray(value)) return selectedSurveyOptionIds(value).length > 0;
  return Array.isArray(value) ? value.length > 0 : Boolean(value?.trim());
}

export async function submitActivity(claims: AuthClaims, activityId: string, input: z.infer<typeof submissionSchema>) {
  const student = await requireStudentUser(claims);
  const activity = await prisma.activity.findUnique({ where: { id: activityId }, include: { chapter: { include: { offering: true } } } });
  if (!activity || activity.archivedAt) throw new PlatformError("NOT_FOUND", "任务不存在", 404);
  const enrollment = await prisma.enrollment.findUnique({ where: { userId_offeringId: { userId: student.id, offeringId: activity.chapter.offeringId } } });
  if (!enrollment || enrollment.status.toLowerCase() !== "active") throw new PlatformError("FORBIDDEN", "请先加入课程", 403);
  if (activity.chapter.offering.status.toLowerCase() !== "open" || !isActivityOpen(activity.chapter, activity)) throw new PlatformError("ACTIVITY_LOCKED", "当前任务未开放提交", 403);
  const type = activity.type.toUpperCase();
  if (type === "CLASSROOM") throw new PlatformError("INVALID_ACTIVITY", "课堂进度由课堂记录更新", 400);
  const config = activity.config && typeof activity.config === "object" ? activity.config as Record<string, unknown> : {};
  if (type === "ASSIGNMENT" && !input.answer) throw new PlatformError("ANSWER_REQUIRED", "请填写作业内容", 400);
  if (type === "FORM" || type === "QUIZ") {
    const questions = Array.isArray(config.questions) ? config.questions as Array<{ id: string; required?: boolean }> : [];
    if (!questions.length && !input.answer) throw new PlatformError("ANSWER_REQUIRED", "请填写回答", 400);
    if (questions.some((question) => question.required !== false && !hasAnswer(input.answers?.[question.id]))) throw new PlatformError("ANSWER_REQUIRED", "请完成所有必答题", 400);
  }
  if (type === "FORM") {
    const survey = SurveyConfigSchema.safeParse(config);
    if (!survey.success) throw new PlatformError("INVALID_ACTIVITY_CONFIG", "问卷配置不完整，请联系教师", 400);
    const invalidChoice = survey.data.questions.find((question) => {
      const answer = input.answers?.[question.id];
      if (answer === undefined) return false;
      if (question.type === "short-text") return typeof answer !== "string";
      const optionIds = new Set(question.options.map((option) => option.id));
      const selected = selectedSurveyOptionIds(answer);
      const structured = answer && typeof answer === "object" && !Array.isArray(answer) ? answer : null;
      if (question.type === "single-choice" && (selected.length !== 1 || Array.isArray(structured?.selected))) return true;
      if (question.type === "multiple-choice" && (!Array.isArray(answer) && !Array.isArray(structured?.selected))) return true;
      if (new Set(selected).size !== selected.length || selected.some((optionId) => !optionIds.has(optionId))) return true;
      if (question.type === "multiple-choice" && question.maxSelections && selected.length > question.maxSelections) return true;
      if (!structured?.optionText) return false;
      return Object.keys(structured.optionText).some((optionId) => {
        const option = question.options.find((item) => item.id === optionId);
        return !selected.includes(optionId) || !option?.allowTextInput;
      });
    });
    if (invalidChoice) throw new PlatformError("INVALID_ANSWER", `“${invalidChoice.title}”的选项无效，请重新选择`, 400);
    const missingChoiceDetail = survey.data.questions.find((question) => {
      if (question.type === "short-text") return false;
      const answer = input.answers?.[question.id];
      const selected = selectedSurveyOptionIds(answer);
      const optionText = answer && typeof answer === "object" && !Array.isArray(answer) ? answer.optionText : undefined;
      return question.options.some((option) => option.allowTextInput && selected.includes(option.id) && !optionText?.[option.id]?.trim());
    });
    if (missingChoiceDetail) throw new PlatformError("ANSWER_REQUIRED", `选择“${missingChoiceDetail.title}”的开放选项后，请填写补充内容`, 400);
  }
  const now = new Date();
  const progressData = { answer: input.answer ?? "", answers: input.answers ?? {}, submittedAt: now.toISOString() };
  return runMutationTransaction(async (tx) => {
    // Serialize submission with teacher edits of this Activity. A changed form
    // must be reloaded by the student so the validated answers and snapshot
    // describe the same question version.
    await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} FOR UPDATE`;
    const current = await tx.activity.findUnique({ where: { id: activityId }, select: { version: true } });
    if (!current || current.version !== activity.version) {
      throw new PlatformError("VERSION_CONFLICT", "题目已更新，请刷新后重新提交", 409);
    }
    await tx.activitySubmission.create({
      data: {
        enrollmentId: enrollment.id,
        activityId,
        researchKey: enrollment.researchKey,
        activityVersion: activity.version,
        activitySnapshot: {
          type: activity.type,
          title: activity.title,
          config: activity.config,
          version: activity.version,
        },
        payload: progressData,
        submittedAt: now,
      },
    });
    return tx.activityProgress.upsert({
      where: { enrollmentId_activityId: { enrollmentId: enrollment.id, activityId } },
      create: { enrollmentId: enrollment.id, activityId, status: "COMPLETED", startedAt: now, completedAt: now, lastAccessedAt: now, progressData },
      update: { status: "COMPLETED", completedAt: now, lastAccessedAt: now, progressData },
    });
  });
}
