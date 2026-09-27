import { describe, expect, it, vi } from 'vitest';
import { shouldApplyProjectedPlayback, type AppliedProjectedPlayback } from './projection-sync';

describe('projected playback reconciliation', () => {
  it('never restores the same or stale snapshot over local playback progress', () => {
    const engine = { actionIndex: 2, restore: vi.fn() };
    let applied: AppliedProjectedPlayback | null = null;
    const deliver = (version: number, actionIndex: number) => {
      if (!shouldApplyProjectedPlayback(applied, engine, version)) return;
      engine.restore(actionIndex);
      engine.actionIndex = actionIndex;
      applied = { engine, version };
    };
    deliver(5, 2);
    engine.actionIndex = 4;
    deliver(5, 2); // Unrelated course refresh recreates props.
    deliver(4, 1); // Delayed transport delivery.
    expect(engine.actionIndex).toBe(4);
    expect(engine.restore).toHaveBeenCalledOnce();
    deliver(6, 6);
    expect(engine.actionIndex).toBe(6);
  });

  it('restores a newly mounted engine even when the projection version did not change', () => {
    const previous = { engine: {}, version: 5 };
    expect(shouldApplyProjectedPlayback(previous, {}, 5)).toBe(true);
  });
});
