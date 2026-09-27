import { describe, expect, it } from "vitest";
import { readDocumentRequestHtml, readDocumentRequestMessage } from "./document-request-input";

describe("document request question boundary", () => {
  it("preserves document whitespace and the entire 120000-character boundary", () => {
    const documentHtml = ` \n${"稿".repeat(119_996)}\t `;
    expect(documentHtml.length).toBe(120_000);
    expect(readDocumentRequestHtml(documentHtml)).toEqual({ ok: true, documentHtml });
  });
  it("rejects oversized document context without silently changing its request fingerprint", () => {
    expect(readDocumentRequestHtml("稿".repeat(120_001))).toEqual({ ok: false });
  });
  it("preserves a question exactly at the 1200-character limit", () => {
    const message = ` ${"问".repeat(1198)} `;
    expect(readDocumentRequestMessage(message)).toEqual({ ok: true, message });
  });
  it("rejects an oversized question instead of assigning its truncated prefix to the request", () => {
    expect(readDocumentRequestMessage("问".repeat(1201))).toEqual({ ok: false });
  });
  it("leaves optional absent and whitespace-only messages empty for action validation", () => {
    expect(readDocumentRequestMessage(undefined)).toEqual({ ok: true, message: "" });
    expect(readDocumentRequestMessage(" \n ")).toEqual({ ok: true, message: "" });
  });
});
