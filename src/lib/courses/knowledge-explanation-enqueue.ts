import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Course, CourseContent } from "@/lib/session/types";
import { decodePblTemplate } from "@/lib/platform/pbl-template";
import type { ExplanationInput } from "./knowledge-explanations";
import { EXPLANATION_VERSION } from "./knowledge-explanation-types";
import { knowledgeTutorEvidence } from "./knowledge-tutor-evidence";

export type KnowledgeExplanationWarmupInput = {
  version?: string;
  classroomId: string;
  classroomRevision?: number;
  sections: Array<{ id?: string; quizOutlineId: string; knowledgePointIds: string[] }>;
  knowledgePoints: CourseContent["knowledgePoints"];
  courseEvidence?: CourseContent["courseEvidence"];
  teachingBlueprint?: CourseContent["teachingBlueprint"];
  /** Written once by the worker before generation; retries never read mutable questions. */
  questionInputs?: ExplanationInput[];
};
type WarmupCourse = Pick<Course, "id" | "version" | "content" | "aiLearningClassroomId">;

/** Pure receipt construction is safe even when the caller already owns a DB transaction. */
export function buildKnowledgeExplanationWarmupInput(course: WarmupCourse): KnowledgeExplanationWarmupInput | null {
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  if (!classroomId || !course.content.knowledgeLectureSections?.length) return null;
  const revisions = [course.content.teachingRevisionState?.classroomRevision,
    course.content.teacherReviewVersion?.classroomRevision, course.content.qualityReview?.classroomRevision]
    .filter((revision): revision is number => revision !== undefined);
  const classroomRevision = revisions.length ? Math.max(...revisions) : undefined;
  return {
    version: EXPLANATION_VERSION,
    classroomId,
    ...(classroomRevision !== undefined ? { classroomRevision } : {}),
    sections: course.content.knowledgeLectureSections.map(section => ({ id: section.id, quizOutlineId: section.quizOutlineId, knowledgePointIds: section.knowledgePointIds })),
    knowledgePoints: course.content.knowledgePoints,
    courseEvidence: course.content.courseEvidence,
    teachingBlueprint: course.content.teachingBlueprint,
  };
}

/** Exclude mutable course versions, review timestamps and unrelated authoring content. */
export function knowledgeExplanationWarmupKey(input: KnowledgeExplanationWarmupInput): string {
  const sections = input.sections.map(section => {
    const unitIds = input.teachingBlueprint?.sections.find(item => item.id === section.id)?.units.map(unit => unit.id) ?? [];
    return {
      ...section, unitIds,
      knowledgePointNames: section.knowledgePointIds.map(id => input.knowledgePoints.find(point => point.id === id)?.name ?? id),
      sourceEvidence: knowledgeTutorEvidence(input, section.knowledgePointIds, unitIds),
    };
  });
  return createHash("sha256").update(JSON.stringify({ version: EXPLANATION_VERSION,
    classroomId: input.classroomId, classroomRevision: input.classroomRevision, sections })).digest("hex");
}

/** This receipt commits with publication. No model, filesystem or network work runs in that transaction. */
export async function enqueueKnowledgeExplanationWarmup(tx: Prisma.TransactionClient, course: WarmupCourse, _identity?: string): Promise<void> {
  void _identity; // Retain the publication caller interface; content owns deduplication.
  const input = buildKnowledgeExplanationWarmupInput(course);
  if (!input) return;
  // Publication, adoption, and start receipts for the same resources share one job.
  const id = knowledgeExplanationWarmupKey(input);
  await tx.$executeRaw`INSERT INTO "KnowledgeExplanationWarmup" (id, "courseId", input, "updatedAt")
    VALUES (${id}, ${course.id}, ${JSON.stringify(input)}::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`;
}

/** V2 publication/start only supplies an immutable snapshot and stable receipt scope. */
export async function enqueueKnowledgeExplanationSnapshot(tx: Prisma.TransactionClient, input: {
  snapshot: unknown; courseId: string; identity: string;
}): Promise<void> {
  const design = decodePblTemplate(input.snapshot);
  if (!design) return;
  await enqueueKnowledgeExplanationWarmup(tx, { id: input.courseId, aiLearningClassroomId: design.aiLearningClassroomId, content: design.content }, input.identity);
}
