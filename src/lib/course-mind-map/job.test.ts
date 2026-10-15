import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Course } from '@/lib/session/types';
import type { CourseMindMap } from './types';

const mocks = vi.hoisted(() => ({ getCourse: vi.fn(), updateCourse: vi.fn(), readClassroom: vi.fn(),
  initialize: vi.fn(), resolveModel: vi.fn(), aiCall: vi.fn(), generate: vi.fn(), fingerprint: vi.fn() }));
vi.mock('@/lib/session/server-store', () => ({ getCourse: mocks.getCourse, updateCourse: mocks.updateCourse }));
vi.mock('@/lib/openmaic/server/classroom-storage', () => ({ readClassroom: mocks.readClassroom }));
vi.mock('@/lib/openmaic/server/provider-config', () => ({ initializeServerProviderConfig: mocks.initialize,
  resolveServerThinkingConfig: () => undefined }));
vi.mock('@/lib/openmaic/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/openmaic/server/course-generation-ai-call', () => ({ createCourseGenerationAiCall: mocks.aiCall }));
vi.mock('./generation', () => ({ generateCourseMindMap: mocks.generate }));
vi.mock('./source', () => ({ computeCourseMindMapSourceFingerprint: mocks.fingerprint }));
import { generateAndSaveCourseMindMap } from './job';
import { createPblTemplateCourse } from '@/lib/platform/pbl-template';

const map: CourseMindMap = { schemaVersion: 1, sourceFingerprint: 'source', bindingFingerprint: 'audio', rootId: 'root',
  nodes: [{ id: 'root', label: '教学方法', knowledgePointIds: [] }], relations: [], bindings: [], diagnostics: [] };
let course: Course;
beforeEach(() => {
  vi.resetAllMocks();
  course = createPblTemplateCourse('course', { aiLearningClassroomId: 'classroom' });
  mocks.getCourse.mockResolvedValue(course);
  mocks.readClassroom.mockResolvedValue({ id: 'classroom', scenes: [{ id: 'page' }] });
  mocks.resolveModel.mockResolvedValue({ model: {}, modelString: 'original-model', providerId: 'provider', modelInfo: { outputWindow: 32000 } });
  mocks.fingerprint.mockReturnValue('source');
  mocks.aiCall.mockReturnValue(vi.fn());
  mocks.generate.mockResolvedValue(map);
  mocks.updateCourse.mockImplementation(async (_id, update) => { course = update(course); return course; });
});
const input = () => ({ courseId: 'course', classroomId: 'classroom', modelString: 'original-model',
  assertExecution: vi.fn().mockResolvedValue(undefined), saveCheckpoint: vi.fn().mockResolvedValue(undefined) });

describe('saved classroom concept map finalization', () => {
  it('adds the map after saved audio and preserves all existing teaching artifacts', async () => {
    const before = structuredClone(course);
    await generateAndSaveCourseMindMap(input());
    expect(course).toEqual({ ...before, content: { ...before.content, courseMindMap: map } });
    expect(mocks.resolveModel).toHaveBeenCalledWith({ modelString: 'original-model' });
    expect(mocks.aiCall.mock.calls[0][0].outputBudget('system', 'prompt')).toBeGreaterThan(10000);
    expect(mocks.generate.mock.calls[0][0].scenes).toEqual([{ id: 'page' }]);
  });
  it('restores the independent checkpoint and guards its writes with execution ownership', async () => {
    const options = { ...input(), checkpoint: { schemaVersion: 1 as const, sourceFingerprint: 'source', attempts: 1,
      bestCandidate: map, complete: true } };
    await generateAndSaveCourseMindMap(options);
    const call = mocks.generate.mock.calls[0][0];
    expect(call.checkpoint).toEqual(options.checkpoint);
    await call.saveCheckpoint(options.checkpoint);
    expect(options.saveCheckpoint).toHaveBeenCalledWith(options.checkpoint);
    options.saveCheckpoint.mockClear();
    options.assertExecution.mockRejectedValueOnce(new Error('GENERATION_JOB_EXECUTION_LOST'));
    await expect(call.saveCheckpoint(options.checkpoint)).rejects.toThrow('EXECUTION_LOST');
    expect(options.saveCheckpoint).not.toHaveBeenCalled();
  });
  it('keeps completed course pages when the independent model stage fails', async () => {
    mocks.generate.mockRejectedValue(new Error('model unavailable'));
    await expect(generateAndSaveCourseMindMap(input())).rejects.toThrow('model unavailable');
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });
  it('rejects a changed source or lost execution before attaching the candidate', async () => {
    mocks.fingerprint.mockReturnValueOnce('source').mockReturnValue('new-speech');
    await expect(generateAndSaveCourseMindMap(input())).rejects.toThrow('课堂内容已改变');
    expect(mocks.updateCourse).not.toHaveBeenCalled();
    const options = input();
    options.assertExecution.mockRejectedValue(new Error('GENERATION_JOB_EXECUTION_LOST'));
    await expect(generateAndSaveCourseMindMap(options)).rejects.toThrow('EXECUTION_LOST');
  });
});
