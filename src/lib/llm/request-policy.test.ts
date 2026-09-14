import { describe, expect, it } from "vitest";
import {
  DURABLE_GENERATION_TRANSIENT_RETRIES,
  requestClassForCourseContentAction,
  resolveLlmRequestTimeoutMs,
} from "./request-policy";

describe("LLM request timeout policy", () => {
  it("keeps durable generation retries bounded while spanning a transient outage", () => {
    expect(DURABLE_GENERATION_TRANSIENT_RETRIES).toBe(4);
  });
  it("gives long structured course outputs substantially more time", () => {
    expect(resolveLlmRequestTimeoutMs("standard", {})).toBe(180_000);
    expect(resolveLlmRequestTimeoutMs("page-generation", {})).toBe(180_000);
    expect(resolveLlmRequestTimeoutMs("quality-review", {})).toBe(300_000);
    expect(resolveLlmRequestTimeoutMs("long-generation", {})).toBe(600_000);
  });

  it("allows the bounded quality-review timeout to be configured independently", () => {
    expect(resolveLlmRequestTimeoutMs("quality-review", {
      OPENPBL_LLM_QUALITY_REVIEW_TIMEOUT_MS: "45000",
      OPENPBL_LLM_LONG_REQUEST_TIMEOUT_MS: "900000",
    })).toBe(45_000);
  });

  it("supports bounded operator overrides", () => {
    expect(resolveLlmRequestTimeoutMs("standard", {
      OPENPBL_LLM_REQUEST_TIMEOUT_MS: "240000",
    })).toBe(240_000);
    expect(resolveLlmRequestTimeoutMs("page-generation", {
      OPENPBL_LLM_PAGE_REQUEST_TIMEOUT_MS: "120000",
    })).toBe(120_000);
    expect(resolveLlmRequestTimeoutMs("long-generation", {
      OPENPBL_LLM_LONG_REQUEST_TIMEOUT_MS: "900000",
    })).toBe(900_000);
    expect(resolveLlmRequestTimeoutMs("long-generation", {
      OPENPBL_LLM_LONG_REQUEST_TIMEOUT_MS: "99999999",
    })).toBe(1_800_000);
  });

  it("classifies output-heavy curriculum actions as long generation", () => {
    expect(requestClassForCourseContentAction("knowledgeGraph")).toBe("long-generation");
    expect(requestClassForCourseContentAction("teachingOutline")).toBe("long-generation");
    expect(requestClassForCourseContentAction("lessonOutline")).toBe("long-generation");
    expect(requestClassForCourseContentAction("fullCourse")).toBe("long-generation");
    expect(requestClassForCourseContentAction("evaluationPlan")).toBe("standard");
  });
});
