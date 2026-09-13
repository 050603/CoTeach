import { canAccessLegacyCourse } from "@/lib/platform/access";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { getCourse } from "@/lib/session/server-store";
import { courseQuestionSet, latestCourseReflection, latestExperienceSurvey } from "@/lib/course-reflection";
import {
  latestReflectionByStudent,
  normalizeReflectionSurvey,
  reflectionCsvCell,
} from "@/lib/reflection-survey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeFilePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "course";
}

const HEADERS = [
  "course_id",
  "course_name",
  "student_id",
  "student_name",
  "first_submitted_at",
  "updated_at",
  "learning_reflection",
  "system_reflection",
  "ai_helpfulness",
  "system_usability",
  "reuse_intention",
];

export async function GET(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  if (auth.claims.role !== "teacher") return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  const { courseId } = await context.params;
  if (!await canAccessLegacyCourse(auth.claims, courseId, "read")) return Response.json({ code: "FORBIDDEN", message: "无权访问该课堂的反思数据" }, { status: 403 });
  const course = await getCourse(courseId);
  if (!course) return Response.json({ error: "COURSE_NOT_FOUND" }, { status: 404 });

  if (courseQuestionSet(course)) {
    const headers = ["course_id", "student_id", "student_name", "question_set_id", "question_set_version", "question_id", "question", "answer", "course_submitted_at", "experience_submitted_at", "system_reflection", "ai_helpfulness", "system_usability", "reuse_intention"];
    const rows = course.students.flatMap((student) => {
      const record = latestCourseReflection(course, student.id);
      const response = record?.courseReflection;
      const experience = latestExperienceSurvey(course, student.id);
      if (!response && !experience) return [];
      const questions = response?.questions ?? [{ id: "", prompt: "" }];
      return questions.map((question) => [course.id, student.id, student.name, response?.questionSetId ?? "", response?.questionSetVersion ?? "", question.id, question.prompt,
        response?.answers[question.id] ?? "", response?.submittedAt ?? "", experience?.submittedAt ?? "", experience?.systemReflection ?? "", experience?.aiHelpfulness ?? "", experience?.systemUsability ?? "", experience?.reuseIntention ?? ""].map(reflectionCsvCell).join(","));
    });
    return new Response(`\uFEFF${headers.join(",")}\n${rows.join("\n")}\n`, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${safeFilePart(course.name)}-课程反思与系统体验.csv`)}`, "Cache-Control": "private, no-store" } });
  }

  const latest = latestReflectionByStudent(course.reflections);
  const students = course.students
    .map((student) => ({ student, reflection: latest.get(student.id) }))
    .map((item) => ({ ...item, survey: normalizeReflectionSurvey(item.reflection?.survey) }))
    .filter((item) => Boolean(item.survey))
    .sort((left, right) =>
      left.student.name.localeCompare(right.student.name, "zh-CN")
      || left.student.id.localeCompare(right.student.id),
    );

  const rows = students.map(({ student, reflection, survey }) => {
    const normalizedSurvey = survey!;
    return [
      course.id,
      course.name,
      student.id,
      student.name,
      reflection!.createdAt,
      reflection!.updatedAt,
      normalizedSurvey.learningReflection,
      normalizedSurvey.systemReflection,
      normalizedSurvey.aiHelpfulness,
      normalizedSurvey.systemUsability,
      normalizedSurvey.reuseIntention,
    ].map(reflectionCsvCell).join(",");
  });
  const csv = `\uFEFF${HEADERS.map(reflectionCsvCell).join(",")}\n${rows.join("\n")}${rows.length ? "\n" : ""}`;
  const fileName = `${safeFilePart(course.name)}-学习反思数据.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
