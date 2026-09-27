import { createHash } from "node:crypto";

export type StructuredModelAttempt = {
  raw: string; sha256: string; attempt: number;
  validation: "received" | "valid" | "invalid-json" | "invalid-schema";
};

/** Save each original output before using it or asking the model to repair it. */
export async function recordedStructuredResponse(input: {
  generate: (attempt: number) => Promise<string>;
  parse: (raw: string) => unknown;
  valid: (value: Record<string, unknown>) => boolean;
  record: (attempt: StructuredModelAttempt) => Promise<void>;
  signal: AbortSignal;
  maxCalls?: number;
}): Promise<Record<string, unknown>> {
  const maxCalls = input.maxCalls ?? 2;
  for (let attempt = 1; attempt <= maxCalls; attempt++) {
    input.signal.throwIfAborted();
    const raw = await input.generate(attempt);
    let parsed: Record<string, unknown> | undefined;
    let validation: StructuredModelAttempt["validation"] = "invalid-json";
    try {
      const value = input.parse(raw);
      validation = "invalid-schema";
      if (value && typeof value === "object" && !Array.isArray(value) && input.valid(value as Record<string, unknown>)) {
        parsed = value as Record<string, unknown>; validation = "valid";
      }
    } catch { /* The exact failed output is retained below. */ }
    // This await must remain outside parsing's catch. A storage failure cannot
    // be treated as malformed JSON and silently replaced by a second model call.
    await input.record({ raw, sha256: createHash("sha256").update(raw).digest("hex"), attempt, validation });
    input.signal.throwIfAborted();
    if (parsed) return parsed;
  }
  throw new Error("AI_RESPONSE_INVALID_STRUCTURE");
}
