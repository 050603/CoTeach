import { scopeCourseForClaims } from "./course-scope";
import type { AuthClaims } from "./session";
import type { SessionState } from "@/lib/session/actions";

export function scopeSessionStateForAuth(
  state: SessionState,
  claims: AuthClaims,
): SessionState {
  if (claims.role === "teacher") {
    return {
      ...state,
      user: {
        role: "teacher",
        name: claims.displayName || claims.username || "教师",
      },
      joinedCourseId: undefined,
      studentId: undefined,
      studentName: undefined,
    };
  }

  // Input must already be authorized by the V2 participation query.
  const courses = state.courses.filter(course => course.students?.some(student => student.id === claims.sub)).map(course => scopeCourseForClaims(course, claims));
  return {
    ...state,
    courses,
    user: { role: "student", name: claims.studentName },
    joinedCourseId: courses.some(course => course.id === state.joinedCourseId) ? state.joinedCourseId : courses[0]?.id,
    studentId: claims.sub,
    studentName: claims.studentName,
  };
}
