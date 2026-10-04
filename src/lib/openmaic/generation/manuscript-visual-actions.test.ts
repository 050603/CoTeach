import { describe, expect, it, vi } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import type { NarrationModuleOutput } from './action-binding-types';
import { compileManuscriptVisualActions, generateManuscriptVisualActions } from './manuscript-visual-actions';
import { calibrateGeneratedVisualCues } from './semantic-visual-cues';

const outline: SceneOutline = { id: 'page', type: 'slide', title: '核对流程', description: '解释核对与比较', keyPoints: [], order: 0 };
const content: GeneratedSlideContent = { elements: [
  ...['采集', '核验', '判断'].map((text, index) => ({ id: `node-${index}`, type: 'text',
    left: 50 + index * 280, top: 100, width: 220, height: 80, content: `<p>${text}</p>`,
    defaultFontName: 'Noto Sans SC', defaultColor: '#111111' })),
  { id: 'cases', type: 'table', left: 50, top: 230, width: 850, height: 200,
    outline: {}, colWidths: [0.3, 0.7], cellMinHeight: 40,
    data: [['情境', '判断'], ['转载同一篇报道', '一个来源'], ['分别采访当事人', '独立来源']].map((row, i) =>
      row.map((text, j) => ({ id: `cell-${i}-${j}`, colspan: 1, rowspan: 1, text }))) },
] as PPTElement[] };

function narration(text: string): NarrationModuleOutput {
  return { pageId: outline.id, segments: [{ id: 'saved-id', pageId: outline.id, text, semanticIds: ['page:teaching'] }] };
}

function compile(text: string, cues: unknown[]) {
  return compileManuscriptVisualActions({ outline, content, narration: narration(text), output: { pageId: outline.id, cues } });
}

const focus = (quote: string, rowIndex: number, extra = {}) => ({ speechId: 'saved-id', type: 'spotlight',
  target: { elementId: 'cases', selector: { rowIndex } }, speechAnchor: { quote, occurrence: 0 }, ...extra });

describe('visual orchestration on an immutable manuscript', () => {
  it('points to differently worded visible evidence while preserving every speech character and ID', () => {
    const text = '两篇文章来自同一份材料，所以还需要进一步核对。保留  空格和“引号”。';
    const result = compile(text, [focus('来自同一份材料', 1)]);
    expect(result.issues).toEqual([]);
    expect(result.actions).toContainEqual(expect.objectContaining({ type: 'spotlight', elementId: 'cases', selector: { rowIndex: 1 } }));
    expect(result.actions.filter((action) => action.type === 'speech')).toEqual([{ id: 'saved-id', type: 'speech', text }]);
  });

  it('switches rows, returns for a correction and holds the spotlight across sentences', () => {
    const text = '两家网站转发同一篇文章。它们仍然共享一个来源。再看分别访问现场的人。回到转发这个例子，并不是文章越多越可靠。';
    const result = compile(text, [focus('两家网站转发', 1, { endSpeechAnchor: { quote: '共享一个来源', occurrence: 0 } }),
      focus('分别访问现场的人', 2), focus('回到转发这个例子', 1)]);
    expect(result.issues).toEqual([]);
    expect(result.actions.filter((action) => action.type === 'spotlight').map((action) => action.selector)).toEqual([
      { rowIndex: 1 }, { rowIndex: 2 }, { rowIndex: 1 },
    ]);
    expect(result.actions[0]).toMatchObject({ endSpeechAnchor: { quote: '共享一个来源', occurrence: 0 } });
  });

  it('retains an explicit repeated-phrase occurrence', () => {
    const result = compile('先核对来源。现在比较另一种情况，再核对来源。', [focus('核对来源', 2,
      { speechAnchor: { quote: '核对来源', occurrence: 1 } })]);
    expect(result.issues).toEqual([]);
    expect(result.actions[0]).toMatchObject({ speechAnchor: { quote: '核对来源', occurrence: 1 } });
  });

  it('compiles a three-node path and a return to an earlier node using verified audio timing', () => {
    const text = '先把材料找齐。接着查明它们的出处。然后决定是否支持判断。不足时回到收集环节。';
    const result = compile(text, [{ speechId: 'saved-id', type: 'laser', target: { elementId: 'node-0' },
      speechAnchor: { quote: '先把材料找齐', occurrence: 0 }, waypoints: [
        { elementId: 'node-1', speechAnchor: { quote: '查明它们的出处', occurrence: 0 } },
        { elementId: 'node-2', speechAnchor: { quote: '决定是否支持判断', occurrence: 0 } },
        { elementId: 'node-0', speechAnchor: { quote: '回到收集环节', occurrence: 0 } },
      ] }]);
    expect(result.issues).toEqual([]);
    const timed = result.actions.map((action) => action.type === 'speech' ? { ...action,
      audioDurationSec: text.length / 10, speechAlignment: { version: 'test-v1', status: 'aligned' as const,
        textHash: 'test', audioHash: 'test', spans: Array.from(text, (character, index) => ({
          text: character, startChar: index, endChar: index + 1, startMs: index * 100, endMs: (index + 1) * 100,
        })) } } : action);
    const calibrated = calibrateGeneratedVisualCues({ outline, elements: content.elements, actions: timed });
    const laser = calibrated.find((action) => action.type === 'laser');
    expect(laser?.waypoints?.map((waypoint) => waypoint.elementId)).toEqual(['node-1', 'node-2', 'node-0']);
    expect(laser?.waypoints?.map((waypoint) => waypoint.speechOffsetMs)).toEqual([
      text.indexOf('查明它们的出处') * 100, text.indexOf('决定是否支持判断') * 100, text.indexOf('回到收集环节') * 100,
    ]);
  });

  it.each([
    { target: { elementId: 'missing' } },
    { target: { elementId: 'cases', selector: { rowIndex: 20 } } },
    { target: { elementId: 'cases', selector: { rowIndex: -1 } } },
    { speechAnchor: { quote: '不在讲稿中的话', occurrence: 0 } },
    { speechAnchor: { quote: '两篇文章', occurrence: 3 } },
    { endSpeechAnchor: { quote: '不存在的结尾' } },
    { speechId: 'unknown-speech' },
  ])('reports an invalid optional cue and retains valid guidance and speech: %j', (invalid) => {
    const text = '两篇文章来自同一篇报道。';
    const result = compile(text, [focus('两篇文章', 1), focus('两篇文章', 1, invalid)]);
    expect(result.actions.filter((action) => action.type === 'spotlight')).toHaveLength(1);
    expect(result.actions.filter((action) => action.type === 'speech')).toEqual([{ id: 'saved-id', type: 'speech', text }]);
    expect(result.issues).toHaveLength(1);
  });

  it.each([
    { waypoints: [{ elementId: 'node-1' }, { elementId: 'node-2', speechAnchor: { quote: '最后', occurrence: 0 } }] },
    { waypoints: [{ elementId: 'node-1', speechAnchor: { quote: '最后', occurrence: 0 } }, { elementId: 'node-2', speechAnchor: { quote: '接着', occurrence: 0 } }] },
  ])('rejects an invalid path without inventing or dropping nodes', ({ waypoints }) => {
    const result = compile('首先。接着。最后。', [{ speechId: 'saved-id', type: 'laser', target: { elementId: 'node-0' },
      speechAnchor: { quote: '首先', occurrence: 0 }, waypoints }]);
    expect(result.actions).toEqual([{ id: 'saved-id', type: 'speech', text: '首先。接着。最后。' }]);
    expect(result.issues).toHaveLength(1);
  });

  it('passes the actual table rows and unchanged manuscript to action authoring', async () => {
    const aiCall = vi.fn(async (_system, prompt) => {
      const request = JSON.parse(prompt);
      expect(request.actualSlide.elements.find((element: { id: string }) => element.id === 'cases').table.rows[1])
        .toMatchObject({ rowIndex: 1, cells: [{ cellId: 'cell-1-0', text: '转载同一篇报道' }, { cellId: 'cell-1-1', text: '一个来源' }] });
      return JSON.stringify({ pageId: outline.id, cues: [focus('需要核对', 1)], segments: [{ id: 'rewritten', text: '不得执行的改写' }] });
    });
    const result = await generateManuscriptVisualActions({ outline, content, narration: narration('这还需要核对。'), aiCall });
    expect(aiCall).toHaveBeenCalledOnce();
    expect(result.actions.at(-1)).toEqual({ id: 'saved-id', type: 'speech', text: '这还需要核对。' });
  });

  it('allows no cues when useful and keeps a silent observation page free of authoring requests', async () => {
    expect(compile('不依赖屏幕的过渡。', []).issues).toEqual([]);
    const aiCall = vi.fn();
    const result = await generateManuscriptVisualActions({ outline, content, narration: { pageId: outline.id, segments: [] }, aiCall });
    expect(aiCall).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
  });

  it('treats malformed, empty or mismatched responses and transport failures as technical errors', async () => {
    for (const output of [{ pageId: 'wrong', cues: [] }, {}, '']) {
      const aiCall = vi.fn().mockResolvedValue(JSON.stringify(output));
      await expect(generateManuscriptVisualActions({ outline, content, narration: narration('讲稿。'), aiCall })).rejects.toThrow();
    }
    const failure = new Error('provider unavailable');
    await expect(generateManuscriptVisualActions({ outline, content, narration: narration('讲稿。'),
      aiCall: vi.fn().mockRejectedValue(failure) })).rejects.toBe(failure);
  });
});
