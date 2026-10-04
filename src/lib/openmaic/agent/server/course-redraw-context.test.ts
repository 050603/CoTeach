import { describe, expect, it } from 'vitest';
import type { Course } from '@/lib/session/types';
import type { SceneContext } from '../tools/regenerate-scene-actions';
import { courseRedrawSourceFingerprint, withCourseRedrawContext } from './course-redraw-context';

describe('server-only adopted redraw context', () => {
  it('uses the authorized current course facts without replacing current canvas, actions or page responsibilities', () => {
    const context = { outline: { id: 'page', type: 'slide', keyPoints: ['已有职责'] }, allOutlines: [],
      content: { type: 'slide', canvas: { elements: [] } }, actions: [{ id: 'speech', type: 'speech', text: '最新手改讲稿' }],
      sourceEvidence: { fingerprint: 'client-stale' }, teachingManuscripts: [{ sectionId: 'client-spoof' }], stageId: 'stage' } as unknown as SceneContext;
    const evidence = { schemaVersion: 2, version: 2, fingerprint: 'current-adopted', items: [], mappings: [], selections: [], warnings: [] };
    const course = { content: { courseEvidence: evidence,
      knowledgePoints: [{ id: 'known', evidenceItemIds: [], sourceId: 'source-known' }],
      teachingBlueprint: { sections: [{ id: 'section', contentMode: 'spoken',
        units: [{ explanationNodes: [{ id: 'node', content: '保存的权威连续讲稿' }] }], pages: [{ introducesNodeIds: ['node'] }] }] },
    } } as unknown as Course;
    const before = structuredClone(context);
    const result = withCourseRedrawContext({ page: context }, course);
    expect(result.page.sourceEvidence).toBe(evidence);
    expect(result.page.sourceKnowledgePoints).toEqual([{ id: 'known', evidenceItemIds: [], sourceId: 'source-known', sourceKnowledgePointIds: undefined, authoring: undefined }]);
    expect(result.page.teachingManuscripts).toEqual([{ sectionId: 'section', segments: [{ id: 'node', text: '保存的权威连续讲稿' }] }]);
    expect(result.page.outline).toBe(context.outline);
    expect(result.page.content).toBe(context.content);
    expect(result.page.actions).toBe(context.actions);
    expect(context).toEqual(before);
  });

  it('detects changed page ownership even when source facts and continuous narration are unchanged', () => {
    const course = { content: { knowledgePoints: [], teachingBlueprint: { sections: [{ id: 'section', contentMode: 'spoken',
      units: [{ explanationNodes: [{ id: 'a', content: '第一段讲稿' }, { id: 'b', content: '第二段讲稿' }] }],
      pages: [{ id: 'page-a', introducesNodeIds: ['a'] }, { id: 'page-b', introducesNodeIds: ['b'] }],
    }] } } } as unknown as Course;
    const changed = structuredClone(course);
    changed.content.teachingBlueprint!.sections[0].pages[0].introducesNodeIds = ['a', 'b'];
    changed.content.teachingBlueprint!.sections[0].pages[1].introducesNodeIds = [];
    expect(withCourseRedrawContext({}, changed)).toEqual({});
    expect(courseRedrawSourceFingerprint(changed)).not.toBe(courseRedrawSourceFingerprint(course));
  });
});
