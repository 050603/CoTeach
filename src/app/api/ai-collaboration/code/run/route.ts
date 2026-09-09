import { NextRequest } from "next/server";
import { parseCodeArtifact, type CodeArtifactLanguage } from "@/lib/ai-collaboration/code-artifact";
import {
  codeRunnerLimiter,
  rateLimitKey,
  rateLimitedResponse,
} from "@/lib/auth/rate-limit";
import { authenticateLegacyAiStudent } from "@/lib/ai-collaboration/legacy-scope";
import {
  CodeRunnerUnavailableError,
  executeCodeArtifact,
} from "@/lib/code-runner/client";
import { getCourse } from "@/lib/session/server-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const STAGES = new Set(["proposal", "make"]);

function clean(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function languageOf(value: unknown): CodeArtifactLanguage | undefined {
  return value === "python" || value === "c" ? value : undefined;
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const courseId = clean(body.courseId, 120);
  const requestedStudentId = clean(body.studentId, 120);
  const stageKey = clean(body.stageKey, 80);
  const language = languageOf(body.language);
  const stdin = typeof body.stdin === "string" ? body.stdin.slice(0, 32_000) : "";
  if (!courseId || !stageKey || !language || !STAGES.has(stageKey)) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  const auth = await authenticateLegacyAiStudent(request, courseId, requestedStudentId);
  if (auth instanceof Response) return auth;
  const studentId = auth.studentId;
  const course = await getCourse(courseId);
  if (!course) return Response.json({ error: "COURSE_NOT_FOUND" }, { status: 404 });
  if (!course.students.some((item) => item.id === studentId)) {
    return Response.json({ error: "STUDENT_NOT_IN_COURSE" }, { status: 403 });
  }
  if (course.stages[course.currentStageIndex]?.key !== stageKey) {
    return Response.json({ error: "STAGE_CHANGED", message: "课堂阶段已经变化，请返回课堂后重新进入。" }, { status: 409 });
  }
  const serialized = typeof body.artifact === "string"
    ? body.artifact
    : JSON.stringify(body.artifact ?? null);
  if (serialized.length > 180_000) {
    return Response.json({ error: "ARTIFACT_TOO_LARGE", message: "代码项目超过单次运行限制。" }, { status: 413 });
  }
  const artifact = parseCodeArtifact(serialized, language);
  if (!artifact || artifact.files.length > 16) {
    return Response.json({ error: "INVALID_ARTIFACT" }, { status: 400 });
  }
  const limit = codeRunnerLimiter.check(rateLimitKey(request, studentId));
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);

  try {
    const result = await executeCodeArtifact({ artifact, stdin, signal: request.signal });
    return Response.json(result);
  } catch (error) {
    if (error instanceof CodeRunnerUnavailableError) {
      return Response.json({
        error: "RUNNER_UNAVAILABLE",
        message: "安全代码运行服务尚未就绪，请稍后重试。你的代码仍已保存在编辑器中。",
      }, { status: 503 });
    }
    return Response.json({
      error: "RUN_FAILED",
      message: "本次运行没有正常启动，请稍后重试。",
    }, { status: 503 });
  }
}
