import {
  AI_DURATION_ATTEMPT_STEP, AI_DURATION_STEP,
  KNOWLEDGE_STRUCTURE_ATTEMPT_STEP, KNOWLEDGE_STRUCTURE_STEP,
  TEACHING_BLUEPRINT_ATTEMPT_STEP, TEACHING_BLUEPRINT_STEP,
} from '@/lib/course-generation/checkpoint-storage';

type SavedDesignAuthoring = {
  courseSeed?: unknown;
  courseSeedAttempt?: unknown;
  knowledgeStructure?: unknown;
  knowledgeStructureAttempt?: unknown;
  aiDuration?: unknown;
  aiDurationAttempt?: unknown;
  teachingBlueprint?: unknown;
  teachingBlueprintAttempt?: unknown;
  classicOutline?: unknown;
  classicOutlineAttempt?: unknown;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Only an explicit teacher replacement may remove a spent authoring identity.
 * Accepted stages keep both their result and original response. The storage
 * transaction archives every replaced response before deleting these steps. */
export function failedCourseDesignAuthoringSteps(saved: SavedDesignAuthoring, trace: unknown): string[] {
  const completed = new Set(Array.isArray(trace) ? trace.flatMap((event) => {
    const item = record(event);
    return item && (item.status === 'completed' || item.status === 'warning') && typeof item.step === 'string'
      ? [item.step] : [];
  }) : []);
  const stages = [
    { draft: saved.courseSeed, attempt: saved.courseSeedAttempt, completed: completed.has('base'),
      steps: ['design-authoring:courseSeed', 'course-design-attempt:course-seed'] },
    { draft: saved.knowledgeStructure, attempt: saved.knowledgeStructureAttempt,
      steps: [KNOWLEDGE_STRUCTURE_STEP, KNOWLEDGE_STRUCTURE_ATTEMPT_STEP, 'design-authoring:knowledgePoints'] },
    { draft: saved.aiDuration, attempt: saved.aiDurationAttempt,
      steps: [AI_DURATION_STEP, AI_DURATION_ATTEMPT_STEP, 'design-authoring:aiDurationPlanning'] },
    { draft: saved.teachingBlueprint, attempt: saved.teachingBlueprintAttempt,
      steps: [TEACHING_BLUEPRINT_STEP, TEACHING_BLUEPRINT_ATTEMPT_STEP, 'design-authoring:teachingBlueprint', 'design-page-capacity'] },
    { draft: saved.classicOutline, attempt: saved.classicOutlineAttempt, completed: completed.has('lessonOutline'),
      steps: ['design-authoring:classicOutline', 'course-design-attempt:classic-outline', 'course-design:classic-outline-validation'] },
  ];
  return stages.flatMap(({ draft, attempt, steps, completed: acceptedByTrace }) => {
    const response = record(draft), started = record(attempt);
    if (response?.status === 'validated' || acceptedByTrace) return [];
    const spent = typeof started?.attemptsStarted === 'number' && started.attemptsStarted > 0
      || typeof response?.rawResponse === 'string' || response?.bestCandidate !== undefined;
    return spent ? steps : [];
  });
}
