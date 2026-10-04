import { describe, expect, it, vi } from 'vitest';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import type { CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';
import { bindRestoredSlideSources, restoredSlideDisplayDiagnostics } from './restored-slide-authoring';
import { generateOpenMaicBaselineContent } from './openmaic-baseline';

const text = (value: string): GeneratedSlideContent => ({ elements: [{ type: 'text', id: 'body',
  left: 80, top: 140, width: 840, height: 100, rotate: 0, content: `<p>${value}</p>`,
  defaultFontName: 'Noto Sans SC', defaultColor: '#334155' }] });

describe('restored native display compatibility', () => {
  it('carries the joint planner page and independently adopted originals into the actual native authoring call', async () => {
    const original = '重复测量3次后计算平均值，可以减小随机误差。';
    const sourceEvidence: CourseEvidenceSnapshot = {
      schemaVersion: 2, version: 1, fingerprint: 'original-measurement', createdAt: '2026-10-03',
      retrievalMode: 'hybrid', selections: [{ revisionId: 'book-v1', primary: true, sectionIds: [] }],
      mappings: [], warnings: [], items: [{ id: 'measurement-original', kind: 'concept', title: '重复测量',
        content: '检索摘要不能替代原文', source: { textbookId: 'book', textbookTitle: '测量教材',
          revisionId: 'book-v1', revisionVersion: 1, sectionPath: ['测量'], sourceBlockId: 'original', quote: original },
        completeSourceBlocks: [{ sourceBlockId: 'original', content: original }] }],
    };
    const outline = {
      id: 'measurement-page', type: 'slide', title: '重复测量', order: 0,
      description: '先观察同一物体测量值的差异，再建立重复测量与平均值的关系。',
      keyPoints: ['完成3次测量后计算平均值'], teachingObjective: '理解重复测量的作用',
      audience: 'student', generationPurpose: 'knowledge-teaching', knowledgePointIds: ['measurement'],
      visualIntent: { representation: 'text', observationGoal: '比较重复测量与单次测量' },
      teachingBrief: { schemaVersion: 1, pptPlanningVersion: 'joint-native-pages-4615-v1',
        explanation: '口播中详细解释波动原因，不新增展示义务', examples: [], conditions: [], evidence: [], assessmentFocus: '',
        manuscript: { sectionId: 'section', segmentIds: ['speech-only'] },
        sharedContext: { caseId: '', learningPurpose: '理解测量结果的可靠性', stableTerms: ['平均值'], caseFacts: [], fixedWording: [], conceptBoundaries: [] },
        teachingPlan: { purpose: '理解重复测量', priorKnowledge: '', newContent: '', learnerQuestion: '',
          reasoningSteps: [], takeaway: '', narrationFocus: [], entryPoint: { kind: 'concrete-observation', object: '同一物体的几次测量结果', bridge: '观察差异引出平均值' },
          taskConnection: { mode: 'none', rationale: '独立解释更清楚' },
          // Stale compatibility fields deliberately disagree with the new page.
          presentationItems: [{ text: '旧投影不能决定本页', nodeIds: ['speech-only'], role: 'key-point' }],
          presentationContent: ['旧展示副本不能决定本页'], visibleContent: ['完整口播不能变为显示清单'],
          visualRelationship: { kind: 'comparison', description: '重复测量与单次测量的关系', preferredForm: 'text', readingOrder: [] },
        },
      },
    } as SceneOutline;
    const before = structuredClone(outline);
    const call = vi.fn(async (_system: string, _prompt: string) => JSON.stringify({
      elements: text('完成3次测量后计算平均值').elements, components: [],
    }));
    const generated = await generateOpenMaicBaselineContent(outline, call, {
      componentAuthoring: true,
      textMeasure: async (input) => ({ width: input.width, height: 48, lines: [input.text], naturalWidth: input.width }),
      sourceEvidence, sourceKnowledgePoints: [{ id: 'measurement', evidenceItemIds: ['measurement-original'] }],
      websiteReferenceContext: { courseTitle: '测量方法', slideTitles: ['重复测量', '测量误差'] },
    }) as GeneratedSlideContent;
    expect(call).toHaveBeenCalledTimes(1);
    const [system, prompt] = call.mock.calls[0]!;
    const context = JSON.parse(prompt.split('## Current adopted teaching sources and page responsibilities\n')[1]!
      .split('\nSource passages and course metadata')[0]!);
    expect(context.pageContract).toMatchObject({ title: outline.title, description: outline.description,
      keyPoints: outline.keyPoints, teachingObjective: outline.teachingObjective,
      sharedContext: outline.teachingBrief!.sharedContext,
      taskConnection: { mode: 'none', rationale: '独立解释更清楚' } });
    expect(context.entryPoint).toEqual(outline.teachingBrief!.teachingPlan!.entryPoint);
    expect(context.visualRelationship).toEqual(outline.teachingBrief!.teachingPlan!.visualRelationship);
    expect(context.displayResponsibilities).toEqual([{ id: 'adopted-content-1', text: outline.keyPoints[0], required: true }]);
    expect(context.originalTeachingSources.originalSources[0].passages[0].text).toBe(original);
    expect(context.courseDeckContext.slideTitles).toEqual(['重复测量', '测量误差']);
    for (const excluded of ['旧投影不能决定本页', '旧展示副本不能决定本页', '完整口播不能变为显示清单',
      '口播中详细解释波动原因', '检索摘要不能替代原文', 'speech-only']) expect(prompt).not.toContain(excluded);
    expect(system).toContain('Do not infer new display duties or change page boundaries from narration');
    expect(system).toContain('Native diagram components are local helpers');
    expect(system).not.toContain('exact immutable presentation-point catalog');
    expect(generated.elements.some((element) => element.type === 'text' && element.content.includes('3次测量'))).toBe(true);
    expect(generated.contentBindings).toContainEqual({ sourceContentId: 'adopted-content-1', elementId: 'body' });
    expect(generated.presentationProjection).toBeUndefined();
    expect(generated.qualityDiagnostics ?? []).not.toContainEqual(expect.stringContaining('omits 3次'));
    expect(outline).toEqual(before);
  });

  it('binds optional table-cell provenance without changing native text, geometry or styling', () => {
    const content: GeneratedSlideContent = { elements: [{ type: 'table', id: 'table',
      left: 90, top: 160, width: 800, height: 200, rotate: 0, cellMinHeight: 40, colWidths: [1],
      outline: { width: 1, color: '#ddd', style: 'solid' },
      data: [[{ id: 'contrast', rowspan: 1, colspan: 1, text: '根据独立完成能力撤除支架' }]] }] };
    const before = structuredClone(content);
    const raw = JSON.stringify({ elements: [{ id: 'table', data: [[{
      sourceContentIds: ['source-a', 'unknown'], text: '根据独立完成能力撤除支架',
    }]] }] });
    const result = bindRestoredSlideSources(raw, content, [{ id: 'source-a',
      text: '学生能独立完成时撤除支架', required: true }, { id: 'empty-source', text: '', required: false }]);
    expect(result.elements).toEqual(before.elements);
    expect(content).toEqual(before);
    expect(result.contentBindings).toEqual([{ sourceContentId: 'source-a', elementId: 'table', selector: { cellId: 'contrast' } }]);
    expect(result.qualityDiagnostics).toEqual(['Restored native provenance references an unknown display source: unknown']);
  });

  it('uses actual quantities rather than a substring of another number or hidden wording', () => {
    const sources = [{ id: 'practice', text: '完成3次练习', required: true }];
    expect(restoredSlideDisplayDiagnostics(text('完成13次练习'), sources)).toContain(
      'Restored native display quantity: practice omits 3次 from the actual canvas');
    expect(restoredSlideDisplayDiagnostics(text('完成3次练习'), sources)).toEqual([]);
    const hidden: GeneratedSlideContent = { elements: [{ ...text('完成3次练习').elements[0]!, opacity: 0 } as GeneratedSlideContent['elements'][number]] };
    expect(restoredSlideDisplayDiagnostics(hidden, sources)).toContain(
      'Restored native display quantity: practice omits 3次 from the actual canvas');
  });

  it('does not invent metadata or display obligations from empty source text', () => {
    const content = text('可读的原生首稿');
    const result = bindRestoredSlideSources(JSON.stringify({ elements: [] }), content,
      [{ id: 'empty', text: '', required: false }]);
    expect(result.contentBindings).toEqual([]);
    expect(result.elements).toEqual(content.elements);
  });

  it('does not mistake an accurately condensed source clause for a missing atomic list member', () => {
    const content = text('身体的物理特性、基本结构、感知运动系统及其活动方式，对认知的形成有决定性影响。');
    const sources = [{ id: 'embodied', required: true,
      text: '身体的物理特性、基本结构、感知运动系统及其活动方式对认知的形成有决定性影响。' }];
    expect(restoredSlideDisplayDiagnostics(content, sources)).toEqual([]);
  });
});
