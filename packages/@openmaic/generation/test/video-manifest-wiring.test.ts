import { describe, expect, test } from 'vitest';
import { generateSceneContent } from '@openmaic/generation';
import type { AICallFn } from '@openmaic/generation';
import type { GeneratedSlideContent, SceneOutline } from '@openmaic/generation';

describe('video manifest wiring', () => {
  test('corrects an invalid generated video src to the only available mediaRef', async () => {
    const outline: SceneOutline = {
      id: 'scene_1',
      type: 'slide',
      title: 'Horse Motion',
      description: 'Show a happy horse running',
      keyPoints: ['horse gait', 'motion'],
      order: 1,
      mediaGenerations: [
        {
          type: 'video',
          prompt: 'A happy horse running in a sunny field',
          elementId: 'gen_vid_real123',
          aspectRatio: '16:9',
        },
      ],
    };

    const aiCall: AICallFn = async () =>
      JSON.stringify({
        background: { type: 'solid', color: '#ffffff' },
        elements: [
          {
            id: 'video_001',
            type: 'video',
            left: 120,
            top: 120,
            width: 640,
            height: 360,
            src: 'gen_vid_1',
            autoplay: false,
          },
        ],
      });

    const content = await generateSceneContent(outline, aiCall);

    expect(content).not.toBeNull();
    const slideContent = content as GeneratedSlideContent;
    const video = slideContent.elements.find((el) => el.type === 'video');
    expect(video).toMatchObject({
      type: 'video',
      mediaRef: 'gen_vid_real123',
    });
    expect(Object.prototype.hasOwnProperty.call(video, 'src')).toBe(false);
  });

  test('rejects a slide that becomes blank after removing a hallucinated generated video', async () => {
    const outline: SceneOutline = {
      id: 'scene_1',
      type: 'slide',
      title: 'Text-only scene',
      description: 'Explain without generated media',
      keyPoints: ['no media'],
      order: 1,
    };

    const aiCall: AICallFn = async () =>
      JSON.stringify({
        background: { type: 'solid', color: '#ffffff' },
        elements: [
          {
            id: 'video_001',
            type: 'video',
            left: 120,
            top: 120,
            width: 640,
            height: 360,
            mediaRef: 'gen_vid_fake',
            autoplay: false,
          },
        ],
      });

    const failures: unknown[] = [];
    const content = await generateSceneContent(outline, aiCall, {
      onFailure: (failure) => failures.push(failure),
    });

    expect(content).toBeNull();
    expect(failures).toEqual([{ code: 'invalid-model-output' }]);
  });

  test('preserves direct video src and drops generated mediaRef', async () => {
    const outline: SceneOutline = {
      id: 'scene_1',
      type: 'slide',
      title: 'Existing video',
      description: 'Use a direct video URL',
      keyPoints: ['direct video'],
      order: 1,
      mediaGenerations: [
        {
          type: 'video',
          prompt: 'A generated fallback video',
          elementId: 'gen_vid_real123',
          aspectRatio: '16:9',
        },
      ],
    };

    const aiCall: AICallFn = async () =>
      JSON.stringify({
        background: { type: 'solid', color: '#ffffff' },
        elements: [
          {
            id: 'video_001',
            type: 'video',
            left: 120,
            top: 120,
            width: 640,
            height: 360,
            src: 'https://example.com/direct.mp4',
            mediaRef: 'gen_vid_real123',
            autoplay: false,
          },
        ],
      });

    const content = await generateSceneContent(outline, aiCall);

    expect(content).not.toBeNull();
    const slideContent = content as GeneratedSlideContent;
    const video = slideContent.elements.find((el) => el.type === 'video');
    expect(video).toMatchObject({
      type: 'video',
      src: 'https://example.com/direct.mp4',
    });
    expect(Object.prototype.hasOwnProperty.call(video, 'mediaRef')).toBe(false);
  });
});
