import { describe, expect, it } from "vitest";
import { publishedClassroomVersion, studentClassroomHref, teacherClassroomEntry } from "./classroom-entry";

describe("classroom entry routing", () => {
  it("enters scheduled classrooms through setup without starting them", () => {
    expect(teacherClassroomEntry({ id: "instance-1", status: "SCHEDULED" })).toEqual({ label: "进入课堂", href: "/teacher/teach/instance-1/setup" });
  });
  it("continues PBL teaching and resolves other formats through setup", () => {
    expect(teacherClassroomEntry({ id: "i", status: "teaching" }, "pbl-course")).toEqual({ label: "继续授课", href: "/teacher/teach/i/classroom" });
    expect(teacherClassroomEntry({ id: "i", status: "teaching" }, "slides").href).toBe("/teacher/teach/i/setup?enter=1");
  });
  it("keeps completed runs on their records", () => {
    expect(teacherClassroomEntry({ id: "i", status: "finished" })).toEqual({ label: "查看课堂记录", href: "/teacher/classrooms/i" });
  });
  it("only selects the newest published version without mutating API data", () => {
    const versions = [{ version: 1, status: "published" }, { version: 5, status: "ready" }, { version: 3, status: "PUBLISHED" }];
    expect(publishedClassroomVersion(versions)?.version).toBe(3);
    expect(versions[0].version).toBe(1);
    expect(publishedClassroomVersion([{ version: 1, status: "draft" }])).toBeUndefined();
  });
  it("preserves student participation routes for non-PBL formats", () => {
    expect(studentClassroomHref("i", "p", "pbl-course")).toBe("/student/classroom/i");
    expect(studentClassroomHref("i", "p", "pbl-course", "FINISHED")).toBe("/student/participations/p");
    expect(studentClassroomHref("i", "p", "slides")).toBe("/student/participations/p");
  });
});
