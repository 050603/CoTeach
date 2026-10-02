import { describe, expect, it, vi } from 'vitest';
import { getSvgPathRange, toPoints } from './svg-path-parser';

describe('native PowerPoint shape paths', () => {
  it('retains every rectangle edge and its closure from horizontal and vertical commands', () => {
    expect(toPoints('M0 0H100V60H0Z')).toEqual([
      { type: 'M', x: 0, y: 0, relative: false },
      { type: 'L', x: 100, y: 0, relative: false },
      { type: 'L', x: 100, y: 60, relative: false },
      { type: 'L', x: 0, y: 60, relative: false },
      { type: 'Z', close: true },
    ]);
  });

  it('resolves relative edges and the next subpath after closing a support shape', () => {
    expect(toPoints('m10 20h80v60h-80z m5 5h10v10z')).toEqual([
      { type: 'M', x: 10, y: 20, relative: false },
      { type: 'L', x: 90, y: 20, relative: false },
      { type: 'L', x: 90, y: 80, relative: false },
      { type: 'L', x: 10, y: 80, relative: false },
      { type: 'Z', close: true },
      { type: 'M', x: 15, y: 25, relative: false },
      { type: 'L', x: 25, y: 25, relative: false },
      { type: 'L', x: 25, y: 35, relative: false },
      { type: 'Z', close: true },
    ]);
  });

  it('preserves the torso and limbs around curved learner shoulders', () => {
    const points = toPoints('M5 13Q0 15 0 20V28H5V45H11V30H17V45H23V28H28V20Q28 15 23 13Z');
    expect(points.filter((point) => point.type === 'L')).toHaveLength(11);
    expect(points.filter((point) => point.type === 'Q')).toHaveLength(2);
    expect(points).toContainEqual({ type: 'L', x: 17, y: 45, relative: false });
    expect(points.at(-1)).toEqual({ type: 'Z', close: true });
  });

  it('expands smooth cubic and quadratic segments without losing their reflected controls', () => {
    expect(toPoints('M0 0C10 0 10 10 20 10S30 20 40 10').at(-1)).toMatchObject({
      type: 'C', x: 40, y: 10, curve: { type: 'cubic', x1: 30, y1: 10, x2: 30, y2: 20 },
    });
    expect(toPoints('M0 0Q10 10 20 0T40 0').at(-1)).toMatchObject({
      type: 'Q', x: 40, y: 0, curve: { type: 'quadratic', x1: 30, y1: -10 },
    });
  });

  it('converts an arc after a closed subpath from its real starting coordinate', () => {
    const points = toPoints('M10 10H30V30Z a10 10 0 0 1 10 10');
    expect(points.at(-1)).toMatchObject({ type: 'C', x: 20, y: 20, relative: false });
    expect(points.filter((point) => 'x' in point).every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    expect(getSvgPathRange('M10 10H30V30Z a10 10 0 0 1 10 10')).toMatchObject({ minX: 10, minY: 10, maxX: 30, maxY: 30 });
  });

  it('keeps malformed paths isolated instead of aborting the presentation export', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(toPoints('M0 0 broken')).toEqual([]);
    warning.mockRestore();
  });
});
