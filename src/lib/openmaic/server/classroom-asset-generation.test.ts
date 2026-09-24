import { promises as fs } from 'node:fs';
import type { Scene } from '@openmaic/lib/types/stage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import {
  buildMediaRepairOutlines,
  collectRequestedClassroomMedia,
  collectPersistedClassroomMedia,
  formatClassroomMediaItemProgress,
  reconcileMediaFailures,
} from './classroom-asset-generation';

const outlines: SceneOutline[] = [
  {
    id: 'intro',
    type: 'slide',
    title: '自然语言处理导入',
    description: '课程引入',
    keyPoints: [],
    order: 0,
    mediaGenerations: [
      { type: 'image', elementId: 'image-intro', prompt: '原始引入图', aspectRatio: '16:9' },
      { type: 'image', elementId: 'image-intro', prompt: '重复请求不应再次生成', aspectRatio: '16:9' },
    ],
  },
  {
    id: 'detail',
    type: 'slide',
    title: '分词与词性标注',
    description: '核心知识讲解',
    keyPoints: [],
    order: 1,
    mediaGenerations: [
      { type: 'image', elementId: 'image-detail', prompt: '可能触发审核的原始提示词' },
      { type: 'video', elementId: 'video-detail', prompt: '课堂演示视频' },
    ],
  },
];

afterEach(() => vi.restoreAllMocks());

describe('classroom asset repair planning', () => {
  it('reuses referenced media from the test classroom but does not trust missing files', async () => {
    vi.spyOn(fs, 'stat').mockImplementation(async (file) => {
      if (String(file).includes('image-detail')) throw new Error('missing');
      return { isFile: () => true, size: 100 } as never;
    });
    const scenes = [{ content: { type: 'slide', canvas: { elements: [
      { type: 'image', src: '/api/openmaic/classroom-media/old-test/media/image-intro.png' },
      { type: 'image', src: '/api/openmaic/classroom-media/old-test/media/image-detail.png' },
    ] } } }] as Scene[];
    await expect(collectPersistedClassroomMedia(collectRequestedClassroomMedia(outlines, { image: true, video: false }), scenes))
      .resolves.toEqual({ 'image-intro': '/api/openmaic/classroom-media/old-test/media/image-intro.png' });
  });

  it('deduplicates media requests and respects enabled capabilities', () => {
    const requests = collectRequestedClassroomMedia(outlines, { image: true, video: false });

    expect(requests.map((request) => request.elementId)).toEqual(['image-intro', 'image-detail']);
    expect(requests[0]?.prompt).toBe('重复请求不应再次生成');
  });

  it('retries only failed media without replacing the intended prompt with generic filler', () => {
    const repair = buildMediaRepairOutlines(outlines, [{
      elementId: 'image-detail',
      type: 'image',
      error: 'Qwen Image failed: DataInspectionFailed inappropriate content',
    }]);

    expect(repair).toHaveLength(1);
    expect(repair[0]?.id).toBe('detail');
    expect(repair[0]?.mediaGenerations).toHaveLength(1);
    expect(repair[0]?.mediaGenerations?.[0]?.prompt).toBe('可能触发审核的原始提示词');
  });

  it('does not report completion while any requested file is still missing', () => {
    const requests = collectRequestedClassroomMedia(outlines, { image: true, video: false });
    const failures = reconcileMediaFailures(requests, { 'image-detail': '/media/detail.png' }, []);

    expect(failures).toEqual([{
      elementId: 'image-intro',
      type: 'image',
      error: '素材生成未返回可用文件',
    }]);
  });

  it('reports the concrete item and retry attempt instead of leaving one static media message', () => {
    expect(formatClassroomMediaItemProgress({
      type: 'image', elementId: 'image-detail', status: 'retrying',
      completed: 1, total: 2, attempt: 2, maxAttempts: 3, nextDelayMs: 15_000,
    })).toBe('课堂配图 2 / 2 正在进行第 2 / 3 次生成，约 15 秒后继续');
    expect(formatClassroomMediaItemProgress({
      type: 'image', elementId: 'image-detail', status: 'failed', completed: 2, total: 2,
    })).toContain('未通过审校');
  });
});
