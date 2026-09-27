export const MAX_DOCUMENT_MESSAGE_LENGTH = 1_200;
export const MAX_DOCUMENT_HTML_LENGTH = 120_000;

/** Context limits must not silently change the text bound to the request receipt. */
export function readDocumentRequestHtml(value: unknown): { ok: true; documentHtml: string } | { ok: false } {
  if (typeof value !== "string") return { ok: true, documentHtml: "" };
  return value.length > MAX_DOCUMENT_HTML_LENGTH ? { ok: false } : { ok: true, documentHtml: value };
}

/** Keep an accepted question intact; never bind a request ID to silently truncated input. */
export function readDocumentRequestMessage(value: unknown): { ok: true; message: string } | { ok: false } {
  if (typeof value !== "string") return { ok: true, message: "" };
  if (value.length > MAX_DOCUMENT_MESSAGE_LENGTH) return { ok: false };
  return { ok: true, message: value.trim() ? value : "" };
}
