import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import type { SceneContext } from './regenerate-scene-actions';
import { makeEditWhiteboardTool } from './edit-whiteboard';
import { makeReadSceneContentTool } from './read-scene-content';
import { buildToolset, V0_ALLOWLIST } from './registry';
import { makeAllowlistGate } from '../runtime/allowlist';
import { prepareWhiteboardPatch, EMBEDDED_BOARD_IMAGE, MAX_WHITEBOARD_STEPS } from '@openmaic/lib/edit/whiteboard-patch';

const imageSrc = 'data:image/png;base64,' + 'A'.repeat(1000);
const actions: Action[] = [
  { id: 'outside', type: 'speech', text: '开始上课' },
  { id: 'board', type: 'wb_open' },
  { id: 'text', type: 'wb_draw_text', elementId: 'note', content: '已有要点', x: 60, y: 60 },
  { id: 'image', type: 'wb_draw_image', elementId: 'diagram', src: imageSrc, x: 60, y: 160, width: 400, height: 220 },
  { id: 'speech', type: 'speech', text: '观察关系', audioUrl: '/audio/original.wav', audioId: 'original' },
  { id: 'close', type: 'wb_close' },
  { id: 'other-board', type: 'wb_open' },
  { id: 'other-draw', type: 'wb_draw_text', elementId: 'other-note', content: '其他白板', x: 60, y: 60 },
  { id: 'other-close', type: 'wb_close' },
  { id: 'discussion', type: 'discussion', topic: '你观察到了什么？' },
];
const ctx = {
  stageId: 'stage', actions,
  outline: { id: 'scene', type: 'slide', title: '关系分析', description: '图文讲解', keyPoints: [] },
  allOutlines: [], content: { type: 'slide', canvas: { elements: [] } },
} as unknown as SceneContext;
const deps = { getSceneContext: (sceneId: string) => sceneId === 'scene' ? ctx : undefined, aiCall: vi.fn() };

beforeEach(() => { ctx.actions = structuredClone(actions); });

describe('edit_whiteboard tool', () => {
  it('retains grouping and validates visible anchor targets while allowing same-type redraws', () => {
    const node = { id: 'node-action', type: 'wb_draw_shape', elementId: 'node', groupId: 'step', shape: 'rectangle', x: 60, y: 80, width: 200, height: 120 };
    const line = { id: 'line-action', type: 'wb_draw_line', startX: 260, startY: 140, endX: 500, endY: 140, startAnchor: { elementId: 'node', side: 'right' } };
    const patch = prepareWhiteboardPatch(actions, 'board', [node, line, { ...node, id: 'move-node', x: 80 }]);
    expect(patch.steps[0]).toHaveProperty('groupId', 'step');
    expect(patch.steps[1]).toHaveProperty('startAnchor.elementId', 'node');
    expect(patch.steps[2]).toHaveProperty('elementId', 'node');
    expect(() => prepareWhiteboardPatch(actions, 'board', [line, node])).toThrow(/箭头/);
    expect(() => prepareWhiteboardPatch(actions, 'board', [node, { type: 'wb_clear' }, line])).toThrow(/箭头/);
  });

  it('returns actionable formula and data quality feedback without applying broken steps', async () => {
    const before = structuredClone(ctx.actions);
    const result = await makeEditWhiteboardTool(deps).execute('invalid-formula', { sceneId: 'scene', boardId: 'board', steps: [
      { type: 'wb_draw_latex', latex: String.raw`\frac{x}{`, x: 60, y: 80, width: 600, height: 100 },
    ] });
    expect(result).toHaveProperty('isError', true);
    expect(result.details.error).toContain('公式');
    expect(ctx.actions).toEqual(before);
  });
  it('uses the prior edit for later reads and edits in the same turn without changing other scenes', async () => {
    const otherCtx = { ...ctx, actions: structuredClone(actions) };
    const roundDeps = { getSceneContext: (sceneId: string) => sceneId === 'scene' ? ctx : otherCtx };
    const tool = makeEditWhiteboardTool(roundDeps);
    const first = await tool.execute('first', { sceneId: 'scene', boardId: 'board', steps: [{ ...actions[2], content: '第一轮修改' }] });
    const read = await makeReadSceneContentTool(roundDeps).execute('read', { sceneId: 'scene' });
    expect(JSON.stringify(read.content)).toContain('第一轮修改');
    const second = await tool.execute('second', { sceneId: 'scene', boardId: 'board', steps: [{ ...actions[2], content: '第二轮修改' }] });
    expect(second.details.whiteboardPatch?.before).toEqual(first.details.whiteboardPatch?.steps);
    expect(ctx.actions?.[2]).toHaveProperty('content', '第二轮修改');
    expect(ctx.actions?.[0]).toEqual(actions[0]);
    expect(ctx.actions?.slice(-4)).toEqual(actions.slice(-4));
    expect(otherCtx.actions).toEqual(actions);
  });

  it('builds a scoped replacement, retains ids and original audio, and assigns new ids', async () => {
    const tool = makeEditWhiteboardTool(deps);
    const result = await tool.execute('call', {
      sceneId: 'scene', boardId: 'board', steps: [
        { ...actions[2], content: '修改后的要点' },
        { id: 'speech', type: 'speech', text: '观察关系' },
        { type: 'speech', text: '然后比较差异' },
      ],
    });
    expect(result.details.whiteboardPatch?.before).toEqual(actions.slice(2, 5));
    expect(result.details.whiteboardPatch?.steps[0]).toMatchObject({ id: 'text', elementId: 'note', content: '修改后的要点' });
    expect(result.details.whiteboardPatch?.steps[1]).toEqual(actions[4]);
    expect(result.details.whiteboardPatch?.steps[2]).toMatchObject({ id: expect.any(String), audioInvalidated: true });
    expect(result.details).not.toHaveProperty('actions');
    expect(actions[2]).toHaveProperty('content', '已有要点');
    expect(deps.aiCall).not.toHaveBeenCalled();
  });

  it('reads board ids and steps without echoing image data or cached audio', async () => {
    const result = await makeReadSceneContentTool(deps).execute('read', { sceneId: 'scene' });
    const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    expect(text).toContain('"boardId": "board"');
    expect(text).toContain('已有要点');
    expect(text).toContain('观察关系');
    expect(text).toContain(EMBEDDED_BOARD_IMAGE);
    expect(text).not.toContain(imageSrc);
    expect(text).not.toContain('/audio/original.wav');
    expect(prepareWhiteboardPatch(actions, 'board', [{ ...actions[3], src: undefined }]).steps[0]).toEqual(actions[3]);
  });

  it('invalidates changed narration and ignores model-supplied audio references', () => {
    const patch = prepareWhiteboardPatch(actions, 'board', [{
      id: 'speech', type: 'speech', text: '新的讲解', audioUrl: 'https://evil.example/audio', audioId: 'forged',
    }]);
    expect(patch.steps).toEqual([{ id: 'speech', type: 'speech', text: '新的讲解', audioInvalidated: true }]);
  });

  it.each([
    [{ type: 'wb_open' }],
    [{ type: 'wb_close' }],
    [{ type: 'spotlight', elementId: 'slide-title' }],
    [{ type: 'discussion', topic: 'outside' }],
    [{ type: 'speech', text: '' }],
    [{ type: 'wb_draw_table', x: 1, y: 2, width: 400, height: 200, data: [['A', 'B'], ['C']] }],
    [{ type: 'wb_draw_image', src: '/image.png', x: 1, y: 2, width: -1, height: 200 }],
    [{ type: 'wb_draw_text', content: '<img src=x onerror=alert(1)>', x: 1, y: 2 }],
    [{ type: 'wb_draw_text', content: 'text', x: Number.NaN, y: 2 }],
    [{ type: 'wb_delete', elementId: 'other-note' }],
    [{ id: 'outside', type: 'speech', text: '侵入其他动作' }],
    [{ type: 'wb_draw_text', elementId: 'other-note', content: '侵入其他白板', x: 1, y: 2 }],
    [{ id: 'same', type: 'speech', text: 'a' }, { id: 'same', type: 'speech', text: 'b' }],
  ])('rejects an invalid or out-of-scope replacement %#', (...steps) => {
    expect(() => prepareWhiteboardPatch(actions, 'board', steps)).toThrow();
  });

  it.each(['javascript:alert(1)', 'blob:local', '//evil.example/image', '/\\evil.example/image', 'data:text/html;base64,AAAA', 'https://user:pass@example.com/image'])('rejects nonportable or unsafe image source %s', (src) => {
    expect(() => prepareWhiteboardPatch(actions, 'board', [{ ...actions[3], src }])).toThrow(/图片地址/);
  });

  it('accepts deletion only after a drawing in this replacement, and not after clearing it', () => {
    const drawing = { type: 'wb_draw_text', elementId: 'new-note', content: 'a < b', x: 1, y: 2 };
    const deletion = { type: 'wb_delete', elementId: 'new-note' };
    expect(prepareWhiteboardPatch(actions, 'board', [drawing, deletion]).steps).toHaveLength(2);
    expect(() => prepareWhiteboardPatch(actions, 'board', [drawing, { type: 'wb_clear' }, deletion])).toThrow(/尚未清除/);
  });

  it('refuses missing boards and excessive steps with a readable tool error', async () => {
    const tool = makeEditWhiteboardTool(deps);
    const result = await tool.execute('call', { sceneId: 'scene', boardId: 'missing', steps: [] });
    expect(result.details.whiteboardPatch).toBeNull();
    expect(result.details.error).toContain('没有找到');
    expect(() => prepareWhiteboardPatch(actions, 'board', Array.from({ length: MAX_WHITEBOARD_STEPS + 1 }, () => ({ type: 'speech', text: 'x' })))).toThrow(/最多/);
  });

  it('registers the tool in both the executable toolset and the capability allowlist', async () => {
    expect(buildToolset(deps).some((tool) => tool.name === 'edit_whiteboard')).toBe(true);
    const gate = makeAllowlistGate(V0_ALLOWLIST);
    await expect(gate({ toolCall: { name: 'edit_whiteboard' } } as never)).resolves.toBeUndefined();
    await expect(gate({ toolCall: { name: 'delete_scene' } } as never)).resolves.toMatchObject({ block: true });
  });
});
