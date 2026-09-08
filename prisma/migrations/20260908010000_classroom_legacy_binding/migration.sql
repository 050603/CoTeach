-- Bind reusable classroom templates and immutable runtime instances to the
-- legacy Course content they carry. A teaching offering may contain several
-- Classroom activities, so this belongs on the template/instance rather than
-- only on CourseOffering.

ALTER TABLE "ClassroomTemplate" ADD COLUMN "legacyCourseId" TEXT;
ALTER TABLE "ClassroomInstance" ADD COLUMN "legacyCourseId" TEXT;

CREATE INDEX "ClassroomTemplate_legacyCourseId_idx" ON "ClassroomTemplate"("legacyCourseId");
CREATE INDEX "ClassroomInstance_legacyCourseId_idx" ON "ClassroomInstance"("legacyCourseId");

ALTER TABLE "ClassroomTemplate"
  ADD CONSTRAINT "ClassroomTemplate_legacyCourseId_fkey"
  FOREIGN KEY ("legacyCourseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClassroomInstance"
  ADD CONSTRAINT "ClassroomInstance_legacyCourseId_fkey"
  FOREIGN KEY ("legacyCourseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;
