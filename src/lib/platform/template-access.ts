import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { prisma } from "@/lib/db/client";
import { getPlatformUser } from "./access";

export async function authorizeTemplateRequest(request: Request, templateId: string): Promise<string | Response> {
  if (!["GET", "HEAD"].includes(request.method)) { const csrf = requireSameOrigin(request); if (csrf) return csrf; }
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const user = await getPlatformUser(auth.claims);
  if (!user || user.role !== "teacher") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const template = await prisma.classroomTemplate.findUnique({ where: { id: templateId }, select: { ownerId: true, status: true } });
  if (!template) return Response.json({ error: "Template not found" }, { status: 404 });
  if (template.ownerId !== user.id) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (template.status.toUpperCase() === "DELETED") return Response.json({ error: "Template not found" }, { status: 404 });
  if (template.status.toUpperCase() === "ARCHIVED" && request.method !== "GET") return Response.json({ error: "Template archived" }, { status: 409 });
  return user.id;
}
