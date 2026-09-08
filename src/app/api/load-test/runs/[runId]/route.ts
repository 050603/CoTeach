// @ts-nocheck
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { authorizeLoadTestRequest } from "@/lib/load-test/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RunIdSchema = z.string().uuid();

export async function DELETE(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const denied = authorizeLoadTestRequest(request);
  if (denied) return denied;
  const parsed = RunIdSchema.safeParse((await context.params).runId);
  if (!parsed.success) {
    return Response.json({ code: "INVALID_RUN_ID", message: "Invalid runId." }, { status: 400 });
  }
  const run = await prisma.loadTestRun.findUnique({ where: { runId: parsed.data } });
  if (!run) return new Response(null, { status: 204 });
  const teacherUsernamePrefix = `load_${parsed.data.replaceAll("-", "").slice(0, 20)}`;

  await prisma.$transaction(async (tx) => {
    await tx.uploadFile.deleteMany({ where: { courseId: run.courseId } });
    await tx.studentAccount.deleteMany({ where: { courseId: run.courseId } });
    await tx.course.delete({ where: { id: run.courseId } });
    await tx.teacher.deleteMany({
      where: { username: { startsWith: teacherUsernamePrefix } },
    });
    await tx.courseEvent.deleteMany({ where: { courseId: run.courseId } });
    await tx.courseMutationReceipt.deleteMany({ where: { courseId: run.courseId } });
    await tx.loadTestRun.delete({ where: { runId: parsed.data } });
  });
  return new Response(null, { status: 204 });
}
