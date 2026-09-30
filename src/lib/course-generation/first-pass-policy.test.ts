import { describe, expect, it } from "vitest";
import { isFirstPassProviderRejection } from "./first-pass-policy";

describe("first-pass provider refusal", () => {
  it.each([429, 503])("allows an explicit HTTP %s refusal before output", (statusCode) => {
    expect(isFirstPassProviderRejection(Object.assign(new Error("refused"), { statusCode }))).toBe(true);
    expect(isFirstPassProviderRejection(new Error("SDK wrapper", {
      cause: Object.assign(new Error("refused"), { statusCode }),
    }))).toBe(true);
  });

  it.each([408, 500, 502, 504, 401, 403])("does not infer refusal from HTTP %s", (statusCode) => {
    expect(isFirstPassProviderRejection({ statusCode, isRetryable: true })).toBe(false);
  });

  it("does not replay ambiguous transport errors or any request with output", () => {
    const rejected = { statusCode: 503 };
    expect(isFirstPassProviderRejection(rejected, true)).toBe(false);
    expect(isFirstPassProviderRejection({ ...rejected, reasoningCharacters: 1 })).toBe(false);
    expect(isFirstPassProviderRejection({ ...rejected, rawResponse: "draft" })).toBe(false);
    expect(isFirstPassProviderRejection({ ...rejected, code: "LLM_STREAM_TRUNCATED" })).toBe(false);
    expect(isFirstPassProviderRejection({ ...rejected, isRetryable: false })).toBe(false);
    expect(isFirstPassProviderRejection({ isRetryable: true, code: "ECONNRESET" })).toBe(false);
    expect(isFirstPassProviderRejection(new DOMException("idle", "TimeoutError"))).toBe(false);
    expect(isFirstPassProviderRejection({ ...rejected, cause: { statusCode: 401 } })).toBe(false);
  });
});
