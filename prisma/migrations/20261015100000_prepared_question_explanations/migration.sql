ALTER TABLE "KnowledgeExplanation"
  ADD COLUMN "contentKey" TEXT,
  ADD COLUMN "audio" JSONB,
  ADD COLUMN "audioToken" TEXT,
  ADD COLUMN "audioLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "audioError" TEXT;

CREATE INDEX "KnowledgeExplanation_contentKey_status_idx"
  ON "KnowledgeExplanation"("contentKey", "status");
