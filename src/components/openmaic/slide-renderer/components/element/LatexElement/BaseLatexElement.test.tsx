import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PPTLatexElement } from '@openmaic/dsl';
import { BaseLatexElement as AppLatex } from './BaseLatexElement';
import { BaseLatexElement as PackageLatex } from '../../../../../../../packages/@openmaic/renderer/src/elements/latex/BaseLatexElement';

const element: PPTLatexElement = {
  id: 'formula', type: 'latex', left: 20, top: 30, width: 200, height: 60,
  rotate: 0, color: '#111111', latex: 'x', html: '<span style="font:20px KaTeX_Main">x</span>',
} as PPTLatexElement;

describe.each([['app', AppLatex], ['package', PackageLatex]] as const)('%s formula font timing', (_name, Component) => {
  let naturalWidth: number;
  let resize: () => void;
  let disconnect: ReturnType<typeof vi.fn>;
  let fonts: EventTarget & { load: ReturnType<typeof vi.fn>; ready: Promise<void> };
  let finishFonts: () => void;
  let frames: Map<number, FrameRequestCallback>;
  beforeEach(() => {
    naturalWidth = 100;
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => naturalWidth);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(40);
    frames = new Map(); let id = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++id, callback); return id; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
    disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    fonts = Object.assign(new EventTarget(), {
      load: vi.fn().mockResolvedValue([]),
      ready: new Promise<void>((resolve) => { finishFonts = resolve; }),
    });
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, 'fonts'); });
  function flushFrames() { act(() => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); }); }
  it('fits the same frame again when delayed KaTeX fonts finish, preserving DSL geometry', async () => {
    const { container } = render(<Component elementInfo={element} />);
    const inner = container.querySelector('[style*="scale("]') as HTMLElement;
    expect(fonts.load).toHaveBeenCalled();
    naturalWidth = 400;
    await act(async () => { finishFonts(); await fonts.ready; });
    flushFrames();
    expect(inner.style.transform).toBe('scale(0.5)');
    expect((container.firstChild as HTMLElement).style.width).toBe('200px');
    expect((container.firstChild as HTMLElement).style.left).toBe('20px');
  });
  it('coalesces font and resize events into one frame and keeps the fit stable', () => {
    const { container } = render(<Component elementInfo={element} />);
    naturalWidth = 500;
    act(() => { fonts.dispatchEvent(new Event('loadingdone')); resize(); resize(); });
    expect(frames.size).toBe(1);
    flushFrames();
    expect((container.querySelector('[style*="scale("]') as HTMLElement).style.transform).toBe('scale(0.4)');
    expect(frames.size).toBe(0);
  });
  it('preserves fractional font widths when scrollWidth rounds down', () => {
    const { container } = render(<Component elementInfo={element} />);
    const inner = container.querySelector('[style*="scale("]') as HTMLElement;
    naturalWidth = 400;
    inner.style.width = '400.4px';
    act(() => resize());
    flushFrames();
    expect(inner.style.transform).toBe(`scale(${200 / 400.4})`);
  });
  it('disconnects observers and ignores late font promises after unmount', async () => {
    const remove = vi.spyOn(fonts, 'removeEventListener');
    const { unmount } = render(<Component elementInfo={element} />);
    act(() => resize());
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('loadingdone', expect.any(Function));
    await act(async () => { finishFonts(); await fonts.ready; });
    expect(frames.size).toBe(0);
  });
});
