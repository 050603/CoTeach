import { describe, expect, test } from 'vitest';
import { uniquifyMediaElementIds, type SceneOutline } from '@openmaic/generation';

describe('uniquifyMediaElementIds', () => {
  test('preserves stable generated-media IDs without mutating the input', () => {
    const outlines: SceneOutline[] = [1, 2].map((order) => ({
      id: `scene_${order}`,
      type: 'slide',
      title: `Scene ${order}`,
      description: 'Description',
      keyPoints: [],
      order,
      mediaGenerations: [
        { type: 'image', prompt: `Diagram ${order}`, elementId: `gen_img_diagram-${order}` },
        { type: 'video', prompt: `Clip ${order}`, elementId: `gen_vid_clip-${order}` },
      ],
    }));

    const result = uniquifyMediaElementIds(outlines);
    const resultIds = result.flatMap((outline) =>
      (outline.mediaGenerations ?? []).map((request) => request.elementId),
    );

    expect(resultIds).toEqual([
      'gen_img_diagram-1',
      'gen_vid_clip-1',
      'gen_img_diagram-2',
      'gen_vid_clip-2',
    ]);
    expect(new Set(resultIds).size).toBe(resultIds.length);
    expect(result.map((outline) => outline.visualIntent?.resourceRefs?.[0])).toEqual([
      expect.objectContaining({ resourceId: 'gen_img_diagram-1', required: true }),
      expect.objectContaining({ resourceId: 'gen_img_diagram-2', required: true }),
    ]);
    expect(
      outlines.flatMap((outline) =>
        (outline.mediaGenerations ?? []).map((request) => request.elementId),
      ),
    ).toEqual([
      'gen_img_diagram-1',
      'gen_vid_clip-1',
      'gen_img_diagram-2',
      'gen_vid_clip-2',
    ]);
  });

  test('collapses a shared definition so one resource is generated once', () => {
    const sharedRequest = {
      type: 'image' as const,
      prompt: 'A child comparing a fish, frog, and cow in their real habitats',
      elementId: 'gen_img_animal-contrast',
    };
    const outlines: SceneOutline[] = [1, 2].map((order) => ({
      id: `scene_${order}`,
      type: 'slide',
      title: `Scene ${order}`,
      description: 'Description',
      keyPoints: [],
      order,
      mediaGenerations: [{ ...sharedRequest }],
    }));

    const result = uniquifyMediaElementIds(outlines);

    expect(result.flatMap((outline) => outline.mediaGenerations ?? [])).toEqual([sharedRequest]);
    expect(result[1]?.visualIntent?.resourceRefs).toEqual([
      expect.objectContaining({
        resourceId: 'gen_img_animal-contrast',
        kind: 'generated-image',
        required: true,
      }),
    ]);
  });

  test('canonicalizes non-placeholder IDs and deterministically separates real collisions', () => {
    const outlines: SceneOutline[] = [
      {
        id: 'scene_1',
        type: 'slide',
        title: 'One',
        description: 'Description',
        keyPoints: [],
        order: 1,
        mediaGenerations: [{ type: 'image', prompt: 'First', elementId: 'lesson:media-1' }],
      },
      {
        id: 'scene_2',
        type: 'slide',
        title: 'Two',
        description: 'Description',
        keyPoints: [],
        order: 2,
        mediaGenerations: [{ type: 'image', prompt: 'Second', elementId: 'lesson:media-1' }],
        visualIntent: {
          observationGoal: 'Compare the second image.',
          representation: 'generated-image',
          resourceRefs: [
            {
              resourceId: 'lesson:media-1',
              kind: 'generated-image',
              required: true,
              reason: 'Concrete comparison',
            },
          ],
        },
      },
    ];

    const firstRun = uniquifyMediaElementIds(outlines);
    const secondRun = uniquifyMediaElementIds(outlines);
    const ids = firstRun.flatMap((outline) => outline.mediaGenerations ?? []).map((item) => item.elementId);

    expect(ids[0]).toBe('gen_img_lesson-media-1');
    expect(ids[1]).toMatch(/^gen_img_lesson-media-1-[a-z0-9]+$/);
    expect(secondRun.flatMap((outline) => outline.mediaGenerations ?? []).map((item) => item.elementId)).toEqual(ids);
    expect(firstRun[1]?.visualIntent?.resourceRefs?.[0]?.resourceId).toBe(ids[1]);
  });

  test('returns the original array when no media IDs exist', () => {
    const outlines: SceneOutline[] = [
      {
        id: 'scene',
        type: 'slide',
        title: 'Scene',
        description: 'Description',
        keyPoints: [],
        order: 1,
      },
    ];
    expect(uniquifyMediaElementIds(outlines)).toBe(outlines);
  });
});
