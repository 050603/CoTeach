import { describe, expect, it, vi } from 'vitest';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import type { SlideLayoutAudit, SlideLayoutFinding } from './slide-layout-audit';
import { repairNativeRenderOnce } from './native-render-repair';

const outline: SceneOutline = { id: 'page', title: '真实观察', type: 'slide', order: 0,
  description: '保留原稿事实', keyPoints: ['至少20人，且来自同一总体。'], teachingBrief: {
    schemaVersion: 1, pptPlanningVersion: 'joint-native-pages-4615-v1',
    explanation: '', examples: [], conditions: [], evidence: [], assessmentFocus: '',
  } };
const content = (): GeneratedSlideContent => ({ elements: [{ id: 'text', type: 'text', left: 30, top: 520,
  width: 800, height: 40, rotate: 0, content: '<p style="font-size:24px">至少20人，且来自同一总体。</p>',
  defaultFontName: 'Noto Sans SC', defaultColor: '#111111' }],
  contentBindings: [{ sourceContentId: 'fact', elementId: 'text' }],
  background: { type: 'solid', color: '#FFFFFF' }, teachingText: ['来源原文'] });
const finding = (kind: string, elementId = 'text'): SlideLayoutFinding => ({
  id: `render:page:${kind}:${elementId}`, title: kind, evidence: `${kind} evidence`, elementId,
});
const auditResult = (...findings: SlideLayoutFinding[]): SlideLayoutAudit => ({ status: 'checked',
  method: 'openmaic-renderer-chromium-v1', findings,
  issues: findings.map((item) => `${item.title}：${item.evidence}（${item.elementId}）`),
  measurements: [{ id: 'text', type: 'text', box: { left: 30, top: 520, width: 800, height: 40 },
    textRects: [{ left: 30, top: 520, width: 500, height: 60 }], text: '至少20人，且来自同一总体。', fontSize: 24 }],
});
function fixture(edits: unknown[] = [{ elementId: 'text', top: 400, height: 70 }]) {
  const source = content();
  const aiCall = vi.fn(async (_system: string, user: string) => JSON.stringify({
    baseFingerprint: JSON.parse(user).baseFingerprint, edits,
  }));
  const audit = vi.fn().mockResolvedValueOnce(auditResult(finding('overflow'))).mockResolvedValue(auditResult());
  const claimAttempt = vi.fn(async () => true);
  return { outline: structuredClone(outline), content: source, aiCall, audit, claimAttempt };
}

describe('bounded native render geometry repair', () => {
  it('uses measured evidence for one patch and preserves all non-geometry fields exactly', async () => {
    const input = fixture(), saved = structuredClone(input.content);
    const result = await repairNativeRenderOnce(input);
    expect(result).toMatchObject({ attempted: true, adopted: 'patch', diagnostics: [] });
    expect(result.content).toEqual({ ...saved, elements: [{ ...saved.elements[0], top: 400, height: 70 }] });
    expect(input.content).toEqual(saved);
    expect(input.aiCall).toHaveBeenCalledOnce();
    expect(input.claimAttempt).toHaveBeenCalledOnce();
    expect(input.audit).toHaveBeenCalledTimes(2);
    expect(JSON.parse(input.aiCall.mock.calls[0]![1])).toMatchObject({
      findings: [finding('overflow')], measurements: [{ fontSize: 24, text: '至少20人，且来自同一总体。' }],
    });
  });
  it('does not audit or reserve repair for a historical contract', async () => {
    const input = fixture();
    delete input.outline.teachingBrief!.pptPlanningVersion;
    expect(await repairNativeRenderOnce(input)).toMatchObject({ content: input.content, attempted: false });
    expect(input.audit).not.toHaveBeenCalled();
    expect(input.claimAttempt).not.toHaveBeenCalled();
    expect(input.aiCall).not.toHaveBeenCalled();
  });
  it('does not reserve a request for an already readable page', async () => {
    const input = fixture();
    input.audit.mockReset().mockResolvedValue(auditResult());
    expect(await repairNativeRenderOnce(input)).toMatchObject({ attempted: false, adopted: 'original' });
    expect(input.claimAttempt).not.toHaveBeenCalled();
  });
  it('respects the durable section repair budget before asking the model', async () => {
    const input = fixture();
    input.claimAttempt.mockResolvedValue(false);
    const result = await repairNativeRenderOnce(input);
    expect(result.content).toBe(input.content);
    expect(result.diagnostics).toEqual([expect.stringContaining('一次排版修复机会已使用')]);
    expect(input.aiCall).not.toHaveBeenCalled();
  });
  it.each([
    [{ elementId: 'text', content: '<p>任何人都适用。</p>', top: 400 }],
    [{ elementId: 'text', top: 400, opacity: 0 }],
    [{ elementId: 'missing', top: 400 }],
    [{ elementId: 'text', top: 400 }, { elementId: 'text', top: 300 }],
    [{ elementId: 'text', top: -20 }],
    [{ elementId: 'text', width: 0 }],
    [{ elementId: 'text', top: 800 }],
    [],
  ])('retains the original after an unsafe or unusable patch: %j', async (...entries) => {
    // Vitest spreads each outer row; gather that row's element edits.
    const input = fixture(entries);
    const result = await repairNativeRenderOnce(input);
    expect(result.content).toBe(input.content);
    expect(result.adopted).toBe('original');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(input.audit).toHaveBeenCalledOnce();
  });
  it('rejects shrinking or distorting a required observation image', async () => {
    for (const geometry of [{ width: 100 }, { width: 400 }]) {
      const input = fixture([{ elementId: 'image', ...geometry }]);
      input.content.elements.push({ id: 'image', type: 'image', src: '/same-source.png', left: 0, top: 0,
        width: 200, height: 200, rotate: 0, fixedRatio: true });
      const saved = structuredClone(input.content);
      expect((await repairNativeRenderOnce(input)).adopted).toBe('original');
      expect(input.content).toEqual(saved);
    }
  });
  it.each([auditResult(finding('overflow')), auditResult(finding('small-type')),
    auditResult(finding('overlap-new', 'text'))])('rejects unchanged severity or any newly introduced finding', async (after) => {
    const input = fixture();
    input.audit.mockReset().mockResolvedValueOnce(auditResult(finding('overflow'))).mockResolvedValueOnce(after);
    const result = await repairNativeRenderOnce(input);
    expect(result.adopted).toBe('original');
    expect(result.content).toBe(input.content);
    expect(input.aiCall).toHaveBeenCalledOnce();
  });
  it('requires no new findings even when the severe finding count falls', async () => {
    const input = fixture();
    input.audit.mockReset().mockResolvedValueOnce(auditResult(finding('overflow'), finding('box-overflow')))
      .mockResolvedValueOnce(auditResult(finding('small-type')));
    expect((await repairNativeRenderOnce(input)).adopted).toBe('original');
  });
  it('does not mistake a collision with a different colon-qualified target for an old finding', async () => {
    const input = fixture();
    input.audit.mockReset().mockResolvedValueOnce(auditResult(finding('overflow'), finding('collision-group:first')))
      .mockResolvedValueOnce(auditResult(finding('collision-group:second')));
    expect((await repairNativeRenderOnce(input)).adopted).toBe('original');
  });
  it('does not adopt a patch with a new structural error even when rendered overflow disappears', async () => {
    const input = fixture();
    input.audit.mockReset().mockResolvedValueOnce(auditResult(finding('overflow')))
      .mockResolvedValueOnce({ ...auditResult(), issues: ['table cells malformed'] });
    expect((await repairNativeRenderOnce(input)).adopted).toBe('original');
  });
  it('adopts a strictly improved patch with unresolved original problems recorded', async () => {
    const input = fixture();
    input.audit.mockReset().mockResolvedValueOnce(auditResult(finding('overflow'), finding('box-overflow')))
      .mockResolvedValueOnce(auditResult(finding('box-overflow')));
    expect(await repairNativeRenderOnce(input)).toMatchObject({ adopted: 'patch',
      diagnostics: [expect.stringContaining('仍有 1 项')] });
  });
  it('refuses to detach labels or nodes in an existing diagram', async () => {
    const input = fixture();
    input.outline.visualIntent = { representation: 'native-diagram', observationGoal: '真实顺序',
      diagram: { topology: 'sequence', nodes: [{ id: 'a', label: '观察' }, { id: 'b', label: '判断' }] } };
    input.content.elements.push({ ...input.content.elements[0]!, id: 'second', top: 200 });
    expect((await repairNativeRenderOnce(input)).adopted).toBe('original');
  });
  it('keeps a connected diagram intact during uniform translation', async () => {
    const input = fixture([{ elementId: 'text', top: 400 }, { elementId: 'edge', top: 180 }]);
    input.content.elements.push({ id: 'edge', type: 'line', left: 40, top: 300, width: 100,
      start: [0, 0], end: [100, 0], style: 'solid', color: '#111111', points: ['', 'arrow'] });
    const savedEdge = structuredClone(input.content.elements[1]);
    const result = await repairNativeRenderOnce(input);
    expect(result.adopted).toBe('patch');
    expect(result.content.elements[1]).toEqual({ ...savedEdge, top: 180 });
  });
  it.each(['initial', 'candidate'])('keeps the draft if %s measurements are unavailable', async (phase) => {
    const input = fixture();
    const unavailable: SlideLayoutAudit = { status: 'unavailable', method: 'openmaic-renderer-chromium-v1', issues: [], reason: 'no browser' };
    input.audit.mockReset();
    if (phase === 'candidate') input.audit.mockResolvedValueOnce(auditResult(finding('overflow')));
    input.audit.mockResolvedValue(unavailable);
    expect((await repairNativeRenderOnce(input)).content).toBe(input.content);
    expect(input.aiCall).toHaveBeenCalledTimes(phase === 'initial' ? 0 : 1);
  });
  it.each(['provider', 'persistence', 'audit', 'abort'])('propagates %s errors without consuming another model attempt', async (stage) => {
    const input = fixture(), error = new Error(stage);
    if (stage === 'provider') input.aiCall.mockRejectedValue(error);
    if (stage === 'persistence') input.claimAttempt.mockRejectedValue(error);
    if (stage === 'audit') input.audit.mockRejectedValue(error);
    if (stage === 'abort') {
      error.name = 'AbortError';
      input.aiCall.mockRejectedValue(error);
    }
    await expect(repairNativeRenderOnce(input)).rejects.toBe(error);
    expect(input.aiCall.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it('rejects a response for a different original as an identity error', async () => {
    const input = fixture();
    input.aiCall.mockResolvedValue(JSON.stringify({ baseFingerprint: 'old-draft', edits: [] }));
    await expect(repairNativeRenderOnce(input)).rejects.toMatchObject({ code: 'NATIVE_RENDER_REPAIR_IDENTITY_MISMATCH' });
  });
  it.each(['', 'not JSON'])('preserves technical errors for an empty or unparseable response', async (response) => {
    const input = fixture();
    input.aiCall.mockResolvedValue(response);
    await expect(repairNativeRenderOnce(input)).rejects.toThrow('unparseable JSON');
  });
});
