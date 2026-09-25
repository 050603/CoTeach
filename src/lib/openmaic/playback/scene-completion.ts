import type { PlaybackSyncState } from '@openmaic/components/stage-experience';
import type { Scene } from '@openmaic/lib/types/stage';

/** Leave the finished slide visible long enough to read before auto-advancing. */
export const SLIDE_END_PAUSE_MS = 2_000;

export function sceneAutoAdvanceDelayMs(scene: Pick<Scene, 'type'>): number {
  return scene.type === 'quiz' || scene.type === 'interactive' ? 350 : SLIDE_END_PAUSE_MS;
}

/**
 * PlaybackEngine gives an action-less scene one synthetic dwell action. A
 * scene is complete only after that beat (or every real action) is consumed
 * and the engine returns to idle. Merely navigating to a scene is not enough.
 */
export function isScenePlaybackExhausted(
  scene: Pick<Scene, 'id' | 'actions'>,
  state: Omit<PlaybackSyncState, 'version'>,
): boolean {
  if (state.engineMode !== 'idle') return false;
  if (state.snapshot.sceneId && state.snapshot.sceneId !== scene.id) return false;
  const requiredActions = Math.max(1, scene.actions?.length ?? 0);
  return state.snapshot.actionIndex >= requiredActions;
}
