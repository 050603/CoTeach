import { createHash } from "node:crypto";
import type { Course } from "@/lib/session/types";
import type { PersistedClassroomData } from "@/lib/openmaic/server/classroom-storage";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]));
}

/** Review stamps cover teaching facts and the exact draft; diagnostics cannot invalidate themselves. */
export function computeCourseQualitySignature(course: Course, classroom: PersistedClassroomData): string {
  const content = course.content;
  return createHash("sha256").update(JSON.stringify(canonical({
    schemaVersion: 1,
    course: { id: course.id, name: course.name, grade: course.grade, subject: course.subject,
      drivingQuestion: course.drivingQuestion, learningObjectives: course.learningObjectives,
      expectedOutcome: course.expectedOutcome, hours: course.hours, pblConfig: course.pblConfig,
      resources: course.resources?.map(({ downloadedBy: _downloadedBy, ...resource }) => { void _downloadedBy; return resource; }),
      resourcePackage: content.resourcePackage, stagePlan: content.stagePlan,
      knowledgePoints: content.knowledgePoints, knowledgeGroups: content.knowledgeGroups, knowledgeGraph: content.knowledgeGraph,
      moduleTimingPlan: content.moduleTimingPlan, evaluationPlan: content.evaluationPlan, outlines: content._openmaicSceneOutlines },
    classroom: { id: classroom.id, revision: classroom.revision ?? 1, stage: classroom.stage, scenes: classroom.scenes },
  }))).digest("hex");
}
