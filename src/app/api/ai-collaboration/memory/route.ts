import { NextRequest } from "next/server";
import { authenticateLegacyAiStudent } from "@/lib/ai-collaboration/legacy-scope";
import {
  dismissProjectMemories,
  listProjectMemories,
  projectMemoryContinuation,
  updateProjectMemory,
} from "@/lib/ai-collaboration/project-support-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clean(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, maxLength)
    : "";
}

async function scope(request: NextRequest, values?: { courseId?: unknown; studentId?: unknown }) {
  const url = new URL(request.url);
  const courseId = clean(values?.courseId ?? url.searchParams.get("courseId"), 120);
  const studentId = clean(values?.studentId ?? url.searchParams.get("studentId"), 120);
  if (!courseId) return Response.json({ error: "MISSING_PARAMETERS" }, { status: 400 });
  const authentication = await authenticateLegacyAiStudent(request, courseId, studentId);
  if (authentication instanceof Response) return authentication;
  return { courseId, authentication };
}

export async function GET(request: NextRequest) {
  const resolved = await scope(request);
  if (resolved instanceof Response) return resolved;
  const memories = await listProjectMemories(resolved.authentication.participationId);
  return Response.json({ memories, continuation: projectMemoryContinuation(memories) });
}

export async function PATCH(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const resolved = await scope(request, body);
  if (resolved instanceof Response) return resolved;
  const action = clean(body.action, 40);
  if (action === "clear") {
    await dismissProjectMemories({ participationId: resolved.authentication.participationId, clearAll: true });
  } else if (action === "update") {
    const changed = await updateProjectMemory({
      participationId: resolved.authentication.participationId,
      memoryId: clean(body.memoryId, 180),
      content: clean(body.content, 500),
    });
    if (!changed) return Response.json({ error: "MEMORY_NOT_FOUND" }, { status: 404 });
  } else {
    return Response.json({ error: "INVALID_ACTION" }, { status: 400 });
  }
  return Response.json({ memories: await listProjectMemories(resolved.authentication.participationId) });
}

export async function DELETE(request: NextRequest) {
  const resolved = await scope(request);
  if (resolved instanceof Response) return resolved;
  const url = new URL(request.url);
  const memoryId = clean(url.searchParams.get("memoryId"), 180);
  const sourceMessageId = clean(url.searchParams.get("sourceMessageId"), 180);
  if (!memoryId && !sourceMessageId) return Response.json({ error: "MISSING_PARAMETERS" }, { status: 400 });
  const changed = await dismissProjectMemories({
    participationId: resolved.authentication.participationId,
    memoryId: memoryId || undefined,
    sourceMessageId: sourceMessageId || undefined,
  });
  return Response.json({ changed, memories: await listProjectMemories(resolved.authentication.participationId) });
}
