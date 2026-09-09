import { authenticateRequest } from "@/lib/auth/request-guards";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { NextRequest, NextResponse } from "next/server";
import { getCourseSession } from "@/lib/db/session-repository";
import { isDatabaseConfigured } from "@/lib/db/client";

// GET /api/courses/[courseId]/sessions/[sessionId]
// Returns a single archived classroom session, including the full archivedData
// snapshot (students, submissions, feedback, evaluations, etc.) for read-only
// history view.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ courseId: string; sessionId: string }> },
) {
  const { courseId, sessionId } = await params;

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
    const session = await getCourseSession(sessionId, courseId);
    if (!session || session.courseId !== courseId) {
      return NextResponse.json(
        { error: "session_not_found", message: "历史会话不存在" },
        { status: 404 },
      );
    }
    return NextResponse.json({ session }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    console.error("[api/courses/sessions/[sessionId]] get error:", err);
    return NextResponse.json(
      { error: "internal_error", message: "获取历史会话详情失败" },
      { status: 500 },
    );
  }
}
