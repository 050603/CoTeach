import { describe, expect, it } from 'vitest';
import type { GeneratedSlideContent, SceneOutline } from '@openmaic/lib/types/generation';
import { buildCompleteScene } from './scene-builder';

describe('native slide scene assembly', () => {
  it('persists actual display items and compiled target bindings through scene serialization', () => {
    const outline: SceneOutline = { id: 'page', type: 'slide', title: '证据关系', description: '比较说法与记录',
      keyPoints: ['记录必须相关'], order: 0, generationPurpose: 'knowledge-teaching', audience: 'student' };
    const content: GeneratedSlideContent = { elements: [{ id: 'body', type: 'text', left: 50, top: 140,
      width: 850, height: 100, rotate: 0, content: '<p>记录必须与具体说法相关。</p>',
      defaultFontName: 'Noto Sans SC', defaultColor: '#334155' }],
      displayItems: [{ id: 'display-1', text: '记录必须与具体说法相关。', sourceContentIds: ['adopted-content-1'] }],
      contentBindings: [{ sourceContentId: 'display-1', elementId: 'body' },
        { sourceContentId: 'adopted-content-1', elementId: 'body' },
        { sourceContentId: 'page:visible-1', elementId: 'body', selector: { quote: '记录' } }],
    };
    const saved = structuredClone(content);
    const scene = buildCompleteScene(outline, content, [{ id: 'speech', type: 'speech', text: '已经确认的讲稿。' }], 'stage');
    expect(scene?.type).toBe('slide');
    if (!scene || scene.content.type !== 'slide') throw new Error('Expected native slide scene');
    const persisted = JSON.parse(JSON.stringify(scene.content.canvas));
    expect(persisted.displayItems).toEqual(content.displayItems);
    expect(persisted.contentBindings).toEqual(content.contentBindings);
    expect(persisted.theme.fontName).toBe('Noto Sans SC');
    expect(scene.actions).toEqual([{ id: 'speech', type: 'speech', text: '已经确认的讲稿。' }]);
    expect(content).toEqual(saved);
  });
});
