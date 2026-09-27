import { createHash } from "node:crypto";
import { parseLLMJson } from "@/lib/llm/client";

export type DocumentModelMessage = { role: "system" | "user" | "assistant"; content: string };
export type DocumentModelOutput = {
  attempt: number;
  raw: string;
  sha256: string;
  recovery?: "closed-outer-object";
};
export type InvalidDocumentModelAttempt = DocumentModelOutput & {
  reason: "INVALID_JSON" | "EXPECTED_OBJECT" | "INVALID_KIND" | "EMPTY_MESSAGE" | "INVALID_SUGGESTION";
};

export class DocumentModelStructureError extends Error {
  readonly code = "AI_RESPONSE_INVALID_STRUCTURE";
  constructor(readonly attempts: number, readonly reason: InvalidDocumentModelAttempt["reason"]) {
    super("AI_RESPONSE_INVALID_STRUCTURE");
    this.name = "DocumentModelStructureError";
  }
}

function inspect(raw: string): { value: Record<string, unknown> } | { reason: InvalidDocumentModelAttempt["reason"] } {
  let parsed: unknown;
  try { parsed = parseLLMJson(raw); }
  catch { return { reason: "INVALID_JSON" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { reason: "EXPECTED_OBJECT" };
  const value = parsed as Record<string, unknown>;
  if (typeof value.kind !== "string" || !["discussion", "edit-suggestion", "boundary"].includes(value.kind)) return { reason: "INVALID_KIND" };
  if (typeof value.message !== "string" || !value.message.trim()) return { reason: "EMPTY_MESSAGE" };
  if (value.kind === "edit-suggestion") {
    const suggestion = value.suggestion as Record<string, unknown> | null;
    if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)
      || typeof suggestion.replacement !== "string" || !suggestion.replacement.trim()
      || typeof suggestion.operation !== "string" || !["replace", "insert"].includes(suggestion.operation)) return { reason: "INVALID_SUGGESTION" };
  }
  return { value };
}

/** Recover only a missing outer object delimiter, never an unfinished value.
 * The original model bytes remain the audit evidence, including this defect. */
function closeCompleteOuterObject(raw: string): string | undefined {
  const text = raw.trim();
  if (!text.startsWith("{") || !/[}\]]$/.test(text)) return undefined;
  const expected: string[] = [];
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") expected.push(character === "{" ? "}" : "]");
    else if (character === "}" || character === "]") {
      if (expected.pop() !== character) return undefined;
    }
  }
  if (quoted || expected.length !== 1 || expected[0] !== "}") return undefined;
  const completed = `${text}}`;
  try { JSON.parse(completed); return completed; }
  catch { return undefined; }
}

/** Two bounded repairs share the caller's original deadline. Every answer is
 * durably recorded in full before use; display limits never truncate this evidence. */
export async function repairDocumentModelResponse(input: {
  raw: string;
  messages: DocumentModelMessage[];
  signal: AbortSignal;
  generate: (messages: DocumentModelMessage[], signal: AbortSignal) => Promise<string>;
  recordInvalid: (attempt: InvalidDocumentModelAttempt) => Promise<void>;
  recordSuccess: (attempt: DocumentModelOutput) => Promise<void>;
}): Promise<Record<string, unknown>> {
  let raw = input.raw;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = inspect(raw);
    const output = { attempt, raw, sha256: createHash("sha256").update(raw).digest("hex") };
    if ("value" in result) {
      await input.recordSuccess(output);
      return result.value;
    }
    await input.recordInvalid({ ...output, reason: result.reason });
    const completed = closeCompleteOuterObject(raw);
    const local = completed && inspect(completed);
    if (local && "value" in local) {
      input.signal.throwIfAborted();
      await input.recordSuccess({ ...output, recovery: "closed-outer-object" });
      return local.value;
    }
    if (attempt === 3) throw new DocumentModelStructureError(attempt, result.reason);
    input.signal.throwIfAborted();
    raw = await input.generate([
      ...input.messages,
      // Context may be bounded; recordInvalid above retains the original bytes.
      { role: "assistant", content: raw.slice(0, 12_000) },
      { role: "user", content: `上一条模型回答未通过结构校验（${result.reason}）。请修复后返回一个完整的严格 JSON 对象，不能返回数组、Markdown 或解释文字。
kind 必须仅选择 "discussion"、"edit-suggestion"、"boundary" 之一；不得把多个值用 | 连接。message 必须是非空字符串，focus 是本轮焦点字符串。
普通讨论的结构示例：{"kind":"discussion","message":"针对原问题的具体回应","focus":"本轮焦点","suggestion":null}。
只有提供文档修改建议时才使用 edit-suggestion；此时 suggestion 必须是对象，operation 只能是 "replace" 或 "insert"，replacement 必须是非空字符串，并包含 title、targetText、reason。
保持原任务、事实和教学边界；边界命中时仍使用 boundary。重新生成完整对象，不要为了满足格式而编造任务内容。` },
    ], input.signal);
  }
  throw new Error("UNREACHABLE_DOCUMENT_RESPONSE");
}
