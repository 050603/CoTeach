import { describe, expect, it } from 'vitest';
import type { Action, WbDrawLineAction, WbDrawShapeAction } from '@openmaic/lib/types/action';
import { auditWhiteboardLayout, getWhiteboardActionBox, resolveWhiteboardLine, WHITEBOARD_HEIGHT, WHITEBOARD_WIDTH } from './layout';

const shape = (id: string, x = 40): WbDrawShapeAction => ({
  id: `${id}-action`, type: 'wb_draw_shape', elementId: id, shape: 'rectangle', x, y: 40, width: 200, height: 100,
});
const line = (patch: Partial<WbDrawLineAction> = {}): WbDrawLineAction => ({
  id: 'line', type: 'wb_draw_line', startX: 240, startY: 90, endX: 600, endY: 90,
  startAnchor: { elementId: 'a', side: 'right' }, endAnchor: { elementId: 'b', side: 'left' }, ...patch,
});

describe('whiteboard shared geometry', () => {
  it('uses a fixed canvas and stable fallback ids without treating a line as an occupied box', () => {
    expect([WHITEBOARD_WIDTH, WHITEBOARD_HEIGHT]).toEqual([1000, 562.5]);
    expect(getWhiteboardActionBox({ id: 'note', type: 'wb_draw_text', x: 10, y: 20, content: '文字' }))
      .toEqual({ id: 'note', left: 10, top: 20, width: 400, height: 100 });
    expect(getWhiteboardActionBox(line())).toBeNull();
  });

  it('attaches rectangle, ellipse and triangle lines to their actual contours', () => {
    for (const kind of ['rectangle', 'circle', 'triangle'] as const) {
      const target = { ...shape('a'), shape: kind };
      expect(resolveWhiteboardLine(line({ startAnchor: { elementId: 'a', side: 'right' } }), [target]).startX)
        .toBe(kind === 'triangle' ? 190 : 240);
      expect(resolveWhiteboardLine(line({ startAnchor: { elementId: 'a', side: 'left' } }), [target]).startX)
        .toBe(kind === 'triangle' ? 90 : 40);
      expect(resolveWhiteboardLine(line({ startAnchor: { elementId: 'a', side: 'top' } }), [target]))
        .toMatchObject({ startX: 140, startY: 40 });
      expect(resolveWhiteboardLine(line({ startAnchor: { elementId: 'a', side: 'bottom' } }), [target]))
        .toMatchObject({ startX: 140, startY: 140 });
    }
  });

  it('resolves action-id aliases and preserves fallback coordinates for a missing anchor', () => {
    const input = line({ startAnchor: { elementId: 'a-action', side: 'center' }, endAnchor: { elementId: 'missing', side: 'left' } });
    expect(resolveWhiteboardLine(input, [shape('a')])).toMatchObject({ startX: 140, startY: 90, endX: 600, endY: 90 });
    expect(input.startX).toBe(240);
  });

  it('permits labels inside nodes but diagnoses text collisions even in the same group', () => {
    const node = { ...shape('a'), groupId: 'node' };
    const label: Action = { id: 'label', type: 'wb_draw_text', groupId: 'node', x: 60, y: 65, width: 160, height: 50, content: '节点' };
    expect(auditWhiteboardLayout([node, label])).toEqual([]);
    expect(auditWhiteboardLayout([label, { ...label, id: 'other-label' }]))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'overlap', actionIds: ['label', 'other-label'] })]));
  });

  it('diagnoses lines through unrelated content while exempting connected nodes and their labels', () => {
    const nodes: Action[] = [shape('a'), shape('b', 600), {
      id: 'label', type: 'wb_draw_text', content: '节点', x: 60, y: 65, width: 160, height: 50,
    }];
    expect(auditWhiteboardLayout([...nodes, line({ startAnchor: { elementId: 'a', side: 'center' } })])).toEqual([]);
    const obstacle: Action = { id: 'obstacle', type: 'wb_draw_text', content: '其他说明', x: 350, y: 70, width: 160, height: 60 };
    expect(auditWhiteboardLayout([...nodes, obstacle, line()])).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'line-through-content', actionIds: ['line', 'obstacle'] }),
    ]));
    expect(auditWhiteboardLayout([...nodes, { ...obstacle, y: 90 }, line()])).toEqual([]);
  });

  it('reports a nonexistent anchor but cascades normal target deletion to its connectors', () => {
    expect(auditWhiteboardLayout([line()]).filter((issue) => issue.code === 'missing-anchor')).toHaveLength(2);
    expect(auditWhiteboardLayout([
      shape('a'), shape('b', 600), line(), { id: 'delete', type: 'wb_delete', elementId: 'a-action' },
    ])).toEqual([]);
  });

  it('retains content across close/open and resets only after explicit clear', () => {
    const first: Action = { id: 'first', type: 'wb_draw_text', content: '第一段', x: 40, y: 40, width: 300, height: 80 };
    const second = { ...first, id: 'second' };
    expect(auditWhiteboardLayout([first, { id: 'close', type: 'wb_close' }, { id: 'open', type: 'wb_open' }, second]))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'overlap' })]));
    expect(auditWhiteboardLayout([first, { id: 'clear', type: 'wb_clear' }, second])).toEqual([]);
    expect(auditWhiteboardLayout([first, { ...second, elementId: 'first' }])).toEqual([]);
  });

  it('keeps intermediate problems visible after a later clear and diagnoses unreadable geometry', () => {
    const issues = auditWhiteboardLayout([
      { id: 'bad', type: 'wb_draw_text', x: -20, y: 600, width: 30, height: 15, fontSize: 8, content: '无法完整展示的长文字' },
      { id: 'invalid', type: 'wb_draw_shape', x: NaN, y: 0, width: 100, height: 100, shape: 'rectangle' },
      { id: 'clear', type: 'wb_clear' }, { id: 'delete', type: 'wb_delete', elementId: 'bad' },
    ]);
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['out-of-bounds', 'unreadable-content', 'invalid-geometry', 'missing-target']));
  });
});
