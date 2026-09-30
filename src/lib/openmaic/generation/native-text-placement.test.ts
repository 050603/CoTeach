import { afterAll, describe, expect, it, vi } from 'vitest';
import { compileTextComponents, resolveAuthoringContent, type AuthoringContentItem, type TextMeasure } from '@openmaic/generation';
import type { SceneOutline } from '../types/generation';
import { buildNativeTextPlacementPlan, expandNativeTextPlacements, formatNativeTextPlacementPlan, type NativeTextPlacementCandidate } from './native-text-placement';
import { generateOpenMaicBaselineContent } from './openmaic-baseline';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';

const texts = [
  '教学理论：系统阐述教学原则与规律，回答“为什么教”。',
  '教学模式：理论的具体化，相对固定的教学结构，如项目式、探究式。',
  '教学方法：灵活的具体技巧，如任务驱动、支架式、抛锚式。',
  '三者关系：理论 → 模式 → 方法，从抽象到具体。',
];
const points: AuthoringContentItem[] = texts.map((text, i) => ({ id: `adopted-content-${i + 1}`, text }));
const outline = { id: 'placement', type: 'slide', order: 0, title: '教学概念体系辨析', description: '', keyPoints: texts,
  generationPurpose: 'knowledge-teaching', teachingBrief: { teachingPlan: { presentationContent: texts } } } as SceneOutline;
const measure: TextMeasure = (input) => ({ height: input.fontSize * 1.5 + 20,
  naturalWidth: input.text.length * input.fontSize, lines: [input.text] });
function response(candidate: NativeTextPlacementCandidate) {
  return { background: { type: 'solid', color: '#ffffff' }, layoutCandidateId: candidate.id, elements: [] as object[],
    components: candidate.placements.map((placement, i) => ({ kind: 'textBox', id: `block-${i}`, placementRef: placement.ref, color: '#1e3a8a' })) };
}
afterAll(() => closeSpatialMeasurementBrowser());

describe('first-response native text placement', () => {
  it('measures the complete title and every adopted point at the playback font and compiles editable text', async () => {
    const plan = await buildNativeTextPlacementPlan(outline, points, { measure: measureAuthoredSlideText });
    expect(plan.supported).toBe(true);
    expect(plan.candidates.length).toBeGreaterThan(1);
    for (const candidate of plan.candidates) {
      expect(candidate.placements.map((box) => box.ref)).toEqual(['page-title', ...points.map((point) => point.id)]);
      for (const box of candidate.placements) {
        expect(box.fontSize).toBeGreaterThanOrEqual(22);
        expect(box.top + box.height).toBeLessThanOrEqual(512.5);
      }
      const expanded = JSON.parse(expandNativeTextPlacements(JSON.stringify(response(candidate)), plan));
      const resolved = resolveAuthoringContent(expanded, points);
      const compiled = await compileTextComponents(resolved.components, measureAuthoredSlideText);
      expect(compiled).toHaveLength(points.length + 1);
      for (const [index, element] of compiled.entries()) {
        if (element.type !== 'text') throw new Error('Expected native editable text');
        expect(element.height).toBe(candidate.placements[index]!.height);
        expect(element.left).toBe(candidate.placements[index]!.left);
        expect(element.top).toBe(candidate.placements[index]!.top);
        expect(element.content.replace(/<[^>]+>/g, '')).toBe(index ? texts[index - 1] : outline.title);
      }
    }
  });

  it('keeps native decoration and model style while host geometry and immutable text are authoritative', async () => {
    const plan = await buildNativeTextPlacementPlan(outline, points, { measure });
    const candidate = plan.candidates[0]!;
    const raw = response(candidate);
    const decoration = { type: 'shape', id: 'accent', left: 22, top: 50, width: 5, height: 100, fill: '#1e3a8a' };
    raw.elements.push(decoration);
    const expanded = JSON.parse(expandNativeTextPlacements(JSON.stringify(raw), plan));
    expect(expanded.elements).toEqual([decoration]);
    expect(expanded.components[1]).toMatchObject({ kind: 'textBox', id: 'block-1', color: '#1e3a8a',
      role: 'body', fontSize: 24, bold: false, contentRef: points[0]!.id });
    expect(formatNativeTextPlacementPlan(plan)).toContain('placementRef');
    expect(formatNativeTextPlacementPlan(plan)).toContain('Before this request, the host selected default layout');
    expect(formatNativeTextPlacementPlan(plan)).toContain('Use bare placementRef components for this default');
  });

  it('reports no candidate when the complete adopted content cannot fit its measured arrangements', async () => {
    const huge: TextMeasure = (input) => ({ height: input.text === outline.title ? 60 : 470,
      naturalWidth: 300, lines: [input.text] });
    const plan = await buildNativeTextPlacementPlan(outline, points, { measure: huge });
    expect(plan).toMatchObject({ supported: true, candidates: [] });
    expect(formatNativeTextPlacementPlan(plan)).toBe('');
    const original = JSON.stringify({ elements: [{ type: 'text', left: 60, top: 145, content: 'saved raw' }] });
    expect(expandNativeTextPlacements(original, plan)).toBe(original);
  });

  it.each(['candidate', 'unknown-ref', 'missing-ref', 'duplicate-ref', 'text-mutation', 'font-mutation', 'native-text', 'shape-text', 'unanchored-arrow'])
    ('rejects %s without silently dropping or rewriting content', async (mutation) => {
      const plan = await buildNativeTextPlacementPlan(outline, points, { measure });
      const raw = response(plan.candidates[0]!);
      if (mutation === 'candidate') raw.layoutCandidateId = 'unknown';
      if (mutation === 'unknown-ref') raw.components[1]!.placementRef = 'unknown';
      if (mutation === 'missing-ref') raw.components.pop();
      if (mutation === 'duplicate-ref') raw.components.push(raw.components[1]!);
      if (mutation === 'text-mutation') Object.assign(raw.components[1]!, { text: 'Changed explanation' });
      if (mutation === 'font-mutation') Object.assign(raw.components[1]!, { fontSize: 16 });
      if (mutation === 'native-text') raw.elements.push({ type: 'text', content: 'untracked body' });
      if (mutation === 'shape-text') raw.elements.push({ type: 'shape', text: { content: 'untracked body' } });
      if (mutation === 'unanchored-arrow') raw.elements.push({ type: 'line', points: ['', 'arrow'] });
      expect(() => expandNativeTextPlacements(JSON.stringify(raw), plan)).toThrow(/Native text placement/);
    });

  it.each([{ visualIntent: { diagram: { nodes: [], edges: [] } } }, { suggestedImageIds: ['textbook-figure'] },
    { teachingBrief: { teachingPlan: { visualRelationship: { kind: 'branch', preferredForm: 'diagram', readingOrder: [] } } } }])
    ('leaves complex diagram/media contracts and all legacy coordinates untouched', async (extra) => {
      const plan = await buildNativeTextPlacementPlan({ ...outline, ...extra } as SceneOutline, points, { measure });
      expect(plan.supported).toBe(false);
      const legacy = JSON.stringify({ elements: [{ type: 'text', left: 60, top: 442, content: 'original' }] });
      expect(expandNativeTextPlacements(legacy, plan)).toBe(legacy);
    });

  it('only supplies clear connections belonging to the actual declared sequence', async () => {
    const sequence = { ...outline, teachingBrief: { teachingPlan: { presentationContent: texts,
      visualRelationship: { kind: 'sequence', preferredForm: 'text', readingOrder: points.map((point) => point.id) } } } } as SceneOutline;
    const plan = await buildNativeTextPlacementPlan(sequence, points, { measure });
    const candidate = plan.candidates.find((entry) => entry.connectors.length)!;
    expect(candidate).toBeDefined();
    const edge = candidate.connectors[0]!;
    expect(candidate.connectors).toHaveLength(points.length - 1);
    expect(plan.candidates.some((entry) => entry.connectors.length === 0)).toBe(true);
    const raw = { ...response(candidate), placementConnectors: candidate.connectors.map(({ fromRef, toRef }) => ({ fromRef, toRef })) };
    expect(() => expandNativeTextPlacements(JSON.stringify(response(candidate)), plan)).toThrow(/every declared connector/);
    const compiled = JSON.parse(expandNativeTextPlacements(JSON.stringify(raw), plan));
    expect(compiled.elements[0]).toMatchObject({ type: 'line', left: edge.start[0], top: edge.start[1], points: ['', 'arrow'] });
    raw.placementConnectors[0] = { fromRef: edge.toRef, toRef: edge.fromRef };
    expect(() => expandNativeTextPlacements(JSON.stringify(raw), plan)).toThrow(/adopted relationship/);
    const statement = await buildNativeTextPlacementPlan(outline, points, { measure });
    expect(statement.candidates.every((entry) => !entry.connectors.length)).toBe(true);
    // A known measured visual occupying the connector corridor removes that route.
    const reserved = { left: Math.min(edge.start[0], edge.end[0]) - 1, top: Math.min(edge.start[1], edge.end[1]) - 1,
      width: Math.abs(edge.end[0] - edge.start[0]) + 2, height: Math.abs(edge.end[1] - edge.start[1]) + 2 };
    const blocked = await buildNativeTextPlacementPlan(sequence, points, { measure, reservedRectangles: [reserved] });
    expect(blocked.candidates.some((entry) => entry.id === candidate.id)).toBe(false);
  });

  it('uses the selected candidate in the existing first-response native compiler with one local authoring response', async () => {
    const plan = await buildNativeTextPlacementPlan(outline, points, { measure: measureAuthoredSlideText });
    const call = vi.fn(async (system: string, user: string) => {
      expect(system).toContain('Measured native text placement choices');
      expect(user).toContain('Required measured placement for this first response');
      expect(user).toContain('Omit contentRef/paragraphRefs');
      expect(user).toContain('expands placementRef into canonical contentRef');
      expect(user).toContain('supersedes the general reference-slot/free-coordinate examples above');
      return JSON.stringify(response(plan.candidates[0]!));
    });
    const onFailure = vi.fn();
    const result = await generateOpenMaicBaselineContent(outline, call, {
      componentAuthoring: true, slideAuthoring: 'native', textMeasure: measureAuthoredSlideText, onFailure,
    });
    expect(call).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
    expect(result && 'elements' in result ? result.elements : []).toHaveLength(points.length + 1);
  });
});

// Saved first response, not a repaired/re-authored slide. This fixture captures
// the actual statement/text contract whose connector wording conflicted with
// the first measured placement protocol.
import conflict from './__fixtures__/native-text-placement-conflict.json';
import { adoptedPageAuthoringContent } from './adopted-page-content';
import { withTeachingSlideGuidance } from './teaching-narration';
import { nativeTextRelationCaption } from './native-text-placement';
const conflictOutline = conflict.outline as unknown as SceneOutline;

describe('saved text-relationship first-input conflict', () => {
  it('recognizes only the complete adopted relation caption and preserves the failed original response', async () => {
    const adopted = adoptedPageAuthoringContent(conflictOutline);
    const plan = await buildNativeTextPlacementPlan(conflictOutline, adopted, { measure: measureAuthoredSlideText });
    expect(plan.relationCaption).toEqual({ ref: 'adopted-content-4', text: '三者关系：理论 → 模式 → 方法，从抽象到具体。' });
    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(plan.candidates.every((candidate) => candidate.connectors.length === 0)).toBe(true);
    expect(() => expandNativeTextPlacements(conflict.response, plan)).toThrow(conflict.expectedFailure);
    expect(JSON.parse(conflict.response).elements.filter((element: { type: string }) => element.type === 'line')).toHaveLength(2);
  });

  it('resolves generic connector guidance in the actual final system and user request without changing the blueprint or raw draft', async () => {
    const before = JSON.stringify(conflictOutline);
    const call = vi.fn(async (system: string, user: string) => {
      for (const prompt of [system, user]) {
        expect(prompt).toContain('三者关系：理论 → 模式 → 方法，从抽象到具体。');
        expect(prompt).toContain('Its literal arrow chain already expresses the page');
        expect(prompt).toContain('they do not request a second node-and-arrow diagram or extra native connecting lines');
        expect(prompt).toContain('placementRef:"adopted-content-4" already displays the complete adopted relationship');
        expect(prompt.lastIndexOf('The page-specific text relationship realization above remains authoritative'))
          .toBeGreaterThan(prompt.lastIndexOf('Choose the visual form from the stated relationship'));
      }
      expect(user.lastIndexOf('The page-specific text relationship realization above remains authoritative'))
        .toBeGreaterThan(user.lastIndexOf('用文字分组列出三个概念的定义，并用箭头表示从理论到模式到方法的关系。'));
      return conflict.response;
    });
    await expect(generateOpenMaicBaselineContent(conflictOutline, withTeachingSlideGuidance(call, conflictOutline), {
      componentAuthoring: true, slideAuthoring: 'native', textMeasure: measureAuthoredSlideText,
      websiteReferenceContext: { courseTitle: '中小学人工智能教育', slideTitles: [conflictOutline.title] },
    })).rejects.toThrow(conflict.expectedFailure);
    expect(call).toHaveBeenCalledOnce();
    expect(JSON.stringify(conflictOutline)).toBe(before);
  });

  it.each(['missing-caption', 'partial-caption', 'reversed-caption', 'ambiguous-definition', 'different-relation', 'branch', 'reading-order-conflict'])
    ('does not remove required visual connections when adopted text is insufficient: %s', async (mutation) => {
      const page = structuredClone(conflictOutline);
      const adopted = adoptedPageAuthoringContent(page);
      const relation = page.teachingBrief!.teachingPlan!.visualRelationship!;
      if (mutation === 'missing-caption') adopted.pop();
      if (mutation === 'partial-caption') adopted[3]!.text = '三者关系：理论 → 模式，从抽象到具体。';
      if (mutation === 'reversed-caption') adopted[3]!.text = '三者关系：方法 → 模式 → 理论，从具体到抽象。';
      if (mutation === 'ambiguous-definition') adopted.push({ id: 'another-theory', text: '另一种理论：并非同一个概念。' });
      if (mutation === 'different-relation') {
        relation.description = '用箭头表示从数据到方法到结果的关系。';
        page.visualIntent!.observationGoal = relation.description;
      }
      if (mutation === 'branch') relation.description += '必须显示分支和反馈关系。';
      if (mutation === 'reading-order-conflict') relation.readingOrder = ['方法', '模式', '理论'];
      expect(nativeTextRelationCaption(page, adopted)).toBeUndefined();
      const plan = await buildNativeTextPlacementPlan(page, adopted, { measure });
      expect(plan).toMatchObject({ supported: false, candidates: [] });
      expect(formatNativeTextPlacementPlan(plan)).toBe('');
    });

  it('retains explicit diagram topology and only offers complete anchored candidates when connectors are required', async () => {
    const page = structuredClone(conflictOutline);
    const adopted = adoptedPageAuthoringContent(page);
    const relation = page.teachingBrief!.teachingPlan!.visualRelationship!;
    relation.kind = 'sequence';
    relation.description = '用箭头连接各阶段，保持完整流程。';
    relation.readingOrder = adopted.map((point) => point.id);
    const plan = await buildNativeTextPlacementPlan(page, adopted, { measure });
    expect(plan.relationCaption).toBeUndefined();
    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(plan.candidates.every((candidate) => candidate.connectors.length === adopted.length - 1)).toBe(true);
    page.visualIntent!.representation = 'native-diagram';
    const visualPlan = await buildNativeTextPlacementPlan(page, adopted, { measure });
    expect(visualPlan).toMatchObject({ supported: false, candidates: [] });
  });
});

import defaultPlacementFixture from './__fixtures__/native-text-default-placement.json';
describe('host-selected default native placement', () => {
  it('fixes the largest offered readable layout before authoring and losslessly expands the real bare-reference response', async () => {
    const page = defaultPlacementFixture.outline as unknown as SceneOutline;
    const adopted = adoptedPageAuthoringContent(page);
    const plan = await buildNativeTextPlacementPlan(page, adopted, { measure: measureAuthoredSlideText });
    expect(plan.defaultCandidateId).toBe('native-text-v1-24-1col-gap24');
    const selected = plan.candidates.find((candidate) => candidate.id === plan.defaultCandidateId)!;
    expect(selected.placements[1]!.fontSize).toBe(Math.max(...plan.candidates.map((candidate) => candidate.placements[1]!.fontSize)));
    const raw = JSON.parse(defaultPlacementFixture.response);
    const expanded = JSON.parse(expandNativeTextPlacements(defaultPlacementFixture.response, plan));
    expect(expanded.elements).toEqual(raw.elements);
    expect(expanded.elements[0]).toMatchObject({ id: 'title-underline', top: 126, height: 3 });
    expect(expanded.components.map((component: { left: number; top: number; fontSize: number }) => [component.left, component.top, component.fontSize]))
      .toEqual(selected.placements.map((placement) => [placement.left, placement.top, placement.fontSize]));
    const call = vi.fn(async (system: string, user: string) => {
      expect(system).toContain(`Before this request, the host selected default layout "${plan.defaultCandidateId}"`);
      expect(user).toContain(`The host selected default layout "${plan.defaultCandidateId}" before this request`);
      expect(system).toContain('you do not need to repeat layoutCandidateId');
      expect(system).toContain('course reference title color #1E3A8A and body color #334155');
      expect(user).toContain('omit layoutCandidateId unless you actively select another advertised candidate');
      return defaultPlacementFixture.response;
    });
    const onFailure = vi.fn();
    const result = await generateOpenMaicBaselineContent(page, withTeachingSlideGuidance(call, page), {
      componentAuthoring: true, slideAuthoring: 'native', textMeasure: measureAuthoredSlideText, onFailure,
    });
    expect(call).toHaveBeenCalledOnce(); // Local fixture only; no provider.
    expect(onFailure).not.toHaveBeenCalled();
    expect(result && 'elements' in result ? result.elements : []).toHaveLength(adopted.length + 2);
    expect(JSON.parse(defaultPlacementFixture.response)).toEqual(raw);
  });

  it('honors one explicitly chosen alternative and does not fall back when a selected contract fails', async () => {
    const plan = await buildNativeTextPlacementPlan(outline, points, { measure });
    const alternative = plan.candidates.find((candidate) => candidate.id !== plan.defaultCandidateId)!;
    const raw = response(alternative);
    const expanded = JSON.parse(expandNativeTextPlacements(JSON.stringify(raw), plan));
    expect(expanded.components[1]).toMatchObject({ left: alternative.placements[1]!.left, width: alternative.placements[1]!.width });
    raw.components.pop();
    expect(() => expandNativeTextPlacements(JSON.stringify(raw), plan)).toThrow(/every title and adopted point/);
  });

  it.each(['unknown-id', 'unknown-ref', 'missing-ref', 'duplicate-ref', 'coordinates', 'font', 'native-text', 'free-arrow'])
    ('keeps the original strict gate with bare references: %s', async (mutation) => {
      const page = defaultPlacementFixture.outline as unknown as SceneOutline;
      const plan = await buildNativeTextPlacementPlan(page, adoptedPageAuthoringContent(page), { measure });
      const raw = JSON.parse(defaultPlacementFixture.response);
      if (mutation === 'unknown-id') raw.layoutCandidateId = 'unknown';
      if (mutation === 'unknown-ref') raw.components[1].placementRef = 'unknown';
      if (mutation === 'missing-ref') raw.components.pop();
      if (mutation === 'duplicate-ref') raw.components.push(raw.components[1]);
      if (mutation === 'coordinates') raw.components[1].top = 50;
      if (mutation === 'font') raw.components[1].fontSize = 16;
      if (mutation === 'native-text') raw.elements.push({ type: 'text', content: 'extra body' });
      if (mutation === 'free-arrow') raw.elements.push({ type: 'line', points: ['', 'arrow'] });
      expect(() => expandNativeTextPlacements(JSON.stringify(raw), plan)).toThrow(/Native text placement/);
    });

  it('never moves old free-coordinate drafts and never defaults a complex visual contract', async () => {
    const plan = await buildNativeTextPlacementPlan(outline, points, { measure });
    const legacy = JSON.stringify({ elements: [{ type: 'text', left: 200, top: 410, content: 'placementRef' }] });
    expect(expandNativeTextPlacements(legacy, plan)).toBe(legacy);
    const complex = await buildNativeTextPlacementPlan({ ...outline, visualIntent: {
      representation: 'native-diagram', observationGoal: '保留真实分支',
    } }, points, { measure });
    expect(complex.defaultCandidateId).toBeUndefined();
    expect(() => expandNativeTextPlacements(defaultPlacementFixture.response, complex)).toThrow(/unknown or unavailable candidate/);
    expect(() => expandNativeTextPlacements(conflict.response, plan)).toThrow(conflict.expectedFailure);
  });
});
