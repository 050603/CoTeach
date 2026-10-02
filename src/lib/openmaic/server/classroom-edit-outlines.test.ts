// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { prepareClassroomEditOutlines } from './classroom-edit-outlines';
import { classroomEditOutlinesFixture } from './classroom-edit-outlines-fixture';
import { canonicalClassroomOutlines } from '@/lib/openmaic-bridge/classroom-editor-outlines';
import { InvalidClassroomEditError } from './classroom-edit';

describe('canonical classroom editing responsibilities', () => {
  it('persists native split duties and original source prose, leaving the next page and audio intact', () => {
    const input = classroomEditOutlinesFixture();
    const saved = prepareClassroomEditOutlines(input);
    expect(saved.slice(0, 2).map((outline) => outline.targetDurationSec)).toEqual([44, 53]);
    expect(saved[1]).toMatchObject({ spatialParentId: 'outline-1', sourcePageIds: ['outline-1'],
      segmentIndex: 2, segmentCount: 2, lectureSectionId: 'section-1', knowledgePointIds: ['knowledge-1'],
      visualSourceCatalog: [input.sources[1]], description: '局部观察 2',
      teachingBrief: { explanation: input.outline.teachingBrief!.explanation,
        evidence: input.outline.teachingBrief!.evidence,
        teachingPlan: { newContent: input.outline.teachingBrief!.teachingPlan!.newContent,
          introduces: ['node-2'], visibleContent: ['评价主体'] } } });
    expect(saved[2]).toEqual({ ...input.course.content._openmaicSceneOutlines![1], order: 2 });
    expect(input.scenes[2].actions).toEqual(input.existing.scenes[1].actions);
  });

  it('reloads both stable local duties without attaching a page by its reordered position', () => {
    const input = classroomEditOutlinesFixture();
    const saved = prepareClassroomEditOutlines(input);
    const reloaded = canonicalClassroomOutlines(saved, [input.scenes[2], input.scenes[1], input.scenes[0]]);
    expect(reloaded.map((outline) => outline.id)).toEqual(['outline-next', 'outline-1--continuation-2', 'outline-1']);
    expect(reloaded[1].visualSourceCatalog).toEqual([input.sources[1]]);
    expect(reloaded[1].teachingBrief!.explanation).toBe(input.outline.teachingBrief!.explanation);
  });

  it.each(['stage', 'identity', 'knowledge', 'section', 'source-text', 'source-id', 'original-prose', 'duration', 'order', 'missing-duty', 'malformed-catalog', 'malformed-plan'])(
    'rejects %s tampering before accepting canonical teaching changes', (kind) => {
      const input = classroomEditOutlinesFixture();
      if (kind === 'stage') input.scenes[1].stageId = 'other-classroom';
      if (kind === 'identity') input.scenes[0].outlineId = 'other-outline';
      if (kind === 'knowledge') input.outlines[1].knowledgePointIds = ['foreign-point'];
      if (kind === 'section') input.outlines[1].lectureSectionId = 'foreign-section';
      if (kind === 'source-text') input.outlines[1].visualSourceCatalog![0].text = '客户端伪造教材';
      if (kind === 'source-id') input.outlines[1].sourcePageIds = ['unadopted-textbook'];
      if (kind === 'original-prose') input.outlines[1].teachingBrief!.explanation = '把短标签作为教材定义';
      if (kind === 'duration') { input.scenes[1].targetDurationSec = 55; input.outlines[1].targetDurationSec = 55; }
      if (kind === 'order') [input.scenes[1], input.scenes[2]] = [input.scenes[2], input.scenes[1]];
      if (kind === 'missing-duty') input.outlines.splice(1, 1);
      if (kind === 'malformed-catalog') Object.assign(input.outlines[1], { visualSourceCatalog: 'not-a-catalog' });
      if (kind === 'malformed-plan') Object.assign(input.outlines[1].teachingBrief!.teachingPlan!, { introduces: 'not-an-array' });
      expect(() => prepareClassroomEditOutlines(input)).toThrow(InvalidClassroomEditError);
    },
  );

  it('refuses changing a different page’s original explanation through a whole-store save', () => {
    const input = classroomEditOutlinesFixture();
    input.outlines[2].teachingBrief!.teachingPlan!.newContent = '与下页无关的新教材';
    expect(() => prepareClassroomEditOutlines(input)).toThrow(InvalidClassroomEditError);
  });

  it('keeps inactive canonical source records out of editor hydration and preserves them on save', () => {
    const input = classroomEditOutlinesFixture();
    const privateSource = { ...input.outline, id: 'private-source', title: '没有运行页面的来源大纲' };
    input.course.content._openmaicSceneOutlines!.push(privateSource);
    const saved = prepareClassroomEditOutlines(input);
    expect(saved.at(-1)).toEqual(privateSource);
    expect(canonicalClassroomOutlines(saved, input.scenes).some((outline) => outline.id === privateSource.id)).toBe(false);
  });

  it('preserves unrelated canonical fingerprints even when old outlines omit optional timing fields', () => {
    const input = classroomEditOutlinesFixture();
    const untouched = input.course.content._openmaicSceneOutlines![1];
    delete untouched.estimatedDuration;
    delete untouched.targetDurationSec;
    input.outlines[2] = { ...input.outlines[2], estimatedDuration: undefined, targetDurationSec: undefined };
    const saved = prepareClassroomEditOutlines(input);
    expect(saved[2]).toEqual({ ...untouched, order: 2 });
  });

  it('can save a guarded local undo and redo after split duties have been persisted', () => {
    const input = classroomEditOutlinesFixture();
    if (input.scene.content.type !== 'slide') throw new Error('Expected slide');
    delete input.scene.content.canvas.teachingVisual;
    input.existing.scenes[0] = input.scene;
    const split = prepareClassroomEditOutlines(input);
    const afterSplit = { ...input, course: { ...input.course, content: { ...input.course.content, _openmaicSceneOutlines: split } },
      existing: { ...input.existing, scenes: input.scenes }, scenes: input.existing.scenes,
      outlines: input.course.content._openmaicSceneOutlines! };
    const undone = prepareClassroomEditOutlines(afterSplit);
    expect(undone[0].targetDurationSec).toBe(97);
    expect(undone[0].visualSourceCatalog).toEqual(input.sources);
    const redone = prepareClassroomEditOutlines({ ...input,
      course: { ...input.course, content: { ...input.course.content, _openmaicSceneOutlines: undone } } });
    expect(redone[1].visualSourceCatalog).toEqual([input.sources[1]]);
  });

  it('saves legacy pages without canonical sources without manufacturing teaching evidence', () => {
    const input = classroomEditOutlinesFixture();
    const saved = prepareClassroomEditOutlines({ ...input, course: { ...input.course,
      content: { ...input.course.content, _openmaicSceneOutlines: undefined } },
      scenes: input.existing.scenes, outlines: [] });
    expect(saved).toHaveLength(2);
    expect(saved[0].title).toBe(input.scene.title);
    expect(saved[0].teachingBrief).toBeUndefined();
    expect(saved[0].sourcePageIds).toBeUndefined();
  });
});
