import type { PlaybackActivityEventDetail } from './activity-events';
import type { EngineMode } from './types';

interface ActivityEngine {
  completeActivity: (sceneId: string, purpose: PlaybackActivityEventDetail['purpose']) => boolean;
  getMode: () => EngineMode;
  resume: () => void;
}

/** Release the quiz gate, or advance an older quiz whose playback already ended. */
export function continueAfterActivityConfirmation(
  engine: ActivityEngine | null,
  detail: PlaybackActivityEventDetail,
  currentSceneId: string | null,
  modalBlocked: boolean,
  advanceCompletedQuiz: (sceneId: string) => void,
): void {
  if (detail.sceneId !== currentSceneId) return;
  const released = engine?.completeActivity(detail.sceneId, detail.purpose) ?? false;
  if (detail.purpose !== 'quiz' && detail.purpose !== 'quiz-submit') return;
  if (modalBlocked) return;

  const mode = engine?.getMode();
  if (mode === 'paused' && released) {
    engine?.resume();
  } else if (detail.purpose === 'quiz' && (!engine || mode === 'idle')) {
    advanceCompletedQuiz(detail.sceneId);
  }
}
