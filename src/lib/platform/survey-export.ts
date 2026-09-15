import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import type { PlatformDb } from "./access";
import { requireTeacherUser } from "./access";
import { PlatformError } from "./repository";
import {
  selectedSurveyOptionIds,
  SurveyConfigSchema,
  type SurveyAnswer,
  type SurveyQuestion,
} from "./survey";
import { surveyResponseAnswers } from "./survey-analytics";

const ACTIVE_ENROLLMENT_STATUSES = ["ACTIVE", "active", "COMPLETED", "completed"];

function safeFilePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "survey";
}

function csvCell(value: unknown): string {
  const text = String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const safe = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function questionHeaders(question: SurveyQuestion, index: number): string[] {
  const prefix = `Q${index + 1} [${question.id}] ${question.title}`;
  return question.type === "short-text"
    ? [`${prefix}（回答）`]
    : [`${prefix}（选项编码）`, `${prefix}（回答）`];
}

function answerCells(question: SurveyQuestion, answer: SurveyAnswer | undefined): string[] {
  if (question.type === "short-text") return [typeof answer === "string" ? answer : ""];

  const selectedIds = selectedSurveyOptionIds(answer);
  const optionText = answer && typeof answer === "object" && !Array.isArray(answer)
    ? answer.optionText ?? {}
    : {};
  const labels = selectedIds.map((optionId) => {
    const label = question.options.find((option) => option.id === optionId)?.label ?? `[未知选项：${optionId}]`;
    const detail = optionText[optionId]?.trim();
    return detail ? `${label}：${detail}` : label;
  });
  return [selectedIds.join(" | "), labels.join(" | ")];
}

export async function createSurveyCsvExport(
  claims: AuthClaims,
  activityId: string,
  db: PlatformDb = prisma,
) {
  const teacher = await requireTeacherUser(claims, db);
  const activity = await db.activity.findUnique({
    where: { id: activityId },
    select: {
      id: true,
      title: true,
      type: true,
      config: true,
      chapter: {
        select: {
          id: true,
          title: true,
          offeringId: true,
          offering: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!activity) throw new PlatformError("NOT_FOUND", "活动不存在", 404);

  const teacherLink = await db.courseTeacher.findFirst({
    where: { offeringId: activity.chapter.offeringId, userId: teacher.id },
    select: { id: true },
  });
  if (!teacherLink) throw new PlatformError("FORBIDDEN", "无权导出该活动数据", 403);
  if (activity.type.toUpperCase() !== "FORM") {
    throw new PlatformError("INVALID_ACTIVITY", "该活动不是问卷", 400);
  }

  const config = SurveyConfigSchema.safeParse(activity.config);
  if (!config.success) {
    throw new PlatformError("INVALID_ACTIVITY_CONFIG", "问卷配置不完整，请先编辑问卷", 400);
  }

  // ActivityProgress is the same latest-response projection used by the
  // dashboard, so a student's resubmission replaces their earlier answer.
  const responses = await db.activityProgress.findMany({
    where: {
      activityId,
      status: { in: ["COMPLETED", "completed"] },
      enrollment: {
        offeringId: activity.chapter.offeringId,
        status: { in: ACTIVE_ENROLLMENT_STATUSES },
      },
    },
    select: {
      id: true,
      progressData: true,
      completedAt: true,
      updatedAt: true,
      enrollment: {
        select: {
          id: true,
          researchKey: true,
          user: { select: { id: true, username: true, displayName: true } },
        },
      },
    },
    orderBy: [{ completedAt: "asc" }, { id: "asc" }],
  });

  const headers = [
    "offering_id",
    "offering_name",
    "chapter_id",
    "chapter_title",
    "activity_id",
    "activity_title",
    "enrollment_id",
    "research_key",
    "student_id",
    "student_username",
    "student_name",
    "submitted_at",
    ...config.data.questions.flatMap(questionHeaders),
  ];
  const rows = responses.map((response) => {
    const answers = surveyResponseAnswers(response.progressData);
    return [
      activity.chapter.offering.id,
      activity.chapter.offering.name,
      activity.chapter.id,
      activity.chapter.title,
      activity.id,
      activity.title,
      response.enrollment.id,
      response.enrollment.researchKey,
      response.enrollment.user.id,
      response.enrollment.user.username,
      response.enrollment.user.displayName,
      (response.completedAt ?? response.updatedAt).toISOString(),
      ...config.data.questions.flatMap((question) => answerCells(question, answers[question.id])),
    ];
  });
  const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
  return {
    csv,
    fileName: `${safeFilePart(activity.chapter.offering.name)}-${safeFilePart(activity.title)}-问卷数据.csv`,
    rowCount: rows.length,
  };
}
