import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { randomUUID } from "node:crypto";
import { getCourse, updateCourse } from "@/lib/session/server-store";
import type { TeacherAgentDirective } from "@/lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  const body = await request.json().catch(() => null) as Partial<TeacherAgentDirective> | null;
  if (!body?.courseId || !body.stageKey || !body.goal?.trim() || !body.instruction?.trim()) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (!await canAccessLegacyCourse(auth.claims, body.courseId)) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const course = await getCourse(body.courseId);
  if (!course) return Response.json({ error: "COURSE_NOT_FOUND" }, { status: 404 });
  const targetStudentIds = body.targetScope === "course"
    ? course.students.map((student) => student.id)
    : (body.targetStudentIds ?? []).filter((id) => course.students.some((student) => student.id === id));
  if (!targetStudentIds.length) return Response.json({ error: "NO_TARGETS" }, { status: 400 });
  const now = new Date().toISOString();
  const directive: TeacherAgentDirective = {
    id: `teacher-directive-${randomUUID()}`,
    courseId: body.courseId,
    stageKey: body.stageKey,
    targetStudentIds,
    targetScope: body.targetScope === "course" ? "course" : targetStudentIds.length > 1 ? "multiple" : "student",
    goal: body.goal.trim(),
    instruction: body.instruction.trim(),
    successCriteria: (body.successCriteria ?? []).map((item) => item.trim()).filter(Boolean),
    status: "active",
    teacherName: typeof auth.claims.displayName === "string" ? auth.claims.displayName : "教师",
    createdAt: now,
    updatedAt: now,
  };
  await updateCourse(body.courseId, (current) => ({
    ...current,
    teacherAgentDirectives: [...(current.teacherAgentDirectives ?? []), directive],
  }), { actor: { id: auth.claims.sub!, role: "teacher" } });
  return Response.json({ directive });
}

export async function PATCH(request: Request) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  const body = await request.json().catch(() => null) as { courseId?: string; directiveId?: string; status?: "revoked" | "goal-completed" } | null;
  if (!body?.courseId || !body.directiveId || !["revoked", "goal-completed"].includes(body.status ?? "")) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  if (!await canAccessLegacyCourse(auth.claims, body.courseId)) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const now = new Date().toISOString();
  await updateCourse(body.courseId, (course) => ({
    ...course,
    teacherAgentDirectives: (course.teacherAgentDirectives ?? []).map((directive) => directive.id === body.directiveId ? {
      ...directive,
      status: body.status!,
      updatedAt: now,
      ...(body.status === "revoked" ? { revokedAt: now } : { completedAt: now }),
    } : directive),
  }), { actor: { id: auth.claims.sub!, role: "teacher" } });
  return Response.json({ ok: true });
}
