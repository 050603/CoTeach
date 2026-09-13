import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WbDrawLatexAction, WbDrawLineAction } from '@openmaic/lib/types/action';
import { whiteboardActionToElement } from '@openmaic/lib/whiteboard/projection';
import { WhiteboardPreview } from '@openmaic/components/edit/ActionsBar/WhiteboardPreview';
import { WhiteboardElement } from './whiteboard-element';

vi.mock('shiki', () => ({ createHighlighter: async () => ({ codeToHtml: () => '' }) }));

describe('native whiteboard rendering', () => {
  it('renders formula HTML through the same native element in the preview and playback', () => {
    const action: WbDrawLatexAction = {
      id: 'formula', type: 'wb_draw_latex', latex: '\\frac{a^2}{b}',
      x: 40, y: 60, width: 320, height: 90, color: '#345678',
    };
    const { container } = render(<>
      <WhiteboardPreview actions={[action]} />
      <WhiteboardElement element={whiteboardActionToElement(action)!} />
    </>);
    const formulas = container.querySelectorAll('.base-element-latex');
    expect(formulas).toHaveLength(2);
    expect(formulas[0].querySelector('.katex')?.innerHTML).toBe(formulas[1].querySelector('.katex')?.innerHTML);
    for (const formula of formulas) {
      expect(formula.querySelector('.katex')).not.toBeNull();
      expect(formula.querySelector('.element-content')).toHaveStyle({ color: '#345678' });
    }
  });

  it('uses native direction markers in both views without colliding SVG IDs', () => {
    const action: WbDrawLineAction = {
      id: 'arrow', type: 'wb_draw_line', startX: 600, startY: 300, endX: 100, endY: 100,
      points: ['arrow', 'arrow'], width: 3, style: 'dashed', color: '#123456',
    };
    const { container } = render(<>
      <WhiteboardPreview actions={[action]} />
      <WhiteboardElement element={whiteboardActionToElement(action)!} />
    </>);
    const lines = container.querySelectorAll('.base-element-line');
    expect(lines).toHaveLength(2);
    const markers = Array.from(container.querySelectorAll('marker'));
    expect(markers).toHaveLength(4);
    expect(new Set(markers.map((marker) => marker.id)).size).toBe(4);
    for (const line of lines) {
      const path = line.querySelector('svg > path')!;
      expect(path).toHaveAttribute('d', 'M500,200 L0,0');
      expect(path).toHaveAttribute('stroke', '#123456');
      expect(path).toHaveAttribute('stroke-dasharray', '15 7.5');
      for (const side of ['start', 'end']) {
        const markerRef = path.getAttribute(`marker-${side}`);
        expect(markerRef).toBe(`url(#${line.querySelector(`marker[id$="-${side}"]`)!.id})`);
      }
    }
  });

  it('shows an editable error for invalid formulas instead of dropping the entire board', () => {
    const { container } = render(<WhiteboardPreview actions={[{
      id: 'broken', type: 'wb_draw_latex', latex: '\\frac{', x: 40, y: 40,
    }]} />);
    expect(container.textContent).toContain('\\frac{');
    expect(container.textContent).toContain('公式无法解析');
  });

  it('renders table cell strings as literal text at the same readable size in both surfaces', () => {
    const { container } = render(<WhiteboardPreview actions={[{
      id: 'table', type: 'wb_draw_table', x: 30, y: 30, width: 600, height: 180,
      data: [['<img src=x onerror="alert(1)">', 'a < b & "quoted"\nnext line']],
    }]} />);
    const cells = container.querySelectorAll('td');
    expect(cells).toHaveLength(2);
    expect(cells[0]).toHaveTextContent('<img src=x onerror="alert(1)">');
    expect(cells[0].querySelector('img')).toBeNull();
    expect(cells[1]).toHaveTextContent('a < b & "quoted"');
    expect(cells[1].querySelector('br')).not.toBeNull();
    for (const cell of cells) expect(cell).toHaveStyle({ fontSize: '18px' });
  });
});
