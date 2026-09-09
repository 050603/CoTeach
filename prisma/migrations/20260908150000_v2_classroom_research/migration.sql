BEGIN;
-- DropForeignKey
ALTER TABLE "ArtifactVersion" DROP CONSTRAINT "ArtifactVersion_artifactId_fkey";

-- DropForeignKey
ALTER TABLE "ArtifactVersion" DROP CONSTRAINT "ArtifactVersion_fileAssetId_fkey";

-- DropForeignKey
ALTER TABLE "AiInteractionEvent" DROP CONSTRAINT "AiInteractionEvent_userId_fkey";

-- DropForeignKey
ALTER TABLE "AiInteractionEvent" DROP CONSTRAINT "AiInteractionEvent_offeringId_fkey";

-- DropForeignKey
ALTER TABLE "AiInteractionEvent" DROP CONSTRAINT "AiInteractionEvent_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "AiInteractionEvent" DROP CONSTRAINT "AiInteractionEvent_taskId_fkey";

-- DropForeignKey
ALTER TABLE "AiInteractionEvent" DROP CONSTRAINT "AiInteractionEvent_participationId_fkey";

-- DropForeignKey
ALTER TABLE "DomainEvent" DROP CONSTRAINT "DomainEvent_actorId_fkey";

-- DropForeignKey
ALTER TABLE "DomainEvent" DROP CONSTRAINT "DomainEvent_offeringId_fkey";

-- DropForeignKey
ALTER TABLE "DomainEvent" DROP CONSTRAINT "DomainEvent_classroomInstanceId_fkey";

-- DropForeignKey
ALTER TABLE "DomainEvent" DROP CONSTRAINT "DomainEvent_participationId_fkey";

-- AlterTable
ALTER TABLE "AiInteractionEvent" ADD COLUMN     "researchKey" TEXT;

-- AlterTable
ALTER TABLE "DomainEvent" ADD COLUMN     "researchKey" TEXT;

-- CreateIndex
CREATE INDEX "AiInteractionEvent_researchKey_createdAt_idx" ON "AiInteractionEvent"("researchKey", "createdAt");

-- CreateIndex
CREATE INDEX "AiInteractionEvent_offeringId_createdAt_id_idx" ON "AiInteractionEvent"("offeringId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "DomainEvent_researchKey_createdAt_idx" ON "DomainEvent"("researchKey", "createdAt");

-- CreateIndex
CREATE INDEX "DomainEvent_offeringId_createdAt_id_idx" ON "DomainEvent"("offeringId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_fileAssetId_fkey" FOREIGN KEY ("fileAssetId") REFERENCES "FileAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInteractionEvent" ADD CONSTRAINT "AiInteractionEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInteractionEvent" ADD CONSTRAINT "AiInteractionEvent_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInteractionEvent" ADD CONSTRAINT "AiInteractionEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInteractionEvent" ADD CONSTRAINT "AiInteractionEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AiTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInteractionEvent" ADD CONSTRAINT "AiInteractionEvent_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainEvent" ADD CONSTRAINT "DomainEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainEvent" ADD CONSTRAINT "DomainEvent_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainEvent" ADD CONSTRAINT "DomainEvent_classroomInstanceId_fkey" FOREIGN KEY ("classroomInstanceId") REFERENCES "ClassroomInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainEvent" ADD CONSTRAINT "DomainEvent_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "AiInteractionEvent" e SET "researchKey" = enrollment."researchKey"
FROM "ClassroomParticipation" p JOIN "Enrollment" enrollment ON enrollment.id = p."enrollmentId"
WHERE e."participationId" = p.id AND e."userId" = enrollment."userId"
AND (e."offeringId" IS NULL OR e."offeringId" = enrollment."offeringId");
UPDATE "DomainEvent" e SET "researchKey" = enrollment."researchKey"
FROM "ClassroomParticipation" p JOIN "Enrollment" enrollment ON enrollment.id = p."enrollmentId"
WHERE e."participationId" = p.id
AND (e."offeringId" IS NULL OR e."offeringId" = enrollment."offeringId");
COMMIT;
