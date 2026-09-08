import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";

export async function hasCurrentSessionVersion(
  claims: AuthClaims,
): Promise<boolean> {
  if (!claims.sub) return false;
  if (claims.role === "teacher") {
    const teacher = await prisma.teacher.findUnique({
      where: { id: claims.sub },
      select: { sessionVersion: true },
    });
    return teacher?.sessionVersion === claims.sv;
  }
  if (claims.role === "student" && "userId" in claims && typeof claims.userId === "string") {
    const user = await prisma.user.findUnique({
      where: { id: claims.userId },
      select: { sessionVersion: true, status: true, role: true },
    });
    if (user) return user.role === "student" && user.status === "active" && user.sessionVersion === claims.sv;
  }
  const account = await prisma.studentAccount.findUnique({
    where: {
      courseId_studentId: {
        courseId: claims.courseId,
        studentId: claims.studentId,
      },
    },
    select: { sessionVersion: true },
  });
  return account?.sessionVersion === claims.sv;
}
