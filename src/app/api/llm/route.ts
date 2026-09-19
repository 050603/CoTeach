// Server-side route for the LLM generation API.
// Centralizes the LLM call so the browser never holds the API key.
//
// Error mapping: each LLM error class is mapped to a specific HTTP status +
// errorCode so the client can show a targeted Chinese toast instead of a
// generic failure message.

import { NextRequest } from "next/server";
import { generateCourseContent, isActiveLlmConfigured } from "@/lib/llm/client";
import { generateKnowledgeStructureOnce } from "@/lib/knowledge-structure-generation";
import type { LlmCallRequest } from "@/lib/llm/types";
import {
  LlmCallFailedError,
  LlmEmptyResponseError,
  LlmJsonModeUnsupportedError,
  LlmNotConfiguredError,
  LlmOutputIncompleteError,
  LlmRateLimitError,
  LlmStreamCorruptedError,
  LlmTimeoutError,
} from "@/lib/llm/errors";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: LlmCallRequest;
  try {
    body = (await req.json()) as LlmCallRequest;
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  if (!body || !body.action || !body.input) {
    return Response.json({ error: "MISSING_FIELDS" }, { status: 400 });
  }
  try {
    let result;
    if (body.action === "knowledgeGraph") {
      const structure = await generateKnowledgeStructureOnce(
        body.input,
        body.context,
        { abortSignal: req.signal },
      );
      result = {
        content: {
          pblOutline: "",
          knowledgePoints: structure.knowledgePoints,
          knowledgeGraph: structure.knowledgeGraph,
          lessonOutline: [],
          evaluationPlan: { dimensions: [], overallRubric: "" },
        },
        source: "llm" as const,
      };
    } else {
      result = await generateCourseContent(body, { signal: req.signal });
    }
    return Response.json({
      ...result,
      llmConfigured: await isActiveLlmConfigured(),
    });
  } catch (e) {
    // Order matters: LlmOutputIncompleteError extends LlmCallFailedError, so
    // it must be checked before the generic LlmCallFailedError branch.
    if (e instanceof LlmNotConfiguredError) {
      return Response.json(
        { error: "LLM_NOT_CONFIGURED", detail: "AI 模型未配置，请在设置页配置" },
        { status: 500 },
      );
    }
    if (e instanceof LlmRateLimitError) {
      return Response.json(
        {
          error: "LLM_RATE_LIMITED",
          detail: "AI 服务繁忙，请稍后重试",
          retryAfterMs: e.retryAfterMs,
        },
        { status: 429 },
      );
    }
    if (e instanceof LlmTimeoutError) {
      return Response.json(
        { error: "LLM_TIMEOUT", detail: "AI 响应超时，请重试" },
        { status: 504 },
      );
    }
    if (e instanceof LlmJsonModeUnsupportedError) {
      return Response.json(
        { error: "LLM_JSON_MODE_UNSUPPORTED", detail: "当前模型不支持 JSON 模式" },
        { status: 400 },
      );
    }
    if (e instanceof LlmStreamCorruptedError) {
      return Response.json(
        { error: "LLM_STREAM_CORRUPTED", detail: "AI 流式响应异常" },
        { status: 502 },
      );
    }
    if (e instanceof LlmEmptyResponseError) {
      return Response.json(
        { error: "LLM_EMPTY_RESPONSE", detail: "AI 返回为空" },
        { status: 502 },
      );
    }
    if (e instanceof LlmOutputIncompleteError) {
      return Response.json(
        {
          error: "LLM_OUTPUT_INCOMPLETE",
          detail: `AI 输出字段不完整：${e.missingFields.join("、")}`,
          upstreamSummary: e.upstreamSummary,
        },
        { status: 502 },
      );
    }
    if (e instanceof LlmCallFailedError) {
      return Response.json(
        {
          error: "LLM_CALL_FAILED",
          detail: e.message,
          upstreamSummary: e.upstreamSummary,
        },
        { status: 502 },
      );
    }
    const message = e instanceof Error ? e.message : String(e);
    return Response.json(
      { error: "LLM_CALL_FAILED", detail: message },
      { status: 500 },
    );
  }
}
