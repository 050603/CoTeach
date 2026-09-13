import { afterEach, describe, expect, it } from 'vitest';
import type { PPTElement, PPTLineElement } from '@openmaic/dsl';
import type { Action, WbDrawLineAction, WbDrawShapeAction } from '@openmaic/lib/types/action';
import type { StageStore } from '@openmaic/lib/api/stage-api-types';
import { createWhiteboardAPI, whiteboardIdForScene } from '@openmaic/lib/api/stage-api-whiteboard';
import { ActionEngine } from '@openmaic/lib/action/engine';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import {
  applyWhiteboardAction,
  getWhiteboardViewport,
  projectWhiteboardActions,
  whiteboardActionToElement,
  type WhiteboardElement,
} from './projection';

const triangle: WbDrawShapeAction = {
  id: 'triangle-step', type: 'wb_draw_shape', elementId: 'triangle', groupId: 'step-group',
  shape: 'triangle', x: 100, y: 100, width: 200, height: 160, fillColor: '#345678',
};
const circle: WbDrawShapeAction = {
  id: 'circle-step', type: 'wb_draw_shape', elementId: 'circle',
  shape: 'circle', x: 600, y: 80, width: 160, height: 160,
};
const connector: WbDrawLineAction = {
  id: 'link-step', type: 'wb_draw_line', elementId: 'link',
  startX: 0, startY: 0, endX: 10, endY: 10,
  startAnchor: { elementId: 'triangle', side: 'right' },
  endAnchor: { elementId: 'circle-step', side: 'left' },
  color: '#ff0000', style: 'dashed', width: 3, points: ['arrow', 'arrow'],
};

function endpoint(line: PPTLineElement, side: 'start' | 'end') {
  return [line.left + line[side][0], line.top + line[side][1]];
}

function createStore(): StageStore {
  let state: ReturnType<StageStore['getState']> = {
    stage: { id: 'lesson', name: '课堂', createdAt: 1, updatedAt: 1, whiteboard: [] },
    scenes: [], currentSceneId: 'scene-1', mode: 'playback',
  };
  return {
    getState: () => state,
    setState: (partial) => { state = { ...state, ...partial }; },
    subscribe: () => () => undefined,
  };
}

afterEach(() => useCanvasStore.getState().setWhiteboardOpen(false));

describe('shared whiteboard projection', () => {
  it('keeps native circle/triangle contours and places attachment points on their visible edges', () => {
    const elements = projectWhiteboardActions([triangle, circle, connector]);
    expect(elements[0]).toMatchObject({ type: 'shape', groupId: 'step-group', path: 'M 500 0 L 1000 1000 L 0 1000 Z' });
    expect(elements[1]).toMatchObject({ type: 'shape', path: 'M 500 0 A 500 500 0 1 1 500 1000 A 500 500 0 1 1 500 0 Z' });
    const line = elements[2] as PPTLineElement;
    expect(endpoint(line, 'start')).toEqual([250, 180]);
    expect(endpoint(line, 'end')).toEqual([600, 160]);
    expect(line).toMatchObject({ points: ['arrow', 'arrow'], width: 3, style: 'dashed', color: '#ff0000' });
  });

  it('preserves a reverse-direction arrow and fits its full length rather than treating stroke width as the extent', () => {
    const [line] = projectWhiteboardActions([{
      id: 'backward', type: 'wb_draw_line', startX: 1450, startY: 820, endX: -60, endY: 40,
      width: 2, points: ['', 'arrow'],
    }]);
    expect(endpoint(line as PPTLineElement, 'start')).toEqual([1450, 820]);
    expect(endpoint(line as PPTLineElement, 'end')).toEqual([-60, 40]);
    expect(getWhiteboardViewport([line], 0)).toEqual({ left: -60, top: 0, width: 1510, height: 820 });
  });

  it('upserts stable ids and reattaches existing arrows after a draw updates a target', () => {
    const initial = projectWhiteboardActions([triangle, circle, connector]);
    const updated = applyWhiteboardAction(initial, { ...triangle, id: 'move-triangle', x: 260, width: 120 });
    expect(updated.map((element) => element.id)).toEqual(['triangle', 'circle', 'link']);
    expect(endpoint(updated[2] as PPTLineElement, 'start')).toEqual([350, 180]);
    expect(projectWhiteboardActions([
      { id: 'legacy', type: 'wb_draw_text', content: 'before', x: 40, y: 40 },
      { id: 'legacy', type: 'wb_draw_text', content: 'after', x: 40, y: 40 },
    ])).toHaveLength(1);
  });

  it('keeps the standard viewport fixed as writing appears within the board edges', () => {
    const elements = projectWhiteboardActions([{ ...triangle, x: 24, y: 24, width: 952, height: 520 }]);
    expect(getWhiteboardViewport(elements)).toEqual({ left: 0, top: 0, width: 1000, height: 562.5 });
  });

  it('retains native formula HTML and gives malformed formula/chart/table content a readable placeholder', () => {
    const formula: Action = { id: 'formula', type: 'wb_draw_latex', latex: '\\frac{a^2}{b}', x: 30, y: 30, color: '#123456' };
    const element = whiteboardActionToElement(formula)!;
    expect(element).toMatchObject({ type: 'latex', color: '#123456', width: 400, height: 80 });
    if (element.type !== 'latex') throw new Error('Expected native formula');
    expect(element.html).toContain('class="katex"');
    expect(element.path).toBeUndefined();
    const invalid = projectWhiteboardActions([
      { ...formula, latex: '\\frac{' },
      { id: 'chart', type: 'wb_draw_chart', x: 30, y: 140, width: 300, height: 220, chartType: 'bar', data: { labels: ['A'], legends: ['数量'], series: [[1, 2]] } },
      { id: 'table', type: 'wb_draw_table', x: 400, y: 140, width: 300, height: 220, data: [['A', 'B'], ['only one']] },
    ]);
    expect(invalid.every((item) => item.type === 'text')).toBe(true);
    expect(invalid[0]).toMatchObject({ content: expect.stringContaining('公式无法解析') });
    expect(invalid[0]).toMatchObject({ content: expect.stringContaining('\\frac{') });
  });

  it('matches playback for all drawing types and deterministic incremental code edits', async () => {
    const actions: Action[] = [
      { id: 'open', type: 'wb_open' }, triangle, circle, connector,
      { id: 'text', type: 'wb_draw_text', content: 'a < b\n下一步', x: 50, y: 280 },
      { id: 'image', type: 'wb_draw_image', src: '/diagram.png', x: 50, y: 390, width: 100, height: 100 },
      { id: 'formula', type: 'wb_draw_latex', latex: 'a^2+b^2=c^2', x: 250, y: 300 },
      { id: 'table', type: 'wb_draw_table', x: 480, y: 300, width: 280, height: 160, data: [['观察', '结论'], ['a', 'b']] },
      { id: 'chart', type: 'wb_draw_chart', x: 0, y: 550, width: 280, height: 160, chartType: 'column', data: { labels: ['A'], legends: ['数量'], series: [[12]] } },
      { id: 'code', type: 'wb_draw_code', elementId: 'program', language: 'python', code: 'start()\nold()\nfinish()', x: 300, y: 550 },
      { id: 'replace', type: 'wb_edit_code', elementId: 'program', operation: 'replace_lines', lineIds: ['L2'], content: 'check()\nready()' },
      { id: 'insert', type: 'wb_edit_code', elementId: 'program', operation: 'insert_before', lineId: 'L3', content: 'run()' },
      { id: 'delete-line', type: 'wb_edit_code', elementId: 'program', operation: 'delete_lines', lineIds: ['L1'] },
      { id: 'delete', type: 'wb_delete', elementId: 'circle' },
      { id: 'close', type: 'wb_close' },
    ];
    const expected = projectWhiteboardActions(actions);
    const program = expected.find((element) => element.id === 'program');
    expect(program?.type === 'code' && program.lines).toEqual([
      { id: 'L2', content: 'check()' }, { id: 'L_replace_2', content: 'ready()' },
      { id: 'L_insert_1', content: 'run()' }, { id: 'L3', content: 'finish()' },
    ]);
    const store = createStore();
    const engine = new ActionEngine(store);
    await engine.restoreWhiteboard(actions);
    expect(store.getState().stage?.whiteboard?.[0].elements).toEqual(expected);
    await engine.restoreWhiteboard(actions);
    expect(store.getState().stage?.whiteboard?.[0].elements).toEqual(expected);
    await engine.restoreWhiteboard([...actions, { id: 'clear', type: 'wb_clear' }]);
    expect(store.getState().stage?.whiteboard?.[0].elements).toEqual([]);
    engine.dispose();
  });

  it('reflows native Stage API edits after a persisted reload and deletes attached connectors with their target', () => {
    const store = createStore();
    const api = createWhiteboardAPI(store);
    const boardId = whiteboardIdForScene('scene-1')!;
    api.create(boardId);
    const elements = projectWhiteboardActions([triangle, circle, connector]);
    api.update({ elements: JSON.parse(JSON.stringify(elements)) as PPTElement[] }, boardId);
    const target = api.getElement('triangle', boardId).data!;
    api.updateElement({ ...target, left: 180 }, boardId);
    expect(endpoint(api.getElement('link', boardId).data as PPTLineElement, 'start')).toEqual([330, 180]);
    api.addElement({ ...target, left: 220 }, boardId);
    expect(api.listElements(boardId).data).toHaveLength(3);
    expect(endpoint(api.getElement('link', boardId).data as PPTLineElement, 'start')).toEqual([370, 180]);
    api.deleteElement('triangle', boardId);
    expect(api.listElements(boardId).data?.map((element) => element.id)).toEqual(['circle']);
  });

  it('detaches persisted source metadata from later mutations of the caller action', () => {
    const source = structuredClone(connector);
    const element = whiteboardActionToElement(source) as WhiteboardElement;
    source.startAnchor!.elementId = 'unrelated';
    expect(element.whiteboard?.action).toMatchObject({ startAnchor: { elementId: 'triangle' } });
  });
});
