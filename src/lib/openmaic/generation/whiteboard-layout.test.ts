import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import { normalizeWhiteboardActionLayout } from './whiteboard-layout';
import { auditWhiteboardLayout, getWhiteboardActionBox, resolveWhiteboardLine } from '@openmaic/lib/whiteboard/layout';

describe('normalizeWhiteboardActionLayout', () => {
  it('moves later content below an existing note instead of covering it', () => {
    const actions: Action[] = [
      { id: 'a', type: 'wb_draw_text', elementId: 'a', content: '前文', x: 40, y: 40, width: 400, height: 100 },
      { id: 'b', type: 'wb_draw_text', elementId: 'b', content: '后文', x: 60, y: 70, width: 400, height: 100 },
    ];
    const result = normalizeWhiteboardActionLayout(actions);
    expect(result[0]).toMatchObject({ y: 40 });
    expect(result[1]).toMatchObject({ y: 164 });
  });

  it('starts a fresh layout page after a board clear', () => {
    const result = normalizeWhiteboardActionLayout([
      { id: 'a', type: 'wb_draw_text', content: '旧内容', x: 40, y: 40 },
      { id: 'clear', type: 'wb_clear' },
      { id: 'b', type: 'wb_draw_text', content: '新内容', x: 40, y: 40 },
    ]);
    expect(result[2]).toMatchObject({ y: 40 });
  });

  it('moves a node and its contained label together while anchored arrows follow it', () => {
    const actions: Action[] = [
      { id: 'note', type: 'wb_draw_text', content: '前文', x: 40, y: 40, width: 240, height: 100 },
      { id: 'node', elementId: 'node', type: 'wb_draw_shape', shape: 'rectangle', x: 40, y: 40, width: 200, height: 100 },
      { id: 'label', type: 'wb_draw_text', content: '输入', x: 60, y: 65, width: 160, height: 50 },
      { id: 'target', elementId: 'target', type: 'wb_draw_shape', shape: 'rectangle', x: 600, y: 40, width: 200, height: 100 },
      { id: 'arrow', type: 'wb_draw_line', startX: 240, startY: 90, endX: 600, endY: 90,
        startAnchor: { elementId: 'node', side: 'right' }, endAnchor: { elementId: 'target', side: 'left' } },
    ];
    const result = normalizeWhiteboardActionLayout(actions);
    const node = getWhiteboardActionBox(result[1])!;
    const label = getWhiteboardActionBox(result[2])!;
    expect([label.left - node.left, label.top - node.top]).toEqual([20, 25]);
    expect(node.top).toBeGreaterThan(140);
    expect(result[4]).toMatchObject({ startX: node.left + node.width, startY: node.top + node.height / 2, endX: 600, endY: 90 });
    expect(auditWhiteboardLayout(result)).toEqual([]);
    expect(normalizeWhiteboardActionLayout(result)).toEqual(result);
  });

  it('infers reliable attachments for legacy arrows instead of pushing the line away', () => {
    const result = normalizeWhiteboardActionLayout([
      { id: 'note', type: 'wb_draw_text', content: '前文', x: 40, y: 40, width: 240, height: 100 },
      { id: 'node', type: 'wb_draw_shape', shape: 'rectangle', x: 40, y: 40, width: 200, height: 100 },
      { id: 'target', type: 'wb_draw_shape', shape: 'rectangle', x: 600, y: 40, width: 200, height: 100 },
      { id: 'arrow', type: 'wb_draw_line', startX: 240, startY: 90, endX: 600, endY: 90 },
    ]);
    expect(result[3]).toMatchObject({ startAnchor: { elementId: 'node', side: 'right' }, endAnchor: { elementId: 'target', side: 'left' } });
    const box = getWhiteboardActionBox(result[1])!;
    expect(result[3]).toMatchObject({ startY: box.top + box.height / 2 });
  });

  it('does not use a standalone line as an occupied rectangle', () => {
    const result = normalizeWhiteboardActionLayout([
      { id: 'arrow', type: 'wb_draw_line', startX: 40, startY: 100, endX: 800, endY: 100 },
      { id: 'note', type: 'wb_draw_text', content: '说明', x: 60, y: 80, width: 400, height: 60 },
    ]);
    expect(result[1]).toMatchObject({ x: 60, y: 80 });
  });

  it('preserves explicit group offsets and does not move later text into a label footprint', () => {
    const result = normalizeWhiteboardActionLayout([
      { id: 'image', type: 'wb_draw_image', src: '/image.png', x: 40, y: 40, width: 280, height: 180 },
      { id: 'first', groupId: 'notes', type: 'wb_draw_text', content: '第一步', x: 70, y: 50, width: 200, height: 60 },
      { id: 'second', groupId: 'notes', type: 'wb_draw_text', content: '第二步', x: 70, y: 110, width: 200, height: 60 },
    ]);
    const first = getWhiteboardActionBox(result[1])!;
    const second = getWhiteboardActionBox(result[2])!;
    expect(second.top - first.top).toBe(60);
    expect(auditWhiteboardLayout(result)).toEqual([]);
  });

  it('retains occupied space across close/open and frees it on delete', () => {
    const first: Action = { id: 'first', type: 'wb_draw_text', content: '第一段', x: 40, y: 40, width: 300, height: 100 };
    const other: Action = { ...first, id: 'other' };
    const kept = normalizeWhiteboardActionLayout([first, { id: 'close', type: 'wb_close' }, { id: 'open', type: 'wb_open' }, other]);
    expect(getWhiteboardActionBox(kept[3])!.top).toBeGreaterThan(140);
    const deleted = normalizeWhiteboardActionLayout([first, { id: 'delete', type: 'wb_delete', elementId: 'first' }, other]);
    expect(deleted[2]).toMatchObject({ x: 40, y: 40 });
  });

  it('keeps all content on a full page and reports the unresolved collision', () => {
    const actions: Action[] = Array.from({ length: 12 }, (_, index) => ({
      id: `text-${index}`, type: 'wb_draw_text', content: '需要保留的讲授内容', x: 40, y: 40, width: 400, height: 100,
    }));
    const result = normalizeWhiteboardActionLayout(actions);
    expect(result.map((action) => action.id)).toEqual(actions.map((action) => action.id));
    expect(result.filter((action) => action.type === 'wb_clear')).toHaveLength(0);
    expect(auditWhiteboardLayout(result).some((issue) => issue.code === 'overlap')).toBe(true);
    expect(auditWhiteboardLayout(result).some((issue) => issue.code === 'out-of-bounds')).toBe(false);
  });

  it('scales oversized pictures into the canvas without shrinking already-readable text below 14px', () => {
    const result = normalizeWhiteboardActionLayout([
      { id: 'picture', type: 'wb_draw_image', src: '/wide.png', x: 0, y: 0, width: 2000, height: 1000 },
      { id: 'clear', type: 'wb_clear' },
      { id: 'text', type: 'wb_draw_text', content: '宽文本', x: 0, y: 0, width: 3000, height: 100, fontSize: 18 },
    ]);
    expect(getWhiteboardActionBox(result[0])).toMatchObject({ left: 24, top: 24, width: 952, height: 476 });
    expect(result[2]).toMatchObject({ fontSize: 14 });
    expect(auditWhiteboardLayout(result)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'out-of-bounds', actionIds: ['text'] })]));
  });

  it('keeps fixed text padding readable when a grouped diagram is scaled down', () => {
    const result = normalizeWhiteboardActionLayout([
      { id: 'node', type: 'wb_draw_shape', shape: 'rectangle', groupId: 'wide', x: 0, y: 0, width: 1200, height: 100 },
      { id: 'label', type: 'wb_draw_text', groupId: 'wide', content: '项目式学习', x: 20, y: 20, width: 240, height: 50, fontSize: 20 },
    ]);

    expect(result[1]).toMatchObject({ fontSize: expect.any(Number), height: expect.any(Number) });
    expect(auditWhiteboardLayout(result).filter((issue) => issue.code === 'unreadable-content')).toEqual([]);
  });

  it('does not reserve a redraw trajectory or shrink a moving node and keeps its arrow attached', () => {
    const result = normalizeWhiteboardActionLayout([
      { id: 'first', elementId: 'node', groupId: 'moving', type: 'wb_draw_shape', shape: 'rectangle', x: 40, y: 40, width: 200, height: 100 },
      { id: 'line', type: 'wb_draw_line', startX: 240, startY: 90, endX: 800, endY: 90, startAnchor: { elementId: 'node', side: 'right' } },
      { id: 'second', elementId: 'node', groupId: 'moving', type: 'wb_draw_shape', shape: 'rectangle', x: 740, y: 400, width: 200, height: 100 },
    ]);
    expect(result[0]).toMatchObject({ x: 40, y: 40, width: 200, height: 100 });
    expect(result[2]).toMatchObject({ x: 740, y: 400, width: 200, height: 100 });
    if (result[1].type !== 'wb_draw_line') throw new Error('Expected line');
    expect(resolveWhiteboardLine(result[1], [result[2]])).toMatchObject({ startX: 940, startY: 450 });
  });
});
