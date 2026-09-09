import { z } from "zod";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { authorizeLegacyAiScope, legacyAiError } from "@/lib/ai-collaboration/legacy-scope";
import { listProjectDocumentVersions } from "@/lib/project-practice/versions";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const QuerySchema = z.object({ courseId: z.string().min(1).max(128), studentId: z.string().min(1).max(128).optional(), submissionId: z.string().min(1).max(128).optional(), stageKey: z.string().min(1).max(64).default("make") }).strict();
export async function GET(request: Request) {
  const auth = await authenticateRequest(request); if ("response" in auth) return auth.response;
  const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "INVALID_REQUEST", message: "查询参数无效。" }, { status: 400 });
  try {
    const scope = await authorizeLegacyAiScope(auth.claims, parsed.data.courseId, parsed.data.studentId);
    const versions = await listProjectDocumentVersions({ ...parsed.data, studentId: scope.studentId });
    return Response.json({ versions: versions.map(row => ({ ...row, downloadUrl: row.docxUploadId ? `/api/uploads/${row.docxUploadId}?download=1` : undefined })) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return legacyAiError(error); }
}
