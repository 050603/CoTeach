import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { promises as fs } from 'node:fs';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { Scene } from '@openmaic/lib/types/stage';
import { isMediaPlaceholder } from '@openmaic/lib/store/media-generation';
import {
  buildInstructionalImagePrompt,
  findUnresolvedClassroomMedia,
  mediaServingUrl,
  normalizeCourseImageToAspectRatio,
  persistGeneratedClassroomImage,
  replaceMediaPlaceholders,
  resolveCourseImageDimensions,
  validateGeneratedCourseImage,
} from './classroom-media-generation';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('classroom media URL and placeholder backfill', () => {
  it('recognizes both legacy and teaching-blueprint media placeholders', () => {
    expect(isMediaPlaceholder('gen_img_randomized')).toBe(true);
    expect(isMediaPlaceholder('teaching-section-1-page-1:media-1')).toBe(true);
    expect(isMediaPlaceholder('/api/openmaic/classroom-media/c1/media/image.png')).toBe(false);
  });

  it('always builds migration-safe same-origin URLs', () => {
    expect(mediaServingUrl('', 'classroom-1', 'media/image.png')).toBe(
      '/api/openmaic/classroom-media/classroom-1/media/image.png',
    );
    expect(mediaServingUrl('https://school.example/', 'classroom-1', 'media/image.png')).toBe(
      '/api/openmaic/classroom-media/classroom-1/media/image.png',
    );
  });

  it('matches a normalized placeholder to the sole planned image for its outline', () => {
    const outlines: SceneOutline[] = [{
      id: 'outline-1',
      type: 'slide',
      title: '页面',
      description: '说明',
      keyPoints: [],
      order: 0,
      mediaGenerations: [{
        type: 'image',
        elementId: 'gen_img_randomized',
        prompt: '课堂插图',
      }],
    }];
    const scenes = [{
      id: 'scene-1',
      outlineId: 'outline-1',
      type: 'slide',
      content: {
        canvas: {
          elements: [{ id: 'image-1', type: 'image', src: 'gen_img_1' }],
        },
      },
    }] as unknown as Scene[];

    replaceMediaPlaceholders(
      scenes,
      { gen_img_randomized: '/api/openmaic/classroom-media/c1/media/generated.png' },
      outlines,
    );

    const element = (scenes[0]!.content as { canvas: { elements: Array<{ src: string }> } })
      .canvas.elements[0];
    expect(element?.src).toBe('/api/openmaic/classroom-media/c1/media/generated.png');
  });

  it('backfills deterministic teaching-blueprint media IDs with the generated URL', () => {
    const mediaId = 'teaching-section-1-page-1:media-1';
    const outlines = [{
      id: 'teaching-section-1-page-1',
      type: 'slide',
      title: '页面',
      description: '说明',
      keyPoints: [],
      order: 0,
      mediaGenerations: [{ type: 'image', elementId: mediaId, prompt: '课堂情境插图' }],
    }] as SceneOutline[];
    const scenes = [{
      id: 'scene-1',
      outlineId: 'teaching-section-1-page-1',
      type: 'slide',
      content: { canvas: { elements: [{ id: 'image-1', type: 'image', src: mediaId }] } },
    }] as unknown as Scene[];

    replaceMediaPlaceholders(
      scenes,
      { [mediaId]: `/api/openmaic/classroom-media/c1/media/${mediaId}.png` },
      outlines,
    );

    const element = (scenes[0]!.content as { canvas: { elements: Array<{ src: string }> } })
      .canvas.elements[0];
    expect(element?.src).toBe(`/api/openmaic/classroom-media/c1/media/${mediaId}.png`);
    expect(findUnresolvedClassroomMedia(outlines, scenes)).toEqual([]);
  });

  it('reports an unresolved deterministic media ID instead of marking the batch complete', () => {
    const mediaId = 'teaching-section-1-page-1:media-1';
    const outlines = [{
      id: 'teaching-section-1-page-1',
      type: 'slide',
      title: '页面',
      description: '说明',
      keyPoints: [],
      order: 0,
      mediaGenerations: [{ type: 'image', elementId: mediaId, prompt: '课堂情境插图' }],
    }] as SceneOutline[];
    const scenes = [{
      id: 'scene-1',
      outlineId: 'teaching-section-1-page-1',
      type: 'slide',
      content: { canvas: { elements: [{ id: 'image-1', type: 'image', src: mediaId }] } },
    }] as unknown as Scene[];

    expect(findUnresolvedClassroomMedia(outlines, scenes)).toEqual([{
      elementId: mediaId,
      type: 'image',
      error: '页面仍包含未解析的媒体占位符',
    }]);
  });

  it('discovers unresolved placeholders even when no asset failure was recorded', () => {
    const outlines = [{
      id: 'outline-1',
      type: 'slide',
      title: '页面',
      description: '说明',
      keyPoints: [],
      order: 0,
      mediaGenerations: [{ type: 'image', elementId: 'gen_img_expected', prompt: '课堂插图' }],
    }] as SceneOutline[];
    const scenes = [{
      id: 'scene-1',
      outlineId: 'outline-1',
      type: 'slide',
      content: { canvas: { elements: [{ type: 'image', src: 'gen_img_1' }] } },
    }] as unknown as Scene[];

    expect(findUnresolvedClassroomMedia(outlines, scenes)).toEqual([{
      elementId: 'gen_img_expected',
      type: 'image',
      error: '页面仍包含未解析的媒体占位符',
    }]);
  });

  it('reports a raw placeholder when its durable media plan is missing', () => {
    const scenes = [{
      id: 'scene-1',
      outlineId: 'outline-1',
      type: 'slide',
      content: { canvas: { elements: [{ type: 'image', src: 'gen_img_lost' }] } },
    }] as unknown as Scene[];

    expect(findUnresolvedClassroomMedia([], scenes)).toEqual([{
      elementId: 'gen_img_lost',
      type: 'image',
      error: '媒体生成计划缺失，无法生成真实资源',
    }]);
  });

  it('adds accuracy constraints and uses classroom-ready image dimensions', () => {
    const prompt = buildInstructionalImagePrompt({
      type: 'image',
      elementId: 'gen_img_1',
      prompt: '带有中文标签的教学流程图',
      observationContext: '牛的四条腿和花斑属于本页需要观察的可见特征。',
      style: 'infographic',
      aspectRatio: '16:9',
    });

    expect(prompt).toContain('精确文字、数值、公式和关系标签由页面原生可编辑元素呈现');
    expect(prompt).toContain('不增加未经要求的事实');
    expect(prompt).toContain('四条腿和花斑');
    expect(resolveCourseImageDimensions('16:9')).toEqual({ width: 1280, height: 720 });
  });

  it('validates image integrity without rejecting a readable image for visual dimensions', async () => {
    const valid = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: '#f5f5f4',
      },
    }).png().toBuffer();
    await expect(validateGeneratedCourseImage(valid, '16:9')).resolves.toMatchObject({
      extension: 'png',
      width: 1280,
      height: 720,
    });

    const tooSmall = await sharp({
      create: {
        width: 320,
        height: 180,
        channels: 3,
        background: '#f5f5f4',
      },
    }).png().toBuffer();
    await expect(validateGeneratedCourseImage(tooSmall, '16:9')).resolves.toMatchObject({ width: 320, height: 180 });

    const wrongRatio = await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,
        background: '#f5f5f4',
      },
    }).png().toBuffer();
    await expect(validateGeneratedCourseImage(wrongRatio, '16:9')).resolves.toMatchObject({ width: 1024, height: 1024 });
    await expect(validateGeneratedCourseImage(Buffer.from('invalid'))).rejects.toMatchObject({ code: 'GENERATED_IMAGE_INVALID', isRetryable: false });
  });

  it('normalizes provider output to a consistent 16:9 WebP cover', async () => {
    const providerImage = await sharp({
      create: {
        width: 1536,
        height: 1024,
        channels: 3,
        background: '#dbeafe',
      },
    }).png().toBuffer();

    const normalized = await normalizeCourseImageToAspectRatio(providerImage, '16:9');
    await expect(validateGeneratedCourseImage(normalized, '16:9')).resolves.toEqual({
      extension: 'webp',
      width: 1280,
      height: 720,
    });
  });

  it('persists the first readable image without calling any vision reviewer', async () => {
    const source = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const write = vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(persistGeneratedClassroomImage({
      result: { base64: source.toString('base64'), width: 1280, height: 720 },
      classroomId: 'single-pass-test', elementId: 'cover', baseUrl: '',
    })).resolves.toContain('cover.png');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

});
