import { describe, expect, it } from 'vitest';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import { expandCompiledSlidePages } from './compiled-slide-pages';
import { bindTeachingManuscript } from '@/lib/course-design/teaching-manuscript';
import { auditSlideDensity } from './slide-layout-audit';
import { adoptedPageAuthoringContent } from './adopted-page-content';

const outline: SceneOutline = {
  id: 'page', type: 'slide', title: '观察与解释', description: '先观察对象，再解释差异',
  keyPoints: ['观察', '解释'], order: 0, targetDurationSec: 61,
  plannedTiming: { narrationSec: 53, learnerActivitySec: 5, transitionSec: 3, role: 'teaching' },
  knowledgePointIds: ['kp'], lectureSectionId: 'section',
  mediaGenerations: [{ type: 'image', prompt: '观察差异', elementId: 'image', aspectRatio: '4:3' }],
  visualIntent: { observationGoal: '观察差异', representation: 'mixed',
    resourceRefs: [{ resourceId: 'image', kind: 'generated-image', required: true, reason: '观察' }] },
};
const content: GeneratedSlideContent = {
  elements: [{ id: 'image', type: 'image', left: 50, top: 150, width: 400, height: 300, src: 'image', fixedRatio: true, rotate: 0 }],
  sourceGroupIds: ['observation'], teachingText: ['先看外观'],
  continuationPages: [{ elements: [], sourceGroupIds: ['explanation'], teachingText: ['解释差异的原因'] }],
};

describe('first-pass semantic pagination', () => {
  it.each([undefined, []])('reads the actual native body when provenance is optional (%s)', (bindings) => {
    const source: SceneOutline = { ...outline, mediaGenerations: undefined, visualIntent: undefined,
      teachingBrief: { schemaVersion: 1, explanation: '', examples: [], conditions: [], evidence: [], assessmentFocus: '',
        manuscript: { sectionId: 'section', segmentIds: ['a', 'b'] },
        teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [],
          takeaway: '', visibleContent: [], narrationFocus: [], introduces: ['a', 'b'],
          presentationItems: [{ text: '完整第一点', role: 'key-point', nodeIds: ['a'] },
            { text: '完整第二点', role: 'key-point', nodeIds: ['b'] }] } } };
    const native = (id: string, value: string): GeneratedSlideContent => ({ contentBindings: bindings,
      elements: [{ type: 'text', id, left: 60, top: 160, width: 880, height: 100, rotate: 0,
        content: `<p>${value}</p>`, defaultFontName: 'Noto Sans SC', defaultColor: '#334155' }] });
    const manuscripts = [{ sectionId: 'section', segments: [{ id: 'a', text: '完整第一段讲稿。' }, { id: 'b', text: '完整第二段讲稿。' }] }];
    const pages = expandCompiledSlidePages(source, { ...native('first', '完整第一点'),
      continuationPages: [native('second', '完整第二点')] }, manuscripts);
    expect(pages.map((page) => page.outline.keyPoints)).toEqual([['完整第一点'], ['完整第二点']]);
    expect(pages.map((page) => page.outline.teachingBrief?.manuscript?.segmentIds)).toEqual([['a'], ['b']]);
    expect(pages.flatMap(({ outline }) => bindTeachingManuscript(outline, manuscripts).segments.map((segment) => segment.text)))
      .toEqual(manuscripts[0]!.segments.map((segment) => segment.text));
  });

  it('keeps native source and semantic identities when older outlines provide presentationContent without item metadata', () => {
    const source: SceneOutline = { ...outline, audience: 'student', generationPurpose: 'knowledge-teaching',
      teachingBrief: { schemaVersion: 1, explanation: '解释背景', examples: [], conditions: [], evidence: [], assessmentFocus: '',
        teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [],
          takeaway: '', visibleContent: [], narrationFocus: [], presentationContent: ['完整第一点', '完整第二点'] } } };
    const page = (id: string, value: string, sourceId: string, semanticId: string): GeneratedSlideContent => ({
      elements: [{ type: 'text', id, left: 50, top: 140, width: 850, height: 100, rotate: 0,
        content: `<p>${value}</p>`, defaultFontName: 'Noto Sans SC', defaultColor: '#334155' }],
      displayItems: [{ id: `display-${id}`, text: value, sourceContentIds: [sourceId] }],
      contentBindings: [{ sourceContentId: `display-${id}`, elementId: id },
        { sourceContentId: sourceId, elementId: id }, { sourceContentId: semanticId, elementId: id }],
    });
    const pages = expandCompiledSlidePages(source, { ...page('a', '第一点', 'adopted-content-1', 'page:visible-1'),
      continuationPages: [page('b', '第二点', 'adopted-content-2', 'page:visible-2')] });
    expect(pages[1]!.outline.teachingBrief?.teachingPlan?.presentationContent).toEqual(['完整第二点']);
    expect(pages[1]!.outline.keyPoints).toEqual(['第二点']);
    expect(pages[1]!.content.contentBindings!.map((binding) => binding.sourceContentId))
      .toEqual(['display-b', 'adopted-content-1', 'page--continuation-2:visible-1']);
    expect(pages[1]!.content.displayItems![0]!.sourceContentIds).toEqual(['adopted-content-1']);
  });

  it('rebases native merged display references and table targets while preserving exact manuscript and all timing', () => {
    const source: SceneOutline = { ...outline, audience: 'student', generationPurpose: 'knowledge-teaching',
      mediaGenerations: undefined, visualIntent: undefined,
      teachingBrief: { schemaVersion: 1, explanation: '', examples: [], conditions: [], evidence: [], assessmentFocus: '',
        manuscript: { sectionId: 'section', segmentIds: ['a', 'b'] },
        teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [],
          takeaway: '', visibleContent: [], narrationFocus: [], introduces: ['a', 'b'],
          presentationItems: [
            { text: '随着学生能力逐步提升，教师逐步撤除支架。', role: 'key-point', nodeIds: ['a'] },
            { text: '支架是否保留，取决于学生能否独立完成任务。', role: 'key-point', nodeIds: ['b'] },
            { text: '不能仅根据教学进度决定支架是否保留。', role: 'key-point', nodeIds: ['b'] },
          ] },
      } };
    const first: GeneratedSlideContent = { elements: [{ type: 'text', id: 'native-a',
      left: 50, top: 140, width: 850, height: 100, rotate: 0, content: '<p>能力提升时，逐步减少支架。</p>',
      defaultFontName: 'Noto Sans SC', defaultColor: '#334155' }],
      teachingText: ['能力提升时，逐步减少支架。'], displayItems: [{ id: 'display-a', text: '能力提升时，逐步减少支架。',
        sourceContentIds: ['adopted-content-1'] }], contentBindings: [
        { sourceContentId: 'display-a', elementId: 'native-a' },
        { sourceContentId: 'adopted-content-1', elementId: 'native-a' },
        { sourceContentId: 'page:visible-1', elementId: 'native-a' },
      ] };
    const continuation: GeneratedSlideContent = { elements: [{ type: 'table', id: 'native-table',
      left: 50, top: 140, width: 850, height: 120, rotate: 0, cellMinHeight: 50, colWidths: [1],
      outline: { width: 1, color: '#ddd', style: 'solid' }, data: [[{ id: 'decision', rowspan: 1, colspan: 1,
        text: '按独立完成能力判断，不能仅看教学进度。' }]] }],
      teachingText: ['按独立完成能力判断，不能仅看教学进度。'], displayItems: [{ id: 'display-b',
        text: '按独立完成能力判断，不能仅看教学进度。', sourceContentIds: ['adopted-content-2', 'adopted-content-3'] }],
      contentBindings: ['display-b', 'adopted-content-2', 'adopted-content-3', 'page:visible-2', 'page:visible-3']
        .map((sourceContentId) => ({ sourceContentId, elementId: 'native-table', selector: { cellId: 'decision' } })),
    };
    const manuscripts = [{ sectionId: 'section', segments: [
      { id: 'a', text: '第一段已确认讲稿：逐步撤除的解释和案例均完整保留。' },
      { id: 'b', text: '第二段已确认讲稿：独立完成能力和教学进度的区别均完整保留。' },
    ] }];
    const saved = structuredClone({ source, first, continuation, manuscripts });
    const pages = expandCompiledSlidePages(source, { ...first, continuationPages: [continuation] }, manuscripts);
    expect(pages.map(({ outline }) => outline.teachingBrief?.manuscript?.segmentIds)).toEqual([['a'], ['b']]);
    expect(pages.flatMap(({ outline }) => bindTeachingManuscript(outline, manuscripts).segments.map((segment) => segment.text)))
      .toEqual(manuscripts[0]!.segments.map((segment) => segment.text));
    expect(pages[1]!.content.displayItems![0]!.sourceContentIds).toEqual(['adopted-content-1', 'adopted-content-2']);
    expect(pages[1]!.content.contentBindings!.map((binding) => binding.sourceContentId))
      .toEqual(['display-b', 'adopted-content-1', 'adopted-content-2', 'page--continuation-2:visible-1', 'page--continuation-2:visible-2']);
    expect(pages[1]!.content.contentBindings!.every((binding) => binding.selector
      && 'cellId' in binding.selector && binding.selector.cellId === 'decision')).toBe(true);
    expect(pages[1]!.outline.keyPoints).toEqual(['按独立完成能力判断，不能仅看教学进度。']);
    expect(pages.reduce((sum, { outline }) => sum + outline.targetDurationSec!, 0)).toBe(61);
    for (const key of ['narrationSec', 'learnerActivitySec', 'transitionSec'] as const) {
      expect(pages.reduce((sum, { outline: page }) => sum + page.plannedTiming![key], 0)).toBe(source.plannedTiming![key]);
    }
    expect({ source, first, continuation, manuscripts }).toEqual(saved);
  });

  it('does not move manuscript ownership for source aliases or display items without actual rendered targets', () => {
    const source: SceneOutline = { ...outline, audience: 'student', generationPurpose: 'knowledge-teaching',
      teachingBrief: { schemaVersion: 1, explanation: '', examples: [], conditions: [], evidence: [], assessmentFocus: '',
        manuscript: { sectionId: 'section', segmentIds: ['a', 'b'] },
        teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [],
          takeaway: '', visibleContent: [], narrationFocus: [], introduces: ['a', 'b'], presentationItems: [
            { text: '实际第一点', role: 'key-point', nodeIds: ['a'] }, { text: '实际第二点', role: 'key-point', nodeIds: ['b'] },
          ] } } };
    const text = (id: string, value: string): GeneratedSlideContent['elements'][number] => ({ type: 'text', id,
      left: 50, top: 140, width: 850, height: 100, rotate: 0, content: `<p>${value}</p>`,
      defaultFontName: 'Noto Sans SC', defaultColor: '#334155' });
    const split: GeneratedSlideContent = { elements: [text('a', '第一点')],
      contentBindings: [{ sourceContentId: 'adopted-content-1', elementId: 'a' },
        { sourceContentId: 'display-a', elementId: 'a' }],
      displayItems: [{ id: 'display-a', text: '第一点', sourceContentIds: ['adopted-content-1'] }],
      continuationPages: [{ elements: [text('note', '视觉补充')], teachingText: ['实际第二点'],
        displayItems: [{ id: 'not-rendered', text: '实际第二点', sourceContentIds: ['adopted-content-2'] }],
        contentBindings: [{ sourceContentId: 'adopted-content-2', elementId: 'missing' },
          { sourceContentId: 'adopted-content-2', elementId: 'note' },
          { sourceContentId: 'note', elementId: 'note' }] }] };
    const manuscripts = [{ sectionId: 'section', segments: [{ id: 'a', text: '完整第一段。' }, { id: 'b', text: '完整第二段。' }] }];
    const pages = expandCompiledSlidePages(source, split, manuscripts);
    expect(pages.map(({ outline }) => outline.teachingBrief?.manuscript?.segmentIds)).toEqual([['a', 'b'], []]);
    expect(pages[1]!.outline.teachingBrief?.teachingPlan?.presentationItems).toEqual([]);
    expect(pages[1]!.outline.keyPoints).toEqual(['视觉补充']);
    expect(pages[1]!.content.displayItems).toEqual([]);
  });

  it.each([false, true])('rebases concise continuation source mappings without moving speech (merged sources: %s)', (merged) => {
    const source: SceneOutline = { ...outline, audience: 'student', generationPurpose: 'knowledge-teaching',
      mediaGenerations: undefined, visualIntent: undefined,
      teachingBrief: { schemaVersion: 1, explanation: '', examples: [], conditions: [], evidence: [], assessmentFocus: '',
        manuscript: { sectionId: 'section', segmentIds: ['a', 'b'] },
        teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [],
          takeaway: '', visibleContent: [], narrationFocus: [], introduces: ['a', 'b'],
          presentationItems: [
            { text: '当学生能力逐步提升时，教师应逐步撤除支架，不能等到最后才一次性撤销。', role: 'key-point', nodeIds: ['a'] },
            { text: '是否保留支架需要根据学生能否独立完成任务作出判断。', role: 'key-point', nodeIds: ['b'] },
            ...(merged ? [{ text: '不能仅根据教学进度决定支架是否保留。', role: 'key-point' as const, nodeIds: ['b'] }] : []),
          ] },
      } };
    const sources = adoptedPageAuthoringContent(source);
    const projectedPage = (id: string, value: string, sourceIds: string[]): GeneratedSlideContent => ({
      elements: [{ type: 'text', id, left: 50, top: 160, width: 850, height: 120, rotate: 0,
        content: `<p style="font-size:24px;color:#334155">${value}</p>`, defaultFontName: 'Noto Sans SC', defaultColor: '#334155' }],
      teachingText: [value], sourceGroupIds: sourceIds,
      presentationProjection: { schemaVersion: 1, layoutVersion: 'teaching-infographic-v2', verified: true,
        items: [{ id, text: value, sourceContentIds: sourceIds }],
        elementIdsBySource: Object.fromEntries(sourceIds.map((sourceId) => [sourceId, [id]])) },
    });
    const split = { ...projectedPage('concise-a', '能力提升时逐步减支架，不能最后一次撤销。', [sources[0]!.id]),
      continuationPages: [projectedPage('concise-b', merged ? '按独立完成能力判断，不能仅看进度。' : '按独立完成能力判断。',
        sources.slice(1).map((item) => item.id))] };
    const manuscripts = [{ sectionId: 'section', segments: [
      { id: 'a', text: '完整第一段：结合学习者的进步逐步解释撤除的节奏。' },
      { id: 'b', text: '完整第二段：通过实际任务表现说明独立完成的判断依据。' },
    ] }];
    const savedSource = structuredClone(source), savedContent = structuredClone(split);
    const pages = expandCompiledSlidePages(source, split, manuscripts);
    expect(pages.map(({ outline }) => outline.teachingBrief?.manuscript?.segmentIds)).toEqual([['a'], ['b']]);
    expect(pages.flatMap(({ outline }) => bindTeachingManuscript(outline, manuscripts).segments.map((segment) => segment.text)))
      .toEqual(manuscripts[0]!.segments.map((segment) => segment.text));
    for (const { outline: local, content: page } of pages) {
      const localIds = adoptedPageAuthoringContent(local).map((item) => item.id);
      expect(page.presentationProjection!.items[0]!.sourceContentIds).toEqual(localIds);
      for (const id of localIds) expect(page.presentationProjection!.elementIdsBySource[id]).toEqual([page.elements[0]!.id]);
      const density = auditSlideDensity(local, page);
      expect(density.underrepresentedKeyPoints).toEqual([]);
      expect(density.issues).not.toContainEqual(expect.stringContaining('关键教学点可见覆盖率'));
    }
    expect(pages[1]!.content.presentationProjection!.items[0]!.sourceContentIds)
      .toEqual(merged ? ['adopted-content-1', 'adopted-content-2'] : ['adopted-content-1']);
    expect(source).toEqual(savedSource);
    expect(split).toEqual(savedContent);
  });

  it('moves complete canonical speech once with exact display bindings and leaves a visual continuation silent', () => {
    const source: SceneOutline = { ...outline, teachingBrief: { schemaVersion: 1,
      manuscript: { sectionId: 'section', segmentIds: ['first', 'oral', 'second'] },
      explanation: '旧正文副本不能进入拆页', examples: [], conditions: [], evidence: [], assessmentFocus: '',
      teachingPlan: { purpose: '', priorKnowledge: '', newContent: '旧的重写任务', learnerQuestion: '',
        reasoningSteps: [], takeaway: '', visibleContent: [], narrationFocus: ['不能补写的提示'],
        introduces: ['first', 'oral', 'second'], deepens: [], references: [],
        presentationItems: [
          { text: '先看外观', role: 'key-point', nodeIds: ['first'] },
          { text: '解释差异的原因', role: 'key-point', nodeIds: ['second'] },
        ] },
    } };
    const manuscripts = [{ sectionId: 'section', segments: [
      { id: 'first', text: '这是已经确认的第一段，限定词不变。' },
      { id: 'oral', text: '这段只讲不显示，不能按屏显相似度搬动。' },
      { id: 'second', text: '然后说明第二个关系。' },
    ] }];
    const split = { ...content, continuationPages: [...content.continuationPages!,
      { elements: content.elements, teachingText: [] }] };
    const pages = expandCompiledSlidePages(source, split, manuscripts);
    expect(pages.map(({ outline }) => outline.teachingBrief?.manuscript?.segmentIds))
      .toEqual([['first', 'oral'], ['second'], []]);
    expect(pages.flatMap(({ outline }) => bindTeachingManuscript(outline, manuscripts).segments.map((segment) => segment.text)))
      .toEqual(manuscripts[0]!.segments.map((segment) => segment.text));
    for (const { outline } of pages) {
      expect(outline.teachingBrief?.explanation).toBe('');
      expect(outline.teachingBrief?.teachingPlan?.newContent).toBe('');
      expect(outline.teachingBrief?.teachingPlan?.narrationFocus).toEqual([]);
    }
    expect(pages.reduce((sum, { outline }) => sum + outline.targetDurationSec!, 0)).toBe(61);
    expect(source.teachingBrief?.manuscript?.segmentIds).toEqual(['first', 'oral', 'second']);
    expect(() => expandCompiledSlidePages(source, split, [])).toThrow('不属于已保存的小节正文');
  });

  it('keeps speech on the complete diagram page before its silent text notes', () => {
    const source: SceneOutline = { ...outline,
      visualIntent: { ...outline.visualIntent!, diagram: { topology: 'sequence', nodes: [
        { id: 'start', label: '起点' }, { id: 'end', label: '终点' },
      ] } },
      teachingBrief: { schemaVersion: 1, explanation: '', examples: [], conditions: [], evidence: [], assessmentFocus: '',
        manuscript: { sectionId: 'section', segmentIds: ['explain'] },
        teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [],
          takeaway: '', visibleContent: [], narrationFocus: [], introduces: ['explain'], deepens: [], references: [],
          presentationItems: [{ text: '解释差异的原因', role: 'key-point', nodeIds: ['explain'] }] } },
    };
    const split = { ...content, sourceGroupIds: ['diagram-node:start', 'diagram-node:end'], teachingText: ['起点', '终点'] };
    const manuscripts = [{ sectionId: 'section', segments: [{ id: 'explain', text: '请看完整关系，从起点解释到终点。' }] }];
    const pages = expandCompiledSlidePages(source, split, manuscripts);
    expect(pages.map(({ outline }) => outline.teachingBrief?.manuscript?.segmentIds)).toEqual([['explain'], []]);
    expect(pages[0]!.content.teachingText).toEqual(['起点', '终点']);
    expect(pages.flatMap(({ outline }) => bindTeachingManuscript(outline, manuscripts).segments.map((segment) => segment.text)))
      .toEqual(['请看完整关系，从起点解释到终点。']);
  });

  it('never treats a repeated visual reference as another speech duty or reverses canonical speech', () => {
    const source: SceneOutline = { ...outline, teachingBrief: { schemaVersion: 1,
      manuscript: { sectionId: 'section', segmentIds: ['a', 'b'] },
      explanation: '', examples: [], conditions: [], evidence: [], assessmentFocus: '',
      teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '',
        reasoningSteps: [], takeaway: '', visibleContent: [], narrationFocus: [], introduces: ['a', 'b'],
        presentationItems: [{ text: '先看外观', role: 'key-point', nodeIds: ['b'] },
          { text: '解释差异的原因', role: 'key-point', nodeIds: ['a', 'b'] }] },
    } };
    const pages = expandCompiledSlidePages(source, content);
    expect(pages.map(({ outline }) => outline.teachingBrief?.manuscript?.segmentIds)).toEqual([[], ['a', 'b']]);
    expect(pages.flatMap(({ outline }) => outline.teachingBrief?.teachingPlan?.deepens ?? [])).toEqual([]);
  });

  it('keeps all content and stable targets while conserving the adopted timing', () => {
    const result = expandCompiledSlidePages(outline, content);
    expect(result.map((page) => page.outline.id)).toEqual(['page', 'page--continuation-2']);
    expect(result.map((page) => page.outline.keyPoints)).toEqual([['先看外观'], ['解释差异的原因']]);
    expect(result.every((page) => page.outline.lectureSectionId === 'section')).toBe(true);
    expect(result.reduce((sum, page) => sum + page.outline.targetDurationSec!, 0)).toBe(61);
    for (const part of ['narrationSec', 'learnerActivitySec', 'transitionSec'] as const) {
      expect(result.reduce((sum, page) => sum + page.outline.plannedTiming![part], 0)).toBe(outline.plannedTiming![part]);
    }
    expect(result[0].content.elements[0].id).toBe('image');
    expect(result[0].content.continuationPages).toBeUndefined();
    expect(result[0].outline.mediaGenerations).toHaveLength(1);
    expect(result[1].outline.mediaGenerations).toHaveLength(0);
    expect(result[1].outline.visualIntent?.resourceRefs).toHaveLength(0);
    expect(content.continuationPages).toHaveLength(1);
  });

  it('leaves unexpanded pages unchanged and does not invent timing for impossible splits', () => {
    const ordinary = { elements: [] };
    expect(expandCompiledSlidePages(outline, ordinary)).toEqual([{ outline, content: ordinary }]);
    expect(() => expandCompiledSlidePages({ ...outline, targetDurationSec: 1 }, content)).toThrow('教学时间不足');
  });

  it('keeps a required textbook original only with the split page that renders it', () => {
    const source = { ...outline,
      visualIntent: { observationGoal: '观察教材图', representation: 'source-image' as const,
        resourceRefs: [{ resourceId: 'textbook_fig_32', kind: 'source-image' as const,
          required: true, reason: '教材原图' }] },
      teachingBrief: { schemaVersion: 1 as const, explanation: '解释', examples: [], conditions: [], evidence: [],
        assessmentFocus: '理解', resourceNeeds: [{ kind: 'source-image' as const,
          assetId: 'textbook_fig_32', required: true, purpose: '教材原图' }] },
    };
    const split: GeneratedSlideContent = { ...content, elements: [],
      continuationPages: [{ ...content.continuationPages![0]!, elements: [{
        id: 'source-image', type: 'image', left: 50, top: 150, width: 400, height: 300,
        src: 'textbook_fig_32', fixedRatio: true, rotate: 0,
      }] }] };
    const result = expandCompiledSlidePages(source, split);
    expect(result[0]?.outline.visualIntent?.resourceRefs).toEqual([]);
    expect(result[0]?.outline.teachingBrief?.resourceNeeds).toEqual([]);
    expect(result[1]?.outline.visualIntent?.resourceRefs?.[0]?.resourceId).toBe('textbook_fig_32');
    expect(result[1]?.outline.teachingBrief?.resourceNeeds?.[0]?.assetId).toBe('textbook_fig_32');
  });

  it('allocates adopted time by measured teaching load when the compiler provides it', () => {
    const weighted: GeneratedSlideContent = {
      ...content,
      layoutMeasurement: { bodyCapacity: 400, occupiedHeight: 300, contentLoad: 0.75,
        pageIndex: 1, pageCount: 2, sourceGroupIds: ['observation'] },
      continuationPages: [{ ...content.continuationPages![0]!,
        layoutMeasurement: { bodyCapacity: 400, occupiedHeight: 100, contentLoad: 0.25,
          pageIndex: 2, pageCount: 2, sourceGroupIds: ['explanation'] } }],
    };
    const pages = expandCompiledSlidePages(outline, weighted);
    expect(pages.map((page) => page.outline.plannedTiming?.narrationSec)).toEqual([40, 13]);
    expect(pages.reduce((sum, page) => sum + page.outline.targetDurationSec!, 0)).toBe(61);
    expect(pages[0]?.outline.teachingBrief?.teachingPlan?.introduces).toBeUndefined();
  });
});
