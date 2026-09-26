/** UUIDs for browser request keys and editor records, including campus HTTP URLs. */
export function browserRandomUUID(): string {
  const source = globalThis.crypto;
  if (typeof source.randomUUID === "function") return source.randomUUID();

  // randomUUID requires HTTPS; getRandomValues is also available on plain HTTP.
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
