import { showcaseStore } from "@/lib/showcase/persistence";
import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { z } from "zod";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { isDatabaseConfigured, prisma } from "@/lib/db/client";
import { canAccessLegacyCourse } from "@/lib/platform/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ParamsSchema = z.object({ courseId: z.string().min(1).max(128) });

function safeFilePart(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-").replace(/\s+/g, " ").trim().slice(0, 100) || "未命名";
}

export async function GET(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  if (auth.claims.role !== "teacher") return new Response(null, { status: 403 });
  if (!isDatabaseConfigured()) return Response.json({ message: "成果收集需要连接数据库。" }, { status: 503 });
  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) return new Response(null, { status: 404 });
  const { courseId } = parsed.data;
  if (!(await canAccessLegacyCourse(auth.claims, courseId, "read"))) return new Response(null, { status: 403 });

  const [course, students, documents, outcomes] = await Promise.all([
    showcaseStore.loadCourse({ where: { id: courseId }, select: { id: true, name: true } }),
    showcaseStore.listStudents({ where: { courseId }, select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] }),
    showcaseStore.listDocuments({
      where: { courseId, stageKey: "make", status: "submitted", docxUploadId: { not: null } },
      select: { studentId: true, sequence: true, title: true, docxUploadId: true, submittedAt: true, createdAt: true },
      orderBy: [{ studentId: "asc" }, { submittedAt: "desc" }, { createdAt: "desc" }, { sequence: "desc" }],
    }),
    showcaseStore.listFiles({
      where: { courseId, stageKey: "make", status: "submitted" },
      select: { studentId: true, sequence: true, title: true, uploadId: true, kind: true },
      orderBy: [{ studentId: "asc" }, { sequence: "asc" }],
    }),
  ]);
  if (!course) return new Response(null, { status: 404 });

  const latestDocumentByStudent = new Map<string, typeof documents[number]>();
  for (const document of documents) {
    if (!latestDocumentByStudent.has(document.studentId)) latestDocumentByStudent.set(document.studentId, document);
  }
  const uploadIds = [
    ...Array.from(latestDocumentByStudent.values()).flatMap((document) => document.docxUploadId ? [document.docxUploadId] : []),
    ...outcomes.map((outcome) => outcome.uploadId),
  ];
  const uploads = uploadIds.length ? await prisma.fileAsset.findMany({
    where: { id: { in: uploadIds }, deletedAt: null },
    select: { id: true, originalName: true, storageKey: true },
  }) : [];
  const uploadById = new Map(uploads.map((upload) => [upload.id, upload]));
  const dataDir = process.env.UPLOAD_DIR?.trim() || path.resolve(".openpbl-data", "uploads");
  const zip = new JSZip();
  let included = 0;

  async function addUpload(folderName: string, prefix: string, uploadId: string) {
    const upload = uploadById.get(uploadId);
    if (!upload || path.basename(upload.storageKey) !== upload.storageKey) return;
    try {
      const bytes = await readFile(/* turbopackIgnore: true */ path.join(dataDir, upload.storageKey));
      zip.file(`${folderName}/${safeFilePart(prefix)}-${safeFilePart(upload.originalName)}`, bytes);
      included += 1;
    } catch {
      // A missing physical upload is omitted while the remaining class archive is still delivered.
    }
  }

  for (const student of students) {
    const folderName = `${safeFilePart(student.name)}-${safeFilePart(student.id)}`;
    const document = latestDocumentByStudent.get(student.id);
    if (document?.docxUploadId) await addUpload(folderName, `主文档-v${document.sequence}`, document.docxUploadId);
    for (const outcome of outcomes.filter((item) => item.studentId === student.id)) {
      await addUpload(folderName, `${outcome.kind === "pdf" ? "展示PDF" : "本地成果"}-v${outcome.sequence}`, outcome.uploadId);
    }
  }

  zip.file("成果清单.txt", `课程：${course.name}\n学生人数：${students.length}\n收集文件数：${included}\n导出时间：${new Date().toLocaleString("zh-CN")}\n`);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const fileName = `${safeFilePart(course.name)}-全班汇报成果.zip`;
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
