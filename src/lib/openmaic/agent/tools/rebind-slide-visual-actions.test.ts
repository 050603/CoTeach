import { describe, expect, it } from 'vitest';
import type { GeneratedSlideContent, SceneOutline } from '@openmaic/lib/types/generation';
import type { Action } from '@openmaic/lib/types/action';
import { rebindSlideVisualActions } from './rebind-slide-visual-actions';

const text = (id: string, content: string) => ({ id, type: 'text' as const, left: 40, top: 80,
  width: 400, height: 80, rotate: 0, content: `<p>${content}</p>`, defaultFontName: 'Noto Sans SC', defaultColor: '#334155' });
const outline: SceneOutline = { id: 'page', type: 'slide', title: '关系', description: '观察关系', keyPoints: [], order: 0 };
const speech: Action = { id: 'speech', type: 'speech', text: '亲切连续的原讲稿，内容、数量和上下文都保持原样。',
  audioId: 'saved-audio', audioUrl: '/audio/original.wav', audioDurationSec: 21,
  speechAlignment: { version: 'align-v1', status: 'aligned', textHash: 'text', audioHash: 'audio', spans: [] } };
const focus: Action = { id: 'focus', type: 'spotlight', elementId: 'old', speechId: 'speech',
  speechAnchor: { quote: '根据真实条件判断' }, speechOffsetMs: 1100, endSpeechOffsetMs: 8000, dimOpacity: 0.35, necessity: 'helpful' };

describe('PPT-only visual action rebinding', () => {
  it('binds actual free native text without displayItems and preserves speech/audio/all non-address fields', () => {
    const before = { elements: [text('old', '根据真实条件判断')] };
    const after = { elements: [text('new', '根据真实条件判断')] };
    const actions: Action[] = [speech, focus, { id: 'wb', type: 'wb_open' },
      { id: 'board-speech', type: 'speech', text: '保留白板讲稿', audioUrl: '/board.wav' },
      { id: 'close', type: 'wb_close' }, { id: 'discussion', type: 'discussion', topic: '原检测问题' }];
    const original = structuredClone(actions);
    const result = rebindSlideVisualActions({ outline, before, after, actions });
    expect(result.diagnostics).toEqual([]);
    expect(result.actions[1]).toEqual({ ...focus, elementId: 'new', selector: undefined });
    expect(result.actions.filter((action) => action.type !== 'spotlight')).toEqual(original.filter((action) => action.type !== 'spotlight'));
    expect(actions).toEqual(original);
  });

  it('moves precise table cells and ordered laser waypoints while keeping anchors and compiled timing', () => {
    const table = (id: string, cell: string): GeneratedSlideContent => ({ elements: [{ type: 'table', id,
      left: 40, top: 100, width: 700, height: 200, rotate: 0, cellMinHeight: 40, colWidths: [1],
      outline: { color: '#ccc', style: 'solid', width: 1 },
      data: [[{ id: cell, text: '根据真实条件判断', rowspan: 1, colspan: 1 }]] }] });
    const laser: Action = { id: 'path', type: 'laser', elementId: 'table-before', selector: { cellId: 'old-cell' },
      speechId: 'speech', duration: 6000, color: '#ef4444', speechOffsetMs: 500,
      waypoints: [{ elementId: 'old', speechAnchor: { quote: '完整终点解释' }, speechOffsetMs: 3900 }] };
    const before = table('table-before', 'old-cell'); before.elements.push(text('old', '完整终点解释'));
    const after = table('table-after', 'new-cell'); after.elements.push(text('new', '完整终点解释'));
    const result = rebindSlideVisualActions({ outline, before, after, actions: [speech, laser] });
    expect(result.actions[1]).toEqual({ ...laser, elementId: 'table-after', selector: { cellId: 'new-cell' },
      waypoints: [{ elementId: 'new', selector: undefined, speechAnchor: { quote: '完整终点解释' }, speechOffsetMs: 3900 }] });
  });

  it('matches preserved source images by actual src and diagram nodes by actual label without a projection', () => {
    const image = (id: string) => ({ id, type: 'image' as const, left: 30, top: 100, width: 300, height: 180,
      rotate: 0, fixedRatio: true, src: '/api/textbooks/figures/identity.png' });
    const flowOutline = { ...outline, visualIntent: { diagram: { nodes: [{ id: 'decision', label: '检测实际条件' }] } } } as SceneOutline;
    const before = { elements: [image('old-image'), text('flow-node-decision', '检测实际条件')] };
    const after = { elements: [image('new-image'), text('compiled-node-decision', '检测实际条件')] };
    const result = rebindSlideVisualActions({ outline: flowOutline, before, after, actions: [
      { id: 'image-cue', type: 'spotlight', elementId: 'old-image' },
      { id: 'node-cue', type: 'laser', elementId: 'flow-node-decision' },
    ] });
    expect(result.actions.map((action) => 'elementId' in action && action.elementId)).toEqual(['new-image', 'compiled-node-decision']);
    const video = { type: 'video' as const, id: 'old-video', mediaRef: 'asset-video', autoplay: false,
      left: 40, top: 200, width: 320, height: 180, rotate: 0 };
    const boundVideo = rebindSlideVisualActions({ outline, before: { elements: [video] },
      after: { elements: [{ ...video, id: 'new-video' }] }, actions: [{ id: 'video-cue', type: 'spotlight', elementId: video.id }] });
    expect(boundVideo.actions[0]).toMatchObject({ elementId: 'new-video' });
  });

  it('omits ambiguous optional cues and every unresolved laser path, without guessing positional IDs', () => {
    const before = { elements: [text('old', '根据真实条件判断')] };
    const after = { elements: [text('old', '另一个完全无关的主题'), text('a', '根据真实条件判断'), text('b', '根据真实条件判断')] };
    const result = rebindSlideVisualActions({ outline, before, after, actions: [speech, focus] });
    expect(result.actions).toEqual([speech]);
    expect(result.essentialUnresolved).toBe(false);
    expect(result.diagnostics[0]).toContain('omitted this optional cue');
    const laser: Action = { id: 'laser', type: 'laser', elementId: 'old', waypoints: [{ elementId: 'missing' }] };
    expect(rebindSlideVisualActions({ outline, before, after: { elements: [text('new', '根据真实条件判断')] }, actions: [laser] }).actions).toEqual([]);
  });

  it('does not accept unrelated or hidden source slots and reports essential failure for saved-draft recovery', () => {
    const before = { elements: [text('old', '根据真实条件判断')], contentBindings: [{ sourceContentId: 'source', elementId: 'old' }] };
    const after = { elements: [text('wrong', '完全不相关的内容')], contentBindings: [{ sourceContentId: 'source', elementId: 'wrong' }] };
    const result = rebindSlideVisualActions({ outline, before, after, actions: [{ ...focus, necessity: 'essential' }] });
    expect(result.actions).toEqual([]);
    expect(result.essentialUnresolved).toBe(true);
    expect(result.diagnostics[0]).toContain('retained the saved slide');
    const hidden = { elements: [{ ...text('hidden', '根据真实条件判断'), opacity: 0 }],
      contentBindings: [{ sourceContentId: 'source', elementId: 'hidden' }] };
    expect(rebindSlideVisualActions({ outline, before, after: hidden, actions: [focus] }).actions).toEqual([]);
  });
});
