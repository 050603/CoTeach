ALTER TABLE "ClassroomInstance"
  ADD COLUMN "legacySourceCourseId" TEXT;

CREATE INDEX "ClassroomInstance_legacySourceCourseId_idx"
  ON "ClassroomInstance"("legacySourceCourseId");

ALTER TABLE "ClassroomInstance"
  ADD CONSTRAINT "ClassroomInstance_legacySourceCourseId_fkey"
  FOREIGN KEY ("legacySourceCourseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;
