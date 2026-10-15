import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import { orderedActionExecutionEntries } from './action-timeline';

describe('whiteboard action execution order', () => {
  it('places bound commands inside their owner and preserves equal-time authoring order', () => {
    const actions: Action[] = [
      { id: 'late', type: 'wb_clear', speechId: 's1', speechOffsetMs: 2000 },
      { id: 'open', type: 'wb_open', speechId: 's1', speechOffsetMs: 0 },
      { id: 'write', type: 'wb_draw_text', content: '要点', x: 40, y: 40, speechId: 's1', speechOffsetMs: 0 },
      { id: 's1', type: 'speech', text: '第一段。' },
      { id: 'legacy', type: 'wb_close' },
      { id: 's2', type: 'speech', text: '第二段。' },
    ];
    const entries = orderedActionExecutionEntries(actions);
    expect(entries.map((entry) => entry.action.id)).toEqual(['s1', 'open', 'write', 'late', 'legacy', 's2']);
    expect(entries[2]).toMatchObject({ actionIndex: 2, speechIndex: 0, speechActionIndex: 3, speechOffsetMs: 0 });
  });

  it('orders pending anchors by their exact text without estimating media time', () => {
    const entries = orderedActionExecutionEntries([
      { id: 'later', type: 'wb_clear', speechId: 'speech', speechAnchor: { quote: '第二项' }, speechOffsetMs: 12345 },
      { id: 'first', type: 'wb_open', speechId: 'speech', speechAnchor: { quote: '第一项' } },
      { id: 'speech', type: 'speech', text: '先讲第一项，再讲第二项。' },
    ]);
    expect(entries.map((entry) => entry.action.id)).toEqual(['speech', 'first', 'later']);
    expect(entries[2]).toMatchObject({ charOffset: 8 });
    expect(entries[2].speechOffsetMs).toBeUndefined();
  });

  it('distinguishes invalid bindings from valid anchors waiting for audio', () => {
    const entries = orderedActionExecutionEntries([
      { id: 'orphan', type: 'wb_open', speechId: 'absent' },
      { id: 'missing', type: 'wb_clear', speechId: 'speech', speechAnchor: { quote: '不存在的要点' } },
      { id: 'pending', type: 'wb_close', speechId: 'speech', speechAnchor: { quote: '要点' } },
      { id: 'speech', type: 'speech', text: '说明要点。' },
    ]);
    expect(entries.find((entry) => entry.action.id === 'orphan')?.speechBindingValid).toBe(false);
    expect(entries.find((entry) => entry.action.id === 'missing')?.speechBindingValid).toBe(false);
    expect(entries.find((entry) => entry.action.id === 'pending')?.speechBindingValid).toBe(true);
  });
});
