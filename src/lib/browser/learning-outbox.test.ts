import { beforeEach, expect, it, vi } from 'vitest';
import { drainLearningWrites, enqueueLearningWrite, readLearningWrites } from './learning-outbox';

beforeEach(() => localStorage.clear());

it('retains a failed write across a new reader and removes it only after acknowledgement', async () => {
  enqueueLearningWrite('student-a:course-a', { completed: ['scene-1'] }, 'stable-id');
  await expect(drainLearningWrites('student-a:course-a', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  expect(readLearningWrites('student-a:course-a')).toMatchObject([{ id: 'stable-id', value: { completed: ['scene-1'] } }]);
  const send = vi.fn(async () => undefined);
  await drainLearningWrites('student-a:course-a', send);
  expect(send).toHaveBeenCalledWith({ completed: ['scene-1'] }, 'stable-id');
  expect(readLearningWrites('student-a:course-a')).toEqual([]);
});

it('serializes writes made during a pending acknowledgement without deleting the new item', async () => {
  enqueueLearningWrite('queue', 1, 'z');
  let release!: () => void;
  const sent: number[] = [];
  const drain = drainLearningWrites<number>('queue', async (value) => {
    sent.push(value);
    if (value === 1) await new Promise<void>((resolve) => { release = resolve; });
  });
  enqueueLearningWrite('queue', 2, 'a');
  expect(drainLearningWrites('queue', vi.fn())).toBe(drain);
  release();
  await drain;
  expect(sent).toEqual([1, 2]);
});

it('isolates learners and courses and surfaces storage failures', () => {
  enqueueLearningWrite('student-a:course-a', 1);
  enqueueLearningWrite('student-b:course-a', 2);
  enqueueLearningWrite('student-a:course-b', 3);
  expect(readLearningWrites('student-a:course-a').map((item) => item.value)).toEqual([1]);
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  expect(() => enqueueLearningWrite('student-a:course-a', 4)).toThrow('quota');
  storage.mockRestore();
});

it('passes the same durable identity to old queue payloads after a lost acknowledgement', async () => {
  enqueueLearningWrite('legacy-progress', { completedScenes: ['a'] }, 'old-persisted-id');
  const requests: unknown[] = [];
  await expect(drainLearningWrites('legacy-progress', async (body, id) => { requests.push({ body, requestId: id }); throw new Error('lost ACK'); })).rejects.toThrow('lost ACK');
  await drainLearningWrites('legacy-progress', async (body, id) => { requests.push({ body, requestId: id }); });
  expect(requests[1]).toEqual(requests[0]);
});
