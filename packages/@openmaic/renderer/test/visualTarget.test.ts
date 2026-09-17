// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveVisualTarget,
  resolveVisualTargetGeometry,
} from '../src/utils/visualTarget';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function setRect(element: Element, value: DOMRect): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(value);
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('resolveVisualTargetGeometry', () => {
  it('resolves an element only within the supplied canvas root', () => {
    document.body.innerHTML = `
      <div id="other"><div data-slide-element-id="shared"><div class="element-content"></div></div></div>
      <div id="canvas"><div data-slide-element-id="shared"><div class="element-content"></div></div></div>
    `;
    const root = document.querySelector<HTMLElement>('#canvas')!;
    const target = root.querySelector<HTMLElement>('.element-content')!;
    setRect(root, rect(100, 50, 800, 450));
    setRect(target, rect(300, 140, 200, 90));

    expect(resolveVisualTargetGeometry(root, { elementId: 'shared' })).toEqual({
      x: 25,
      y: 20,
      w: 25,
      h: 20,
      centerX: 37.5,
      centerY: 30,
    });
  });

  it('targets the requested table cell and never falls back when it is missing', () => {
    document.body.innerHTML = `
      <div id="canvas">
        <div data-slide-element-id="table"><div class="element-content">
          <table><tbody><tr><td data-slide-cell-id="primary">Primary</td></tr></tbody></table>
        </div></div>
      </div>
    `;
    const root = document.querySelector<HTMLElement>('#canvas')!;
    const cell = root.querySelector<HTMLElement>('[data-slide-cell-id="primary"]')!;
    setRect(root, rect(0, 0, 1000, 500));
    setRect(cell, rect(250, 100, 300, 80));

    expect(resolveVisualTargetGeometry(root, {
      elementId: 'table',
      selector: { cellId: 'primary' },
    })).toMatchObject({ x: 25, y: 20, w: 30, h: 16 });
    expect(resolveVisualTargetGeometry(root, {
      elementId: 'table',
      selector: { cellId: 'stale-cell' },
    })).toBeNull();
    expect(resolveVisualTarget(root, {
      elementId: 'table',
      selector: { cellId: 'primary' },
    })).toMatchObject({
      rect: { left: 250, top: 100, width: 300, height: 80 },
      observeElement: cell,
    });
  });

  it('resolves a quote inside its cell before measuring the text range', () => {
    document.body.innerHTML = `
      <div id="canvas"><div data-slide-element-id="table"><div class="element-content">
        <table><tbody><tr>
          <td data-slide-cell-id="other">PBL outside</td>
          <td data-slide-cell-id="lesson">先讲 <span>P</span>BL，再讲 PBL</td>
        </tr></tbody></table>
      </div></div></div>
    `;
    const root = document.querySelector<HTMLElement>('#canvas')!;
    const cell = root.querySelector<HTMLElement>('[data-slide-cell-id="lesson"]')!;
    setRect(root, rect(0, 0, 1000, 500));
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(420, 130, 48, 24),
    });

    const resolved = resolveVisualTarget(root, {
      elementId: 'table',
      selector: { cellId: 'lesson', quote: 'PBL', occurrence: 1 },
    });
    expect(resolved).toMatchObject({
      rect: { left: 420, top: 130, width: 48, height: 24 },
      observeElement: cell,
    });
    expect(resolveVisualTargetGeometry(root, {
      elementId: 'table',
      selector: { cellId: 'lesson', quote: 'PBL', occurrence: 1 },
    })).toMatchObject({ x: 42, y: 26, w: 4.8, h: 4.8 });
    expect(resolveVisualTarget(root, {
      elementId: 'table',
      selector: { cellId: 'lesson', quote: 'outside' },
    })).toBeNull();
  });

  it('selects a zero-based repeated quote across rich-text nodes', () => {
    document.body.innerHTML = `
      <div id="canvas"><div data-slide-element-id="text"><div class="element-content">
        first P<span>B</span>L, second <strong>PBL</strong>
      </div></div></div>
    `;
    const root = document.querySelector<HTMLElement>('#canvas')!;
    setRect(root, rect(0, 0, 1000, 500));
    let selected = '';
    let selectedParent = '';
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Range) {
        selected = this.toString();
        selectedParent = this.startContainer.parentElement?.tagName ?? '';
        return rect(600, 200, 60, 20);
      },
    });

    expect(resolveVisualTargetGeometry(root, {
      elementId: 'text',
      selector: { quote: 'PBL', occurrence: 1 },
    })).toMatchObject({ x: 60, y: 40, w: 6, h: 4 });
    expect(selected).toBe('PBL');
    expect(selectedParent).toBe('STRONG');
    expect(resolveVisualTargetGeometry(root, {
      elementId: 'text',
      selector: { quote: 'PBL', occurrence: 2 },
    })).toBeNull();
  });
});
