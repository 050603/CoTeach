import { describe, expect, it } from 'vitest';
import type { Scene } from '@openmaic/lib/types/stage';
import { isStudentAiLearningScene } from '@openmaic/lib/pbl/scene-routing';
import { resolveSceneOutline } from '@openmaic/lib/agent/client/resolve-scene-outline';
import { createBlankSlideScene, duplicateScene, duplicateSlideScene } from './slide-defaults';

describe('scene creation and duplication', () => {
  it('keeps copied whiteboard groups and arrow attachments independent from their source', () => {
    const source = createBlankSlideScene('c1', '步骤演示', 0);
    source.actions = [
      { id: 'node-action', type: 'wb_draw_shape', elementId: 'node', groupId: 'step', shape: 'rectangle', x: 40, y: 80, width: 200, height: 120 },
      { id: 'label-action', type: 'wb_draw_text', elementId: 'label', groupId: 'step', content: '观察', x: 60, y: 100 },
      { id: 'line-action', type: 'wb_draw_line', elementId: 'arrow', startX: 240, startY: 140, endX: 500, endY: 140, startAnchor: { elementId: 'node', side: 'right' } },
      { id: 'move-action', type: 'wb_draw_shape', elementId: 'node', groupId: 'step', shape: 'rectangle', x: 80, y: 80, width: 200, height: 120 },
    ];
    const [node, label, line, moved] = duplicateSlideScene(source, '副本', 1).actions!;
    expect(node).toHaveProperty('elementId', expect.not.stringMatching(/^node$/));
    expect(node.groupId).not.toBe('step');
    expect(label.groupId).toBe(node.groupId);
    expect(line).toHaveProperty('startAnchor.elementId', (node as { elementId: string }).elementId);
    expect(moved).toHaveProperty('elementId', (node as { elementId: string }).elementId);
    expect(source.actions[2]).toHaveProperty('startAnchor.elementId', 'node');
  });
  it('keeps newly inserted AI-learning pages visible to students', () => {
    const neighbor = {
      ...createBlankSlideScene('c1', '原页面', 0),
      stageKey: 'ai-learning', audience: 'student', generationPurpose: 'knowledge-teaching',
      outlineId: 'original-outline', knowledgePointIds: ['k1'],
    } as Scene;
    const inserted = createBlankSlideScene('c1', '新页面', 1, neighbor);
    expect(isStudentAiLearningScene(inserted)).toBe(true);
    expect(inserted.outlineId).toBeUndefined();
    expect(inserted.knowledgePointIds).toEqual(['k1']);
    expect(inserted.knowledgePointIds).not.toBe(neighbor.knowledgePointIds);
  });

  it('gives non-slide copies their own outline and narration identity', () => {
    const source: Scene = {
      id: 'quiz', stageId: 'c1', type: 'quiz', title: '原测验', order: 0, outlineId: 'outline-quiz',
      content: { type: 'quiz', questions: [] },
      actions: [{ id: 'speech', type: 'speech', text: '说明', audioId: 'original-audio', audioUrl: '/old.wav' }],
    };
    const copy = duplicateScene(source, '副本', 1);
    expect(copy.id).not.toBe(source.id);
    expect(copy.content).not.toBe(source.content);
    expect(copy.outlineId).toBeUndefined();
    expect(copy.actions?.[0].id).not.toBe('speech');
    expect(copy.actions?.[0]).not.toHaveProperty('audioId');
    expect(copy.actions?.[0]).not.toHaveProperty('audioUrl');
    expect(resolveSceneOutline(copy, [{ id: 'outline-quiz', title: '旧大纲', type: 'quiz', description: '', keyPoints: [], order: 0 }]).title).toBe('原测验 副本');
  });

  it('remaps duplicated animations and cues to the copied slide elements', () => {
    const source = createBlankSlideScene('c1', '页面', 0);
    if (source.type !== 'slide') throw new Error('Expected slide');
    source.content.canvas.elements = [{
      id: 'image', type: 'image', left: 0, top: 0, width: 100, height: 100, src: '/image.png', fixedRatio: true, rotate: 0,
      shadow: { h: 1, v: 2, blur: 3, color: '#000000' },
    }];
    source.content.canvas.animations = [{ id: 'animation', elId: 'image', effect: 'fade', type: 'in', duration: 300, trigger: 'click' }];
    source.actions = [{ id: 'laser', type: 'laser', elementId: 'image' }];
    const copy = duplicateSlideScene(source, '副本', 1);
    if (copy.type !== 'slide') throw new Error('Expected slide');
    const copiedImage = copy.content.canvas.elements[0];
    expect(copiedImage.id).not.toBe('image');
    expect(copy.content.canvas.animations?.[0]).toMatchObject({ elId: copiedImage.id });
    expect(copy.actions?.[0]).toMatchObject({ elementId: copiedImage.id });
    const originalImage = source.content.canvas.elements[0];
    if (copiedImage.type !== 'image' || originalImage.type !== 'image') throw new Error('Expected image');
    expect(copiedImage.shadow).not.toBe(originalImage.shadow);
  });
});
