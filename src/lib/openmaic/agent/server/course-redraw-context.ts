import type { Course } from '@/lib/session/types';
import { createHash } from 'node:crypto';
import { teachingManuscripts } from '@/lib/course-design/teaching-manuscript';
import { resolveCourseSourceSequenceContracts } from '@/lib/textbook/course-evidence-types';
import type { SceneContext } from '../tools/regenerate-scene-actions';

export function courseRedrawSourceFingerprint(course: Course): string {
  return createHash('sha256').update(JSON.stringify({
    sourceEvidence: course.content.courseEvidence,
    knowledge: course.content.knowledgePoints?.map(({ id, evidenceItemIds, sourceId, sourceKnowledgePointIds, authoring }) => ({
      id, evidenceItemIds, sourceId, sourceKnowledgePointIds, authoring,
    })),
    // Ownership can change while the continuous spoken text stays identical.
    // Include the confirmed page responsibilities as well as the manuscript.
    teachingBlueprint: course.content.teachingBlueprint,
  })).digest('hex');
}

/** Called only after course authorization. Keep the authoritative source
 * catalogue on the server; tool results expose only the selected PPT patch. */
export function withCourseRedrawContext(contexts: Record<string, SceneContext>, course: Course): Record<string, SceneContext> {
  const knowledge = course.content.knowledgePoints ?? [];
  const facts = {
    sourceEvidence: course.content.courseEvidence,
    sourceKnowledgePoints: knowledge.map(({ id, evidenceItemIds, sourceId, sourceKnowledgePointIds, authoring }) => ({
      id, evidenceItemIds, sourceId, sourceKnowledgePointIds, authoring,
    })),
    teachingAuthoringKnowledge: knowledge.flatMap((point) => point.authoring ? [{ id: point.id, authoring: point.authoring }] : []),
    sourceSequenceContracts: resolveCourseSourceSequenceContracts(course.content.courseEvidence, knowledge),
    teachingManuscripts: teachingManuscripts(course.content.teachingBlueprint),
  };
  return Object.fromEntries(Object.entries(contexts).map(([id, context]) => [id, { ...context, ...facts }]));
}
