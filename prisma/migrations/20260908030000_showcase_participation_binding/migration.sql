ALTER TABLE "ShowcasePresentation"
  ADD COLUMN "participationId" TEXT;

CREATE INDEX "ShowcasePresentation_participationId_updatedAt_idx"
  ON "ShowcasePresentation"("participationId", "updatedAt");

ALTER TABLE "ShowcasePresentation"
  ADD CONSTRAINT "ShowcasePresentation_participationId_fkey"
  FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
