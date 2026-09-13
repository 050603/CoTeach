import { describe, expect, it } from 'vitest';
import { validateAction } from '../src/validate.js';

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
});
