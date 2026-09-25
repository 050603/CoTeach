"use client";

import { StudentExperimentAssessment } from "@/components/platform/student-experiment-assessment";
import type { Course } from "@/lib/session/types";

export function ExperimentPosttestStudentView({ course }: { course: Course }) {
  return <div className="mx-auto max-w-7xl px-3 pb-8 sm:px-5">
    <StudentExperimentAssessment instanceId={course.id} key={course.id} phase="posttest" />
  </div>;
}
