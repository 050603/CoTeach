import { z } from "zod";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { isDatabaseConfigured, prisma } from "@/lib/db/client";
import { canAccessLegacyCourse } from "@/lib/platform/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  courseId: z.string().min(1).max(128),
  studentId: z.string().min(1).max(128).optional(),
  submissionId: z.string().min(1).max(128).optional(),
  stageKey: z.string().min(1).max(64).default("make"),
}).strict();

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  if (!isDatabaseConfigured()) return Response.json({ versions: [] });
  const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "INVALID_REQUEST", message: "查询参数无效。" }, { status: 400 });
  const query = parsed.data;
  if (auth.claims.role === "student" && auth.claims.courseId !== query.courseId) {
    return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  if (!(await canAccessLegacyCourse(auth.claims, query.courseId, "read"))) {
    return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  const studentId = auth.claims.role === "student" ? auth.claims.studentId : query.studentId;
  const rows = await prisma.projectDocumentVersion.findMany({
    where: {
      courseId: query.courseId,
      stageKey: query.stageKey,
      ...(studentId ? { studentId } : {}),
      ...(query.submissionId ? { submissionId: query.submissionId } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { sequence: "desc" }],
    take: 500,
  });
  return Response.json({
    versions: rows.map((row) => ({
      id: row.id,
      courseId: row.courseId,
      submissionId: row.submissionId,
      studentId: row.studentId,
      stageKey: row.stageKey,
      sequence: row.sequence,
      sourceVersion: row.sourceVersion,
      title: row.title,
      sourceHtml: row.sourceHtml,
      docxUploadId: row.docxUploadId ?? undefined,
      docxSha256: row.docxSha256 ?? undefined,
      docxSize: row.docxSize ?? undefined,
      status: row.status,
      error: row.error ?? undefined,
      requestId: row.requestId ?? undefined,
      submittedAt: row.submittedAt?.toISOString(),
      createdAt: row.createdAt.toISOString(),
      downloadUrl: row.docxUploadId ? `/api/uploads/${row.docxUploadId}?download=1` : undefined,
    })),
  });
}
