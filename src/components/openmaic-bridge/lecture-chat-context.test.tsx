import { describe, expect, it } from 'vitest';
import type { Scene } from '@openmaic/lib/types/stage';
import { resolveLectureChatPage } from './lecture-chat-context';

describe('lecture chat source pages', () => {
  it('keeps adaptive conversations on the original page when an insertion is recreated', () => {
    const page = (insertionId: string) => resolveLectureChatPage({
      id: `adaptive:${insertionId}:source:page`, type: 'slide',
      openpblAdaptiveInsertionId: insertionId, openpblAdaptiveClassroomId: 'resource',
    } as unknown as Scene, 'main');
    expect(page('run-1')).toEqual({ classroomId: 'resource', sceneId: 'source:page' });
    expect(page('run-2')).toEqual(page('run-1'));
  });

  it('excludes assessment and teacher-only pages from the lecture input', () => {
    expect(resolveLectureChatPage(null, 'main')).toBeNull();
    for (const scene of [{ type: 'quiz' }, { type: 'pbl' }, { type: 'slide', audience: 'teacher' }]) {
      expect(resolveLectureChatPage(scene as Scene, 'main')).toBeNull();
    }
    expect(resolveLectureChatPage({ id: 'page', type: 'slide' } as Scene, 'main'))
      .toEqual({ classroomId: 'main', sceneId: 'page' });
  });
});
