import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Course } from '@/lib/session/types';
import { requeueCourseGenerationFromCheckpoints } from './job-runner';

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), replace: vi.fn(), count: vi.fn(), updateCourse: vi.fn() }));
vi.mock('./job-storage', async (importOriginal) => ({
  ...await importOriginal<typeof import('./job-storage')>(),
  contentGenerationJobs: { findUnique: mocks.findUnique, replace: mocks.replace },
}));
vi.mock('./checkpoint-storage', async (importOriginal) => ({
  ...await importOriginal<typeof import('./checkpoint-storage')>(), countGenerationPageCheckpoints: mocks.count,
}));
vi.mock('@/lib/session/server-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/session/server-store')>(), updateCourse: mocks.updateCourse,
}));

const failed = { id: 'job', courseId: 'course', status: 'failed', version: 7, request: { courseId: 'course', managedRecoveryCount: 2, requirement: 'Adopted plan' } };

describe('explicit checkpoint recovery lifecycle notification', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.count.mockResolvedValue(3);
  });

  it('publishes the existing course invalidation only after the guarded queue write succeeds, preserving teaching references', async () => {
    const queued = { ...failed, status: 'queued', version: 8 };
    const classroomContent = { _openmaicClassroomId: 'old-playable-classroom', _openmaicSceneOutlines: [{ id: 'accepted-page' }] };
    const course = { id: 'course', version: 123, aiLearningClassroomId: 'old-playable-classroom', content: classroomContent } as unknown as Course;
    const order: string[] = [];
    mocks.findUnique.mockResolvedValueOnce(failed).mockResolvedValueOnce(queued);
    mocks.replace.mockImplementation(async () => { order.push('queued'); return queued; });
    mocks.updateCourse.mockImplementation(async (id: string, updater: (current: Course) => Course) => {
      order.push('invalidated');
      expect(id).toBe('course');
      expect(updater(course)).toBe(course);
      expect(updater(course).content).toBe(classroomContent);
      expect(updater(course).aiLearningClassroomId).toBe('old-playable-classroom');
    });
    await expect(requeueCourseGenerationFromCheckpoints('course')).resolves.toBe(queued);
    expect(order).toEqual(['queued', 'invalidated']);
    expect(mocks.updateCourse).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job', status: 'failed', version: 7 },
      checkpointPolicy: { prefixes: ['stage-attempt:'] },
      data: expect.objectContaining({ status: 'queued', activePages: [], stageProgress: [], currentStage: null,
        request: { ...failed.request, managedRecoveryCount: 0 } }),
    }));
  });

  it('does not emit a false course update when the failed/version compare-and-swap loses', async () => {
    mocks.findUnique.mockResolvedValue(failed);
    mocks.replace.mockRejectedValue(new Error('GENERATION_JOB_NOT_FOUND'));
    await expect(requeueCourseGenerationFromCheckpoints('course')).rejects.toThrow('GENERATION_JOB_NOT_FOUND');
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });

  it.each(['queued', 'running', 'completed'])('does not write or notify an already %s job', async (status) => {
    const existing = { ...failed, status };
    mocks.findUnique.mockResolvedValue(existing);
    await expect(requeueCourseGenerationFromCheckpoints('course')).resolves.toBe(existing);
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });
});
