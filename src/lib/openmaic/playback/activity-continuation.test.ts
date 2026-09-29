import { describe, expect, it, vi } from 'vitest';
import { continueAfterActivityConfirmation } from './activity-continuation';

const quiz = { sceneId: 'quiz-1', purpose: 'quiz' as const };
const submission = { sceneId: 'quiz-1', purpose: 'quiz-submit' as const };

describe('quiz playback continuation', () => {
  it('advances after confirmation when an older quiz has already exhausted playback', () => {
    const engine = {
      completeActivity: vi.fn(() => false),
      getMode: vi.fn(() => 'idle' as const),
      resume: vi.fn(),
    };
    const advance = vi.fn();

    continueAfterActivityConfirmation(engine, quiz, quiz.sceneId, false, advance);

    expect(engine.completeActivity).toHaveBeenCalledWith('quiz-1', 'quiz');
    expect(advance).toHaveBeenCalledExactlyOnceWith('quiz-1');
    expect(engine.resume).not.toHaveBeenCalled();
  });

  it('advances a quiz with no playback engine', () => {
    const advance = vi.fn();

    continueAfterActivityConfirmation(null, quiz, quiz.sceneId, false, advance);

    expect(advance).toHaveBeenCalledExactlyOnceWith('quiz-1');
  });

  it('resumes feedback narration after a tutor explanation paused the quiz gate', () => {
    const engine = {
      completeActivity: vi.fn(() => true),
      getMode: vi.fn(() => 'paused' as const),
      resume: vi.fn(),
    };
    const advance = vi.fn();

    continueAfterActivityConfirmation(engine, quiz, quiz.sceneId, false, advance);

    expect(engine.completeActivity).toHaveBeenCalledWith('quiz-1', 'quiz');
    expect(engine.resume).toHaveBeenCalledOnce();
    expect(advance).not.toHaveBeenCalled();
  });

  it('does not advance for a stale scene or while an overlay blocks playback', () => {
    const engine = {
      completeActivity: vi.fn(() => false),
      getMode: vi.fn(() => 'idle' as const),
      resume: vi.fn(),
    };
    const advance = vi.fn();

    continueAfterActivityConfirmation(engine, quiz, 'next-scene', false, advance);
    continueAfterActivityConfirmation(engine, quiz, quiz.sceneId, true, advance);

    expect(advance).not.toHaveBeenCalled();
    expect(engine.resume).not.toHaveBeenCalled();
  });

  it('releases a submitted quiz for review without advancing the scene', () => {
    const engine = {
      completeActivity: vi.fn(() => true),
      getMode: vi.fn(() => 'playing' as const),
      resume: vi.fn(),
    };
    const advance = vi.fn();

    continueAfterActivityConfirmation(engine, submission, submission.sceneId, false, advance);

    expect(engine.completeActivity).toHaveBeenCalledExactlyOnceWith('quiz-1', 'quiz-submit');
    expect(advance).not.toHaveBeenCalled();
  });

  it('does not resume unrelated paused narration when confirmation arrives before its gate', () => {
    const engine = {
      completeActivity: vi.fn(() => false),
      getMode: vi.fn(() => 'paused' as const),
      resume: vi.fn(),
    };

    continueAfterActivityConfirmation(engine, quiz, quiz.sceneId, false, vi.fn());

    expect(engine.resume).not.toHaveBeenCalled();
  });
});
