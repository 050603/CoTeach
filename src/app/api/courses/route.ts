import { authenticateRequest } from "@/lib/auth/request-guards";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { scopeCourseForClaims } from "@/lib/auth/course-scope";
import { loadCourse, loadSessionState, stateFor } from "@/lib/db/session-repository";
import { prisma } from "@/lib/db/client";
import type { Course } from "@/lib/session/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await authenticateRequest(request); if ("response" in auth) return auth.response;
  try {
    const claims = auth.claims;
    const requested = new URL(request.url).searchParams.get("courseId");
    if (claims.role === "teacher") {
      if (requested) {
        if (!await canAccessLegacyCourse(claims, requested)) return Response.json({ code: "FORBIDDEN" }, { status: 403 });
        const course = await loadCourse(requested);
        return noStore({ ...stateFor(course ? [course] : []), user: { role: "teacher", name: claims.displayName } });
      }
      return noStore({ ...await loadSessionState(claims.sub), user: { role: "teacher", name: claims.displayName } });
    }
    const participations = await prisma.classroomParticipation.findMany({ where: { ...(requested ? { instanceId: requested } : {}), enrollment: { userId: claims.sub, status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] } } }, orderBy: { lastEnteredAt: "desc" }, select: { instanceId: true } });
    const courses = (await Promise.all(participations.map(p => loadCourse(p.instanceId)))).filter((course): course is Course => Boolean(course)).map(course => scopeCourseForClaims(course, claims));
    return noStore({ ...stateFor(courses), user: { role: "student", name: claims.studentName }, studentId: claims.sub, studentName: claims.studentName, joinedCourseId: requested ?? courses[0]?.id });
  } catch (error) {
    console.error("[v2-courses] projection read failed", error instanceof Error ? error.message : "unknown");
    return Response.json({ code: "COURSES_UNAVAILABLE", message: "无法读取课堂，请稍后重试" }, { status: 503 });
  }
}
function noStore(value: unknown) { return Response.json(value, { headers: { "Cache-Control": "private, no-store" } }); }
