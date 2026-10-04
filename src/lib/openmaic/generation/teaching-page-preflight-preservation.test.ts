import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextMeasure } from '@openmaic/generation';
import type { SceneOutline } from '../types/generation';
import { prepareTeachingPageCapacity } from './teaching-page-preflight';
import { replanMeasuredTeachingSection } from './section-capacity-replanner';

vi.mock('./section-capacity-replanner', () => ({ replanMeasuredTeachingSection: vi.fn() }));

const measure: TextMeasure = async ({ text, width, fontSize, padding }) => {
  const lines = Math.max(1, Math.ceil([...text].length * fontSize / Math.max(1, width - padding * 2)));
  return { naturalWidth: [...text].length * fontSize, height: padding * 2 + lines * fontSize * 1.5,
    lines: Array.from({ length: lines }, () => text) };
};

function draft(): SceneOutline {
  const display = ['甲'.repeat(550), '乙'.repeat(550)];
  return { id: 'draft', type: 'slide', title: '两项比较', description: '比较同一观察任务下的两项事实', order: 0,
    audience: 'student', generationPurpose: 'knowledge-teaching', lectureSectionId: 'section',
    keyPoints: display, knowledgePointIds: ['knowledge'], targetDurationSec: 60,
    teachingBrief: { schemaVersion: 1, explanation: '', examples: [], conditions: [], evidence: [], assessmentFocus: '',
      manuscript: { sectionId: 'section', segmentIds: ['first', 'second'] },
      teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [],
        takeaway: '', visibleContent: [], narrationFocus: [], introduces: ['first', 'second'], deepens: [],
        presentationContent: display, presentationItems: display.map((text, index) => ({ text, role: 'comparison',
          nodeIds: [index ? 'second' : 'first'] })) } },
  };
}

function proposal(page: SceneOutline): SceneOutline[] {
  return page.keyPoints.map((text, index) => ({ ...structuredClone(page), id: index ? 'continuation' : page.id,
    order: index, keyPoints: [text], targetDurationSec: 30, sourcePageIds: [page.id], sectionPlanVersion: 'measured-plan',
    teachingBrief: { ...structuredClone(page.teachingBrief!),
      manuscript: { sectionId: 'section', segmentIds: [index ? 'second' : 'first'] },
      teachingPlan: { ...structuredClone(page.teachingBrief!.teachingPlan!),
        introduces: [index ? 'second' : 'first'], presentationContent: [text],
        presentationItems: [page.teachingBrief!.teachingPlan!.presentationItems![index]!] } },
  }));
}

beforeEach(() => vi.mocked(replanMeasuredTeachingSection).mockReset());

describe('bounded page capacity preserves adopted teaching', () => {
  it('adopts a measured split and keeps continuous speech, knowledge and the existing quiz', async () => {
    const page = draft(), saved = structuredClone(page), revised = proposal(page);
    const quiz: SceneOutline = { id: 'quiz', type: 'quiz', title: '检测', description: '检验上述理解', order: 1,
      keyPoints: ['题目和解析保持已采纳内容'], lectureSectionId: 'section', targetDurationSec: 30 };
    vi.mocked(replanMeasuredTeachingSection).mockResolvedValue({ status: 'replanned', outlines: revised, assessments: [] });
    const result = await prepareTeachingPageCapacity([page, quiz], { nativeLectureAuthoring: true, measure });
    expect(result.changed).toBe(true);
    expect(result.outlines).toHaveLength(3);
    expect(result.outlines.flatMap((outline) => outline.teachingBrief?.manuscript?.segmentIds ?? [])).toEqual(['first', 'second']);
    expect(result.outlines.slice(0, 2).flatMap((outline) => outline.keyPoints)).toEqual(page.keyPoints);
    expect(result.outlines.slice(0, 2).every((outline) => outline.knowledgePointIds?.[0] === 'knowledge')).toBe(true);
    expect(result.outlines[2]).toEqual({ ...quiz, order: 2 });
    expect(result.outlines.slice(0, 2).every((outline) => outline.visualPlan === undefined)).toBe(true);
    expect(result.assessments.every((assessment) => assessment.selectedLayout?.fits)).toBe(true);
    expect(page).toEqual(saved);
  });

  it.each(['reordered', 'missing', 'duplicated', 'other-section'] as const)('rejects a capacity proposal with %s spoken paragraphs and retains the original draft', async (kind) => {
    const page = draft(), saved = structuredClone(page), revised = proposal(page);
    if (kind === 'reordered') {
      revised[0]!.teachingBrief!.manuscript!.segmentIds = ['second'];
      revised[1]!.teachingBrief!.manuscript!.segmentIds = ['first'];
    } else if (kind === 'missing') revised[1]!.teachingBrief!.manuscript!.segmentIds = [];
    else if (kind === 'duplicated') revised[1]!.teachingBrief!.manuscript!.segmentIds.push('first');
    else revised[1]!.teachingBrief!.manuscript!.sectionId = 'unrelated-section';
    vi.mocked(replanMeasuredTeachingSection).mockResolvedValue({ status: 'replanned', outlines: revised, assessments: [] });
    const result = await prepareTeachingPageCapacity([page], { nativeLectureAuthoring: true, measure });
    expect(result.changed).toBe(false);
    expect(result.outlines[0]).toBe(page);
    expect(result.diagnostics).toContainEqual(expect.stringContaining('未完整保留讲稿顺序'));
    expect(result.assessments[0]!.decision).toBe('page-overflow');
    expect(page).toEqual(saved);
  });

  it.each(['knowledge', 'node-duty', 'source-image', 'branch', 'budget', 'source-identity'] as const)('retains the original draft when capacity adjustment loses %s', async (kind) => {
    const page = draft();
    if (kind === 'source-image') page.visualIntent = { representation: 'source-image', observationGoal: '观察教材事实',
      resourceRefs: [{ kind: 'source-image', resourceId: 'textbook-figure', required: true, reason: '理解事实' }] };
    if (kind === 'branch') page.visualIntent = { representation: 'native-diagram', observationGoal: '观察真实两条分支',
      diagram: { topology: 'branch', nodes: [{ id: 'start', label: '判断条件' }, { id: 'yes', label: '条件成立' }, { id: 'no', label: '条件不成立' }],
        edges: [{ from: 'start', to: 'yes' }, { from: 'start', to: 'no' }] } };
    const saved = structuredClone(page), revised = proposal(page);
    if (kind === 'knowledge') revised.forEach((outline) => { outline.knowledgePointIds = []; });
    else if (kind === 'node-duty') revised[1]!.teachingBrief!.teachingPlan!.introduces = [];
    else if (kind === 'source-image') revised.forEach((outline) => { outline.visualIntent!.resourceRefs = []; });
    else if (kind === 'branch') revised.forEach((outline) => { outline.visualIntent!.diagram!.edges!.pop(); });
    else if (kind === 'budget') revised[0]!.targetDurationSec = 40;
    else revised[1]!.sourcePageIds = ['unrelated-source'];
    vi.mocked(replanMeasuredTeachingSection).mockResolvedValue({ status: 'replanned', outlines: revised, assessments: [] });
    const result = await prepareTeachingPageCapacity([page], { nativeLectureAuthoring: true, measure });
    expect(result.changed).toBe(false);
    expect(result.outlines[0]).toBe(page);
    expect(result.diagnostics).toContainEqual(expect.stringContaining('保留原页面计划并继续生成'));
    expect(page).toEqual(saved);
  });

  it('retains the measured first draft and the real reason when bounded adjustment is infeasible', async () => {
    const page = draft();
    vi.mocked(replanMeasuredTeachingSection).mockResolvedValue({ status: 'infeasible',
      reason: '原图与完整观察材料不能同时装入可读页面', assessments: [] });
    const result = await prepareTeachingPageCapacity([page], { nativeLectureAuthoring: true, measure });
    expect(replanMeasuredTeachingSection).toHaveBeenCalledTimes(1);
    expect(result.changed).toBe(false);
    expect(result.outlines[0]).toBe(page);
    expect(result.diagnostics).toContainEqual(expect.stringContaining('原图与完整观察材料不能同时装入可读页面'));
    expect(result.assessments[0]!.decision).toBe('page-overflow');
  });

  it('records unavailable measurements without inventing a feasible layout or changing page count', async () => {
    const page = draft();
    const result = await prepareTeachingPageCapacity([page], { nativeLectureAuthoring: true,
      measure: async () => { throw new Error('字体测量不可用'); } });
    expect(replanMeasuredTeachingSection).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.outlines[0]).toBe(page);
    expect(result.assessments[0]!.decision).toBe('measurement-unavailable');
    expect(result.assessments[0]!.selectedLayout).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.stringContaining('字体测量不可用'));
  });
});
