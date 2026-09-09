import { describe, expect, it } from "vitest";
import { initialSessionState } from "@/lib/session/actions";
import type { Course } from "@/lib/session/types";
import { scopeSessionStateForAuth } from "./session-state";

const courses = [
  { id: "course-1", name: "课程一", students: [] },
  { id: "course-2", name: "课程二", students: [{ id: "student-1", name: "张三" }] },
] as Course[];

describe("scopeSessionStateForAuth", () => {
  it("derives teacher identity from JWT claims and clears student identity", () => {
    const state = {
      ...initialSessionState(),
      courses,
      user: { role: "student" as const, name: "旧学生" },
      joinedCourseId: "course-1",
      studentId: "old-student",
      studentName: "旧学生",
    };

    const scoped = scopeSessionStateForAuth(state, {
      role: "teacher",
      sub: "teacher-1",
      sv: 1,
      username: "teacher",
      displayName: "王老师",
    });

    expect(scoped.courses).toHaveLength(2);
    expect(scoped.user).toEqual({ role: "teacher", name: "王老师" });
    expect(scoped.joinedCourseId).toBeUndefined();
    expect(scoped.studentId).toBeUndefined();
  });

  it("uses V2 participation membership and the account subject", () => {
    const state = { ...initialSessionState(), courses };

    const scoped = scopeSessionStateForAuth(state, {
      role: "student",
      sub: "student-1",
      sv: 1,
      studentName: "张三",
    });

    expect(scoped.courses.map((course) => course.id)).toEqual(["course-2"]);
    expect(scoped.user).toEqual({ role: "student", name: "张三" });
    expect(scoped.joinedCourseId).toBe("course-2");
    expect(scoped.studentId).toBe("student-1");
  });
});
