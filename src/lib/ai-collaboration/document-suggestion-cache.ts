import { createHash } from "node:crypto";
import { recordAiCacheEvent } from "@/lib/observability/classroom-ai";
import {
  claimDocumentRequest,
  completeDocumentRequest,
  failDocumentRequest,
  prepareDocumentRequestResponse,
  readDocumentRequestReceipt,
  type DocumentRequestInput,
} from "./document-request-store";

// Bump when normalization or the two-stage suggestion contract changes.
const SUGGESTION_VERSION = 1;

export function buildDocumentSuggestionRequest(input: {
  courseId: string;
  studentId: string;
  participationId: string;
  stageKey: string;
  workspaceKind: string;
  threadStageKey: string;
  documentHtml: string;
  generationPrompts: { system: string; user: string };
  reviewPrompts: { system: string; user: string };
  model: { endpoint: string; model: string };
}): DocumentRequestInput {
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const fingerprint = hash({
    version: SUGGESTION_VERSION,
    courseId: input.courseId,
    studentId: input.studentId,
    participationId: input.participationId,
    stageKey: input.stageKey,
    workspaceKind: input.workspaceKind,
    // Hash the full document, including material omitted by existing prompts.
    documentHtml: input.documentHtml,
    generationPrompts: input.generationPrompts,
    reviewPrompts: input.reviewPrompts,
    model: { endpoint: input.model.endpoint, model: input.model.model },
  });
  return {
    requestId: `document-suggestions-${fingerprint}`,
    courseId: input.courseId,
    studentId: input.studentId,
    participationId: input.participationId,
    stageKey: input.stageKey,
    workspaceKind: input.workspaceKind,
    threadStageKey: input.threadStageKey,
    conversationId: "document-work-suggestions",
    documentVersion: hash(input.documentHtml),
    fingerprint,
    message: "",
    intent: "suggest-delegated-work",
    history: [],
  };
}

/** Database leases merge simultaneous tabs/workers, including empty successful results. */
export async function cachedDocumentSuggestions(
  task: DocumentRequestInput,
  generate: (token: string, candidateStarters?: string[]) => Promise<string[]>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const claim = await claimDocumentRequest(task);
  if (claim.kind === "conflict") {
    return { status: 409, body: { error: "REQUEST_ID_CONFLICT" } };
  }
  if (claim.kind === "existing") {
    const receipt = await readDocumentRequestReceipt(task);
    recordAiCacheEvent("document-suggestions", receipt.status === 200 ? "hit" : "joined");
    return { ...receipt, body: { ...receipt.body, resultSource: "reused" } };
  }
  try {
    const prepared = claim.preparedResponse?.starters;
    const reusable = Array.isArray(prepared) && prepared.every(item => typeof item === "string");
    const candidates = claim.preparedResponse?.candidateStarters;
    const candidateStarters = Array.isArray(candidates) && candidates.every(item => typeof item === "string")
      ? candidates as string[] : undefined;
    recordAiCacheEvent("document-suggestions", reusable ? "hit" : "miss");
    const starters = reusable ? prepared as string[] : await generate(claim.token, candidateStarters);
    const resultSource = reusable ? "reused" : "generated";
    const response = { starters, requestId: task.requestId, status: "completed", documentVersion: task.documentVersion };
    if (!reusable && !await prepareDocumentRequestResponse({ ...task, token: claim.token, response })) {
      return readDocumentRequestReceipt(task);
    }
    const committed = await completeDocumentRequest({
      ...task,
      token: claim.token,
      messages: [],
      response,
      auditEvents: [{
        idempotencyKey: `document-suggestions:${claim.token}`,
        eventType: "response",
        actor: "assistant",
        content: starters.join("\n"),
        payload: { action: task.intent, workspaceKind: task.workspaceKind, starters,
          resultSource, documentVersion: task.documentVersion,
          outcome: starters.length ? "suggestions" : "no-suggestion", suggestionVersion: SUGGESTION_VERSION },
      }],
    });
    if (!committed) return readDocumentRequestReceipt(task);
    return { status: 200, body: { ...response, resultSource } };
  } catch (error) {
    await failDocumentRequest({ ...task, token: claim.token, error: error instanceof Error ? error.message : "SUGGESTION_FAILED" });
    throw error;
  }
}
