import { describe, expect, it, vi } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import { isRetryableGenerationError } from './generation-retry';
import { ensureGeneratedWhiteboardQuality } from './whiteboard-quality';

const valid: Action[] = [{ id: 'equation', type: 'wb_draw_latex', latex: 'x=2', x: 60, y: 80, width: 600, height: 80 }];
const broken: Action[] = [{ ...valid[0], type: 'wb_draw_latex', latex: String.raw`\frac{x}{`, x: 60, y: 80 }];

describe('generated whiteboard repair', () => {
  it('does not add an AI call to a valid board', async () => {
    const repair = vi.fn();
    expect(await ensureGeneratedWhiteboardQuality(valid, repair)).toBe(valid);
    expect(repair).not.toHaveBeenCalled();
  });
  it('retries once with specific defects and accepts the corrected board', async () => {
    const repair = vi.fn().mockResolvedValue(valid);
    expect(await ensureGeneratedWhiteboardQuality(broken, repair)).toBe(valid);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(repair.mock.calls[0][0]).toContain('equation');
    expect(repair.mock.calls[0][0]).toContain('公式无法解析');
  });
  it('refuses another broken result or silently dropping whiteboard teaching', async () => {
    for (const repair of [
      vi.fn().mockResolvedValue(broken),
      vi.fn().mockResolvedValue([]),
    ]) {
      const error = await ensureGeneratedWhiteboardQuality(broken, repair).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/白板/);
      expect(error).toMatchObject({ code: 'WHITEBOARD_QUALITY_REPAIR_INCOMPLETE', isRetryable: true });
      expect(isRetryableGenerationError(error)).toBe(true);
    }
  });
  it('drops only optional whiteboard actions after repair is exhausted', async () => {
    const narrated: Action[] = [
      { id: 'intro', type: 'speech', text: '保留讲解' },
      { id: 'open', type: 'wb_open' },
      ...broken,
      { id: 'close', type: 'wb_close' },
      { id: 'recap', type: 'speech', text: '保留总结' },
    ];
    const result = await ensureGeneratedWhiteboardQuality(
      narrated,
      vi.fn().mockResolvedValue(narrated),
      { allowWhiteboardFallback: true },
    );

    expect(result.map((action) => action.id)).toEqual(['intro', 'recap']);
  });
});
