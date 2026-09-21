import { describe, expect, it } from "vitest";
import { courseDetailedEditHref } from "./preparation-navigation";

describe("course preparation navigation", () => {
  it("routes preview edits directly into the course design workspace", () => {
    const href = courseDetailedEditHref("course/one");
    expect(href).toBe("/teacher/prepare/course%2Fone/verify/edit");
  });
});
