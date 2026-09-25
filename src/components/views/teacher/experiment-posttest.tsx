"use client";

import { TeacherExperimentResults } from "@/components/platform/teacher-experiment-results";
import type { TeacherPresentationMode } from "@/lib/classroom/presentation";
import type { TeacherStageFocus } from "@/lib/classroom/teacher-dashboard-metrics";
import type { Course } from "@/lib/session/types";

export function NewExperimentPosttestTeacherView({ course, presentation = "workspace", focus }: {
  course: Course;
  presentation?: TeacherPresentationMode;
  focus?: Extract<TeacherStageFocus, { stageKey: "reflection" }>;
}) {
  const context = course.platformContext;
  const configHref = context?.offeringId && context.activityId
    ? `/teacher/classes/${encodeURIComponent(context.offeringId)}/activities/${encodeURIComponent(context.activityId)}/experiment`
    : undefined;
  return <TeacherExperimentResults
    instanceId={course.id}
    offeringId={context?.offeringId ?? ""}
    mode="posttest"
    presentation={presentation}
    configHref={configHref}
    focusedStudentId={focus?.studentId}
    studentFilter={focus?.filter}
    revision={course.updatedAt}
  />;
}
