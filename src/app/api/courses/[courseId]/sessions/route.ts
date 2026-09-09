import { authenticateRequest } from "@/lib/auth/request-guards";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { NextRequest, NextResponse } from "next/server";
import { listCourseSessions } from "@/lib/db/session-repository";
import { isDatabaseConfigured } from "@/lib/db/client";

// GET /api/courses/[courseId]/sessions
// Returns the list of archived classroom sessions for a course (newest first).
// Each item contains only summary metadata — full archivedData is fetched
// from the per-session endpoint.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> },
) {
  const { courseId } = await params;

  const auth = await authenticateRequest(_req, "teacher"); if ("response" in auth) return auth.response;
  if (!await canAccessLegacyCourse(auth.claims, courseId)) return Response.json({ code: "FORBIDDEN" }, { status: 403 });

  if (!isDatabaseConfigured()) {
    return NextResponse.json(
      {
        error: "history_unavailable_in_demo_mode",
        message: "历史开课记录功能仅在配置 PostgreSQL 数据库后可用。",
      },
      { status: 501 },
    );
  }

  try {
    const sessions = await listCourseSessions(courseId);
    return NextResponse.json({ sessions }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    console.error("[api/courses/sessions] list error:", err);
    return NextResponse.json(
      { error: "internal_error", message: "获取历史开课记录失败" },
      { status: 500 },
    );
  }
}
