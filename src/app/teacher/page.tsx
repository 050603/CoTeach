import { redirect } from "next/navigation";

/**
 * V2 uses CourseOffering as the teacher-facing course root. Keep the former
 * local-session dashboard out of the authenticated entry path so teachers
 * cannot accidentally create data outside the V2 database model.
 */
export default function TeacherHomePage() {
  redirect("/teacher/classes");
}
