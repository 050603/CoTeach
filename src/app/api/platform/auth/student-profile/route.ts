import { authenticateRequest } from "@/lib/auth/request-guards";
import { prisma } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request, "student");
  if ("response" in auth) return auth.response;
  const user = await prisma.user.findFirst({
    where: { id: auth.claims.sub, role: { in: ["STUDENT", "student"] }, status: { in: ["ACTIVE", "active"] } },
    select: { displayName: true, username: true },
  });
  if (!user) return Response.json({ message: "学生账号不存在或已停用" }, { status: 401 });
  return Response.json({ user: { ...user, role: "student" } }, { headers: { "Cache-Control": "private, no-store" } });
}
