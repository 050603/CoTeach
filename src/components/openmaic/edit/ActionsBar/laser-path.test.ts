import { describe, expect, it } from 'vitest';
import type { Action, LaserAction } from '@openmaic/lib/types/action';
import { applyLaserPathDraft, laserPathDraft, MAX_LASER_STOPS, setLaserPathById, validateLaserPathDraft } from './laser-path';

const elements = ['diagram', 'formula', 'result'];
const speeches = [{ id: 'speech', text: '先看图示，再看公式，最后得到结果。' }];

describe('teacher laser route authoring', () => {
  it('preserves generated narration anchors and fine-grained target selectors', () => {
    const action: LaserAction = {
      id: 'path', type: 'laser', elementId: 'diagram',
      selector: { quote: '输入' }, speechId: 'speech',
      speechAnchor: { quote: '图示' },
      waypoints: [
        { elementId: 'formula', speechAnchor: { quote: '公式' } },
        { elementId: 'result', selector: { quote: '输出' }, speechAnchor: { quote: '结果' } },
      ],
    };
    const draft = laserPathDraft(action);
    expect(draft.stops.map((stop) => stop.elementId)).toEqual(elements);
    expect(validateLaserPathDraft(draft, elements, speeches)).toBeNull();
    expect(applyLaserPathDraft(action, draft)).toEqual(action);
  });

  it('saves a timed path in target order and places it before its bound narration', () => {
    const actions = [
      { id: 'speech', type: 'speech', text: speeches[0].text },
      { id: 'path', type: 'laser', elementId: 'diagram' },
    ] as Action[];
    const draft = {
      speechId: 'speech',
      stops: [
        { elementId: 'diagram', mode: 'time' as const, offsetMs: 0, quote: '' },
        { elementId: 'formula', mode: 'time' as const, offsetMs: 1200, quote: '' },
        { elementId: 'result', mode: 'time' as const, offsetMs: 2400, quote: '' },
      ],
    };
    expect(validateLaserPathDraft(draft, elements, speeches)).toBeNull();
    const saved = setLaserPathById(actions, 'path', draft);
    expect(saved.map((action) => action.id)).toEqual(['path', 'speech']);
    expect(saved[0]).toMatchObject({
      type: 'laser', elementId: 'diagram', speechId: 'speech', speechOffsetMs: 0,
      waypoints: [
        { elementId: 'formula', speechOffsetMs: 1200 },
        { elementId: 'result', speechOffsetMs: 2400 },
      ],
    });
    expect(actions[1]).toEqual({ id: 'path', type: 'laser', elementId: 'diagram' });
  });

  it('lets teachers preserve all seven steps in a generated laser path', () => {
    const text = '先看第一步、第二步、第三步、第四步、第五步、第六步，最后看第七步。';
    const stops = Array.from({ length: 7 }, (_, index) => ({
      elementId: `step-${index + 1}`,
      mode: 'time' as const,
      offsetMs: index * 1200,
      quote: '',
    }));
    const draft = { speechId: 'speech', stops };
    expect(validateLaserPathDraft(draft, stops.map((stop) => stop.elementId), [{ id: 'speech', text }])).toBeNull();
    expect(applyLaserPathDraft({ id: 'path', type: 'laser', elementId: 'step-1' }, draft).waypoints).toHaveLength(6);
    expect(validateLaserPathDraft({
      ...draft,
      stops: Array.from({ length: MAX_LASER_STOPS + 1 }, (_, index) => ({ ...stops[0], offsetMs: index * 1200 })),
    }, ['step-1'], [{ id: 'speech', text }])).toContain(`${MAX_LASER_STOPS}`);
  });

  it('rejects missing targets, unbound motion, and out-of-order triggers', () => {
    const draft = {
      speechId: 'speech',
      stops: [
        { elementId: 'diagram', mode: 'time' as const, offsetMs: 0, quote: '' },
        { elementId: 'formula', mode: 'time' as const, offsetMs: 1200, quote: '' },
      ],
    };
    expect(validateLaserPathDraft({ ...draft, speechId: '' }, elements, speeches)).toContain('请选择');
    expect(validateLaserPathDraft({ ...draft, stops: [draft.stops[0], { ...draft.stops[1], elementId: 'missing' }] }, elements, speeches)).toContain('本页的元素');
    expect(validateLaserPathDraft({ ...draft, stops: [draft.stops[0], { ...draft.stops[1], mode: 'phrase' as const, quote: '公式' }] }, elements, speeches)).toContain('统一');
    expect(validateLaserPathDraft({ ...draft, stops: [draft.stops[0], { ...draft.stops[1], offsetMs: 0 }] }, elements, speeches)).toContain('从早到晚');
    expect(validateLaserPathDraft({
      speechId: 'speech',
      stops: [
        { elementId: 'diagram', mode: 'phrase', offsetMs: 0, quote: '结果' },
        { elementId: 'formula', mode: 'phrase', offsetMs: 0, quote: '公式' },
      ],
    }, elements, speeches)).toContain('出现顺序');
  });
});
