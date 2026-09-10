import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { jsonError } from "@/lib/platform/http";
import { PlatformError } from "@/lib/platform/repository";
import {
  createStudentRecordsArchive,
  STUDENT_RECORD_EXPORT_SECTIONS,
} from "@/lib/platform/student-record-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const schema = z.object({
  enrollmentIds: z.array(z.string().trim().min(1).max(200)).min(1).max(5000),
  sections: z.array(z.enum(STUDENT_RECORD_EXPORT_SECTIONS)).min(1).max(STUDENT_RECORD_EXPORT_SECTIONS.length),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ offeringId: string }> }) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请选择要导出的学生和数据类型", 400);
  try {
    const { offeringId } = await context.params;
    const archive = await createStudentRecordsArchive(
      auth.claims,
      offeringId,
      parsed.data.enrollmentIds,
      parsed.data.sections,
    );
    return new Response(archive.bytes as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(archive.bytes.length),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(archive.fileName)}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "STUDENT_EXPORT_FAILED", "无法生成学生学习记录数据包", 503);
  }
}
