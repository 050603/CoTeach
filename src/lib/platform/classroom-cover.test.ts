import { describe, expect, it } from "vitest";
import { classroomCoverImageUrl } from "./classroom-cover";

describe("classroom cover snapshot projection", () => {
  it.each([
    "/api/openmaic/classroom-media/classroom-1/media/course-cover.webp",
    "https://cdn.example.test/classroom.webp",
    "data:image/png;base64,aGVsbG8=",
  ])("returns a safe PBL preparation cover: %s", (coverImageUrl) => {
    expect(classroomCoverImageUrl({
      schemaVersion: 2,
      kind: "pbl-course",
      design: { coverImageUrl },
    })).toBe(coverImageUrl);
  });

  it.each([
    null,
    {},
    { schemaVersion: 1, kind: "pbl-course", design: { coverImageUrl: "/old.webp" } },
    { schemaVersion: 2, kind: "lesson", design: { coverImageUrl: "/lesson.webp" } },
    { schemaVersion: 2, kind: "pbl-course", design: { coverImageUrl: "javascript:alert(1)" } },
    { schemaVersion: 2, kind: "pbl-course", design: { coverImageUrl: "//evil.example/cover.webp" } },
  ])("returns null for an unsupported or unsafe snapshot", (snapshot) => {
    expect(classroomCoverImageUrl(snapshot)).toBeNull();
  });
});
