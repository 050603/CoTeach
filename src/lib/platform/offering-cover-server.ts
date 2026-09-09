import type { AuthClaims } from "@/lib/auth/session";
import { generateCourseCoverImageOnServer } from "@/lib/course-cover-server";
import { prisma } from "@/lib/db/client";
import { requireTeacherUser } from "./access";
import { OFFERING_COVER_MEDIA_PREFIX } from "./classroom-cover";
import { PlatformError, updateOffering } from "./repository";

export async function generateOfferingCoverImage(
  claims: AuthClaims,
  offeringId: string,
) {
  const teacher = await requireTeacherUser(claims);
  const offering = await prisma.courseOffering.findUnique({
    where: { id: offeringId },
    select: { id: true, name: true, description: true, term: true, settings: true, version: true },
  });
  if (!offering) throw new PlatformError("NOT_FOUND", "教学班不存在", 404);
  const owns = await prisma.courseTeacher.findFirst({
    where: { offeringId, userId: teacher.id },
    select: { id: true },
  });
  if (!owns) throw new PlatformError("FORBIDDEN", "无权操作该教学班", 403);

  const coverImageUrl = await generateCourseCoverImageOnServer(
    {
      name: offering.name,
      summary: offering.description ?? undefined,
      term: offering.term ?? undefined,
      outline: offering.settings && typeof offering.settings === "object" && !Array.isArray(offering.settings)
        && typeof offering.settings.outline === "string"
        ? offering.settings.outline
        : undefined,
    },
    `${OFFERING_COVER_MEDIA_PREFIX}${offering.id}`,
    undefined,
    `course-cover-v${offering.version + 1}`,
  );
  return updateOffering(claims, offering.id, {
    coverImageUrl,
    version: offering.version,
  });
}
