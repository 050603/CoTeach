CREATE TABLE "ExperimentAssessmentAssignment" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "pretestForm" JSONB NOT NULL,
    "posttestForm" JSONB NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentAssessmentAssignment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExperimentAssessmentAssignment_variant_check" CHECK ("variant" IN ('none', 'A_PRE_B_POST', 'B_PRE_A_POST'))
);

CREATE UNIQUE INDEX "ExperimentAssessmentAssignment_instanceId_enrollmentId_key"
    ON "ExperimentAssessmentAssignment"("instanceId", "enrollmentId");
CREATE INDEX "ExperimentAssessmentAssignment_instanceId_variant_idx"
    ON "ExperimentAssessmentAssignment"("instanceId", "variant");

ALTER TABLE "ExperimentAssessmentAssignment"
    ADD CONSTRAINT "ExperimentAssessmentAssignment_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "ClassroomInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExperimentAssessmentAssignment"
    ADD CONSTRAINT "ExperimentAssessmentAssignment_enrollmentId_fkey"
    FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ExperimentAssessmentSubmission" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "researchKey" TEXT NOT NULL,
    "questionnaire" JSONB NOT NULL,
    "answers" JSONB NOT NULL,
    "objectiveScore" INTEGER NOT NULL,
    "objectiveTotal" INTEGER NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentAssessmentSubmission_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExperimentAssessmentSubmission_phase_check" CHECK ("phase" IN ('pretest', 'posttest')),
    CONSTRAINT "ExperimentAssessmentSubmission_score_check" CHECK ("objectiveScore" >= 0 AND "objectiveTotal" >= "objectiveScore")
);

CREATE UNIQUE INDEX "ExperimentAssessmentSubmission_instanceId_enrollmentId_phase_key"
    ON "ExperimentAssessmentSubmission"("instanceId", "enrollmentId", "phase");
CREATE INDEX "ExperimentAssessmentSubmission_instanceId_phase_submittedAt_idx"
    ON "ExperimentAssessmentSubmission"("instanceId", "phase", "submittedAt");
CREATE INDEX "ExperimentAssessmentSubmission_enrollmentId_submittedAt_idx"
    ON "ExperimentAssessmentSubmission"("enrollmentId", "submittedAt");

ALTER TABLE "ExperimentAssessmentSubmission"
    ADD CONSTRAINT "ExperimentAssessmentSubmission_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "ClassroomInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExperimentAssessmentSubmission"
    ADD CONSTRAINT "ExperimentAssessmentSubmission_enrollmentId_fkey"
    FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExperimentAssessmentSubmission"
    ADD CONSTRAINT "ExperimentAssessmentSubmission_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "ExperimentAssessmentAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
