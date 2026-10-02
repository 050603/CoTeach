import type { Action } from '@openmaic/lib/types/action';
import type { Scene } from '@openmaic/lib/types/stage';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { createBlankSlideScene } from '@openmaic/lib/edit/slide-defaults';
import { teachingVisualEditFixture } from '@openmaic/lib/edit/teaching-visual-edit-fixture';
import type { RegenerateApplyContext, RegenerateDetails } from './apply-regenerate';
import { resolveSceneOutline } from './resolve-scene-outline';

export function regenerateSplitFixture(): { context: RegenerateApplyContext; details: RegenerateDetails; scene: Scene } {
  const scene = createBlankSlideScene('stage', '支架撤除与五环节', 1);
  scene.id = 'original';
  scene.outlineId = 'outline';
  scene.targetDurationSec = 97;
  scene.lectureSectionId = 'section';
  scene.narrationRevision = 'prior-audio-policy';
  scene.actions = [{ id: 'old-speech', type: 'speech', text: '原始完整讲稿', audioId: 'old-audio', audioUrl: '/ready.wav', audioDurationSec: 97 }];
  const outline: SceneOutline = {
    id: 'outline', title: scene.title, type: 'slide', description: '教材中的暂时性、渐消性与五个教学环节',
    keyPoints: ['逐个撤除，不能最后一次性撤销', '完整五环节与评价主体、内容'],
    order: 1, targetDurationSec: 97, estimatedDuration: 97, lectureSectionId: 'section',
  };
  const previous = createBlankSlideScene('stage', '上页', 0);
  previous.id = 'previous';
  const next = createBlankSlideScene('stage', '下页', 2);
  next.id = 'next';
  next.actions = [{ id: 'next-speech', type: 'speech', text: '下一页已完成的讲稿', audioUrl: '/next.wav' }];
  const pages: NonNullable<RegenerateDetails['visualRedesign']>['pages'] = [44, 53].map((duration, index) => {
    const content = teachingVisualEditFixture();
    const actions: Action[] = [
      { id: `speech-${index}`, type: 'speech', text: index === 0 ? '依据原资料解释渐退及撤除条件。' : '依据原资料解释完整教学过程及评价内容。' },
      { id: `laser-${index}`, type: 'laser', elementId: 'support-label', speechId: `speech-${index}` },
    ];
    return {
      outline: { ...outline, id: index === 0 ? outline.id : 'outline--continuation-2',
        title: index === 0 ? '支持逐渐撤除' : '支架教学的五环节',
        order: index + 1, targetDurationSec: duration, estimatedDuration: duration,
        segmentIndex: index + 1, segmentCount: 2, segmentGroupId: outline.id,
        segmentRole: index === 0 ? '撤除依据' : '教学环节',
      },
      content: { elements: content.canvas.elements, teachingVisual: content.canvas.teachingVisual, theme: content.canvas.theme },
      actions,
    };
  });
  return {
    scene,
    context: { scenes: [previous, scene, next], outlines: [outline], requestScene: structuredClone(scene),
      requestOutline: resolveSceneOutline(scene, [outline]), requestStoredOutline: structuredClone(outline) },
    details: { sceneId: scene.id, visualRedesign: {
      before: { content: structuredClone(scene.content), actions: structuredClone(scene.actions) }, pages,
    } },
  };
}
