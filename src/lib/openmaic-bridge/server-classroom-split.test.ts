import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene, Stage } from '@openmaic/lib/types/stage';

const mocks = vi.hoisted(() => ({ read: vi.fn(), persist: vi.fn() }));
vi.mock('@openmaic/lib/server/classroom-storage', () => ({ readClassroom: mocks.read, persistClassroom: mocks.persist }));
import { splitGeneratedClassroom } from './server-classroom-split';

const stage = { id: 'lesson', name: 'Course', createdAt: 1, updatedAt: 1 } as Stage;
const scenes = [
  { id: 'student', type: 'slide', title: 'Concept', order: 0, audience: 'student', stageKey: 'ai-learning', generationPurpose: 'knowledge-teaching', actions: [] },
  { id: 'teacher', type: 'slide', title: 'Teacher resource', order: 1, audience: 'teacher', stageKey: 'make', generationPurpose: 'teacher-resource', actions: [] },
] as unknown as Scene[];

beforeEach(() => { vi.clearAllMocks(); mocks.persist.mockResolvedValue(undefined); });

describe('classroom split asset readiness', () => {
  it('preserves running preparation on both classroom snapshots before preview links are exposed', async () => {
    const assetGeneration = { status: 'running', requested: 2, completed: 0, failures: [], updatedAt: '2026-09-23T00:00:00Z' };
    mocks.read.mockResolvedValue({ assetGeneration });
    const split = await splitGeneratedClassroom({ stage, scenes, pblMode: true });
    expect(split.studentClassroomId).toBe('lesson');
    expect(split.teacherClassroomId).toBe('lesson-teacher');
    expect(mocks.persist).toHaveBeenCalledTimes(2);
    for (const [snapshot] of mocks.persist.mock.calls) expect(snapshot.assetGeneration).toEqual(assetGeneration);
  });

  it('does not invent an unfinished media phase for classrooms without requested assets', async () => {
    mocks.read.mockResolvedValue(null);
    await splitGeneratedClassroom({ stage, scenes: scenes.slice(0, 1), pblMode: false });
    expect(mocks.persist.mock.calls[0][0]).not.toHaveProperty('assetGeneration');
  });
});
