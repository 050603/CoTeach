import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import { normalizeWhiteboardActionLifecycle } from './whiteboard-action-lifecycle';

const speech = (id: string, text: string): Action => ({ id, type: 'speech', text });

describe('normalizeWhiteboardActionLifecycle', () => {
  it('opens before an implicit drawing sequence and closes after its explanation', () => {
    const actions: Action[] = [
      {
        id: 'draw_1',
        type: 'wb_draw_text',
        content: 'Step 1',
        x: 60,
        y: 60,
      },
      speech('speech_1', 'Explain the visible first step.'),
    ];

    expect(normalizeWhiteboardActionLifecycle(actions).map((action) => action.type)).toEqual([
      'wb_open',
      'wb_draw_text',
      'speech',
      'wb_close',
    ]);
  });

  it('returns to the PPT before spotlighting a slide element', () => {
    const actions: Action[] = [
      { id: 'open', type: 'wb_open' },
      {
        id: 'formula',
        type: 'wb_draw_latex',
        latex: 'a+b=c',
        x: 80,
        y: 80,
      },
      speech('speech_1', 'Explain the derivation.'),
      { id: 'focus', type: 'spotlight', elementId: 'conclusion' },
      speech('speech_2', 'Return to the durable conclusion.'),
    ];

    expect(normalizeWhiteboardActionLifecycle(actions).map((action) => action.type)).toEqual([
      'wb_open',
      'wb_draw_latex',
      'speech',
      'wb_close',
      'spotlight',
      'speech',
    ]);
  });

  it('removes duplicate lifecycle actions without moving narration', () => {
    const actions: Action[] = [
      { id: 'open_1', type: 'wb_open' },
      { id: 'open_2', type: 'wb_open' },
      speech('speech_1', 'Set up the process.'),
      { id: 'close_1', type: 'wb_close' },
      { id: 'close_2', type: 'wb_close' },
    ];

    expect(normalizeWhiteboardActionLifecycle(actions)).toEqual([
      actions[0],
      actions[2],
      actions[3],
    ]);
  });

  it('keeps timed open/close commands according to speech order rather than their storage positions', () => {
    const actions: Action[] = [
      { id: 'late-write', type: 'wb_draw_text', content: '第二项', x: 40, y: 40, speechId: 's1', speechAnchor: { quote: '第二项' } },
      { id: 'close', type: 'wb_close', speechId: 's1', speechAnchor: { quote: '返回PPT' } },
      { id: 'open', type: 'wb_open', speechId: 's1', speechAnchor: { quote: '第一项' } },
      speech('s1', '先讲第一项，再讲第二项，最后返回PPT。'),
    ];
    expect(normalizeWhiteboardActionLifecycle(actions)).toEqual(actions);
  });

  it('binds an implicit opener and a PPT transition to the same narration moments as their triggers', () => {
    const actions: Action[] = [
      { id: 'write', type: 'wb_draw_text', content: '要点', x: 40, y: 40, speechId: 's1', speechAnchor: { quote: '写出要点' }, speechOffsetMs: 2000 },
      { id: 'focus', type: 'spotlight', elementId: 'stage', speechId: 's1', speechAnchor: { quote: '返回PPT' }, speechOffsetMs: 4000 },
      speech('s1', '先说明，再写出要点，然后返回PPT。'),
    ];
    const result = normalizeWhiteboardActionLifecycle(actions);
    expect(result.map((action) => action.type)).toEqual(['wb_open', 'wb_draw_text', 'wb_close', 'spotlight', 'speech']);
    expect(result[0]).toMatchObject({ speechId: 's1', speechAnchor: { quote: '写出要点' }, speechOffsetMs: 2000 });
    expect(result[2]).toMatchObject({ speechId: 's1', speechAnchor: { quote: '返回PPT' }, speechOffsetMs: 4000 });
  });

  it('keeps an orphaned binding without injecting an early sequential opener', () => {
    const actions: Action[] = [
      { id: 'write', type: 'wb_draw_text', content: '要点', x: 40, y: 40, speechId: 'missing', speechAnchor: { quote: '要点' } },
      speech('s1', '当前讲词。'),
    ];
    expect(normalizeWhiteboardActionLifecycle(actions)).toEqual(actions);
  });

  it('does not synthesize or switch surfaces for a missing spoken anchor', () => {
    const actions: Action[] = [
      { id: 'open', type: 'wb_open', speechId: 's1', speechAnchor: { quote: '不存在的要点' } },
      { id: 'write', type: 'wb_draw_text', content: '要点', x: 40, y: 40, speechId: 's1', speechAnchor: { quote: '不存在的要点' } },
      speech('s1', '当前讲词。'),
    ];
    expect(normalizeWhiteboardActionLifecycle(actions)).toEqual(actions);
  });
});
