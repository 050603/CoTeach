import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '../types/generation';
import { buildSlideSpatialSketchSvg, prepareCourseSlideSpatialPlans, remainingSlideSpace } from './slide-spatial-plan';
import { measureSlideRegionConservatively, type SpatialMeasureFn } from './slide-spatial-measurement';
import { formatSlideSpatialBudget, type SlideTeachingRegion } from './slide-spatial-types';

const page: SceneOutline = { id: 'page', type: 'slide', title: '空间教学', description: '展示具体知识', keyPoints: ['知识甲', '知识乙'], knowledgePointIds: ['k1', 'k2'], targetDurationSec: 91, estimatedDuration: 100, order: 0 };
const region = (id: string, content: string, index: number): SlideTeachingRegion => ({ id, content, kind: 'text', unitId: id, keyPointIndexes: [index], knowledgePointIds: [`k${index + 1}`], readingOrder: index, x: 60 + index * 440, y: 145, width: 420, height: 335 });
const measure: SpatialMeasureFn = async (region, width, fontSize) => ({ width, height: 20 + Math.ceil(region.content.length / Math.floor((width - 20) / fontSize)) * fontSize * 1.5, representativeCharWidth: fontSize });

describe('pre-authoring space budgets', () => {
  it('budgets renderer metrics, reserves capacity and keeps final coordinates advisory', async () => {
    const [prepared] = await prepareCourseSlideSpatialPlans([page], { measure });
    const budget = prepared.spatialBudget!;
    expect(budget.regions.every((r) => r.fits && r.fontSize >= 22 && r.padding === 10)).toBe(true);
    expect(budget.reserveRatio).toBe(0.1);
    expect(budget.regions[0].maxLines).toBe(Math.floor((335 - 20) * 0.9 / 36));
    expect(formatSlideSpatialBudget(prepared)).toContain('You decide final coordinates');
    expect(formatSlideSpatialBudget(prepared)).toContain('EVERY text element defaultFontName to Noto Sans SC');
    expect(formatSlideSpatialBudget(prepared)).toContain('each resulting DSL text box needs its OWN 20px');
    expect(buildSlideSpatialSketchSvg(prepared)).toContain('point-1');
  });
  it('splits before generation with stable IDs, complete knowledge coverage and exact total durations', async () => {
    const dense = { ...page, keyPoints: ['甲'.repeat(240), '乙'.repeat(240), '丙'.repeat(240)], knowledgePointIds: ['k1', 'k2', 'k3'] };
    const first = await prepareCourseSlideSpatialPlans([dense], { measure });
    const second = await prepareCourseSlideSpatialPlans([dense], { measure });
    expect(first.length).toBe(3);
    expect(first.map((p) => p.id)).toEqual(second.map((p) => p.id));
    expect(first.map((p) => p.id)).toEqual(['page--spatial-1', 'page--spatial-2', 'page--spatial-3']);
    expect(first.flatMap((p) => p.keyPoints)).toEqual(dense.keyPoints);
    expect(new Set(first.flatMap((p) => p.knowledgePointIds!))).toEqual(new Set(dense.knowledgePointIds));
    expect(first.reduce((sum, p) => sum + p.targetDurationSec!, 0)).toBe(91);
    expect(first.every((p) => Number.isInteger(p.targetDurationSec))).toBe(true);
    expect(first.reduce((sum, p) => sum + Math.round(p.targetDurationSec!), 0)).toBe(91);
    expect(first.reduce((sum, p) => sum + p.estimatedDuration!, 0)).toBe(100);
    expect(first.every((p) => p.spatialParentId === 'page')).toBe(true);
    expect(await prepareCourseSlideSpatialPlans(first, { measure: async () => { throw new Error('must not remeasure'); } })).toEqual(first);
  });
  it('relaxes an impossible model-grouped comparison instead of aborting the course', async () => {
    const dense = { ...page, title: '比较', keyPoints: ['甲'.repeat(240), '乙'.repeat(240)],
      visualPlan: { schemaVersion: 2 as const, composition: 'comparison' as const, density: 'regular' as const, coreMessage: '对齐比较', readingPath: '左右', visualEvidence: [],
        regions: [region('a', '甲'.repeat(240), 0), { ...region('b', '乙'.repeat(240), 1), unitId: 'a' }] } };
    const prepared = await prepareCourseSlideSpatialPlans([dense], { measure });
    expect(prepared).toHaveLength(2);
    expect(prepared.flatMap((item) => item.keyPoints)).toEqual(dense.keyPoints);
  });
  it('splits inferred fallback comparisons instead of treating every synthesized point as indivisible', async () => {
    const dense = { ...page, title: '对比与差异', keyPoints: ['甲'.repeat(240), '乙'.repeat(240), '丙'.repeat(240)] };
    const prepared = await prepareCourseSlideSpatialPlans([dense], { measure });
    expect(prepared).toHaveLength(3);
    expect(prepared.flatMap((item) => item.keyPoints)).toEqual(dense.keyPoints);
  });
  it('reports accidental overlap but exempts explicit containment', async () => {
    const first = region('a', '知识甲', 0), second = { ...region('b', '知识乙', 1), x: 100 };
    const outlined: SceneOutline = { ...page, visualPlan: { schemaVersion: 2, composition: 'concept-focus', density: 'regular', coreMessage: '知识', readingPath: '顺序', visualEvidence: [], regions: [first, second] } };
    const [accidental] = await prepareCourseSlideSpatialPlans([outlined], { measure });
    expect(accidental.spatialBudget?.conflicts).toHaveLength(1);
    second.parentRegionId = 'a';
    const [intentional] = await prepareCourseSlideSpatialPlans([outlined], { measure });
    expect(intentional.spatialBudget?.conflicts).toHaveLength(0);
  });
  it('computes non-overlapping free rectangles whose area complements occupied space', () => {
    const free = remainingSlideSpace([{ x: 160, y: 200, width: 100, height: 100 }]);
    expect(free.reduce((sum, rect) => sum + rect.width * rect.height, 0)).toBe(880 * 335 - 10000);
  });
  it('preserves non-slide outlines and escapes schematic labels', async () => {
    const quiz: SceneOutline = { ...page, type: 'quiz', id: 'quiz' };
    const [prepared, untouched] = await prepareCourseSlideSpatialPlans([{ ...page, title: '<script>bad</script>' }, quiz], { measure });
    expect(untouched.spatialBudget).toBeUndefined();
    expect(buildSlideSpatialSketchSvg(prepared)).not.toContain('<script>');
    expect(buildSlideSpatialSketchSvg(prepared)).toContain('&lt;script&gt;');
  });
  it('provides ELK candidate ports and channels while keeping semantic relation labels', async () => {
    const outlined: SceneOutline = { ...page, visualPlan: { schemaVersion: 2, composition: 'process', density: 'regular', coreMessage: '过程', readingPath: '左右', visualEvidence: [], regions: [region('a', '知识甲', 0), region('b', '知识乙', 1)], relations: [{ from: 'a', to: 'b', kind: 'sequence', label: '然后' }] } };
    const [prepared] = await prepareCourseSlideSpatialPlans([outlined], { measure });
    expect(prepared.spatialBudget?.connectors[0]).toMatchObject({ from: 'a', to: 'b', label: '然后' });
    expect(prepared.spatialBudget?.connectors[0].points.length).toBeGreaterThanOrEqual(2);
  });
  it('assigns each media request to exactly one split child and narrows child teaching scope', async () => {
    const dense: SceneOutline = { ...page, keyPoints: ['甲'.repeat(240), '乙'.repeat(240)],
      mediaGenerations: [{ type: 'image', prompt: '实验情境', elementId: 'experiment' }],
      visualPlan: { schemaVersion: 2, composition: 'concept-focus', density: 'regular', coreMessage: '全页教学结论', readingPath: '依次', visualEvidence: [],
        regions: [region('a', '甲'.repeat(240), 0), { ...region('b', '乙'.repeat(240), 1), mediaElementId: 'experiment' }] } };
    const children = await prepareCourseSlideSpatialPlans([dense], { measure });
    expect(children).toHaveLength(2);
    expect(children[0].mediaGenerations).toEqual([]);
    expect(children[1].mediaGenerations?.map((r) => r.elementId)).toEqual(['experiment']);
    expect(children[0].description).not.toContain('乙');
    expect(children[1].visualPlan?.coreMessage).not.toContain('甲');
    expect(children[0].spatialSourceContext?.description).toBe(page.description);
  });
  it('measures long titles before authoring and surfaces unavailable measurement explicitly', async () => {
    await expect(prepareCourseSlideSpatialPlans([{ ...page, title: '长'.repeat(120) }], { measure })).rejects.toThrow('页面标题无法');
    await expect(prepareCourseSlideSpatialPlans([page], { measure: async () => { throw new Error('font unavailable'); } })).rejects.toThrow('font unavailable');
  });

  it('guides the first image request using its measured display region and safe crop margin', async () => {
    const outlined: SceneOutline = { ...page, keyPoints: [], mediaGenerations: [{ type: 'image', elementId: 'scene-image', prompt: '课堂实验', aspectRatio: '9:16' }],
      visualPlan: { schemaVersion: 2, composition: 'annotated-example', density: 'focused', coreMessage: '观察实验', readingPath: '中心', visualEvidence: [],
        regions: [{ ...region('photo', '观察学生合作进行实验', 0), kind: 'image', width: 420, height: 300, imageAspectRatio: 1.4, mediaElementId: 'scene-image', keyPointIndexes: [] }] } };
    const [prepared] = await prepareCourseSlideSpatialPlans([outlined], { measure });
    expect(prepared.mediaGenerations?.[0].aspectRatio).toBe('4:3');
    expect(prepared.mediaGenerations?.[0].prompt).toContain('central 80%');
    expect(prepared.mediaGenerations?.[0].prompt).toContain('separate editable slide elements');
  });

  it('keeps a conservative and explicitly labelled budget when browser measurement is unavailable', async () => {
    const [prepared] = await prepareCourseSlideSpatialPlans([page], { measure: measureSlideRegionConservatively });
    expect(prepared.spatialBudget?.measurement).toBe('conservative-text-estimate-v1');
    expect(prepared.spatialBudget?.regions.every((item) => item.fits)).toBe(true);
    expect(formatSlideSpatialBudget(prepared)).toContain('Browser measurement was unavailable');
  });

});
