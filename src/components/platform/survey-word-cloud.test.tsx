import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SurveyWordCloud } from './survey-word-cloud';

vi.mock('@visx/wordcloud', () => ({
  Wordcloud: ({ width, height }: { width: number; height: number }) => <svg aria-label="词云画布" width={width} height={height} />,
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('fits the measured container when a short projection window is resized', () => {
  let width = 240;
  let height = 179;
  let resized: () => void = () => {};
  const disconnect = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {} }));
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const { unmount } = render(<SurveyWordCloud terms={[{ label: '团队合作', value: 3 }]} onSelect={vi.fn()} large />);
  expect(screen.getByLabelText('词云画布')).toHaveAttribute('width', '240');
  expect(screen.getByLabelText('词云画布')).toHaveAttribute('height', '179');
  act(() => { width = 640; height = 400; resized(); });
  expect(screen.getByLabelText('词云画布')).toHaveAttribute('width', '640');
  expect(screen.getByLabelText('词云画布')).toHaveAttribute('height', '400');
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});
