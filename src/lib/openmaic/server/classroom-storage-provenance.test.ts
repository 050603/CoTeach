// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), readFile: vi.fn() }));
vi.mock('fs', () => ({ promises: io }));
import { persistClassroom, readClassroom, updatePersistedClassroomForEditing } from './classroom-storage';

const stage = { id: 'fork', name: '课程草稿', createdAt: 1, updatedAt: 1 };
const teachingSource = { courseId: 'course', classroomId: 'original' };
beforeEach(() => { vi.clearAllMocks(); });

describe('server-owned fork provenance persistence', () => {
  it('round-trips the trusted ancestor in the persisted fork without needing client hydration', async () => {
    const saved = await persistClassroom({ id: 'fork', stage, scenes: [], teachingSource });
    const written = JSON.parse(io.writeFile.mock.calls[0][1]);
    expect(written.teachingSource).toEqual(teachingSource);
    io.readFile.mockResolvedValue(JSON.stringify(written));
    expect((await readClassroom('fork'))?.teachingSource).toEqual(teachingSource);
    expect(saved.teachingSource).toEqual(teachingSource);
  });

  it('preserves existing provenance through normal edits and ignores fields outside the editing contract', async () => {
    io.readFile.mockResolvedValue(JSON.stringify({ id: 'fork', stage, scenes: [], revision: 4,
      createdAt: '2026-10-02', teachingSource }));
    const submitted = { stage, scenes: [], teachingSource: { courseId: 'forged', classroomId: 'forged' } };
    const saved = await updatePersistedClassroomForEditing('fork', submitted, 4);
    expect(saved.teachingSource).toEqual(teachingSource);
    expect(JSON.parse(io.writeFile.mock.calls[0][1]).teachingSource).toEqual(teachingSource);
  });
});
