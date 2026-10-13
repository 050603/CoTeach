import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('./logger', () => ({ logger: { info: mocks.info } }));
import { startClassroomAiCall, withClassroomAiUsage } from './classroom-ai';

describe('classroom AI accounting', () => {
  it('reports unknown usage instead of inventing zero and records once', () => {
    const finish = withClassroomAiUsage({ feature: 'knowledge-tutor', courseId: 'course' }, () => startClassroomAiCall('quiz-grade', 'provider', 'model'));
    finish('failed'); finish('failed');
    expect(mocks.info).toHaveBeenCalledTimes(1);
    expect(mocks.info.mock.calls[0][0]).toMatchObject({ courseId: 'course', feature: 'knowledge-tutor',
      usageSource: 'unknown', inputTokens: null, outputTokens: null, totalTokens: null });
  });
  it('keeps provider zero counts and cached tokens without double-counting calls', () => {
    mocks.info.mockClear();
    const finish = startClassroomAiCall('document-collaboration', 'provider', 'model');
    finish('response', { inputTokens: 100, outputTokens: 0, cacheReadTokens: 50, totalTokens: 100 });
    expect(mocks.info.mock.calls[0][0]).toMatchObject({ usageSource: 'provider', inputTokens: 100, outputTokens: 0, cacheReadTokens: 50 });
  });
});
