import JSZip from "jszip";
import { z } from "zod";
import { buildStudentAiInteractionTurns } from "@/lib/ai-collaboration/interaction-transcript";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { prisma } from "@/lib/db/client";
import { authorizeLegacyAiScope, legacyAiError } from "@/lib/ai-collaboration/legacy-scope";
import { listAiInteractionEvents } from "@/lib/ai-collaboration/audit-store";
import { listProjectDocumentVersions } from "@/lib/project-practice/versions";
import type { AiInteractionEvent } from "@/lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const QuerySchema = z.object({
  courseId: z.string().min(1).max(128),
  studentId: z.string().min(1).max(128).optional(),
}).strict();

function safeFilePart(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "student";
}

export async function GET(request: Request) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  if (auth.claims.role !== "teacher") return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "INVALID_REQUEST", message: "导出参数无效。" }, { status: 400 });
  const query = parsed.data;
  let scope: Awaited<ReturnType<typeof authorizeLegacyAiScope>>;
  try { scope = await authorizeLegacyAiScope(auth.claims, query.courseId, query.studentId); }
  catch (error) { return legacyAiError(error); }
  const course = { id: query.courseId, name: scope.instance.activity.title };
  const [participations, versions] = await Promise.all([
    prisma.classroomParticipation.findMany({ where: { instanceId: query.courseId, ...(query.studentId ? { enrollment: { userId: query.studentId } } : {}) }, include: { enrollment: { include: { user: { select: { id: true, displayName: true } } } } } }),
    listProjectDocumentVersions({ ...query, stageKey: "make" }),
  ]);
  const students = participations.map(p => ({ id: p.enrollment.user.id, name: p.enrollment.user.displayName, researchKey: p.enrollment.researchKey }));
  const eventRows: AiInteractionEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await listAiInteractionEvents({ ...query, stageKey: "make", limit: 500, cursor });
    eventRows.push(...page.events); cursor = page.nextCursor;
  } while (cursor);
  eventRows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const exportedAt = new Date().toISOString();
  const createStudentArchive = (student: typeof students[number]) => {
    const interactions = buildStudentAiInteractionTurns(eventRows.filter((event) => event.studentId === student.id));
    const modifications = interactions.flatMap((turn) =>
      turn.messages.flatMap((message) => message.modification ? [message.modification] : [])
    );
    const writingVersions = versions
      .filter((version) => version.studentId === student.id)
      .map((version) => ({
        version: version.sequence,
        title: version.title,
        status: version.status,
        submittedAt: (version.submittedAt ?? version.createdAt),
      }));
    return {
      schemaVersion: 2,
      exportedAt,
      course: { id: course.id, name: course.name, stageKey: "make", stageName: "项目实践" },
      student: { id: student.id, name: student.name, researchKey: student.researchKey },
      summary: {
        conversationCount: interactions.length,
        interactionTurnCount: interactions.length,
        interactionMessageCount: interactions.reduce((sum, turn) => sum + turn.messages.length, 0),
        aiModificationCount: modifications.length,
        adoptedModificationCount: modifications.filter((item) => item.decision === "adopted" && !item.undoneAt).length,
        writingVersionCount: writingVersions.length,
      },
      interactions,
      writingVersions,
    };
  };

  if (query.studentId) {
    const student = students[0];
    const body = JSON.stringify(createStudentArchive(student), null, 2);
    const fileName = `${safeFilePart(student.name)}-${safeFilePart(student.id)}-AI协作记录.json`;
    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  const zip = new JSZip();
  for (const student of students) {
    const fileName = `${safeFilePart(student.name)}-${safeFilePart(student.id)}.json`;
    zip.file(fileName, JSON.stringify(createStudentArchive(student), null, 2));
  }
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const fileName = `${safeFilePart(course.name)}-全班AI协作记录.zip`;
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
