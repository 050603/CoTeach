import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { useVisualTargetGeometry } from './useVisualTargetGeometry';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function Harness({ canvasScale = 1 }: { canvasScale?: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const geometry = useVisualTargetGeometry({
    containerRef,
    rootRef,
    elementId: 'copy',
    selector: { cellId: 'detail' },
    canvasScale,
    contentRevision: 'revision',
  });

  return (
    <div data-box="outer">
      <div ref={rootRef} data-box="root">
        <div data-slide-element-id="copy">
          <div className="element-content">
            <div data-slide-cell-id="detail" data-box="target" />
          </div>
        </div>
      </div>
      <div ref={containerRef} data-box="container" />
      <output data-testid="geometry">{geometry ? JSON.stringify(geometry) : 'null'}</output>
    </div>
  );
}

describe('useVisualTargetGeometry layout refresh', () => {
  let targetRect: DOMRect;
  let resize: () => void;
  let frames: Map<number, FrameRequestCallback>;
  let fonts: EventTarget & { ready: Promise<void> };

  beforeEach(() => {
    targetRect = rect(100, 50, 200, 100);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.box === 'target') return targetRect;
      if (this.dataset.box === 'outer') return rect(0, 0, 2000, 1000);
      if (this.dataset.box === 'container') return rect(0, 0, 1000, 500);
      if (this.dataset.box === 'root') return rect(40, 20, 800, 400);
      return rect(0, 0, 1000, 500);
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    frames = new Map();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    fonts = Object.assign(new EventTarget(), { ready: new Promise<void>(() => undefined) });
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, 'fonts');
  });

  function flushFrames() {
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  }

  it('remeasures percentage geometry after resize and font loading', () => {
    render(<Harness />);
    expect(screen.getByTestId('geometry')).toHaveTextContent(
      JSON.stringify({ x: 10, y: 10, w: 20, h: 20, centerX: 20, centerY: 20 }),
    );

    targetRect = rect(200, 100, 100, 50);
    act(() => resize());
    flushFrames();
    expect(screen.getByTestId('geometry')).toHaveTextContent(
      JSON.stringify({ x: 20, y: 20, w: 10, h: 10, centerX: 25, centerY: 25 }),
    );

    targetRect = rect(300, 150, 200, 100);
    act(() => fonts.dispatchEvent(new Event('loadingdone')));
    flushFrames();
    expect(screen.getByTestId('geometry')).toHaveTextContent(
      JSON.stringify({ x: 30, y: 30, w: 20, h: 20, centerX: 40, centerY: 40 }),
    );
  });
});
