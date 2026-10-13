CREATE TABLE "KnowledgeExplanation" (
  "id" TEXT PRIMARY KEY, "status" TEXT NOT NULL DEFAULT 'PENDING', "input" JSONB NOT NULL,
  "raw" TEXT, "error" TEXT, "token" TEXT, "leaseUntil" TIMESTAMP(3), "retryAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "KnowledgeExplanation_status_leaseUntil_idx" ON "KnowledgeExplanation"("status", "leaseUntil");
CREATE TABLE "KnowledgeExplanationWarmup" (
  "id" TEXT PRIMARY KEY, "courseId" TEXT NOT NULL, "input" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT, "token" TEXT, "leaseUntil" TIMESTAMP(3), "retryAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "KnowledgeExplanationWarmup_status_retryAt_createdAt_idx" ON "KnowledgeExplanationWarmup"("status", "retryAt", "createdAt");
