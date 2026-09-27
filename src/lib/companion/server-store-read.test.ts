// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { loadCompanionState } from './server-store';
import type { PlatformDb } from '@/lib/platform/access';

const timestamp = new Date('2026-09-27T00:00:00.000Z');
const stages = [undefined, null, 0, false, [], {}, '', 'make', '文档_%'];
const rows = stages.map((stage, index) => ({
  id: String(index), userId: 'student', metadata: stage === undefined ? {} : { legacyStageKey: stage },
  createdAt: timestamp, updatedAt: timestamp,
  messages: [{ id: `message-${index}`, role: 'user', content: 'Retained original', createdAt: timestamp, metadata: {} }],
}));
function database(filtered: boolean) {
  const findMany = vi.fn(async () => filtered ? rows.filter(row => typeof row.metadata.legacyStageKey === 'string') : rows);
  return { findMany, db: {
    aiConversation: { findMany }, aiTask: { findMany: vi.fn(async () => []) },
    aiActionConfirmation: { findMany: vi.fn(async () => []) }, aiSupportRecord: { findMany: vi.fn(async () => []) },
  } as unknown as PlatformDb };
}
describe('companion read projection', () => {
  it.each(['student', undefined])('preserves full threads and messages when prefiltering string stage keys (%s)', async student => {
    const original = database(false), filtered = database(true);
    const before = await loadCompanionState('course', original.db, student);
    const after = await loadCompanionState('course', filtered.db, student);
    expect(after).toEqual(before);
    expect(after.companionThreads?.map(thread => thread.stageKey)).toEqual(['', 'make', '文档_%']);
    expect(after.companionThreads?.every(thread => thread.messages[0].content === 'Retained original')).toBe(true);
    expect(filtered.findMany).toHaveBeenCalledWith({
      where: { participation: { instanceId: 'course' }, ...(student ? { userId: student } : {}),
        metadata: { path: ['legacyStageKey'], string_starts_with: '' } },
      include: { messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
  });
});
