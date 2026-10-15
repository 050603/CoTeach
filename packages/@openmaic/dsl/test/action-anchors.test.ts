import { describe, expect, it } from 'vitest';
import { validateAction } from '../src/validate.js';
import { isWhiteboardAction, type Action } from '../src/action.js';

const line = { id: 'line', type: 'wb_draw_line', startX: 10, startY: 10, endX: 90, endY: 90 };

describe('whiteboard attachment contract', () => {
  it('accepts legacy coordinates and explicit grouped element anchors', () => {
    expect(validateAction(line).valid).toBe(true);
    expect(validateAction({ ...line, groupId: 'process', startAnchor: { elementId: 'source', side: 'right' }, endAnchor: { elementId: 'destination', side: 'left' } }).valid).toBe(true);
  });
  it.each([{ elementId: '', side: 'left' }, { elementId: 'target', side: 'diagonal' }, null, 'target'])('rejects malformed anchors %j', (startAnchor) => {
    expect(validateAction({ ...line, startAnchor }).valid).toBe(false);
  });
  it('rejects an empty group identity', () => {
    expect(validateAction({ ...line, groupId: ' ' }).valid).toBe(false);
  });
  it('accepts narration bindings on drawing and lifecycle commands', () => {
    for (const action of [line, { id: 'open', type: 'wb_open' }, { id: 'clear', type: 'wb_clear' }, { id: 'close', type: 'wb_close' }]) {
      expect(validateAction({ ...action, speechId: 'speech', speechAnchor: { quote: '现在板书', occurrence: 1 }, speechOffsetMs: 2300 }).valid).toBe(true);
    }
    expect(isWhiteboardAction(line as Action)).toBe(true);
    expect(isWhiteboardAction({ id: 'speech', type: 'speech', text: '现在板书' })).toBe(false);
  });
  it.each([
    { speechId: ' ' }, { speechOffsetMs: -1 }, { speechOffsetMs: Number.NaN },
    { speechAnchor: { quote: '' } }, { speechAnchor: { quote: '要点', occurrence: -1 } },
  ])('rejects malformed narration bindings %j', (binding) => {
    expect(validateAction({ ...line, ...binding }).valid).toBe(false);
    expect(validateAction({ id: 'open', type: 'wb_open', ...binding }).valid).toBe(false);
  });
});
