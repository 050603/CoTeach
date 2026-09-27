"use client";

import { useRouter } from "next/navigation";
import { StudentExperimentAssessment, type ExperimentPhase } from "./student-experiment-assessment";

export function StudentExperimentAssessmentEntry({ activityId, instanceId, phase }: {
  activityId: string;
  instanceId: string;
  phase: ExperimentPhase;
}) {
  const router = useRouter();
  return <StudentExperimentAssessment
    instanceId={instanceId}
    layout="full"
    onSubmitted={() => router.replace(`/student/activities/${encodeURIComponent(activityId)}`)}
    phase={phase}
  />;
}
