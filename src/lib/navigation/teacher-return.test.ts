import { describe, expect, it } from "vitest";
import { resolveTeacherReturnHref, teacherSettingsHref } from "./teacher-return";

describe("teacher return navigation", () => {
  it("carries the current teacher page into the settings link", () => {
    expect(teacherSettingsHref("/teacher/templates"))
      .toBe("/teacher/settings?returnTo=%2Fteacher%2Ftemplates");
  });

  it.each(["https://example.com", "//example.com", "/student", "/teacher/settings"])(
    "rejects an unsafe or recursive return target: %s",
    (href) => expect(resolveTeacherReturnHref(href)).toBeUndefined(),
  );

  it("preserves a safe nested teacher route", () => {
    expect(resolveTeacherReturnHref("/teacher/classes/course-1?tab=students"))
      .toBe("/teacher/classes/course-1?tab=students");
  });
});
