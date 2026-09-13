import { describe, expect, it, vi } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
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
    await expect(ensureGeneratedWhiteboardQuality(broken, vi.fn().mockResolvedValue(broken))).rejects.toThrow(/白板仍存在/);
    await expect(ensureGeneratedWhiteboardQuality(broken, vi.fn().mockResolvedValue([]))).rejects.toThrow(/未保留讲授内容/);
  });
});
