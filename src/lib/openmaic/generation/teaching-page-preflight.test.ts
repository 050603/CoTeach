import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '../types/generation';
const mocks = vi.hoisted(() => ({ measure: vi.fn(), replan: vi.fn() }));
vi.mock('./semantic-page-capacity', () => ({ evaluateSemanticPageCapacity: mocks.measure }));
vi.mock('./section-capacity-replanner', () => ({ replanMeasuredTeachingSection: mocks.replan }));
import { prepareTeachingPageCapacity } from './teaching-page-preflight';
const page: SceneOutline = { id: 'p', order: 0, type: 'slide', title: '概念', description: '解释概念',
  keyPoints: ['完整定义'], generationPurpose: 'knowledge-teaching', lectureSectionId: 's' };
const assessment = (outlineId: string, decision = 'fits') => ({ outlineId, decision, reason: decision });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.measure.mockImplementation(async (outline: SceneOutline) => assessment(outline.id));
  mocks.replan.mockResolvedValue({ status: 'infeasible' });
});
describe('shared pre-confirmation and production capacity preflight', () => {
  it('measures and verifies a deterministic split before returning the reviewable plan', async () => {
    mocks.measure.mockResolvedValueOnce(assessment('p', 'page-overflow'));
    const next = [{ ...page, id: 'p-a' }, { ...page, id: 'p-b', order: 1 }];
    mocks.replan.mockResolvedValue({ status: 'replanned', outlines: next });
    const dimensions = { figure: { width: 1200, height: 900 } };
    const result = await prepareTeachingPageCapacity([page], { resourceDimensions: dimensions });
    expect(result).toMatchObject({ outlines: next, changed: true });
    expect(mocks.measure).toHaveBeenCalledTimes(3);
    expect(mocks.measure.mock.calls.every((call) => call[1].resourceDimensions === dimensions)).toBe(true);
  });
  it('preserves a teacher-confirmed page and records overload without stopping generation', async () => {
    mocks.measure.mockResolvedValue(assessment('p', 'page-overflow'));
    expect(await prepareTeachingPageCapacity([page], { lockedOutlineIds: ['p'] })).toMatchObject({
      outlines: [page], changed: false, diagnostics: [expect.stringContaining('page-overflow')],
    });
    expect(mocks.replan).not.toHaveBeenCalled();
  });
  it('preserves completed pages without remeasurement', async () => {
    expect(await prepareTeachingPageCapacity([page], { completedOutlineIds: ['p'] })).toEqual({ outlines: [page], assessments: [], changed: false, diagnostics: [] });
    expect(mocks.measure).not.toHaveBeenCalled();
  });
  it('does not infer pagination from unavailable measurements', async () => {
    mocks.measure.mockResolvedValue(assessment('p', 'measurement-unavailable'));
    expect(await prepareTeachingPageCapacity([page])).toMatchObject({ outlines: [page],
      assessments: [assessment('p', 'measurement-unavailable')], diagnostics: [expect.stringContaining('measurement-unavailable')] });
    expect(mocks.replan).not.toHaveBeenCalled();
  });
  it('does not redistribute a selected subset of a complete section', async () => {
    mocks.measure.mockResolvedValue(assessment('p', 'page-overflow'));
    expect(await prepareTeachingPageCapacity([page], { allOutlines: [page, { ...page, id: 'other' }] })).toMatchObject({
      outlines: [page], changed: false, diagnostics: [expect.stringContaining('page-overflow')],
    });
    expect(mocks.replan).not.toHaveBeenCalled();
  });
  it('supplies only actually introduced prior nodes from the full execution plan to a selected complete section', async () => {
    const earlier: SceneOutline = { ...page, id: 'earlier', lectureSectionId: 'before', teachingBrief: {
      schemaVersion: 1, explanation: '已实际讲授的前提。', examples: [], conditions: [], evidence: [], assessmentFocus: '',
      teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [], takeaway: '',
        visibleContent: [], narrationFocus: [], introduces: ['established'], deepens: [], references: ['reference-only'] },
    } };
    const later = { ...earlier, id: 'later', lectureSectionId: 'after' };
    later.teachingBrief = { ...earlier.teachingBrief!, teachingPlan: { ...earlier.teachingBrief!.teachingPlan!, introduces: ['future'] } };
    mocks.measure.mockResolvedValue(assessment('p', 'page-overflow'));
    expect(await prepareTeachingPageCapacity([page], { allOutlines: [earlier, page, later] })).toMatchObject({ outlines: [page], changed: false });
    expect(mocks.replan).toHaveBeenCalledWith([page], expect.objectContaining({ priorTeachingNodeIds: ['established'] }));
  });
});
