import { describe, expect, it } from 'vitest';
import { nativeAuthoringEnvelopeContract, normalizeNativeAuthoringEnvelope } from './native-authoring-envelope';
import { resolveAuthoringContent } from '@openmaic/generation';
const native = { id: 'title', type: 'text', left: 60, top: 50, width: 880, height: 70, content: '<p>Title</p>' };
const body = { id: 'body', kind: 'textBox', left: 60, top: 210, width: 440, height: 96,
  fontSize: 22, bold: true, role: 'label', color: '#1E3A8A', paragraphRefs: ['point-1'] };
describe('native authoring envelope normalization', () => {
  it('moves unambiguous measured components to their proper array without modifying any authored properties', () => {
    const response = `\`\`\`json\n${JSON.stringify({ background: { color: '#fff' }, elements: [native, body] })}\n\`\`\``;
    const normalized = JSON.parse(normalizeNativeAuthoringEnvelope(response));
    expect(normalized).toEqual({ background: { color: '#fff' }, elements: [native], components: [body] });
    expect(resolveAuthoringContent(normalized, [{ id: 'point-1', text: '完整定义及必要条件' }])).toMatchObject({
      components: [{ fontSize: 22, left: 60, top: 210, width: 440, role: 'label', bold: true, paragraphs: ['完整定义及必要条件'] }],
    });
  });
  it('retains existing components and never drops unsupported or ambiguous entries', () => {
    const ambiguous = { ...body, type: 'text' };
    const unknown = { kind: 'unknown', contentRef: 'point-1' };
    const existing = { ...body, id: 'existing' };
    expect(JSON.parse(normalizeNativeAuthoringEnvelope(JSON.stringify({ elements: [native, ambiguous, unknown, body], components: [existing] }))))
      .toEqual({ elements: [native, ambiguous, unknown], components: [existing, body] });
  });
  it.each(['{invalid', JSON.stringify({ elements: [body], components: {} }), JSON.stringify({ elements: [body], layout: { groups: [] } })])
    ('does not guess missing JSON or a different authoring protocol: %s', (response) => {
      expect(normalizeNativeAuthoringEnvelope(response)).toBe(response);
    });
  it('defines one complete response envelope with full-text measured body boundaries', () => {
    const contract = nativeAuthoringEnvelopeContract('point-1');
    expect(contract).toContain('"elements":[{"type":"text"');
    expect(contract).toContain('"components":[{"kind":"textBox"');
    expect(contract).toContain('"contentRef":"point-1"');
    expect(contract).toContain('role:body');
    expect(contract).toContain('top + its full measured height must be <=512.5');
  });
});

// Explicit historical replay keeps envelope parsing while current quality policy retains complete drafts.
import { afterAll, vi } from 'vitest';
import { generateOpenMaicBaselineContent } from './openmaic-baseline';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';
import type { SceneOutline } from '../types/generation';
afterAll(() => closeSpatialMeasurementBrowser());
it('legacy envelope replay preserves overflowing text and records its actual measured capacity without a rewrite', async () => {
  const text = '教学方法：灵活的具体技巧，如任务驱动、支架式、抛锚式。';
  const outline = { id: 'original-overflow', type: 'slide', order: 0, title: '教学方法', description: text, keyPoints: [text],
    generationPurpose: 'knowledge-teaching', teachingBrief: { teachingPlan: { presentationContent: [text] } } } as SceneOutline;
  const raw = JSON.stringify({ elements: [native, { ...body, top: 442, paragraphRefs: ['adopted-content-1'] }] });
  const ai = vi.fn().mockResolvedValue(raw);
  const onFailure = vi.fn();
  const result = await generateOpenMaicBaselineContent(outline, ai, {
    visualProjection: false, componentAuthoring: true, slideAuthoring: 'native', textMeasure: measureAuthoredSlideText, onFailure,
  });
  expect(ai).toHaveBeenCalledOnce();
  expect(result).not.toBeNull();
  if (!result || !('elements' in result)) throw new Error('Expected complete saved native text');
  expect(onFailure).not.toHaveBeenCalled();
  const compiledBody = result.elements.find((element) => element.type === 'text' && element.id === 'original-overflow-component-0');
  expect(compiledBody).toMatchObject({ top: 442, width: 440, height: 86 });
  if (!compiledBody || compiledBody.type !== 'text') throw new Error('Expected measured editable body');
  expect(compiledBody.content.replace(/<[^>]*>/gu, '')).toBe(text);
  expect(compiledBody.content).toContain('font-size:22px');
  expect(result.qualityDiagnostics).toContainEqual(expect.stringContaining('needs 86px but its maximum allocation is 70.5px'));
  expect(raw).toContain('"fontSize":22');
  expect(raw).toContain('"top":442');
});
