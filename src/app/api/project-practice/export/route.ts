// @ts-nocheck
import JSZip from "jszip";
import { z } from "zod";
import { buildStudentAiInteractionTurns } from "@/lib/ai-collaboration/interaction-transcript";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { isDatabaseConfigured, prisma } from "@/lib/db/client";
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

function toEvent(row: {
  id: string;
  courseId: string;
  studentId: string;
  stageKey: string;
  conversationId: string | null;
  source: string;
  eventType: string;
  actorRole: string;
  actorId: string | null;
  content: string | null;
  payload: unknown;
  requestId: string | null;
  createdAt: Date;
}): AiInteractionEvent {
  return {
    id: row.id,
    courseId: row.courseId,
    studentId: row.studentId,
    stageKey: row.stageKey,
    conversationId: row.conversationId ?? undefined,
    source: row.source as AiInteractionEvent["source"],
    eventType: row.eventType as AiInteractionEvent["eventType"],
    actorRole: row.actorRole as AiInteractionEvent["actorRole"],
    actorId: row.actorId ?? undefined,
    content: row.content ?? undefined,
    payload: (row.payload as Record<string, unknown>) ?? undefined,
    requestId: row.requestId ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function GET(request: Request) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  if (auth.claims.role !== "teacher") return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  if (!isDatabaseConfigured()) return Response.json({ error: "DATABASE_REQUIRED" }, { status: 503 });
  const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "INVALID_REQUEST", message: "导出参数无效。" }, { status: 400 });
  const query = parsed.data;
  const [course, students, events, versions] = await Promise.all([
    prisma.course.findUnique({ where: { id: query.courseId }, select: { id: true, name: true } }),
    prisma.student.findMany({
      where: { courseId: query.courseId, ...(query.studentId ? { id: query.studentId } : {}) },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
    prisma.aiInteractionEvent.findMany({
      where: { courseId: query.courseId, stageKey: "make", ...(query.studentId ? { studentId: query.studentId } : {}) },
      orderBy: [{ studentId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.projectDocumentVersion.findMany({
      where: { courseId: query.courseId, stageKey: "make", ...(query.studentId ? { studentId: query.studentId } : {}) },
      select: { id: true, studentId: true, sequence: true, title: true, status: true, submittedAt: true, createdAt: true },
      orderBy: [{ studentId: "asc" }, { sequence: "asc" }],
    }),
  ]);
  if (!course) return Response.json({ error: "COURSE_NOT_FOUND" }, { status: 404 });
  if (query.studentId && !students.length) return Response.json({ error: "STUDENT_NOT_FOUND" }, { status: 404 });
  const exportedAt = new Date().toISOString();
  const eventRows = events.map(toEvent);
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
        submittedAt: (version.submittedAt ?? version.createdAt).toISOString(),
      }));
    return {
      schemaVersion: 2,
      exportedAt,
      course: { id: course.id, name: course.name, stageKey: "make", stageName: "项目实践" },
      student: { id: student.id, name: student.name },
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
