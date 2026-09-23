import { describe, expect, it } from "vitest";
import { courseDetailedEditHref, courseLibraryStatus, coursePreparationHref, isCourseGenerationActive } from "./preparation-navigation";

describe("course preparation navigation", () => {
  it("routes preview edits directly into the course design workspace", () => {
    const href = courseDetailedEditHref("course/one");
    expect(href).toBe("/teacher/prepare/course%2Fone/verify/edit");
  });

  it.each(["queued", "running", "review_available", "paused", "cancelling", "RUNNING"])(
    "opens the generation workspace while the job is %s",
    (generationStatus) => {
      expect(isCourseGenerationActive(generationStatus)).toBe(true);
      const status = courseLibraryStatus({ generationStatus, latestVersionStatus: "DRAFT" });
      expect(status).toBe("generating");
      expect(coursePreparationHref("course/one", status)).toBe("/teacher/prepare/course%2Fone/verify");
    },
  );

  it("keeps incomplete, failed, and cancelled courses in the generation workspace", () => {
    for (const generationStatus of [undefined, null, "failed", "cancelled"]) {
      expect(isCourseGenerationActive(generationStatus)).toBe(false);
      const status = courseLibraryStatus({ generationStatus, latestVersionStatus: "DRAFT" });
      expect(status).toBe("incomplete");
      expect(coursePreparationHref("course", status)).toBe("/teacher/prepare/course/verify");
    }
  });

  it("opens the publish center only for a completed or published course", () => {
    const completed = courseLibraryStatus({
      latestVersionStatus: "DRAFT",
      generationRun: { scope: "full-course", status: "completed" },
    });
    const published = courseLibraryStatus({ latestVersionStatus: "PUBLISHED" });
    expect(completed).toBe("completed-unpublished");
    expect(published).toBe("published");
    expect(coursePreparationHref("course", completed)).toBe("/teacher/prepare/course/preview");
    expect(coursePreparationHref("course", published)).toBe("/teacher/prepare/course/preview");
  });

  it("does not treat a completed test lesson as a complete course", () => {
    const status = courseLibraryStatus({
      latestVersionStatus: "DRAFT",
      generationRun: { scope: "test-lesson", status: "completed" },
    });
    expect(status).toBe("incomplete");
    expect(coursePreparationHref("course", status)).toBe("/teacher/prepare/course/verify");
  });
});
