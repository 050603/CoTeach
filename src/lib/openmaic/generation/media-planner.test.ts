import { describe, expect, it } from 'vitest';
import { applyMediaPlanToOutlines } from './media-planner';
import type { SceneOutline } from '../types/generation';

const outlines: SceneOutline[] = Array.from({ length: 6 }, (_, index) => ({
  id: `scene-${index + 1}`,
  type: 'slide',
  title: `页面 ${index + 1}`,
  description: '讲清楚一个课程知识点',
  keyPoints: ['知识点'],
  estimatedDuration: 60,
  order: index,
}));

describe('confirmed-outline media planner', () => {
  it('uses only enabled media and preserves the confirmed outline structure', () => {
    const result = applyMediaPlanToOutlines(outlines, { media: [
      { outlineId: 'scene-1', type: 'image', prompt: '用于解释知识关系的清晰中文结构图' },
      { outlineId: 'scene-2', type: 'video', prompt: '展示物体运动变化过程的短动画' },
      { outlineId: 'missing', type: 'image', prompt: '不应使用的无效页面图片说明' },
    ] }, { imageEnabled: true, videoEnabled: false });

    expect(result.map(({ id, title, order }) => ({ id, title, order }))).toEqual(
      outlines.map(({ id, title, order }) => ({ id, title, order })),
    );
    expect(result[0]?.mediaGenerations).toHaveLength(1);
    expect(result[1]?.mediaGenerations).toBeUndefined();
  });

  it('has no course image quota, allows two media per page, and caps unique videos', () => {
    const plan = { media: [
      { outlineId: 'scene-1', type: 'video', prompt: '展示物体随时间连续运动变化的演示视频' },
      { outlineId: 'scene-1', type: 'image', prompt: '展示物体运动路径和关键位置的连续示意图' },
      ...outlines.slice(1).map((outline) => ({
        outlineId: outline.id,
        type: 'image' as const,
        prompt: `页面 ${outline.id} 的概念关系示意插图`,
      })),
    ] };
    const result = applyMediaPlanToOutlines(outlines, plan, { imageEnabled: true, videoEnabled: true });
    const requests = result.flatMap((outline) => outline.mediaGenerations ?? []);
    expect(requests.filter((item) => item.type === 'image')).toHaveLength(6);
    expect(requests.filter((item) => item.type === 'video')).toHaveLength(1);
    expect(result.every((outline) => (outline.mediaGenerations?.length ?? 0) <= 2)).toBe(true);
  });

  it('reuses one generated asset across pages with the same reuse key', () => {
    const result = applyMediaPlanToOutlines(outlines, { media: [
      { outlineId: 'scene-1', type: 'image', reuseKey: 'shared-model', prompt: '同一个结构模型的准确教学示意图' },
      { outlineId: 'scene-2', type: 'image', reuseKey: 'shared-model', prompt: '同一个结构模型的准确教学示意图' },
    ] }, { imageEnabled: true, videoEnabled: false });
    expect(result[0]?.mediaGenerations?.[0]?.elementId).toBe(
      result[1]?.mediaGenerations?.[0]?.elementId,
    );
  });

  it('keeps generated media in the planner-owned course visual direction', () => {
    const result = applyMediaPlanToOutlines([
      {
        ...outlines[0]!,
        generationPurpose: 'knowledge-teaching',
        courseVisualDirection: '暖白背景、墨绿主色、珊瑚色强调，以抽样路径为图形母题。',
      },
    ], { media: [{
      outlineId: 'scene-1',
      type: 'image',
      prompt: '解释抽样总体与样本关系的准确示意图',
      style: 'flat vector',
    }] }, { imageEnabled: true, videoEnabled: false });

    expect(result[0]?.mediaGenerations?.[0]?.style).toContain('flat vector');
    expect(result[0]?.mediaGenerations?.[0]?.style).toContain('暖白背景、墨绿主色、珊瑚色强调');
    expect(result[0]?.mediaGenerations?.[0]?.style).not.toContain('topic-appropriate palette');
  });

  it('does not impose the lecture palette on unrelated course media', () => {
    const result = applyMediaPlanToOutlines([{
      ...outlines[0]!,
      mediaGenerations: [{
        type: 'image',
        prompt: '一张用于项目情境导入的纪实照片',
        elementId: 'existing-image',
        style: 'documentary photography',
      }],
    }], { media: [] }, { imageEnabled: true, videoEnabled: false });

    expect(result[0]?.mediaGenerations?.[0]?.style).toBe('documentary photography');
  });
});
