import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import type { GeneratedSlideContent, SceneOutline } from '@openmaic/lib/types/generation';
import type { SlideLayoutAudit, SlideLayoutRepairResult } from './slide-layout-audit';

const { audit } = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock('./slide-layout-audit', () => ({ auditAndRepairSlideOnce: audit }));

import { auditGeneratedSlideLocally, collectNarrationAdvisories } from './course-generation-policy';

const outline: SceneOutline = { id: 'page', type: 'slide', title: '理解独立测试', description: '解释测试的作用', keyPoints: ['独立检验'], order: 0 };
const content: GeneratedSlideContent = { elements: [] };

describe('shared first-pass course policy', () => {
  beforeEach(() => audit.mockReset());

  it.each([
    { status: 'checked', issues: [] },
    { status: 'checked', issues: ['文本与箭头重叠'] },
    { status: 'unavailable', issues: [], reason: '浏览器不可用' },
  ] satisfies Array<Pick<SlideLayoutAudit, 'status' | 'issues' | 'reason'>>)(
    'preserves $status audit evidence while making model repair unavailable', async (finding) => {
      const result = { content, initialAudit: finding, finalAudit: finding, repairAttempted: false, adopted: 'first-draft' } as SlideLayoutRepairResult;
      audit.mockImplementationOnce(async (input) => {
        expect(input.outline).toBe(outline);
        expect(input.content).toBe(content);
        // Even when the local auditor requests a repair, the only supplied
        // callback produces no candidate and has no model call dependency.
        await expect(input.regenerate('修复测量到的缺陷', content)).resolves.toBeNull();
        return result;
      });
      await expect(auditGeneratedSlideLocally(outline, content)).resolves.toBe(result);
      expect(audit).toHaveBeenCalledOnce();
    },
  );

  it('reports long or document-like speech without mutating or rejecting it', () => {
    const actions: Action[] = [
      { id: 'long', type: 'speech', text: `这一页${'需要根据实际证据解释原因'.repeat(15)}。` },
      { id: 'short', type: 'speech', text: '先看这组照片。' },
      { id: 'gate', type: 'speech', text: '' },
    ];
    const before = structuredClone(actions);
    const findings = collectNarrationAdvisories(actions);
    expect(findings).toEqual(expect.arrayContaining([expect.stringContaining('页面制作视角'), expect.stringContaining('长句')]));
    expect(findings.every((finding) => !finding.startsWith('short') && !finding.startsWith('gate'))).toBe(true);
    expect(actions).toEqual(before);
    expect(audit).not.toHaveBeenCalled();
  });

  it('accepts a brief, directly understandable explanation without filling a word quota', () => {
    expect(collectNarrationAdvisories([{ id: 'short', type: 'speech', text: '先看这组照片。' }])).toEqual([]);
  });
});
