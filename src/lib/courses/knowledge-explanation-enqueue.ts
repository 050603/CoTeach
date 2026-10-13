import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Course, CourseContent } from "@/lib/session/types";
import { decodePblTemplate } from "@/lib/platform/pbl-template";

type WarmupInput = { classroomId: string; sections: Array<{ id?: string; quizOutlineId: string; knowledgePointIds: string[] }>; knowledgePoints: CourseContent["knowledgePoints"]; courseEvidence?: CourseContent["courseEvidence"]; teachingBlueprint?: CourseContent["teachingBlueprint"] };

/** This receipt commits with publication. No model, filesystem or network work runs in that transaction. */
export async function enqueueKnowledgeExplanationWarmup(tx: Prisma.TransactionClient, course: Pick<Course, "id" | "version" | "content" | "aiLearningClassroomId">, identity?: string): Promise<void> {
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  if (!classroomId || !course.content.knowledgeLectureSections?.length) return;
  const input: WarmupInput = { classroomId, sections: course.content.knowledgeLectureSections.map(section => ({ id: section.id, quizOutlineId: section.quizOutlineId, knowledgePointIds: section.knowledgePointIds })),
    knowledgePoints: course.content.knowledgePoints, courseEvidence: course.content.courseEvidence, teachingBlueprint: course.content.teachingBlueprint };
  const id = createHash('sha256').update(JSON.stringify([identity ?? [course.id, course.version], input])).digest('hex');
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
