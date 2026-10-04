import { describe, expect, it } from 'vitest';
import { isUnrequestedSpokenSectionContinuation } from './saved-spoken-section-policy';

describe('partial spoken draft continuation', () => {
  it('permits only untouched later sections', () => {
    expect(isUnrequestedSpokenSectionContinuation({ spokenSectionCount: 4 }, 'spoken-section:5', undefined)).toBe(true);
    expect(isUnrequestedSpokenSectionContinuation({ spokenSectionCount: 4 }, 'spoken-section:6', { attemptsStarted: 0 })).toBe(true);
    expect(isUnrequestedSpokenSectionContinuation({ spokenSectionCount: 4 }, 'spoken-section:4', undefined)).toBe(false);
    expect(isUnrequestedSpokenSectionContinuation({ spokenSectionCount: 4 }, 'spoken-section:5', { attemptsStarted: 1 })).toBe(false);
    expect(isUnrequestedSpokenSectionContinuation({ spokenSectionCount: 4 }, 'spoken-section:5', {})).toBe(false);
  });

  it.each(['teaching-blueprint', 'knowledge-structure', 'ai-duration', 'course-seed'])('never reauthors %s during a partial replay', (stage) => {
    expect(isUnrequestedSpokenSectionContinuation({ spokenSectionCount: 4 }, stage, undefined)).toBe(false);
  });

  it.each([undefined, 0, -1, 1.5, NaN])('does not expand an invalid or ordinary replay permission (%s)', (spokenSectionCount) => {
    expect(isUnrequestedSpokenSectionContinuation({ spokenSectionCount }, 'spoken-section:5', undefined)).toBe(false);
  });
});
