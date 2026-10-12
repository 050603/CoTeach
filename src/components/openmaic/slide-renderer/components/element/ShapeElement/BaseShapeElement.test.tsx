import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PPTShapeElement } from '@openmaic/dsl';
import { BaseShapeElement } from './BaseShapeElement';

const element: PPTShapeElement = {
  id: 'process-step', type: 'shape', left: 0, top: 0, width: 182, height: 60,
  rotate: 0, fixedRatio: false, viewBox: [182, 60], path: 'M0 0H182V60H0Z', fill: '#ffffff',
  text: {
    content: '<p style="font-size:18px;font-weight:700;line-height:1.25">情境创设，提出问题</p>',
    align: 'middle', defaultFontName: 'Noto Sans SC', defaultColor: '#333333',
  },
};

afterEach(() => { cleanup(); document.documentElement.style.removeProperty('font-size'); });

describe('playback shape text layout', () => {
  it.each([16, 24, 32])('keeps the editor’s 10px text inset when the page root font is %ipx', (fontSize) => {
    document.documentElement.style.fontSize = `${fontSize}px`;
    const { container } = render(<BaseShapeElement elementInfo={element} />);
    const text = container.querySelector('.shape-text')!;
    const style = getComputedStyle(text);
    expect(style.paddingLeft).toBe('10px');
    expect(style.paddingRight).toBe('10px');
    expect(style.paddingTop).toBe('10px');
    expect(style.paddingBottom).toBe('10px');
    expect(style.lineHeight).toBe('1.5');
    expect((container.firstChild as HTMLElement).style.width).toBe('182px');
    expect(text.querySelector('p')?.style.fontSize).toBe('18px');
  });

  it('preserves authored line height, letter spacing and explicit line breaks', () => {
    const { container } = render(<BaseShapeElement elementInfo={{ ...element, text: {
      ...element.text!, content: '<p>创设情境<br>提出任务</p>', lineHeight: 1.25, wordSpace: 2,
    } }} />);
    const text = container.querySelector('.shape-text') as HTMLElement;
    expect(text.style.lineHeight).toBe('1.25');
    expect(text.style.letterSpacing).toBe('2px');
    expect(text.querySelectorAll('br')).toHaveLength(1);
    expect(text.textContent).toBe('创设情境提出任务');
  });
});
