import { createHash } from "node:crypto";
import type { CompanionMessage } from "@/lib/session/types";
import type { AiInteractionEventInput } from "./audit-store";
import { claimDocumentRequest, completeDocumentRequest, failDocumentRequest, prepareDocumentRequestResponse, readDocumentRequestReceipt, type DocumentRequestInput } from "./document-request-store";
import { getActiveAiSettings } from "@/lib/llm/settings";
import { recordAiCacheEvent } from "@/lib/observability/classroom-ai";

export const codeRequestDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Bind background reuse to the exact model prompts and response policy, never to a runtime course version. */
export async function codeBackgroundRequestId(input: { prompts: { system: string; user: string }; action: string; language: string; context?: unknown }) {
  const settings = await getActiveAiSettings();
  return `code-background:${codeRequestDigest({ ...input, policyVersion: 3,
    endpoint: settings.endpoint || process.env.OPENPBL_LLM_ENDPOINT,
    model: settings.model || process.env.OPENPBL_LLM_MODEL })}`;
}

export async function beginCodeRequest(input: DocumentRequestInput) {
  const claim = await claimDocumentRequest(input);
  if (claim.kind === "conflict") return { response: Response.json({ error: "REQUEST_ID_CONFLICT", message: "这次请求的内容已变化，请使用原请求重试。" }, { status: 409 }) };
  if (claim.kind === "existing") {
    recordAiCacheEvent("code-collaboration", claim.state.status === "completed" ? "hit" : "joined");
    const receipt = await readDocumentRequestReceipt(input);
    return { response: Response.json(receipt.body, { status: receipt.status }) };
  }
  recordAiCacheEvent("code-collaboration", "miss");
  const finish = async (body: Record<string, unknown>, messages: CompanionMessage[], events: AiInteractionEventInput[] = []) => {
      const response = { ...body, requestId: input.requestId, status: "completed", artifactVersion: input.documentVersion };
      const prepared = await prepareDocumentRequestResponse({ ...input, token: claim.token,
        response: { body, messages, events } });
      if (!prepared) {
        const receipt = await readDocumentRequestReceipt(input);
        return Response.json(receipt.body, { status: receipt.status });
      }
      const committed = await completeDocumentRequest({ ...input, token: claim.token, messages, response,
        auditEvents: events.map((event, index) => ({
          idempotencyKey: `code-ai:${input.participationId}:${input.requestId}:${index}`,
          eventType: event.eventType, actor: event.actorRole === "ai" ? "assistant" : event.actorRole,
          content: event.content ?? "",
          payload: { schemaVersion: 1, legacy: { stageKey: input.stageKey, source: event.source,
            conversationId: event.conversationId ?? null, actorId: event.actorId ?? null }, detail: event.payload ?? {} },
        })),
      });
      if (committed) return Response.json(response);
      const receipt = await readDocumentRequestReceipt(input);
      return Response.json(receipt.body, { status: receipt.status });
  };
  if (claim.preparedResponse) {
    const { body, messages, events } = claim.preparedResponse;
    if (body && typeof body === "object" && Array.isArray(messages) && Array.isArray(events)) {
      try { return { response: await finish(body as Record<string, unknown>, messages as CompanionMessage[], events as AiInteractionEventInput[]) }; }
      catch (error) {
        await failDocumentRequest({ ...input, token: claim.token, error: "CODE_RECEIPT_RETRY_FAILED" });
        throw error;
      }
    }
  }
  return { history: claim.history, finish,
    async fail(error: unknown, fallback: Response) {
      await failDocumentRequest({ ...input, token: claim.token, error: error instanceof Error ? error.name : "CODE_AI_FAILED" });
      // A commit may have succeeded before its acknowledgement was lost.
      const receipt = await readDocumentRequestReceipt(input);
      return receipt.status === 200 || receipt.status === 202 ? Response.json(receipt.body, { status: receipt.status }) : fallback;
    },
  };
}
