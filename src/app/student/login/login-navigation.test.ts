import { describe, expect, it } from "vitest";
import { normalizeStudentRedirect } from "./login-navigation";

describe("normalizeStudentRedirect", () => {
  it("returns a student course or classroom deep link", () => {
    expect(normalizeStudentRedirect("/student/activities/activity-1")).toBe("/student/activities/activity-1");
    expect(normalizeStudentRedirect("/student/classroom/run-1?stage=ai-learning"))
      .toBe("/student/classroom/run-1?stage=ai-learning");
  });

  it("rejects external, other-role, and auth-loop destinations", () => {
    for (const value of [
      null, "https://example.com", "//example.com/student", "/\\example.com/student",
      "/teacher/classes", "/student/login", "/student/register", "/student/reset-password",
    ]) {
      expect(normalizeStudentRedirect(value)).toBeNull();
    }
  });
});
