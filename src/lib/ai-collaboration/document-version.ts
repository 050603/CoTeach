/** Match the server's SHA-256(JSON.stringify(documentHtml)) version token. */
export async function documentVersionDigest(html: string, subtle: SubtleCrypto | null | undefined = globalThis.crypto?.subtle): Promise<string | null> {
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(html)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
