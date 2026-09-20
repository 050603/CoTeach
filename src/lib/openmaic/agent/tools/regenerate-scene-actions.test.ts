import { describe, expect, it, vi } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import { makeRegenerateSceneActionsTool, type SceneContext } from './regenerate-scene-actions';
import { planRegenerateApply } from '../client/apply-regenerate';

const imageSrc = 'data:image/png;base64,' + 'UNIQUEIMAGEBYTES'.repeat(100);
const original: Action[] = [
  { id: 'intro', type: 'speech', text: '原来的讲稿。', audioUrl: '/original.wav', audioId: 'old' },
  { id: 'focus', type: 'spotlight', elementId: 'slide-title' },
  { id: 'board', type: 'wb_open' },
  { id: 'image', type: 'wb_draw_image', src: imageSrc, elementId: 'diagram', x: 60, y: 60, width: 400, height: 220 },
  { id: 'board-speech', type: 'speech', text: '保留白板讲解。', audioUrl: '/board.wav' },
  { id: 'board-close', type: 'wb_close' },
  { id: 'outro', type: 'speech', text: '其他讲稿保持不变。', audioUrl: '/outro.wav' },
  { id: 'discussion', type: 'discussion', topic: '有什么发现？' },
];

function setup(response: unknown, withActions = true) {
  const outline = { id: 'scene', type: 'slide', title: '观察关系', description: '利用证据进行解释', keyPoints: ['证据'] };
  const ctx = {
    stageId: 'stage', outline, allOutlines: [outline],
    content: { type: 'slide', canvas: { elements: [{ id: 'slide-title', type: 'text', content: '关系' }] } },
    sectionNarrations: [
      { sceneId: 'previous', outlineId: 'previous', title: '前页', current: false, speeches: [{ id: 'previous-speech', text: '前页已经解释概念含义。' }] },
      { sceneId: 'scene', outlineId: 'scene', title: '观察关系', current: true, speeches: [{ id: 'intro', text: '原来的讲稿。' }] },
      { sceneId: 'next', outlineId: 'next', title: '后页', current: false, speeches: [{ id: 'next-speech', text: '后页将分析适用边界。' }] },
    ],
    ...(withActions ? { actions: structuredClone(original) } : {}),
  } as unknown as SceneContext;
  const aiCall = vi.fn().mockResolvedValue(JSON.stringify(response));
  return { ctx, aiCall, tool: makeRegenerateSceneActionsTool({ aiCall, getSceneContext: () => ctx }) };
}

describe('teacher-guided narration edits', () => {
  it('forwards the instruction and current script to generation while preserving board/images and other cues', async () => {
    const { ctx, aiCall, tool } = setup([{ type: 'action', name: 'speech', action_id: 'intro', params: { text: '请观察两条证据，用自己的话解释。' } }]);
    const instruction = '只把开场讲稿改成面向初一学生的提问，其余内容保持原样。';
    const result = await tool.execute('edit', { sceneId: 'scene', instruction });
    expect(aiCall).toHaveBeenCalledTimes(1);
    const [stage, system, user] = aiCall.mock.calls[0];
    expect(stage).toBe('scene-actions');
    expect(system).toContain(instruction);
    expect(system).toContain('Actual narration for this complete section');
    expect(system).toContain('前页已经解释概念含义。');
    expect(system).toContain('后页将分析适用边界。');
    expect(user).toContain('原来的讲稿。');
    expect(user).toContain('"id":"image"');
    expect(user).not.toContain('UNIQUEIMAGEBYTES');
    expect(system).not.toContain('UNIQUEIMAGEBYTES');
    expect(result.details.actions[0]).toEqual({ id: 'intro', type: 'speech', text: '请观察两条证据，用自己的话解释。', audioInvalidated: true });
    expect(result.details.actions.slice(1)).toEqual(original.slice(2));
    expect(result.details.actions[2]).toHaveProperty('src', imageSrc);
    expect(ctx.actions).toEqual(result.details.actions);
    const current = original.map((action) => action.id === 'board-speech' ? { ...action, text: 'AI 运行期间手动修改的白板讲解' } as Action : action);
    const plan = planRegenerateApply(result.details, { content: ctx.content, actions: current }, 'regenerate_scene_actions');
    expect(plan.patch?.actions?.[4]).toHaveProperty('text', 'AI 运行期间手动修改的白板讲解');
    expect(plan.patch?.actions?.[0]).toHaveProperty('text', '请观察两条证据，用自己的话解释。');
    const conflict = current.map((action) => action.id === 'intro' ? { ...action, text: '手动改过目标讲稿' } as Action : action);
    expect(planRegenerateApply(result.details, { content: ctx.content, actions: conflict }, 'regenerate_scene_actions')).toMatchObject({ patch: null, error: expect.stringContaining('已保留你的最新内容') });
  });

  it('refuses attempts to rewrite a whiteboard narration or replace an image with an elided source', async () => {
    const { ctx, tool } = setup([
      { type: 'action', name: 'speech', action_id: 'board-speech', params: { text: '覆盖白板讲解' } },
      { type: 'action', name: 'wb_draw_image', action_id: 'image', params: { src: '[embedded asset preserved by id]', x: 0, y: 0, width: 400, height: 200 } },
    ]);
    const result = await tool.execute('edit', { sceneId: 'scene', instruction: '修改开场' });
    expect(result.details.actions).toEqual([]);
    expect(ctx.actions).toEqual(original);
  });

  it('supports old calls without an instruction or current-action context', async () => {
    const { tool, aiCall } = setup([{ type: 'text', content: '新的基础讲解。' }], false);
    const result = await tool.execute('edit', { sceneId: 'scene' });
    expect(aiCall).toHaveBeenCalledTimes(1);
    expect(result.details.actions).toEqual([expect.objectContaining({ type: 'speech', text: '新的基础讲解。' })]);
  });
});
