import { TextbookError } from "./errors";

export function textbookApiError(request: Request, error: unknown, fallbackCode: string, fallbackMessage: string): Response {
  if (error instanceof TextbookError) {
    return Response.json({ code: error.code, message: error.message, requestId: request.headers.get("x-request-id") ?? "unknown" }, { status: error.status });
  }
  console.error(`[textbook] ${fallbackCode}`, error);
  return Response.json({ code: fallbackCode, message: fallbackMessage, requestId: request.headers.get("x-request-id") ?? "unknown" }, { status: 500 });
}
