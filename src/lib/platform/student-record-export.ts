import JSZip from "jszip";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import type { PlatformDb } from "./access";
import { getOfferingStudentsSummary } from "./student-records";
import { PlatformError } from "./repository";

export const STUDENT_RECORD_EXPORT_SECTIONS = [
  "summary",
  "activity_progress",
  "activity_submissions",
  "classrooms",
  "artifacts",
  "reflections",
  "evaluations",
  "summary_csv",
] as const;

export type StudentRecordExportSection = typeof STUDENT_RECORD_EXPORT_SECTIONS[number];

const FINAL_RECORD_STATUSES = ["SUBMITTED", "submitted", "COMPLETED", "completed", "PUBLISHED", "published", "READY", "ready"];

function safeFilePart(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "course";
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function csvCell(value: string | number): string {
  let content = String(value);
  if (/^[=+\-@]/.test(content)) content = `'${content}`;
  return `"${content.replaceAll('"', '""')}"`;
}

export async function createStudentRecordsArchive(
  claims: AuthClaims,
  offeringId: string,
  enrollmentIds: string[],
  requestedSections: StudentRecordExportSection[],
  db: PlatformDb = prisma,
  generatedAt = new Date(),
) {
  const sections = Array.from(new Set(requestedSections));
  const selectedIds = Array.from(new Set(enrollmentIds));
  if (!sections.length || !selectedIds.length) throw new PlatformError("INVALID_INPUT", "请选择学生和需要导出的数据", 400);

  const summary = await getOfferingStudentsSummary(claims, offeringId, db, generatedAt);
  const studentByEnrollment = new Map(summary.students.map((student) => [student.enrollmentId, student]));
  const missingIds = selectedIds.filter((id) => !studentByEnrollment.has(id));
  if (missingIds.length) throw new PlatformError("INVALID_INPUT", "导出名单包含不属于当前教学班的学生", 400);
  const students = selectedIds.map((id) => studentByEnrollment.get(id)!);
  const exportedAt = generatedAt.toISOString();
  const zip = new JSZip();
  const files: Array<{ path: string; description: string; recordCount?: number }> = [];
  const addJson = (path: string, description: string, records: unknown[]) => {
    zip.file(path, jsonText({ schemaVersion: 1, exportedAt, offeringId, records }));
    files.push({ path, description, recordCount: records.length });
  };

  if (sections.includes("summary")) {
    addJson("data/students.json", "学生身份与当前筛选口径下的学习摘要", students);
  }
  if (sections.includes("activity_progress") || sections.includes("activity_submissions")) {
    addJson("reference/activity-catalog.json", "章节顺序、活动类型、开放与归档状态", summary.activities);
  }
  if (sections.includes("activity_progress")) {
    const progressRows = await db.activityProgress.findMany({
      where: { enrollmentId: { in: selectedIds } },
      orderBy: [{ enrollmentId: "asc" }, { activityId: "asc" }],
      select: {
        id: true, enrollmentId: true, activityId: true, status: true,
        startedAt: true, completedAt: true, lastAccessedAt: true, progressData: true, updatedAt: true,
      },
    });
    const progressByStudentActivity = new Map(progressRows.map((record) => [`${record.enrollmentId}:${record.activityId}`, record]));
    const records = students.flatMap((student) => summary.activities.map((activity) => {
      const record = progressByStudentActivity.get(`${student.enrollmentId}:${activity.id}`);
      return record ?? {
        id: null,
        enrollmentId: student.enrollmentId,
        activityId: activity.id,
        status: student.activityStatuses[activity.id] ?? "not_started",
        startedAt: null,
        completedAt: null,
        lastAccessedAt: null,
        progressData: null,
        updatedAt: null,
      };
    }));
    addJson("data/activity-progress.json", "活动最新进度投影；可能包含预创建的 NOT_STARTED 记录", records);
  }
  if (sections.includes("activity_submissions")) {
    const records = await db.activitySubmission.findMany({
      where: { enrollmentId: { in: selectedIds } },
      orderBy: [{ enrollmentId: "asc" }, { submittedAt: "asc" }, { id: "asc" }],
      select: {
        id: true, enrollmentId: true, activityId: true,
        activityVersion: true, activitySnapshot: true, payload: true, submittedAt: true,
      },
    });
    addJson("data/activity-submissions.json", "活动不可变提交历史，包含提交时题目配置快照与答案", records);
  }

  const needsClassroomRecords = sections.some((section) => ["classrooms", "artifacts", "reflections", "evaluations"].includes(section));
  const participations = needsClassroomRecords ? await db.classroomParticipation.findMany({
    where: { enrollmentId: { in: selectedIds } },
    orderBy: [{ enrollmentId: "asc" }, { instanceId: "asc" }],
    select: {
      id: true, enrollmentId: true, firstEnteredAt: true, lastEnteredAt: true, completedAt: true, stageProgress: true,
      instance: { select: { id: true, activityId: true, runNo: true, status: true, startedAt: true, endedAt: true } },
    },
  }) : [];
  const participationIds = participations.map((participation) => participation.id);

  if (sections.includes("classrooms")) {
    addJson("data/classroom-participations.json", "课堂场次参与时间与阶段进度", participations);
    const records = participationIds.length ? await db.classroomSubmission.findMany({
      where: { participationId: { in: participationIds }, status: { in: FINAL_RECORD_STATUSES } },
      orderBy: [{ participationId: "asc" }, { submittedAt: "asc" }, { id: "asc" }],
      select: { id: true, participationId: true, stageKey: true, status: true, payload: true, submittedAt: true, createdAt: true, updatedAt: true },
    }) : [];
    addJson("data/classroom-submissions.json", "课堂中已提交的阶段内容；草稿与归档内容已排除", records);
  }
  if (sections.includes("artifacts")) {
    const records = participationIds.length ? await db.artifact.findMany({
      where: { participationId: { in: participationIds } },
      orderBy: [{ participationId: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, participationId: true, groupId: true, title: true, type: true, status: true, createdAt: true, updatedAt: true,
        versions: {
          where: { status: { in: FINAL_RECORD_STATUSES } },
          orderBy: { sequence: "asc" },
          select: { id: true, sequence: true, sourceHtml: true, fileAssetId: true, mimeType: true, sha256: true, size: true, status: true, submittedAt: true, createdAt: true },
        },
      },
    }) : [];
    addJson("data/artifacts.json", "课堂成果及已提交版本；草稿与归档版本已排除", records.filter((record) => record.versions.length));
  }
  if (sections.includes("reflections")) {
    const records = participationIds.length ? await db.reflection.findMany({
      where: { participationId: { in: participationIds } },
      orderBy: [{ participationId: "asc" }, { createdAt: "asc" }],
      select: { id: true, participationId: true, activityId: true, authorId: true, content: true, metadata: true, createdAt: true, updatedAt: true },
    }) : [];
    addJson("data/reflections.json", "学生课堂反思", records);
  }
  if (sections.includes("evaluations")) {
    const records = participationIds.length ? await db.evaluation.findMany({
      where: { participationId: { in: participationIds } },
      orderBy: [{ participationId: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, participationId: true, studentId: true, groupId: true, activityId: true,
        type: true, evaluatorType: true, evaluatorId: true, score: true, rubric: true,
        result: true, content: true, metadata: true, createdAt: true,
      },
    }) : [];
    addJson("data/evaluations.json", "教师评价、学生自评与其他评价记录；可用 evaluatorType 区分来源", records);
  }
  if (sections.includes("summary_csv")) {
    const header = ["姓名", "账号", "已完成当前开放非课堂活动", "当前开放非课堂活动总数", "课堂参与次数", "最近学习时间", "关注原因"];
    const rows = students.map((student) => [
      student.displayName,
      student.username,
      student.completedOpenActivities,
      student.openActivityCount,
      student.classroomParticipationCount,
      student.lastLearningAt ?? "",
      student.attentionReasons.join(";"),
    ]);
    const csv = `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
    zip.file("data/students-summary.csv", csv);
    files.push({ path: "data/students-summary.csv", description: "便于电子表格查看的学生摘要（UTF-8 BOM，已防止公式注入）", recordCount: rows.length });
  }

  const manifest = {
    archiveVersion: 1,
    exportedAt,
    offering: summary.offering,
    selectedSections: sections,
    studentCount: students.length,
    enrollmentIds: selectedIds,
    attentionReasonCodes: {
      not_participated: "尚未参与",
      incomplete_open_activity: "存在未完成的开放活动",
      pending_teacher_evaluation: "已提交课堂成果但无教师评价",
    },
    relations: {
      student: "enrollmentId",
      activity: "activityId",
      classroom: "participationId",
    },
    files,
  };
  zip.file("manifest.json", jsonText(manifest));
  zip.file("README.txt", [
    `${summary.offering.name}｜学生学习记录数据包`,
    "",
    `导出时间：${exportedAt}`,
    `学生人数：${students.length}`,
    "",
    "JSON 文件均使用 UTF-8 编码。各文件通过 enrollmentId、activityId 与 participationId 关联。",
    "manifest.json 记录本次选择的数据类型、文件清单、关联字段和关注原因代码。",
    "活动完成比例仅统计当前开放、未归档的非课堂活动；课堂参与按实际进入场次统计。",
    "课堂提交与成果只包含已提交或已完成版本，草稿与归档内容不会作为成果导出。",
  ].join("\n"));

  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return { bytes, fileName: `${safeFilePart(summary.offering.name)}-学生学习记录.zip`, manifest };
}
