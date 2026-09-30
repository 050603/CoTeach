import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '../types/generation';
const mocks = vi.hoisted(() => ({ measure: vi.fn(), replan: vi.fn() }));
vi.mock('./semantic-page-capacity', () => ({ evaluateSemanticPageCapacity: mocks.measure }));
vi.mock('./section-capacity-replanner', () => ({ replanMeasuredTeachingSection: mocks.replan }));
import { prepareTeachingPageCapacity, TeachingPagePreflightError } from './teaching-page-preflight';
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
  it('stops rather than changing a teacher-confirmed page', async () => {
    mocks.measure.mockResolvedValue(assessment('p', 'page-overflow'));
    await expect(prepareTeachingPageCapacity([page], { lockedOutlineIds: ['p'] })).rejects.toBeInstanceOf(TeachingPagePreflightError);
    expect(mocks.replan).not.toHaveBeenCalled();
  });
  it('preserves completed pages without remeasurement', async () => {
    expect(await prepareTeachingPageCapacity([page], { completedOutlineIds: ['p'] })).toEqual({ outlines: [page], assessments: [], changed: false });
    expect(mocks.measure).not.toHaveBeenCalled();
  });
  it('does not infer pagination from unavailable measurements', async () => {
    mocks.measure.mockResolvedValue(assessment('p', 'measurement-unavailable'));
    await expect(prepareTeachingPageCapacity([page])).rejects.toMatchObject({ assessments: [assessment('p', 'measurement-unavailable')] });
    expect(mocks.replan).not.toHaveBeenCalled();
  });
  it('does not redistribute a selected subset of a complete section', async () => {
    mocks.measure.mockResolvedValue(assessment('p', 'page-overflow'));
    await expect(prepareTeachingPageCapacity([page], { allOutlines: [page, { ...page, id: 'other' }] })).rejects.toBeInstanceOf(TeachingPagePreflightError);
    expect(mocks.replan).not.toHaveBeenCalled();
  });
});
