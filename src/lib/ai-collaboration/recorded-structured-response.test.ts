import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { recordedStructuredResponse, type StructuredModelAttempt } from "./recorded-structured-response";

describe("recorded structured model output", () => {
  const base = () => ({ parse: JSON.parse, valid: (value: Record<string, unknown>) => typeof value.complete === "boolean", signal: new AbortController().signal });
  it("retains a full no-comment output before returning a usable result", async () => {
    const raw = JSON.stringify({ complete: true, comments: [], reason: "完整原文".repeat(5000) });
    const records: StructuredModelAttempt[] = [];
    const parsed = await recordedStructuredResponse({ ...base(), generate: async () => raw, record: async item => { records.push(item); } });
    expect(records).toEqual([{ raw, attempt: 1, validation: "valid", sha256: createHash("sha256").update(raw).digest("hex") }]);
    expect(parsed).toEqual(JSON.parse(raw));
  });
  it("keeps invalid JSON and invalid schema separately before a bounded retry", async () => {
    const records: StructuredModelAttempt[] = [];
    const generate = vi.fn().mockResolvedValueOnce('{"complete":').mockResolvedValueOnce('{"complete":"yes"}');
    await expect(recordedStructuredResponse({ ...base(), generate, record: async item => { records.push(item); } })).rejects.toThrow("AI_RESPONSE_INVALID_STRUCTURE");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(records.map(item => [item.attempt, item.validation, item.raw])).toEqual([[1, "invalid-json", '{"complete":'], [2, "invalid-schema", '{"complete":"yes"}']]);
  });
  it("never consumes another model answer when durable recording fails", async () => {
    const generate = vi.fn().mockResolvedValue('{"complete":');
    await expect(recordedStructuredResponse({ ...base(), generate, record: async () => { throw new Error("ENOSPC"); } })).rejects.toThrow("ENOSPC");
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("preserves the received raw on cancellation but does not repair it", async () => {
    const controller = new AbortController(); const record = vi.fn(async () => undefined);
    const generate = vi.fn(async () => { controller.abort(); return '{"complete":'; });
    await expect(recordedStructuredResponse({ ...base(), signal: controller.signal, generate, record })).rejects.toMatchObject({ name: "AbortError" });
    expect(record).toHaveBeenCalledTimes(1); expect(generate).toHaveBeenCalledTimes(1);
  });
});
