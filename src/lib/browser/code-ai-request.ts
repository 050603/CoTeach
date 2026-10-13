import { boundedFetch } from "./bounded-fetch";
import { clientUUID } from "@/lib/uuid";
import { COLLABORATION_BROWSER_TIMEOUT_MS } from "@/lib/ai-collaboration/request-budget";

export type PendingCodeAiRequest = { requestId: string; body: Record<string, unknown> };
export type CodeAiRequestChannel = "sidebar" | "comment";
const key = (scope: string, channel: CodeAiRequestChannel) => `openpbl:code-ai-request:v1:${scope}:${channel}`;
export function readPendingCodeAiRequest(scope: string, channel: CodeAiRequestChannel): PendingCodeAiRequest | null {
  try {
    const value = JSON.parse(localStorage.getItem(key(scope, channel)) ?? "null");
    return value && typeof value.requestId === "string" && value.body && typeof value.body === "object" ? value : null;
  } catch { return null; }
}
export function acknowledgeCodeAiRequest(scope: string, channel: CodeAiRequestChannel, requestId: string) {
  if (readPendingCodeAiRequest(scope, channel)?.requestId === requestId) localStorage.removeItem(key(scope, channel));
}

/** Persist the exact paid request before sending. A retry never silently switches to a newer artifact. */
export async function requestCodeAi(scope: string, channel: CodeAiRequestChannel, body: Record<string, unknown>) {
  let pending = readPendingCodeAiRequest(scope, channel);
  if (pending && (pending.body.message !== body.message || pending.body.intent !== body.intent || pending.body.commentThreadId !== body.commentThreadId)) {
    throw new Error("上一次 AI 请求尚未确认，请先恢复上次结果。");
  }
  pending ??= { requestId: `code-ai:${clientUUID()}`, body };
  // A storage failure must stop before a request whose result could not be recovered.
  localStorage.setItem(key(scope, channel), JSON.stringify(pending));
  const query = new URLSearchParams({ courseId: String(pending.body.courseId), studentId: String(pending.body.studentId),
    stageKey: String(pending.body.stageKey), language: String(pending.body.language), requestId: pending.requestId });
  const status = () => boundedFetch(`/api/ai-collaboration/code?${query}`, { cache: "no-store" });
  let response = await status();
  const receipt = response.status === 503 ? await response.clone().json().catch(() => null) : null;
  if (response.status === 503 && receipt?.status === "failed" && receipt?.retryable === true && receipt.requestId === pending.requestId) {
    response = await boundedFetch("/api/ai-collaboration/code", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Request-Id": pending.requestId },
      body: JSON.stringify({ ...pending.body, requestId: pending.requestId }),
    }, COLLABORATION_BROWSER_TIMEOUT_MS);
  }
  const deadline = Date.now() + COLLABORATION_BROWSER_TIMEOUT_MS;
  while (response.status === 202 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
    response = await status();
  }
  if (response.status === 202) throw new Error("AI 组员仍在处理，可以稍后恢复这次请求，无需重新发送。");
  return { response, pending };
}

/** Background duplicates join the original receipt; HTTP 202 is not a completed review. */
export async function requestBackgroundCodeAi(body: Record<string, unknown>, signal: AbortSignal) {
  let response = await boundedFetch("/api/ai-collaboration/code", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  }, COLLABORATION_BROWSER_TIMEOUT_MS);
  const deadline = Date.now() + COLLABORATION_BROWSER_TIMEOUT_MS;
  while (response.status === 202 && Date.now() < deadline) {
    const payload = await response.json() as { requestId?: string };
    if (!payload.requestId) throw new Error("AI 后台检查尚未取得请求回执。");
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1_500);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    const query = new URLSearchParams({ courseId: String(body.courseId), studentId: String(body.studentId),
      stageKey: String(body.stageKey), language: String(body.language), requestId: payload.requestId });
    response = await boundedFetch(`/api/ai-collaboration/code?${query}`, { cache: "no-store", signal });
  }
  if (response.status === 202) throw new Error("AI 后台检查仍在处理中，稍后自动恢复。");
  return response;
}
