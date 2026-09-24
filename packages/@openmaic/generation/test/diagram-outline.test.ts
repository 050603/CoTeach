import { expect, test } from 'vitest';
import {
  changeOutlineType,
  generateSceneOutlinesFromRequirements,
  uniquifyMediaElementIds,
  type DiagramPlan,
  type SceneOutline,
} from '@openmaic/generation';

test('ordinary outline parsing and transformations preserve a planned diagram alongside an illustration', async () => {
  const diagram: DiagramPlan = {
    topology: 'cycle',
    nodes: [
      { id: 'goal', label: '教学目标' },
      { id: 'teach', label: '新知讲解' },
      { id: 'practice', label: '强化练习' },
      { id: 'feedback', label: '学习反馈' },
    ],
    edges: [{ from: 'feedback', to: 'goal', label: '调整' }],
    annotation: '教学闭环',
  };
  const response: SceneOutline = {
    id: 'scene_1', type: 'slide', title: '教学循环', description: '观察步骤与反馈',
    keyPoints: ['步骤', '反馈'], order: 1,
    visualIntent: {
      observationGoal: 'Trace the cycle and inspect the example image.', representation: 'mixed',
      diagram,
      resourceRefs: [{ resourceId: 'gen_img_case', kind: 'generated-image', required: true, reason: 'See the concrete case.' }],
    },
    mediaGenerations: [{ type: 'image', elementId: 'gen_img_case', prompt: 'A concrete classroom example' }],
  };
  const generated = await generateSceneOutlinesFromRequirements(
    { requirement: '讲解教学循环' }, undefined, undefined,
    async () => JSON.stringify({ languageDirective: '使用中文教学。', courseTitle: '教学循环', outlines: [response] }),
  );
  expect(generated.success).toBe(true);
  if (!generated.success || !generated.data) throw new Error(generated.error ?? 'missing generated outline');
  const parsed = generated.data.outlines[0]!;
  expect(parsed.visualIntent?.diagram).toEqual(diagram);
  expect(changeOutlineType(parsed, 'quiz').visualIntent?.diagram).toEqual(diagram);
  expect(uniquifyMediaElementIds([parsed])[0]!.visualIntent?.diagram).toEqual(diagram);
});
