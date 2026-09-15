CREATE TABLE "PublicDiscussionSession" (
    "id" TEXT NOT NULL,
    "classroomInstanceId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "currentStudentId" TEXT,
    "knowledgePointId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "openingPrompt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INVITING',
    "resumeStatus" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "roundCount" INTEGER NOT NULL DEFAULT 0,
    "candidateEvidence" JSONB,
    "soundOwnerId" TEXT,
    "soundClientId" TEXT,
    "soundLeaseUntil" TIMESTAMP(3),
    "keyConclusion" TEXT,
    "misconceptionRepair" TEXT,
    "transferQuestion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    CONSTRAINT "PublicDiscussionSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PublicDiscussionTurn" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "studentId" TEXT,
    "clientRequestId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'TEXT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PublicDiscussionTurn_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PublicDiscussionTurn_clientRequestId_key" ON "PublicDiscussionTurn"("clientRequestId");
CREATE UNIQUE INDEX "PublicDiscussionTurn_sessionId_sequence_key" ON "PublicDiscussionTurn"("sessionId", "sequence");
CREATE INDEX "PublicDiscussionSession_classroomInstanceId_status_updatedAt_idx" ON "PublicDiscussionSession"("classroomInstanceId", "status", "updatedAt");
CREATE INDEX "PublicDiscussionSession_currentStudentId_updatedAt_idx" ON "PublicDiscussionSession"("currentStudentId", "updatedAt");
CREATE INDEX "PublicDiscussionSession_soundOwnerId_soundLeaseUntil_idx" ON "PublicDiscussionSession"("soundOwnerId", "soundLeaseUntil");
CREATE INDEX "PublicDiscussionTurn_sessionId_createdAt_idx" ON "PublicDiscussionTurn"("sessionId", "createdAt");
CREATE INDEX "PublicDiscussionTurn_studentId_createdAt_idx" ON "PublicDiscussionTurn"("studentId", "createdAt");

ALTER TABLE "PublicDiscussionSession" ADD CONSTRAINT "PublicDiscussionSession_classroomInstanceId_fkey" FOREIGN KEY ("classroomInstanceId") REFERENCES "ClassroomInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublicDiscussionSession" ADD CONSTRAINT "PublicDiscussionSession_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublicDiscussionSession" ADD CONSTRAINT "PublicDiscussionSession_currentStudentId_fkey" FOREIGN KEY ("currentStudentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PublicDiscussionSession" ADD CONSTRAINT "PublicDiscussionSession_soundOwnerId_fkey" FOREIGN KEY ("soundOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PublicDiscussionTurn" ADD CONSTRAINT "PublicDiscussionTurn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PublicDiscussionSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublicDiscussionTurn" ADD CONSTRAINT "PublicDiscussionTurn_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
