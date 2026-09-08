import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";

export async function hasCurrentSessionVersion(
  claims: AuthClaims,
): Promise<boolean> {
  if (!claims.sub) return false;
  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: { sessionVersion: true, status: true, role: true },
  });
  return Boolean(
    user
      && user.role.toLowerCase() === claims.role
      && user.status.toLowerCase() === "active"
      && user.sessionVersion === claims.sv,
  );
}
