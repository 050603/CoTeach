import { describe, expect, it } from "vitest";
import { getSessionRouteMode } from "./route-mode";

describe("getSessionRouteMode", () => {
  it.each(["/teacher/settings", "/teacher/settings/providers"])("loads only identity for V2 settings %s", (pathname) => {
    expect(getSessionRouteMode(pathname)).toBe("identity");
  });
  it.each(["/", "/teacher/login", "/teacher/register", "/unrelated"])(
    "does not load protected course data on public route %s",
    (pathname) => {
      expect(getSessionRouteMode(pathname)).toBe("none");
    },
  );

  it("checks for an existing student session on the join page", () => {
    expect(getSessionRouteMode("/student")).toBe("optional");
  });

  it.each([
    "/teacher",
    "/teacher/prepare/course-1/verify",
    "/student/classroom/course-1",
    "/student/ai-learning/course-1",
  ])("loads session data on protected route %s", (pathname) => {
    expect(getSessionRouteMode(pathname)).toBe("required");
  });
});
