import { z } from "zod";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { requireStudentUser } from "./access";
import { isActivityOpen, PlatformError } from "./repository";
import { SurveyConfigSchema } from "./survey";

export const submissionSchema = z.object({
  answer: z.string().trim().max(30000).optional(),
  answers: z.record(z.string(), z.string().trim().max(10000)).optional(),
});

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
    if (questions.some((question) => question.required !== false && !input.answers?.[question.id]?.trim())) throw new PlatformError("ANSWER_REQUIRED", "请完成所有必答题", 400);
  }
  if (type === "FORM") {
    const survey = SurveyConfigSchema.safeParse(config);
    if (!survey.success) throw new PlatformError("INVALID_ACTIVITY_CONFIG", "问卷配置不完整，请联系教师", 400);
    const invalidChoice = survey.data.questions.find((question) => question.type === "single-choice"
      && input.answers?.[question.id]
      && !question.options.some((option) => option.id === input.answers?.[question.id]));
    if (invalidChoice) throw new PlatformError("INVALID_ANSWER", `“${invalidChoice.title}”的选项无效，请重新选择`, 400);
  }
  const now = new Date();
  const progressData = { answer: input.answer ?? "", answers: input.answers ?? {}, submittedAt: now.toISOString() };
  return runMutationTransaction(async (tx) => {
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
