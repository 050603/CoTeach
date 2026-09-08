// @ts-nocheck
import { authenticateRequest } from "@/lib/auth/request-guards";
import { scopeCourseForClaims } from "@/lib/auth/course-scope";
import { getCourse, readSessionState } from "@/lib/session/server-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  try {
    if (auth.claims.role === "teacher") {
      const state = await readSessionState();
      return noStoreJson({
        ...state,
        user: { role: "teacher", name: auth.claims.displayName },
        joinedCourseId: undefined,
        studentId: undefined,
        studentName: undefined,
      });
    }

    // A student token is already bound to exactly one course. Loading the
    // complete cross-course session and filtering afterwards makes every
    // student request grow with the total number of teachers and courses.
    // Read only the signed-in course so concurrent classrooms stay isolated.
    const course = await getCourse(auth.claims.courseId);
    return noStoreJson({
      courses: course ? [scopeCourseForClaims(course, auth.claims)] : [],
      user: { role: "student", name: auth.claims.studentName },
      joinedCourseId: auth.claims.courseId,
      studentId: auth.claims.studentId,
      studentName: auth.claims.studentName,
      hydrated: true,
      updatedAt: course?.updatedAt ?? new Date(0).toISOString(),
    });
  } catch (error) {
    console.error("[courses] unable to load course list", {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        code: "COURSES_UNAVAILABLE",
        message: "Course data is temporarily unavailable.",
        requestId: request.headers.get("x-request-id") ?? "unknown",
      },
      { status: 503 },
    );
  }
}

function noStoreJson(value: unknown): Response {
  return Response.json(value, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
