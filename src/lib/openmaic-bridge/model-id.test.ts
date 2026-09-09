import { describe, expect, it } from "vitest";
import { qualifyModelForProvider, splitModelIds } from "./model-id";

describe("model-id helpers", () => {
  it("prefixes bare model IDs with the selected provider", () => {
    expect(qualifyModelForProvider("deepseek-v4-flash", "deepseek")).toBe(
      "deepseek:deepseek-v4-flash",
    );
  });

  it("keeps already-qualified model IDs unchanged", () => {
    expect(qualifyModelForProvider("qwen:qwen3.7-plus", "deepseek")).toBe("qwen:qwen3.7-plus");
  });

  it("prefixes Bedrock model IDs whose native identifier contains a colon", () => {
    expect(qualifyModelForProvider("us.amazon.nova-pro-v1:0", "bedrock")).toBe(
      "bedrock:us.amazon.nova-pro-v1:0",
    );
  });

  it("splits comma, Chinese comma, and newline separated model lists", () => {
    expect(splitModelIds("gpt-5.4-mini，gpt-5.4\n gpt-5.5")).toEqual([
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-5.5",
    ]);
  });
});
