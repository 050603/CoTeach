// 服务端 API 路由：统一暴露 teaching-ai/support-engine 的所有函数。
// 客户端组件必须通过此路由调用，避免将 callLLM → settings → node:fs/promises
// 等服务端模块拉入客户端 bundle。

import { NextRequest } from "next/server";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { getCourse } from "@/lib/session/server-store";
import {
  buildReflectionEvidencePrompts,
  buildShowcaseCoach,
  buildTeacherDashboardAdvice,
  buildTeacherInterventionSignals,
  diagnoseAllProposals,
  diagnoseGroupIdea,
  diagnoseProjectArtifact,
  generateLiveEvaluation,
  generateProcessEvaluation,
  generateProjectSkeleton,
  suggestProjectDirections,
} from "@/lib/teaching-ai/support-engine";

export const dynamic = "force-dynamic";

type SupportRequest = {
  action: string;
  input: unknown;
};

type SupportHandler = (input: unknown, signal: AbortSignal) => Promise<unknown>;

const HANDLERS: Record<
  string,
  SupportHandler
> = {
  diagnoseGroupIdea: (input, signal) =>
    diagnoseGroupIdea(input as Parameters<typeof diagnoseGroupIdea>[0], { abortSignal: signal }),
  diagnoseProjectArtifact: (input, signal) =>
    diagnoseProjectArtifact(input as Parameters<typeof diagnoseProjectArtifact>[0], { abortSignal: signal }),
  buildShowcaseCoach: (input, signal) =>
    buildShowcaseCoach(input as Parameters<typeof buildShowcaseCoach>[0], { abortSignal: signal }),
  buildReflectionEvidencePrompts: (input, signal) =>
    buildReflectionEvidencePrompts(input as Parameters<typeof buildReflectionEvidencePrompts>[0], { abortSignal: signal }),
  buildTeacherInterventionSignals: (input, signal) => {
    const { course, stageKey } = input as {
      course: Parameters<typeof buildTeacherInterventionSignals>[0];
      stageKey: string;
    };
    return buildTeacherInterventionSignals(course, stageKey, { abortSignal: signal });
  },
  generateProjectSkeleton: (input, signal) =>
    generateProjectSkeleton(input as Parameters<typeof generateProjectSkeleton>[0], { abortSignal: signal }),
  diagnoseAllProposals: (input, signal) =>
    diagnoseAllProposals(input as Parameters<typeof diagnoseAllProposals>[0], { abortSignal: signal }),
  generateProcessEvaluation: (input, signal) =>
    generateProcessEvaluation(input as Parameters<typeof generateProcessEvaluation>[0], { abortSignal: signal }),
  generateLiveEvaluation: (input, signal) =>
    generateLiveEvaluation(input as Parameters<typeof generateLiveEvaluation>[0], { abortSignal: signal }),
  suggestProjectDirections: (input, signal) =>
    suggestProjectDirections(input as Parameters<typeof suggestProjectDirections>[0], { abortSignal: signal }),
};

export async function POST(req: NextRequest) {
  let body: SupportRequest;
  try {
    body = (await req.json()) as SupportRequest;
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  if (!body?.action || !body.input) {
    return Response.json({ error: "MISSING_FIELDS" }, { status: 400 });
  }

  if (body.action === "buildTeacherDashboardAdvice") {
    const csrfError = requireSameOrigin(req);
    if (csrfError) return csrfError;
    const auth = await authenticateRequest(req, "teacher");
    if ("response" in auth) return auth.response;
    const input = body.input && typeof body.input === "object" && !Array.isArray(body.input)
      ? body.input as { courseId?: unknown; stageKey?: unknown }
      : {};
    if (typeof input.courseId !== "string" || typeof input.stageKey !== "string") {
      return Response.json({ error: "INVALID_DASHBOARD_INPUT" }, { status: 400 });
    }
    const course = await getCourse(input.courseId);
    if (!course) return Response.json({ error: "COURSE_NOT_FOUND" }, { status: 404 });
    if (!course.stages.some((stage) => stage.key === input.stageKey)) {
      return Response.json({ error: "STAGE_NOT_FOUND" }, { status: 404 });
    }
    try {
      const result = await buildTeacherDashboardAdvice(course, input.stageKey, { abortSignal: req.signal });
      return Response.json({ result }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (e) {
      if (req.signal.aborted || (e instanceof Error && e.name === "AbortError")) {
        return new Response(null, { status: 499 });
      }
      const message = e instanceof Error ? e.message : String(e);
      console.error("[api/teaching-ai/support] dashboard advice failed:", message);
      return Response.json({ error: "SUPPORT_CALL_FAILED", detail: message }, { status: 500 });
    }
  }

  const handler = HANDLERS[body.action];
  if (!handler) {
    return Response.json({ error: `UNKNOWN_ACTION: ${body.action}` }, { status: 400 });
  }

  try {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    const result = await handler(body.input, req.signal);
    if (req.signal.aborted) return new Response(null, { status: 499 });
    return Response.json({ result });
  } catch (e) {
    if (req.signal.aborted || (e instanceof Error && e.name === "AbortError")) {
      return new Response(null, { status: 499 });
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[api/teaching-ai/support] action=${body.action} failed:`, message);
    return Response.json({ error: "SUPPORT_CALL_FAILED", detail: message }, { status: 500 });
  }
}
