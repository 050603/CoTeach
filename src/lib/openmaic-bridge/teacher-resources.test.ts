import { describe, expect, it } from "vitest";
import { teacherResourceTypeLabel } from "./teacher-resources";

describe("teacher resources", () => {
  it("keeps the real interactive resource label", () => {
    expect(teacherResourceTypeLabel("interactive")).toBe("互动演示");
  });
});
