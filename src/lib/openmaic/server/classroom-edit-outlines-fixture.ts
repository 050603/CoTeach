import type { Course } from '@/lib/session/types';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { Scene } from '@openmaic/lib/types/stage';
import type { PersistedClassroomData } from './classroom-storage';
import { teachingVisualEditFixture } from '@openmaic/lib/edit/teaching-visual-edit-fixture';

/** Isolated real-native pages, with source duties independent of display labels. */
export function classroomEditOutlinesFixture() {
  const stage = { id: 'classroom-1', name: 'AI 课堂', createdAt: 1, updatedAt: 1 };
  const sources = [
    { id: 'source-1', text: '支架逐个撤除，不能最后一次性撤销。' },
    { id: 'source-2', text: '评价包括自评、互评和教师评价。' },
  ];
  const outline: SceneOutline = {
    id: 'outline-1', type: 'slide', title: '支架撤除与教学评价', order: 0,
    description: '原始完整教学责任', keyPoints: sources.map((source) => source.text),
    targetDurationSec: 97, estimatedDuration: 97, lectureSectionId: 'section-1',
    knowledgePointIds: ['knowledge-1'], teachingUnitIds: ['unit-1'],
    stageKey: 'ai-learning', audience: 'student', generationPurpose: 'knowledge-teaching',
    visualSourceCatalog: sources,
    teachingBrief: {
      schemaVersion: 1, explanation: '完整教材解释与两个必要条件，不能用视觉短句替换。',
      examples: ['原教学案例'], conditions: ['能够独立解决问题时撤离'],
      evidence: [{ sourceId: 'textbook-page-19', quote: '原文：逐个撤除，并进行多主体评价。' }],
      assessmentFocus: '辨析渐退与一次性撤销',
      teachingPlan: {
        purpose: '理解支持撤除和评价', priorKnowledge: '支架式教学', newContent: '完整原始新知与必要条件。',
        learnerQuestion: '何时撤除？如何评价？', reasoningSteps: ['判断自主能力', '逐个撤除'],
        takeaway: '按能力渐退并进行多主体评价', visibleContent: sources.map((source) => source.text),
        presentationContent: sources.map((source) => source.text),
        presentationItems: sources.map((source, index) => ({ role: 'key-point', text: source.text, nodeIds: [`node-${index + 1}`] })),
        narrationFocus: ['原文条件', '既有案例'], introduces: ['node-1', 'node-2'], deepens: [], references: [],
      },
    },
  };
  const scene: Scene = {
    id: 'scene-1', outlineId: outline.id, stageId: stage.id, type: 'slide', order: 0, title: outline.title,
    content: teachingVisualEditFixture(),
    actions: [{ id: 'old-speech', type: 'speech', text: '完整原始讲稿', audioUrl: '/original.wav', audioDurationSec: 97 }],
    targetDurationSec: 97, lectureSectionId: outline.lectureSectionId,
    knowledgePointIds: outline.knowledgePointIds, teachingUnitIds: outline.teachingUnitIds,
    stageKey: outline.stageKey, audience: outline.audience, generationPurpose: outline.generationPurpose,
  };
  const next = { ...structuredClone(scene), id: 'scene-next', outlineId: 'outline-next', order: 1, title: '下页',
    actions: [{ id: 'next-speech', type: 'speech' as const, text: '下页既有讲稿', audioUrl: '/next.wav' }] } as Scene;
  const nextOutline = { ...structuredClone(outline), id: next.outlineId!, order: 1, title: next.title };
  const existing: PersistedClassroomData = {
    id: stage.id, stage, scenes: [scene, next], revision: 4, createdAt: '2026-10-02T00:00:00Z',
  };
  const course = { id: 'course-1', name: '课程', status: 'preparing', aiLearningClassroomId: stage.id,
    content: { _openmaicClassroomId: stage.id, _openmaicSceneOutlines: [outline, nextOutline] },
  } as unknown as Course;
  const outlines: SceneOutline[] = [44, 53].map((duration, index) => ({
    ...structuredClone(outline), id: index === 0 ? outline.id : `${outline.id}--continuation-2`,
    title: index === 0 ? '支架逐渐退出' : '谁来评价', order: index,
    description: `局部观察 ${index + 1}`, keyPoints: [index === 0 ? '逐个撤除' : '评价主体'],
    targetDurationSec: duration, estimatedDuration: duration,
    sourcePageIds: [outline.id], spatialParentId: outline.id,
    segmentIndex: index + 1, segmentCount: 2, segmentGroupId: outline.id, segmentRole: `局部责任 ${index + 1}`,
    visualSourceCatalog: [structuredClone(sources[index])],
    teachingBrief: { ...structuredClone(outline.teachingBrief!), teachingPlan: {
      ...structuredClone(outline.teachingBrief!.teachingPlan!),
      visibleContent: [index === 0 ? '逐个撤除' : '评价主体'], presentationContent: [index === 0 ? '逐个撤除' : '评价主体'],
      presentationItems: [{ role: 'key-point', text: index === 0 ? '逐个撤除' : '评价主体', nodeIds: [`node-${index + 1}`] }],
      introduces: [`node-${index + 1}`], narrationFocus: [`只展开局部责任 ${index + 1}`],
    } },
  }));
  const pages: Scene[] = outlines.map((page, index) => {
    const content = teachingVisualEditFixture();
    const metadata = content.canvas.teachingVisual!;
    metadata.sourceCatalog = structuredClone(sources);
    metadata.components = [metadata.components[index]];
    metadata.scene.pages[0].components = [metadata.scene.pages[0].components[index]];
    metadata.scene.pages[0].title = page.title;
    return {
      ...structuredClone(scene), id: index === 0 ? scene.id : 'scene-continuation', outlineId: page.id,
      title: page.title, order: index, content, targetDurationSec: page.targetDurationSec,
      segmentIndex: page.segmentIndex, segmentCount: page.segmentCount, segmentGroupId: page.segmentGroupId,
      segmentRole: page.segmentRole,
      actions: [{ id: `new-speech-${index}`, type: 'speech', text: `局部独立讲稿 ${index + 1}`, audioInvalidated: true }],
    } as Scene;
  });
  return { course, existing, stage, outline, scene, sources, scenes: [...pages, { ...next, order: 2 }],
    outlines: [...outlines, { ...structuredClone(nextOutline), order: 2 }] };
}
