BEGIN;

ALTER TABLE "FileAsset"
  ADD COLUMN "assetRole" TEXT NOT NULL DEFAULT 'SOURCE',
  ADD COLUMN "backupPolicy" TEXT NOT NULL DEFAULT 'REQUIRED',
  ADD COLUMN "sourceAssetId" TEXT,
  ADD COLUMN "regenerationRecipe" JSONB,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing classroom PDF previews were previously related to their PPTX only
-- through Resource.metadata. Normalize that dependency so backup/recovery can
-- reason about it without parsing arbitrary application JSON.
UPDATE "FileAsset" AS preview
SET
  "assetRole" = 'CLASSROOM_PREVIEW',
  "backupPolicy" = 'REGENERATE',
  "sourceAssetId" = resource."fileAssetId",
  "regenerationRecipe" = jsonb_build_object(
    'schemaVersion', 1,
    'operation', 'presentation-to-pdf',
    'outputMimeType', 'application/pdf'
  )
FROM "Resource" AS resource
WHERE resource."fileAssetId" IS NOT NULL
  AND resource."metadata" ->> 'previewAssetId' = preview."id"
  AND preview."mimeType" = 'application/pdf';

ALTER TABLE "FileAsset"
  ADD CONSTRAINT "FileAsset_sourceAssetId_fkey"
  FOREIGN KEY ("sourceAssetId") REFERENCES "FileAsset"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FileAsset_size_check" CHECK ("size" >= 0),
  ADD CONSTRAINT "FileAsset_sha256_check" CHECK (
    "sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "FileAsset_backupPolicy_check" CHECK (
    "backupPolicy" IN ('REQUIRED', 'REGENERATE', 'EPHEMERAL')
  ),
  ADD CONSTRAINT "FileAsset_regeneration_check" CHECK (
    "backupPolicy" <> 'REGENERATE'
    OR ("sourceAssetId" IS NOT NULL AND "regenerationRecipe" IS NOT NULL)
  );

CREATE INDEX "FileAsset_sourceAssetId_idx" ON "FileAsset"("sourceAssetId");
CREATE INDEX "FileAsset_backupPolicy_deletedAt_idx" ON "FileAsset"("backupPolicy", "deletedAt");

COMMIT;
