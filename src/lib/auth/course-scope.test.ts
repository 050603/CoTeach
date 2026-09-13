import { describe, expect, it } from "vitest";
import type { StudentClaims } from "@/lib/auth/session";
import type { Course } from "@/lib/session/types";
import { scopeCourseForClaims } from "./course-scope";

describe("scopeCourseForClaims", () => {
  it("removes private package authoring data while retaining classroom stage requirements", () => {
    const course = { id: "course", stages: [], students: [], content: { resourcePackage: { secret: "teacher source" }, stagePlan: { totalMinutes: 135 } } } as unknown as Course;
    const scoped = scopeCourseForClaims(course, { role: "student", sub: "student" } as StudentClaims);
    expect(scoped.content).not.toHaveProperty("resourcePackage");
    expect(scoped.content.stagePlan?.totalMinutes).toBe(135);
    expect(course.content).toHaveProperty("resourcePackage");
  });
  it("does not expose another student's knowledge-lecture answers", () => {
    const course = {
      id: "course-1",
      stages: [{ key: "ai-learning", label: "AI 授知", description: "旧课程" }],
      students: [{ id: "student-1", name: "甲" }, { id: "student-2", name: "乙" }],
      aiLearningProgress: {
        "student-1": { studentId: "student-1", knowledgeLectureAttempts: [{ id: "attempt-1" }] },
        "student-2": { studentId: "student-2", knowledgeLectureAttempts: [{ id: "attempt-2" }] },
      },
    } as unknown as Course;
    const claims = {
      role: "student",
      courseId: "course-1",
      studentId: "stale-legacy-id",
      studentName: "甲",
      sub: "student-1",
      sv: 1,
    } as StudentClaims;

    const scoped = scopeCourseForClaims(course, claims);
    expect(Object.keys(scoped.aiLearningProgress ?? {})).toEqual(["student-1"]);
    expect(scoped.aiLearningProgress?.["student-2"]).toBeUndefined();
    expect(scoped.stages[0]?.label).toBe("知识讲授");
  });
});
