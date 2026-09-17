import { describe, expect, it } from 'vitest';
import { streamBufferOwnsActionExecution } from './use-chat-sessions';

describe('StreamBuffer action ownership', () => {
  it('leaves lecture effects to PlaybackEngine instead of replaying the transcript copy', () => {
    expect(streamBufferOwnsActionExecution('lecture')).toBe(false);
  });

  it('keeps live discussion and QA actions owned by their originating buffer', () => {
    expect(streamBufferOwnsActionExecution('discussion')).toBe(true);
    expect(streamBufferOwnsActionExecution('qa')).toBe(true);
  });
});
