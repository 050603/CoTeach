import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { documentVersionDigest } from "./document-version";

describe("document version digest", () => {
  it("matches the route's SHA-256 JSON string digest for Chinese HTML", async () => {
    const html = '<p>学生的结论：“5 人支持”</p><p data-id="a">下一步</p>';
    const serverDigest = createHash("sha256").update(JSON.stringify(html)).digest("hex");
    expect(await documentVersionDigest(html, webcrypto.subtle as unknown as SubtleCrypto)).toBe(serverDigest);
  });

  it("allows exact snapshot comparison when browser crypto is unavailable", async () => {
    expect(await documentVersionDigest("<p>草稿</p>", null)).toBeNull();
  });
});
