import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { TextbookError } from "@/lib/textbook/errors";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { textbookApiError } from "@/lib/textbook/http";
import { searchTextbookEvidence } from "@/lib/textbook/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const ParamsSchema = z.object({ id: z.string().uuid() });
const QuerySchema = z.object({ q: z.string().trim().min(1).max(2_000), sectionIds: z.array(z.string().uuid()).max(200), limit: z.number().int().min(1).max(100) });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return new Response(null, { status: 404 });
  const url = new URL(request.url);
  const query = QuerySchema.safeParse({ q: url.searchParams.get("q") ?? "", sectionIds: url.searchParams.getAll("sectionId"), limit: Number(url.searchParams.get("limit") ?? 20) });
  if (!query.success) return Response.json({ code: "INVALID_TEXTBOOK_SEARCH", message: "教材检索条件无效。" }, { status: 400 });
  try {
    const textbook = await prisma.textbook.findUnique({
      where: { id: params.data.id },
      select: {
        currentRevision: { select: { id: true } },
        revisions: { orderBy: { revision: "desc" }, take: 1, select: { id: true } },
      },
    });
    if (!textbook) throw new TextbookError("TEXTBOOK_NOT_FOUND", "教材不存在。", 404);
    const revision = textbook.currentRevision ?? textbook.revisions[0] ?? null;
    if (!revision) return Response.json({ query: query.data.q, degraded: true, degradationReason: "教材尚未完成结构解析。", hits: [] });
    return Response.json(await searchTextbookEvidence({ revisionIds: [revision.id], sectionIds: query.data.sectionIds, query: query.data.q, limit: query.data.limit }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return textbookApiError(request, error, "TEXTBOOK_SEARCH_FAILED", "暂时无法检索教材。 ");
  }
}
