CREATE TABLE "ExperimentAssessmentDraft" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "currentPage" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExperimentAssessmentDraft_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExperimentAssessmentDraft_assignmentId_phase_key" ON "ExperimentAssessmentDraft"("assignmentId", "phase");
CREATE INDEX "ExperimentAssessmentDraft_phase_updatedAt_idx" ON "ExperimentAssessmentDraft"("phase", "updatedAt");
ALTER TABLE "ExperimentAssessmentDraft" ADD CONSTRAINT "ExperimentAssessmentDraft_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "ExperimentAssessmentAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
