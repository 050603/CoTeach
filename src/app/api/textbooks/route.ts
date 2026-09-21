import { after } from "next/server";
import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { TEXTBOOK_DOCX_LIMITS } from "@/lib/textbook/docx-parser";
import { textbookApiError } from "@/lib/textbook/http";
import { createTextbookFromUpload, listTextbooks } from "@/lib/textbook/service";
import { runTextbookIngestJob } from "@/lib/textbook/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1_800;

const QuerySchema = z.object({
  q: z.string().max(200).optional(),
  includeArchived: z.enum(["true", "false"]).optional(),
  status: z.enum(["PENDING", "PARSING", "WAITING_EMBEDDING", "READY", "FAILED"]).optional(),
});

export async function GET(request: Request) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({ q: url.searchParams.get("q") ?? undefined, includeArchived: url.searchParams.get("includeArchived") ?? undefined, status: url.searchParams.get("status") ?? undefined });
  if (!parsed.success) return Response.json({ code: "INVALID_TEXTBOOK_QUERY", message: "教材查询条件无效。" }, { status: 400 });
  try {
    return Response.json(await listTextbooks({ query: parsed.data.q, includeArchived: parsed.data.includeArchived === "true", revisionStatus: parsed.data.status }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return textbookApiError(request, error, "TEXTBOOK_LIST_FAILED", "暂时无法读取教材库。 ");
  }
}

export async function POST(request: Request) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > TEXTBOOK_DOCX_LIMITS.compressedBytes + 512 * 1024) {
    return Response.json({ code: "TEXTBOOK_FILE_SIZE_INVALID", message: "教材 Word 不能超过 80 MiB。" }, { status: 413 });
  }
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ code: "TEXTBOOK_FILE_REQUIRED", message: "请选择 .docx 教材文件。" }, { status: 400 });
    const titleValue = form.get("title");
    const authorValue = form.get("author");
    const title = typeof titleValue === "string" ? titleValue.trim().slice(0, 300) : undefined;
    const author = typeof authorValue === "string" ? authorValue.trim().slice(0, 300) : undefined;
    const result = await createTextbookFromUpload({
      bytes: Buffer.from(await file.arrayBuffer()), originalName: file.name, mimeType: file.type,
      title: title || undefined, author: author || undefined, maintainerId: auth.claims.sub!,
    });
    if (!result.deduplicated) after(() => runTextbookIngestJob(result.revision.id));
    return Response.json(result, { status: result.deduplicated ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return textbookApiError(request, error, "TEXTBOOK_UPLOAD_FAILED", "教材上传失败，请稍后重试。 ");
  }
}
