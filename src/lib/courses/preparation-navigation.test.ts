import { describe, expect, it } from "vitest";
import { courseDetailedEditHref, coursePreparationHref, isCourseGenerationActive } from "./preparation-navigation";

describe("course preparation navigation", () => {
  it("routes preview edits directly into the course design workspace", () => {
    const href = courseDetailedEditHref("course/one");
    expect(href).toBe("/teacher/prepare/course%2Fone/verify/edit");
  });

  it.each(["queued", "running", "review_available", "paused", "cancelling", "RUNNING"])(
    "opens the generation workspace while the job is %s",
    (status) => {
      expect(isCourseGenerationActive(status)).toBe(true);
      expect(coursePreparationHref("course/one", status)).toBe("/teacher/prepare/course%2Fone/verify");
    },
  );

  it.each([undefined, null, "completed", "failed", "cancelled"])(
    "opens the publish center when the job is %s",
    (status) => {
      expect(isCourseGenerationActive(status)).toBe(false);
      expect(coursePreparationHref("course", status)).toBe("/teacher/prepare/course/preview");
    },
  );
});
