// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { LaserPointerOverlay } from './LaserPointerOverlay';

vi.mock('@openmaic/lib/contexts/scene-context', () => ({
  useSceneSelector: (select: (content: unknown) => unknown) =>
    select({ canvas: { elements: [{ id: 'text-target', type: 'text' }] } }),
}));

vi.mock('@openmaic/lib/store/canvas', () => ({
  useCanvasStore: {
    use: {
      laserElementId: () => 'text-target',
      laserOptions: () => ({ selector: { quote: '知识点' } }),
      canvasScale: () => 1,
    },
  },
}));

vi.mock('./useVisualTargetGeometry', () => ({
  useVisualTargetGeometry: () => ({
    x: 20, y: 30, w: 40, h: 20, centerX: 40, centerY: 40,
  }),
}));

afterEach(cleanup);

describe('LaserPointerOverlay', () => {
  it('points to the measured target center in the editor preview', () => {
    const { container } = render(<LaserPointerOverlay rootRef={createRef<HTMLDivElement>()} />);
    const laser = container.querySelector<HTMLElement>('[data-visual-cue="laser"]');

    expect(laser).not.toBeNull();
    expect(laser?.style.left).toBe('40%');
    expect(laser?.style.top).toBe('40%');
  });
});
