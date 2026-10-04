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
  spokenSections?: Array<{ step: string; state: unknown }>;
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
  const failedStages = stages.flatMap(({ draft, attempt, steps, completed: acceptedByTrace }) => {
    const response = record(draft), started = record(attempt);
    if (response?.status === 'validated' || acceptedByTrace) return [];
    const spent = typeof started?.attemptsStarted === 'number' && started.attemptsStarted > 0
      || typeof response?.rawResponse === 'string' || response?.bestCandidate !== undefined;
    return spent ? steps : [];
  });
  if (record(saved.teachingBlueprint)?.status === 'validated' || completed.has('lessonOutline')) return failedStages;
  const sections = new Map<number, { draft?: Record<string, unknown>; attempt?: Record<string, unknown>; compiled?: Record<string, unknown> }>();
  for (const row of saved.spokenSections ?? []) {
    const match = /^(design-authoring|course-design-attempt|course-design):spoken-section:(\d+)$/u.exec(row.step);
    if (!match) continue;
    const index = Number(match[2]);
    const section = sections.get(index) ?? {};
    section[match[1] === 'design-authoring' ? 'draft' : match[1] === 'course-design-attempt' ? 'attempt' : 'compiled'] = record(row.state);
    sections.set(index, section);
  }
  // Sections are authored and compiled serially. For older jobs without a
  // compiled receipt, only the last spent section can be the failed section;
  // complete earlier responses must remain available for deterministic replay.
  const last = [...sections].filter(([, section]) => typeof section.draft?.rawResponse === 'string'
    || typeof section.attempt?.attemptsStarted === 'number' && section.attempt.attemptsStarted > 0)
    .sort(([left], [right]) => right - left)[0];
  if (!last || last[1].compiled?.status === 'validated') return failedStages;
  return [...failedStages, ...['design-authoring', 'course-design-attempt', 'course-design']
    .map((prefix) => `${prefix}:spoken-section:${last[0]}`)];
}
