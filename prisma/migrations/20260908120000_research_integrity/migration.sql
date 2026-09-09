-- Additive V2 migration. Abort on invalid existing values; never rewrite research records.
BEGIN;
-- DropForeignKey
ALTER TABLE "LearningEvent" DROP CONSTRAINT "LearningEvent_userId_fkey";

-- DropForeignKey
ALTER TABLE "LearningEvent" DROP CONSTRAINT "LearningEvent_offeringId_fkey";

-- DropForeignKey
ALTER TABLE "LearningEvent" DROP CONSTRAINT "LearningEvent_enrollmentId_fkey";

-- DropForeignKey
ALTER TABLE "LearningEvent" DROP CONSTRAINT "LearningEvent_chapterId_fkey";

-- DropForeignKey
ALTER TABLE "LearningEvent" DROP CONSTRAINT "LearningEvent_activityId_fkey";

-- DropForeignKey
ALTER TABLE "LearningEvent" DROP CONSTRAINT "LearningEvent_classroomInstanceId_fkey";

-- DropForeignKey
ALTER TABLE "LearningEvent" DROP CONSTRAINT "LearningEvent_participationId_fkey";

-- DropIndex
DROP INDEX "LearningEvent_idempotencyKey_key";

-- AlterTable
ALTER TABLE "LearningEvent" ADD COLUMN     "researchKey" TEXT;

-- CreateTable
CREATE TABLE "ActivitySubmission" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "researchKey" TEXT NOT NULL,
    "activityVersion" INTEGER NOT NULL,
    "activitySnapshot" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivitySubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivitySubmission_enrollmentId_activityId_submittedAt_idx" ON "ActivitySubmission"("enrollmentId", "activityId", "submittedAt");

-- CreateIndex
CREATE INDEX "ActivitySubmission_activityId_submittedAt_id_idx" ON "ActivitySubmission"("activityId", "submittedAt", "id");

-- CreateIndex
CREATE INDEX "LearningEvent_offeringId_receivedAt_id_idx" ON "LearningEvent"("offeringId", "receivedAt", "id");

-- CreateIndex
CREATE INDEX "LearningEvent_researchKey_occurredAt_idx" ON "LearningEvent"("researchKey", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "LearningEvent_userId_idempotencyKey_key" ON "LearningEvent"("userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "ActivitySubmission" ADD CONSTRAINT "ActivitySubmission_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivitySubmission" ADD CONSTRAINT "ActivitySubmission_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_classroomInstanceId_fkey" FOREIGN KEY ("classroomInstanceId") REFERENCES "ClassroomInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Only backfill a pseudonymous identity when enrollment ownership is consistent.
UPDATE "LearningEvent" AS event
SET "researchKey" = enrollment."researchKey"
FROM "Enrollment" AS enrollment
WHERE event."enrollmentId" = enrollment."id"
  AND event."userId" = enrollment."userId"
  AND (event."offeringId" IS NULL OR event."offeringId" = enrollment."offeringId");

ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_durationMs_check"
  CHECK ("durationMs" IS NULL OR "durationMs" >= 0);
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_eventVersion_check"
  CHECK ("eventVersion" > 0);
ALTER TABLE "CourseInvitation" ADD CONSTRAINT "CourseInvitation_usage_check"
  CHECK ("useCount" >= 0 AND ("maxUses" IS NULL OR ("maxUses" >= 0 AND "useCount" <= "maxUses")));
ALTER TABLE "ActivitySubmission" ADD CONSTRAINT "ActivitySubmission_activityVersion_check"
  CHECK ("activityVersion" > 0);
COMMIT;
