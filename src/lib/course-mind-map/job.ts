import { getCourse, updateCourse } from '@/lib/session/server-store';
import { readClassroom } from '@/lib/openmaic/server/classroom-storage';
import { initializeServerProviderConfig, resolveServerThinkingConfig } from '@/lib/openmaic/server/provider-config';
import { resolveModel } from '@/lib/openmaic/server/resolve-model';
import { createCourseGenerationAiCall } from '@/lib/openmaic/server/course-generation-ai-call';
import { createCourseOutputBudget, resolveCourseExecutionBudgetOptions } from '@/lib/openmaic/generation/course-output-budget';
import { resolveLlmRequestTimeoutMs } from '@/lib/llm/request-policy';
import { generateCourseMindMap, type CourseMindMapCheckpoint } from './generation';
import { computeCourseMindMapSourceFingerprint } from './source';
import type { CourseMindMap } from './types';

/** Runs after saved pages and audio, without replacing any completed course stage. */
export async function generateAndSaveCourseMindMap(input: {
  courseId: string;
  classroomId: string;
  modelString?: string;
  signal?: AbortSignal;
  checkpoint?: CourseMindMapCheckpoint;
  saveCheckpoint: (checkpoint: CourseMindMapCheckpoint) => Promise<void>;
  assertExecution: () => Promise<void>;
}): Promise<CourseMindMap> {
  await input.assertExecution();
  const course = await getCourse(input.courseId);
  const classroom = await readClassroom(input.classroomId);
  if (!course || !classroom || (course.aiLearningClassroomId || course.content._openmaicClassroomId) !== classroom.id) {
    throw new Error('思维导图来源课堂与当前课程不一致');
  }
  const sourceFingerprint = computeCourseMindMapSourceFingerprint(course, classroom.scenes);
  await initializeServerProviderConfig();
  const model = await resolveModel({ modelString: input.modelString });
  const thinking = resolveServerThinkingConfig(model.providerId, 'generate-classroom') ?? model.thinkingConfig;
  const aiCall = createCourseGenerationAiCall({
    model: model.model, vision: false, source: 'course-mind-map', thinking, signal: input.signal,
    outputBudget: createCourseOutputBudget({ resource: 'planning', modelOutputWindow: model.modelInfo?.outputWindow, thinking }),
    executionBudget: resolveCourseExecutionBudgetOptions(),
    timeoutMs: resolveLlmRequestTimeoutMs('long-generation'), maxRetries: 1,
    streamResponse: true, responseFormat: 'json',
  });
  const existing = course.content.courseMindMap;
  const checkpoint = input.checkpoint ?? (existing?.sourceFingerprint === sourceFingerprint
    ? { schemaVersion: 1 as const, sourceFingerprint, attempts: 1, bestCandidate: existing,
      bestIssues: existing.diagnostics, complete: true } : undefined);
  const map = await generateCourseMindMap({ course, scenes: classroom.scenes, aiCall, checkpoint,
    saveCheckpoint: async (state) => { await input.assertExecution(); await input.saveCheckpoint(state); } });
  await input.assertExecution();
  const currentClassroom = await readClassroom(input.classroomId);
  if (!currentClassroom || computeCourseMindMapSourceFingerprint(course, currentClassroom.scenes) !== sourceFingerprint) {
    throw new Error('思维导图生成期间课堂内容已改变，候选未被采用');
  }
  await updateCourse(input.courseId, (current) => {
    if ((current.aiLearningClassroomId || current.content._openmaicClassroomId) !== classroom.id
      || computeCourseMindMapSourceFingerprint(current, currentClassroom.scenes) !== sourceFingerprint) {
      throw new Error('思维导图生成期间课程来源已改变，候选未被采用');
    }
    return { ...current, content: { ...current.content, courseMindMap: map } };
  });
  return map;
}
