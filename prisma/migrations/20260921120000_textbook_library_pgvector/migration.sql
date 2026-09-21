BEGIN;

-- pgvector is installed by deploy/postgres/Dockerfile. Extension creation is
-- intentionally migration-owned so the normal application role never needs
-- extension-management privileges.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "Textbook" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "description" TEXT,
    "maintainerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "currentRevisionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    CONSTRAINT "Textbook_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TextbookRevision" (
    "id" TEXT NOT NULL,
    "textbookId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "fileAssetId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "parseVersion" TEXT NOT NULL,
    "extractionVersion" TEXT NOT NULL,
    "error" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "readyAt" TIMESTAMP(3),
    CONSTRAINT "TextbookRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TextbookSection" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "parentId" TEXT,
    "title" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'FRONT_MATTER',
    "level" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TextbookSection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TextbookSourceBlock" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "blockKey" TEXT NOT NULL,
    "blockType" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "normalizedContent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TextbookSourceBlock_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TextbookConcept" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "kind" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "origin" TEXT NOT NULL DEFAULT 'TEXTBOOK',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TextbookConcept_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TextbookConceptEvidence" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "sourceBlockId" TEXT NOT NULL,
    "quoteStart" INTEGER NOT NULL,
    "quoteEnd" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TextbookConceptEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TextbookConceptRelation" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "sourceConceptId" TEXT NOT NULL,
    "targetConceptId" TEXT NOT NULL,
    "relationType" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'TEXTBOOK',
    "sourceBlockId" TEXT,
    "confidence" DOUBLE PRECISION,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TextbookConceptRelation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TextbookExample" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "sourceBlockId" TEXT,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'TEXTBOOK',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TextbookExample_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TextbookConceptExample" (
    "conceptId" TEXT NOT NULL,
    "exampleId" TEXT NOT NULL,
    CONSTRAINT "TextbookConceptExample_pkey" PRIMARY KEY ("conceptId", "exampleId")
);

CREATE TABLE "TextbookFigure" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "sectionId" TEXT,
    "sourceBlockId" TEXT,
    "fileAssetId" TEXT NOT NULL,
    "caption" TEXT,
    "position" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TextbookFigure_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TextbookConceptFigure" (
    "conceptId" TEXT NOT NULL,
    "figureId" TEXT NOT NULL,
    CONSTRAINT "TextbookConceptFigure_pkey" PRIMARY KEY ("conceptId", "figureId")
);

CREATE TABLE "TextbookRetrievalItem" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "sectionId" TEXT,
    "sourceBlockId" TEXT,
    "conceptId" TEXT,
    "exampleId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "searchTokens" TEXT NOT NULL,
    "searchVector" tsvector GENERATED ALWAYS AS
      (to_tsvector('simple'::regconfig, COALESCE("searchTokens", ''))) STORED,
    "contentFingerprint" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TextbookRetrievalItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmbeddingProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "baseUrl" TEXT,
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL DEFAULT 1024,
    "textProcessingVersion" TEXT NOT NULL,
    "configFingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "credentialId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmbeddingProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TextbookEmbedding" (
    "id" TEXT NOT NULL,
    "retrievalItemId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "contentFingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "embedding" vector(1024),
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "embeddedAt" TIMESTAMP(3),
    CONSTRAINT "TextbookEmbedding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CourseTextbookBinding" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CourseTextbookBinding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CourseTextbookSection" (
    "bindingId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    CONSTRAINT "CourseTextbookSection_pkey" PRIMARY KEY ("bindingId", "sectionId")
);

CREATE TABLE "CourseEvidenceSnapshot" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "fingerprint" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourseEvidenceSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CourseEvidenceSnapshotBinding" (
    "snapshotId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    CONSTRAINT "CourseEvidenceSnapshotBinding_pkey" PRIMARY KEY ("snapshotId", "bindingId")
);

CREATE UNIQUE INDEX "Textbook_currentRevisionId_key" ON "Textbook"("currentRevisionId");
CREATE INDEX "Textbook_status_updatedAt_idx" ON "Textbook"("status", "updatedAt");
CREATE INDEX "Textbook_maintainerId_status_idx" ON "Textbook"("maintainerId", "status");

CREATE UNIQUE INDEX "TextbookRevision_fileAssetId_key" ON "TextbookRevision"("fileAssetId");
CREATE UNIQUE INDEX "TextbookRevision_sha256_key" ON "TextbookRevision"("sha256");
CREATE UNIQUE INDEX "TextbookRevision_textbookId_revision_key" ON "TextbookRevision"("textbookId", "revision");
CREATE INDEX "TextbookRevision_textbookId_status_createdAt_idx" ON "TextbookRevision"("textbookId", "status", "createdAt");
CREATE INDEX "TextbookRevision_status_updatedAt_idx" ON "TextbookRevision"("status", "updatedAt");

CREATE UNIQUE INDEX "TextbookSection_revisionId_path_key" ON "TextbookSection"("revisionId", "path");
CREATE UNIQUE INDEX "TextbookSection_revisionId_position_key" ON "TextbookSection"("revisionId", "position");
CREATE INDEX "TextbookSection_revisionId_parentId_position_idx" ON "TextbookSection"("revisionId", "parentId", "position");
CREATE INDEX "TextbookSection_revisionId_kind_position_idx" ON "TextbookSection"("revisionId", "kind", "position");

CREATE UNIQUE INDEX "TextbookSourceBlock_revisionId_blockKey_key" ON "TextbookSourceBlock"("revisionId", "blockKey");
CREATE UNIQUE INDEX "TextbookSourceBlock_revisionId_position_key" ON "TextbookSourceBlock"("revisionId", "position");
CREATE INDEX "TextbookSourceBlock_sectionId_position_idx" ON "TextbookSourceBlock"("sectionId", "position");

CREATE UNIQUE INDEX "TextbookConcept_revisionId_normalizedName_sectionId_key" ON "TextbookConcept"("revisionId", "normalizedName", "sectionId");
CREATE INDEX "TextbookConcept_revisionId_status_normalizedName_idx" ON "TextbookConcept"("revisionId", "status", "normalizedName");
CREATE INDEX "TextbookConcept_sectionId_status_idx" ON "TextbookConcept"("sectionId", "status");

CREATE UNIQUE INDEX "TextbookConceptEvidence_conceptId_sourceBlockId_quoteStart_quoteEnd_key" ON "TextbookConceptEvidence"("conceptId", "sourceBlockId", "quoteStart", "quoteEnd");
CREATE INDEX "TextbookConceptEvidence_sourceBlockId_idx" ON "TextbookConceptEvidence"("sourceBlockId");

CREATE UNIQUE INDEX "TextbookConceptRelation_sourceConceptId_targetConceptId_relationType_key" ON "TextbookConceptRelation"("sourceConceptId", "targetConceptId", "relationType");
CREATE INDEX "TextbookConceptRelation_revisionId_relationType_idx" ON "TextbookConceptRelation"("revisionId", "relationType");
CREATE INDEX "TextbookConceptRelation_targetConceptId_relationType_idx" ON "TextbookConceptRelation"("targetConceptId", "relationType");
CREATE INDEX "TextbookConceptRelation_sourceBlockId_idx" ON "TextbookConceptRelation"("sourceBlockId");

CREATE INDEX "TextbookExample_revisionId_sectionId_idx" ON "TextbookExample"("revisionId", "sectionId");
CREATE INDEX "TextbookExample_sourceBlockId_idx" ON "TextbookExample"("sourceBlockId");
CREATE INDEX "TextbookConceptExample_exampleId_idx" ON "TextbookConceptExample"("exampleId");

CREATE UNIQUE INDEX "TextbookFigure_revisionId_position_key" ON "TextbookFigure"("revisionId", "position");
CREATE INDEX "TextbookFigure_sectionId_position_idx" ON "TextbookFigure"("sectionId", "position");
CREATE INDEX "TextbookFigure_sourceBlockId_idx" ON "TextbookFigure"("sourceBlockId");
CREATE INDEX "TextbookFigure_fileAssetId_idx" ON "TextbookFigure"("fileAssetId");
CREATE INDEX "TextbookConceptFigure_figureId_idx" ON "TextbookConceptFigure"("figureId");

CREATE UNIQUE INDEX "TextbookRetrievalItem_revisionId_kind_position_key" ON "TextbookRetrievalItem"("revisionId", "kind", "position");
CREATE INDEX "TextbookRetrievalItem_revisionId_sectionId_kind_idx" ON "TextbookRetrievalItem"("revisionId", "sectionId", "kind");
CREATE INDEX "TextbookRetrievalItem_contentFingerprint_idx" ON "TextbookRetrievalItem"("contentFingerprint");
CREATE INDEX "TextbookRetrievalItem_sourceBlockId_idx" ON "TextbookRetrievalItem"("sourceBlockId");
CREATE INDEX "TextbookRetrievalItem_conceptId_idx" ON "TextbookRetrievalItem"("conceptId");
CREATE INDEX "TextbookRetrievalItem_exampleId_idx" ON "TextbookRetrievalItem"("exampleId");
CREATE INDEX "TextbookRetrievalItem_searchVector_idx" ON "TextbookRetrievalItem" USING GIN ("searchVector");

CREATE UNIQUE INDEX "EmbeddingProfile_configFingerprint_key" ON "EmbeddingProfile"("configFingerprint");
CREATE UNIQUE INDEX "EmbeddingProfile_one_active_idx" ON "EmbeddingProfile" ((true)) WHERE "isActive" AND "status" = 'ACTIVE';
CREATE INDEX "EmbeddingProfile_status_isActive_idx" ON "EmbeddingProfile"("status", "isActive");
CREATE INDEX "EmbeddingProfile_credentialId_idx" ON "EmbeddingProfile"("credentialId");

CREATE UNIQUE INDEX "TextbookEmbedding_retrievalItemId_profileId_contentFingerprint_key" ON "TextbookEmbedding"("retrievalItemId", "profileId", "contentFingerprint");
CREATE INDEX "TextbookEmbedding_profileId_status_idx" ON "TextbookEmbedding"("profileId", "status");
CREATE INDEX "TextbookEmbedding_retrievalItemId_status_idx" ON "TextbookEmbedding"("retrievalItemId", "status");

CREATE UNIQUE INDEX "CourseTextbookBinding_templateId_revisionId_key" ON "CourseTextbookBinding"("templateId", "revisionId");
CREATE UNIQUE INDEX "CourseTextbookBinding_one_primary_idx" ON "CourseTextbookBinding"("templateId") WHERE "isPrimary";
CREATE INDEX "CourseTextbookBinding_templateId_isPrimary_idx" ON "CourseTextbookBinding"("templateId", "isPrimary");
CREATE INDEX "CourseTextbookBinding_revisionId_idx" ON "CourseTextbookBinding"("revisionId");
CREATE INDEX "CourseTextbookSection_sectionId_idx" ON "CourseTextbookSection"("sectionId");

CREATE UNIQUE INDEX "CourseEvidenceSnapshot_templateId_version_key" ON "CourseEvidenceSnapshot"("templateId", "version");
CREATE UNIQUE INDEX "CourseEvidenceSnapshot_templateId_fingerprint_key" ON "CourseEvidenceSnapshot"("templateId", "fingerprint");
CREATE UNIQUE INDEX "CourseEvidenceSnapshot_one_current_idx" ON "CourseEvidenceSnapshot"("templateId") WHERE "isCurrent";
CREATE INDEX "CourseEvidenceSnapshot_templateId_isCurrent_idx" ON "CourseEvidenceSnapshot"("templateId", "isCurrent");
CREATE INDEX "CourseEvidenceSnapshot_status_createdAt_idx" ON "CourseEvidenceSnapshot"("status", "createdAt");
CREATE INDEX "CourseEvidenceSnapshotBinding_bindingId_idx" ON "CourseEvidenceSnapshotBinding"("bindingId");

ALTER TABLE "Textbook"
  ADD CONSTRAINT "Textbook_maintainerId_fkey" FOREIGN KEY ("maintainerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Textbook_currentRevisionId_fkey" FOREIGN KEY ("currentRevisionId") REFERENCES "TextbookRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Textbook_status_check" CHECK ("status" IN ('ACTIVE', 'ARCHIVED')),
  ADD CONSTRAINT "Textbook_archive_state_check" CHECK (("status" = 'ARCHIVED') = ("archivedAt" IS NOT NULL));

ALTER TABLE "TextbookRevision"
  ADD CONSTRAINT "TextbookRevision_textbookId_fkey" FOREIGN KEY ("textbookId") REFERENCES "Textbook"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookRevision_fileAssetId_fkey" FOREIGN KEY ("fileAssetId") REFERENCES "FileAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookRevision_revision_check" CHECK ("revision" > 0),
  ADD CONSTRAINT "TextbookRevision_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "TextbookRevision_status_check" CHECK ("status" IN ('PENDING', 'PARSING', 'WAITING_EMBEDDING', 'READY', 'FAILED')),
  ADD CONSTRAINT "TextbookRevision_ready_state_check" CHECK (("status" = 'READY') = ("readyAt" IS NOT NULL));

ALTER TABLE "TextbookSection"
  ADD CONSTRAINT "TextbookSection_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "TextbookRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookSection_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "TextbookSection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookSection_level_check" CHECK ("level" >= 0),
  ADD CONSTRAINT "TextbookSection_position_check" CHECK ("position" >= 0),
  ADD CONSTRAINT "TextbookSection_kind_check" CHECK ("kind" IN ('FRONT_MATTER', 'CHAPTER', 'SECTION', 'SUBSECTION'));

ALTER TABLE "TextbookSourceBlock"
  ADD CONSTRAINT "TextbookSourceBlock_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "TextbookRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookSourceBlock_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "TextbookSection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookSourceBlock_position_check" CHECK ("position" >= 0),
  ADD CONSTRAINT "TextbookSourceBlock_content_check" CHECK (length("content") > 0);

ALTER TABLE "TextbookConcept"
  ADD CONSTRAINT "TextbookConcept_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "TextbookRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookConcept_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "TextbookSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookConcept_origin_check" CHECK ("origin" IN ('TEXTBOOK', 'INFERRED', 'MANUAL'));

ALTER TABLE "TextbookConceptEvidence"
  ADD CONSTRAINT "TextbookConceptEvidence_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "TextbookConcept"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookConceptEvidence_sourceBlockId_fkey" FOREIGN KEY ("sourceBlockId") REFERENCES "TextbookSourceBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookConceptEvidence_range_check" CHECK ("quoteStart" >= 0 AND "quoteEnd" > "quoteStart");

ALTER TABLE "TextbookConceptRelation"
  ADD CONSTRAINT "TextbookConceptRelation_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "TextbookRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookConceptRelation_sourceConceptId_fkey" FOREIGN KEY ("sourceConceptId") REFERENCES "TextbookConcept"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookConceptRelation_targetConceptId_fkey" FOREIGN KEY ("targetConceptId") REFERENCES "TextbookConcept"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookConceptRelation_sourceBlockId_fkey" FOREIGN KEY ("sourceBlockId") REFERENCES "TextbookSourceBlock"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookConceptRelation_self_check" CHECK ("sourceConceptId" <> "targetConceptId"),
  ADD CONSTRAINT "TextbookConceptRelation_origin_check" CHECK ("origin" IN ('TEXTBOOK', 'INFERRED', 'MANUAL')),
  ADD CONSTRAINT "TextbookConceptRelation_confidence_check" CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));

ALTER TABLE "TextbookExample"
  ADD CONSTRAINT "TextbookExample_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "TextbookRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookExample_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "TextbookSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookExample_sourceBlockId_fkey" FOREIGN KEY ("sourceBlockId") REFERENCES "TextbookSourceBlock"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookExample_origin_check" CHECK ("origin" IN ('TEXTBOOK', 'ADAPTED', 'MANUAL'));

ALTER TABLE "TextbookConceptExample"
  ADD CONSTRAINT "TextbookConceptExample_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "TextbookConcept"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookConceptExample_exampleId_fkey" FOREIGN KEY ("exampleId") REFERENCES "TextbookExample"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TextbookFigure"
  ADD CONSTRAINT "TextbookFigure_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "TextbookRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookFigure_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "TextbookSection"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookFigure_sourceBlockId_fkey" FOREIGN KEY ("sourceBlockId") REFERENCES "TextbookSourceBlock"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookFigure_fileAssetId_fkey" FOREIGN KEY ("fileAssetId") REFERENCES "FileAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookFigure_position_check" CHECK ("position" >= 0),
  ADD CONSTRAINT "TextbookFigure_dimensions_check" CHECK (("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0));

ALTER TABLE "TextbookConceptFigure"
  ADD CONSTRAINT "TextbookConceptFigure_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "TextbookConcept"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookConceptFigure_figureId_fkey" FOREIGN KEY ("figureId") REFERENCES "TextbookFigure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TextbookRetrievalItem"
  ADD CONSTRAINT "TextbookRetrievalItem_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "TextbookRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookRetrievalItem_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "TextbookSection"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookRetrievalItem_sourceBlockId_fkey" FOREIGN KEY ("sourceBlockId") REFERENCES "TextbookSourceBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookRetrievalItem_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "TextbookConcept"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookRetrievalItem_exampleId_fkey" FOREIGN KEY ("exampleId") REFERENCES "TextbookExample"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookRetrievalItem_position_check" CHECK ("position" >= 0),
  ADD CONSTRAINT "TextbookRetrievalItem_origin_check" CHECK (
    ("kind" = 'SOURCE_BLOCK' AND "sourceBlockId" IS NOT NULL AND "conceptId" IS NULL AND "exampleId" IS NULL)
    OR ("kind" = 'CONCEPT' AND "sourceBlockId" IS NULL AND "conceptId" IS NOT NULL AND "exampleId" IS NULL)
    OR ("kind" = 'EXAMPLE' AND "conceptId" IS NULL AND "exampleId" IS NOT NULL)
  ),
  ADD CONSTRAINT "TextbookRetrievalItem_kind_check" CHECK ("kind" IN ('SOURCE_BLOCK', 'CONCEPT', 'EXAMPLE'));

ALTER TABLE "EmbeddingProfile"
  ADD CONSTRAINT "EmbeddingProfile_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ProviderCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "EmbeddingProfile_dimensions_check" CHECK ("dimensions" = 1024);

ALTER TABLE "TextbookEmbedding"
  ADD CONSTRAINT "TextbookEmbedding_retrievalItemId_fkey" FOREIGN KEY ("retrievalItemId") REFERENCES "TextbookRetrievalItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookEmbedding_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "EmbeddingProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TextbookEmbedding_attempt_check" CHECK ("attempt" >= 0),
  ADD CONSTRAINT "TextbookEmbedding_status_check" CHECK ("status" IN ('PENDING', 'PROCESSING', 'READY', 'FAILED')),
  ADD CONSTRAINT "TextbookEmbedding_ready_state_check" CHECK (("status" = 'READY') = ("embedding" IS NOT NULL AND "embeddedAt" IS NOT NULL));

ALTER TABLE "CourseTextbookBinding"
  ADD CONSTRAINT "CourseTextbookBinding_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ClassroomTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CourseTextbookBinding_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "TextbookRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CourseTextbookSection"
  ADD CONSTRAINT "CourseTextbookSection_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "CourseTextbookBinding"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CourseTextbookSection_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "TextbookSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CourseEvidenceSnapshot"
  ADD CONSTRAINT "CourseEvidenceSnapshot_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ClassroomTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CourseEvidenceSnapshot_version_check" CHECK ("version" > 0);

ALTER TABLE "CourseEvidenceSnapshotBinding"
  ADD CONSTRAINT "CourseEvidenceSnapshotBinding_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "CourseEvidenceSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CourseEvidenceSnapshotBinding_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "CourseTextbookBinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
