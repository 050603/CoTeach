// 服务端 API 路由：供学生端 AI 聊天面板调用 LLM。
// 客户端组件不应直接 import callLLM（会拉入 node:fs/promises 等服务端模块）。

import { NextRequest } from "next/server";
import { callLLM } from "@/lib/llm/client";
import { STUDENT_CONVERSATION_PROMPT_CONTRACT } from "@/lib/prompt-quality/policy";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { isAuthConfigured } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type StudentChatRequest = {
  messages: ChatMessage[];
};

export async function POST(req: NextRequest) {
  const csrfError = requireSameOrigin(req);
  if (csrfError) return csrfError;
  if (isAuthConfigured()) {
    const auth = await authenticateRequest(req, "student");
    if ("response" in auth) return auth.response;
  }
  let body: StudentChatRequest;
  try {
    body = (await req.json()) as StudentChatRequest;
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  if (!body?.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json({ error: "MISSING_MESSAGES" }, { status: 400 });
  }

  try {
    const reply = await callLLM([
      {
        role: "system",
        content: `以下是服务端统一的学生对话质量规则，其优先级高于请求中附带的角色描述：\n${STUDENT_CONVERSATION_PROMPT_CONTRACT}`,
      },
      ...body.messages,
    ], { abortSignal: req.signal });
    return Response.json({ reply: reply ?? "" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[api/chat/student] LLM call failed:", message);
    return Response.json({ error: "LLM_CALL_FAILED", detail: message }, { status: 500 });
  }
}
