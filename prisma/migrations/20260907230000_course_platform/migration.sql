-- Long-lived course platform foundation. Legacy classroom tables remain in
-- place so the current classroom UI can be adopted by ClassroomInstance.

ALTER TABLE "LearningEvent"
  ADD COLUMN "offeringId" TEXT,
  ADD COLUMN "enrollmentId" TEXT,
  ADD COLUMN "chapterId" TEXT,
  ADD COLUMN "activityId" TEXT,
  ADD COLUMN "classroomInstanceId" TEXT,
  ADD COLUMN "participationId" TEXT,
  ADD COLUMN "eventVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'classroom';

-- These nullable links let the current classroom result, file and AI tables
-- be traced to a student's concrete participation while keeping old rows
-- readable during the platform cutover.
ALTER TABLE "ClassroomSubmission" ADD COLUMN "participationId" TEXT;
ALTER TABLE "ProjectDocumentVersion" ADD COLUMN "participationId" TEXT;
ALTER TABLE "ProjectPdfVersion" ADD COLUMN "participationId" TEXT;
ALTER TABLE "ReflectionRecord" ADD COLUMN "participationId" TEXT;
ALTER TABLE "CourseUpload" ADD COLUMN "participationId" TEXT;
ALTER TABLE "AiSupportRecord" ADD COLUMN "participationId" TEXT;
ALTER TABLE "CompanionThread" ADD COLUMN "participationId" TEXT;
ALTER TABLE "CompanionTask" ADD COLUMN "participationId" TEXT;
ALTER TABLE "CompanionConfirmation" ADD COLUMN "participationId" TEXT;
ALTER TABLE "CompanionProcessRecord" ADD COLUMN "participationId" TEXT;
ALTER TABLE "AiInteractionEvent" ADD COLUMN "participationId" TEXT;

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "usernameKey" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "sessionVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastLoginAt" TIMESTAMP(3),
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PasswordResetToken" (
  "id" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CourseOffering" (
  "id" TEXT NOT NULL,
  "teacherId" TEXT NOT NULL,
  "legacyCourseId" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "term" TEXT,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'draft',
  "coverImageUrl" TEXT,
  "plan" JSONB,
  "settings" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "CourseOffering_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CourseInvitation" (
  "id" TEXT NOT NULL,
  "offeringId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "disabledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CourseInvitation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Enrollment" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "offeringId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "withdrawnAt" TIMESTAMP(3),
  "currentChapterId" TEXT,
  "currentActivityId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Chapter" (
  "id" TEXT NOT NULL,
  "offeringId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "position" INTEGER NOT NULL,
  "isOpen" BOOLEAN NOT NULL DEFAULT false,
  "opensAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "Chapter_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClassroomTemplate" (
  "id" TEXT NOT NULL,
  "teacherId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "ClassroomTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClassroomTemplateVersion" (
  "id" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "snapshot" JSONB NOT NULL,
  "mediaRefs" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClassroomTemplateVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Activity" (
  "id" TEXT NOT NULL,
  "offeringId" TEXT NOT NULL,
  "chapterId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "position" INTEGER NOT NULL,
  "isOpen" BOOLEAN NOT NULL DEFAULT false,
  "opensAt" TIMESTAMP(3),
  "config" JSONB,
  "archivedAt" TIMESTAMP(3),
  "templateId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClassroomInstance" (
  "id" TEXT NOT NULL,
  "offeringId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "templateVersionId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'scheduled',
  "snapshot" JSONB NOT NULL,
  "startedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "ClassroomInstance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClassroomParticipation" (
  "id" TEXT NOT NULL,
  "offeringId" TEXT NOT NULL,
  "instanceId" TEXT NOT NULL,
  "enrollmentId" TEXT NOT NULL,
  "firstEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stageProgress" JSONB,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "ClassroomParticipation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StudentProjectWorkspace" (
  "id" TEXT NOT NULL,
  "participationId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "projectState" JSONB,
  "aiMembers" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "StudentProjectWorkspace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActivityProgress" (
  "id" TEXT NOT NULL,
  "offeringId" TEXT NOT NULL,
  "enrollmentId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'not_started',
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "lastAccessedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "ActivityProgress_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LearningEventRecord" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "offeringId" TEXT NOT NULL,
  "enrollmentId" TEXT,
  "chapterId" TEXT,
  "activityId" TEXT,
  "classroomInstanceId" TEXT,
  "participationId" TEXT,
  "type" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL DEFAULT 'platform',
  "metadata" JSONB,
  "eventVersion" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "LearningEventRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_usernameKey_key" ON "User"("usernameKey");
CREATE INDEX "User_role_status_idx" ON "User"("role", "status");
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_targetUserId_expiresAt_idx" ON "PasswordResetToken"("targetUserId", "expiresAt");
CREATE INDEX "PasswordResetToken_requestedById_createdAt_idx" ON "PasswordResetToken"("requestedById", "createdAt");
CREATE INDEX "CourseOffering_teacherId_status_updatedAt_idx" ON "CourseOffering"("teacherId", "status", "updatedAt");
CREATE INDEX "CourseOffering_status_startsAt_idx" ON "CourseOffering"("status", "startsAt");
CREATE UNIQUE INDEX "CourseInvitation_offeringId_key" ON "CourseInvitation"("offeringId");
CREATE UNIQUE INDEX "CourseInvitation_code_key" ON "CourseInvitation"("code");
CREATE INDEX "CourseInvitation_code_disabledAt_expiresAt_idx" ON "CourseInvitation"("code", "disabledAt", "expiresAt");
CREATE UNIQUE INDEX "Enrollment_userId_offeringId_key" ON "Enrollment"("userId", "offeringId");
CREATE UNIQUE INDEX "Enrollment_id_offeringId_key" ON "Enrollment"("id", "offeringId");
CREATE INDEX "Enrollment_offeringId_status_joinedAt_idx" ON "Enrollment"("offeringId", "status", "joinedAt");
CREATE UNIQUE INDEX "Chapter_offeringId_position_key" ON "Chapter"("offeringId", "position");
CREATE UNIQUE INDEX "Chapter_id_offeringId_key" ON "Chapter"("id", "offeringId");
CREATE INDEX "Chapter_offeringId_archivedAt_position_idx" ON "Chapter"("offeringId", "archivedAt", "position");
CREATE INDEX "ClassroomTemplate_teacherId_status_updatedAt_idx" ON "ClassroomTemplate"("teacherId", "status", "updatedAt");
CREATE UNIQUE INDEX "ClassroomTemplateVersion_templateId_version_key" ON "ClassroomTemplateVersion"("templateId", "version");
CREATE INDEX "ClassroomTemplateVersion_templateId_status_idx" ON "ClassroomTemplateVersion"("templateId", "status");
CREATE UNIQUE INDEX "Activity_chapterId_position_key" ON "Activity"("chapterId", "position");
CREATE UNIQUE INDEX "Activity_id_offeringId_key" ON "Activity"("id", "offeringId");
CREATE INDEX "Activity_offeringId_chapterId_archivedAt_position_idx" ON "Activity"("offeringId", "chapterId", "archivedAt", "position");
CREATE INDEX "ClassroomInstance_offeringId_activityId_status_idx" ON "ClassroomInstance"("offeringId", "activityId", "status");
CREATE INDEX "ClassroomInstance_templateVersionId_idx" ON "ClassroomInstance"("templateVersionId");
CREATE UNIQUE INDEX "ClassroomInstance_id_offeringId_key" ON "ClassroomInstance"("id", "offeringId");
CREATE UNIQUE INDEX "ClassroomParticipation_instanceId_enrollmentId_key" ON "ClassroomParticipation"("instanceId", "enrollmentId");
CREATE INDEX "ClassroomParticipation_offeringId_enrollmentId_completedAt_idx" ON "ClassroomParticipation"("offeringId", "enrollmentId", "completedAt");
CREATE UNIQUE INDEX "StudentProjectWorkspace_participationId_key" ON "StudentProjectWorkspace"("participationId");
CREATE INDEX "StudentProjectWorkspace_status_updatedAt_idx" ON "StudentProjectWorkspace"("status", "updatedAt");
CREATE UNIQUE INDEX "ActivityProgress_enrollmentId_activityId_key" ON "ActivityProgress"("enrollmentId", "activityId");
CREATE INDEX "ActivityProgress_offeringId_enrollmentId_status_idx" ON "ActivityProgress"("offeringId", "enrollmentId", "status");
CREATE UNIQUE INDEX "LearningEventRecord_userId_offeringId_idempotencyKey_key" ON "LearningEventRecord"("userId", "offeringId", "idempotencyKey");
CREATE INDEX "LearningEventRecord_userId_occurredAt_idx" ON "LearningEventRecord"("userId", "occurredAt");
CREATE INDEX "LearningEventRecord_offeringId_activityId_occurredAt_idx" ON "LearningEventRecord"("offeringId", "activityId", "occurredAt");
CREATE INDEX "LearningEventRecord_offeringId_enrollmentId_occurredAt_idx" ON "LearningEventRecord"("offeringId", "enrollmentId", "occurredAt");
CREATE INDEX "LearningEvent_offeringId_enrollmentId_occurredAt_idx" ON "LearningEvent"("offeringId", "enrollmentId", "occurredAt");
CREATE INDEX "LearningEvent_offeringId_activityId_occurredAt_idx" ON "LearningEvent"("offeringId", "activityId", "occurredAt");
CREATE INDEX "ClassroomSubmission_participationId_createdAt_idx" ON "ClassroomSubmission"("participationId", "createdAt");
CREATE INDEX "ProjectDocumentVersion_participationId_createdAt_idx" ON "ProjectDocumentVersion"("participationId", "createdAt");
CREATE INDEX "ProjectPdfVersion_participationId_createdAt_idx" ON "ProjectPdfVersion"("participationId", "createdAt");
CREATE INDEX "ReflectionRecord_participationId_createdAt_idx" ON "ReflectionRecord"("participationId", "createdAt");
CREATE INDEX "CourseUpload_participationId_createdAt_idx" ON "CourseUpload"("participationId", "createdAt");
CREATE INDEX "AiSupportRecord_participationId_createdAt_idx" ON "AiSupportRecord"("participationId", "createdAt");
CREATE INDEX "CompanionThread_participationId_createdAt_idx" ON "CompanionThread"("participationId", "createdAt");
CREATE INDEX "CompanionTask_participationId_createdAt_idx" ON "CompanionTask"("participationId", "createdAt");
CREATE INDEX "CompanionConfirmation_participationId_createdAt_idx" ON "CompanionConfirmation"("participationId", "createdAt");
CREATE INDEX "CompanionProcessRecord_participationId_createdAt_idx" ON "CompanionProcessRecord"("participationId", "createdAt");
CREATE INDEX "AiInteractionEvent_participationId_createdAt_idx" ON "AiInteractionEvent"("participationId", "createdAt");

ALTER TABLE "User" ADD CONSTRAINT "User_role_check" CHECK ("role" IN ('student', 'teacher'));
ALTER TABLE "CourseOffering" ADD CONSTRAINT "CourseOffering_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CourseOffering" ADD CONSTRAINT "CourseOffering_legacyCourseId_fkey" FOREIGN KEY ("legacyCourseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CourseInvitation" ADD CONSTRAINT "CourseInvitation_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Chapter" ADD CONSTRAINT "Chapter_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassroomTemplate" ADD CONSTRAINT "ClassroomTemplate_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassroomTemplateVersion" ADD CONSTRAINT "ClassroomTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ClassroomTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_chapterId_offeringId_fkey" FOREIGN KEY ("chapterId", "offeringId") REFERENCES "Chapter"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ClassroomTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassroomInstance" ADD CONSTRAINT "ClassroomInstance_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassroomInstance" ADD CONSTRAINT "ClassroomInstance_activityId_offeringId_fkey" FOREIGN KEY ("activityId", "offeringId") REFERENCES "Activity"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassroomInstance" ADD CONSTRAINT "ClassroomInstance_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "ClassroomTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassroomParticipation" ADD CONSTRAINT "ClassroomParticipation_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassroomParticipation" ADD CONSTRAINT "ClassroomParticipation_instanceId_offeringId_fkey" FOREIGN KEY ("instanceId", "offeringId") REFERENCES "ClassroomInstance"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassroomParticipation" ADD CONSTRAINT "ClassroomParticipation_enrollmentId_offeringId_fkey" FOREIGN KEY ("enrollmentId", "offeringId") REFERENCES "Enrollment"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StudentProjectWorkspace" ADD CONSTRAINT "StudentProjectWorkspace_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActivityProgress" ADD CONSTRAINT "ActivityProgress_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActivityProgress" ADD CONSTRAINT "ActivityProgress_enrollmentId_offeringId_fkey" FOREIGN KEY ("enrollmentId", "offeringId") REFERENCES "Enrollment"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActivityProgress" ADD CONSTRAINT "ActivityProgress_activityId_offeringId_fkey" FOREIGN KEY ("activityId", "offeringId") REFERENCES "Activity"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LearningEventRecord" ADD CONSTRAINT "LearningEventRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LearningEventRecord" ADD CONSTRAINT "LearningEventRecord_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LearningEventRecord" ADD CONSTRAINT "LearningEventRecord_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LearningEventRecord" ADD CONSTRAINT "LearningEventRecord_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LearningEventRecord" ADD CONSTRAINT "LearningEventRecord_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LearningEventRecord" ADD CONSTRAINT "LearningEventRecord_classroomInstanceId_fkey" FOREIGN KEY ("classroomInstanceId") REFERENCES "ClassroomInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LearningEventRecord" ADD CONSTRAINT "LearningEventRecord_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_classroomInstanceId_fkey" FOREIGN KEY ("classroomInstanceId") REFERENCES "ClassroomInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassroomSubmission" ADD CONSTRAINT "ClassroomSubmission_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectDocumentVersion" ADD CONSTRAINT "ProjectDocumentVersion_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectPdfVersion" ADD CONSTRAINT "ProjectPdfVersion_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReflectionRecord" ADD CONSTRAINT "ReflectionRecord_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CourseUpload" ADD CONSTRAINT "CourseUpload_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiSupportRecord" ADD CONSTRAINT "AiSupportRecord_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompanionThread" ADD CONSTRAINT "CompanionThread_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompanionTask" ADD CONSTRAINT "CompanionTask_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompanionConfirmation" ADD CONSTRAINT "CompanionConfirmation_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompanionProcessRecord" ADD CONSTRAINT "CompanionProcessRecord_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiInteractionEvent" ADD CONSTRAINT "AiInteractionEvent_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
