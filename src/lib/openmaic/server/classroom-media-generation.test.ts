import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { promises as fs } from 'node:fs';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { Scene } from '@openmaic/lib/types/stage';
import {
  buildInstructionalImagePrompt,
  findUnresolvedClassroomMedia,
  mediaServingUrl,
  normalizeCourseImageToAspectRatio,
  persistGeneratedClassroomImage,
  replaceMediaPlaceholders,
  reviewGeneratedCourseImage,
  resolveCourseImageDimensions,
  validateGeneratedCourseImage,
} from './classroom-media-generation';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('classroom media URL and placeholder backfill', () => {
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
      style: 'infographic',
      aspectRatio: '16:9',
    });

    expect(prompt).toContain('中文必须逐字准确');
    expect(prompt).toContain('不得擅自增加事实');
    expect(resolveCourseImageDimensions('16:9')).toEqual({ width: 1280, height: 720 });
  });

  it('validates generated image integrity, resolution, and aspect ratio', async () => {
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
    await expect(validateGeneratedCourseImage(tooSmall, '16:9')).rejects.toThrow('分辨率不足');

    const wrongRatio = await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,
        background: '#f5f5f4',
      },
    }).png().toBuffer();
    await expect(validateGeneratedCourseImage(wrongRatio, '16:9')).rejects.toThrow('比例不符合');
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

  it('does not write a generated cover when the independent reviewer rejects it', async () => {
    const source = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const write = vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    const mkdir = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const rejected = Object.assign(new Error('visible text'), { code: 'COURSE_COVER_QUALITY_REJECTED' });
    const reviewer = vi.fn().mockRejectedValue(rejected);
    await expect(persistGeneratedClassroomImage({
      result: { base64: source.toString('base64'), width: 1280, height: 720 },
      classroomId: 'review-test', elementId: 'cover', baseUrl: '',
      normalizeToAspectRatio: true, validateBeforePersist: reviewer,
    })).rejects.toBe(rejected);
    expect(reviewer).toHaveBeenCalledWith(expect.any(Buffer));
    expect(write).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('uses Qwen vision review as a semantic quality gate', async () => {
    const image = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: '#f5f5f4',
      },
    }).png().toBuffer();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"pass":true,"issues":[]}' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reviewGeneratedCourseImage({
      buffer: image,
      providerId: 'qwen-image',
      apiKey: 'test-key',
      requirement: '准确展示三个教学步骤，中文清晰',
    })).resolves.toBeUndefined();

    const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      messages: Array<{ content: Array<{ image_url?: { url?: string } }> }>;
    };
    expect(request.messages[1]?.content[0]?.image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('rejects an image when semantic review finds garbled teaching text', async () => {
    const image = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: '#f5f5f4',
      },
    }).png().toBuffer();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"pass":false,"issues":["中文标签存在乱码"]}' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    await expect(reviewGeneratedCourseImage({
      buffer: image,
      providerId: 'qwen-image',
      apiKey: 'test-key',
      requirement: '中文教学流程图',
    })).rejects.toThrow('中文标签存在乱码');
  });

});
