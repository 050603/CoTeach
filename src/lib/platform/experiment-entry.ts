export function studentExperimentHref(activityId: string, instanceId: string, phase: "pretest" | "posttest") {
  return `/student/activities/${encodeURIComponent(activityId)}/assessments/${encodeURIComponent(instanceId)}/${phase}`;
}
