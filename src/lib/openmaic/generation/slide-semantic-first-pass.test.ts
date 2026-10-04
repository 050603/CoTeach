import { afterAll, describe, expect, it, vi } from 'vitest';
import { generateSceneContent, type TextMeasure } from '@openmaic/generation';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import { adaptOutlineToOpenMaicBaseline, generateOpenMaicBaselineContent } from './openmaic-baseline';
import { prepareNativeLectureResponse, bindNativeLectureContent } from './slide-native-authoring';
import { buildSlideDisplayAuthoringContext, projectionData } from './slide-visual-projection';
import { closeSpatialMeasurementBrowser } from './slide-spatial-measurement';

const page = (): SceneOutline => ({ id: 'materials', type: 'slide', title: '材料与选择依据', description: '', order: 0,
  generationPurpose: 'knowledge-teaching', audience: 'student', keyPoints: [],
  teachingBrief: { schemaVersion: 1, explanation: '', examples: [], conditions: [], evidence: [], assessmentFocus: '',
    teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [],
      takeaway: '', visibleContent: [], narrationFocus: [],
      presentationContent: ['三类材料：金属、塑料、木材。', '选择原则：根据用途选择材料。'] } },
});
const measure: TextMeasure = async (input) => ({ width: input.width, height: 45,
  lines: [input.text], naturalWidth: Math.min(input.width, input.text.length * input.fontSize) });
afterAll(closeSpatialMeasurementBrowser);

function response(outline: SceneOutline, metadata = true) {
  const group = buildSlideDisplayAuthoringContext(outline).context.semanticGroups[0]!;
  return { displayItems: [
    { id: 'types', text: '三类材料：金属、塑料、木材。', sourceContentIds: ['adopted-content-1'],
      ...(metadata ? { semanticBindings: [{ groupId: group.id, role: 'overview' }] } : {}) },
    { id: 'principle', text: '根据用途选择材料。', sourceContentIds: ['adopted-content-2'],
      ...(metadata ? { semanticBindings: [{ groupId: group.id, role: 'context' }] } : {}) },
  ], elements: [{ id: 'title', type: 'text', textType: 'title', left: 60, top: 50, width: 880, height: 46,
    content: '<p style="font-size:30px">材料与选择依据</p>', defaultFontName: 'Noto Sans SC', defaultColor: '#1E3A8A' }],
  components: [{ kind: 'textBox', id: 'collection', contentRef: 'types', left: 60, top: 140, width: 880, fontSize: 18 },
    { kind: 'textBox', id: 'support', contentRef: 'principle', left: 60, top: 280, width: 880, fontSize: 18 }],
  };
}

/** Exercise the retired response parser and real native compiler directly.
 * The production adapter must not require this v5 display metadata anymore. */
async function compileLegacy(outline: SceneOutline, raw: string) {
  const authoring = buildSlideDisplayAuthoringContext(outline);
  const prepared = prepareNativeLectureResponse(raw, authoring, outline);
  const call = vi.fn(async () => raw);
  const generated = await generateSceneContent(adaptOutlineToOpenMaicBaseline(outline), call, {
    componentAuthoring: true, slideAuthoring: 'native', textMeasure: measure,
    responseAuthoringContent: () => prepared, preserveNativeComposition: true,
  });
  if (!generated || !('elements' in generated)) throw new Error('Legacy native response did not compile');
  const result = bindNativeLectureContent(outline, generated as GeneratedSlideContent, prepared.displayItems, authoring.sources);
  return { result, prepared, call };
}

describe('legacy v5 semantic response parsing and binding', () => {
  it('preserves membership metadata through parsing and actual compiled content bindings', async () => {
    const outline = page(), before = structuredClone(outline);
    const { result, prepared, call } = await compileLegacy(outline, JSON.stringify(response(outline)));
    expect(call).toHaveBeenCalledTimes(1);
    expect(result.displayItems?.[0]?.semanticBindings?.[0]?.role).toBe('overview');
    expect(result.displayItems?.[1]?.semanticBindings?.[0]?.role).toBe('context');
    expect(result.contentBindings).toContainEqual(expect.objectContaining({ sourceContentId: 'types' }));
    expect(prepared.semanticIssues).toEqual([]);
    expect(outline).toEqual(before);
  });

  it('records missing hierarchy on a usable draft without another call or a list fallback', async () => {
    const outline = page();
    const { result, prepared, call } = await compileLegacy(outline, JSON.stringify(response(outline, false)));
    expect(call).toHaveBeenCalledTimes(1);
    const body = result.contentBindings?.find((binding) => binding.sourceContentId === 'types');
    expect(result.elements.find((element) => element.id === body?.elementId)).toMatchObject({ left: 60, top: 140, width: 880 });
    expect(result.displayItems?.map((item) => item.id)).toEqual(['types', 'principle']);
    expect(prepared.semanticIssues.length).toBeGreaterThan(0);
    expect((result.qualityDiagnostics ?? []).some((issue) => issue.includes('local draft') || issue.includes('retained every original'))).toBe(false);
  });

  it('keeps executable wording and reports malformed optional metadata', () => {
    const diagnostics: string[] = [];
    const projection = projectionData(JSON.stringify({ items: [{ id: 'fact', text: '根据用途选择材料。',
      sourceContentIds: ['adopted-content-2'], semanticBindings: [{ groupId: 'x', role: 'made-up' }] }] }), diagnostics);
    expect(projection.items[0]?.text).toBe('根据用途选择材料。');
    expect(projection.items[0]?.semanticBindings).toBeUndefined();
    expect(diagnostics).toContainEqual(expect.stringContaining('Invalid semantic hierarchy metadata'));
  });

  it('does not reject a new default literal draft for lacking retired hierarchy metadata when a baseline exists', async () => {
    const outline = page();
    const existing = { elements: [{ id: 'existing-body', type: 'text' as const, left: 60, top: 130,
      width: 880, height: 60, rotate: 0, defaultFontName: 'Noto Sans SC', defaultColor: '#334155',
      content: '<p style="font-size:18px">已确认的完整认识</p>' }] };
    const legacy = prepareNativeLectureResponse(JSON.stringify(response(outline, false)), buildSlideDisplayAuthoringContext(outline), outline);
    expect(legacy.semanticIssues.length).toBeGreaterThan(0);
    const call = vi.fn(async () => JSON.stringify({ elements: response(outline).elements, components: [
      { kind: 'textBox', id: 'types', left: 60, top: 140, width: 880, fontSize: 18, text: '三类材料：金属、塑料、木材。' },
      { kind: 'textBox', id: 'principle', left: 60, top: 280, width: 880, fontSize: 18, text: '根据用途选择材料。' },
    ] }));
    const original = structuredClone(existing);
    const result = await generateOpenMaicBaselineContent(outline, call, {
      componentAuthoring: true, textMeasure: measure, visualBaseline: existing }) as GeneratedSlideContent;
    expect(call).toHaveBeenCalledTimes(1);
    expect(result.elements).not.toEqual(existing.elements);
    expect(result.displayItems).toBeUndefined();
    expect(result.elements.filter((element) => element.type === 'text').map((element) => element.content).join(' ')).toContain('三类材料：金属、塑料、木材。');
    expect(result.qualityDiagnostics ?? []).not.toContainEqual(expect.stringContaining('semantic hierarchy'));
    expect(existing).toEqual(original);
  });

  it('diagnoses a missing object in its own sourced proposition without rewriting the whole page', async () => {
    const outline = page();
    outline.teachingBrief!.teachingPlan!.presentationContent![1] = '设计观察活动、记录表和操作环境。';
    const raw = response(outline);
    raw.displayItems[1]!.text = '设计观察活动与操作环境。';
    const { result, prepared, call } = await compileLegacy(outline, JSON.stringify(raw));
    expect(call).toHaveBeenCalledTimes(1);
    expect(result.displayItems?.[1]?.text).toBe('设计观察活动与操作环境。');
    expect(prepared.factIssues).toContainEqual(expect.stringContaining('记录表'));
    expect((result.qualityDiagnostics ?? []).some((issue) => issue.includes('local draft') || issue.includes('retained every original'))).toBe(false);
  });
});
