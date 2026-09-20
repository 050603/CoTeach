import { describe, expect, it, vi } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { reviewSlideInstructionalContent } from './slide-content-review';

const outline: SceneOutline = { id: 'inquiry', type: 'slide', title: '探究案例', description: '根据实验结果检验假设', keyPoints: [], order: 0 };
const assertedConclusion = '训练轮数与准确率正相关';
const pendingConclusion = '根据实验记录判断假设是否得到支持';
const actualResult = '同一测试集上，5轮准确率80%，10轮准确率85%。';
const elements = (conclusion: string, records = ''): PPTElement[] => [{
  id: 'example', type: 'text', left: 60, top: 160, width: 800, height: 240,
  content: `<p>提出假设：增大训练轮数会提升准确率</p><p>实验验证：调试模型观察准确率变化</p><p>归纳结论：${conclusion}</p>${records ? `<p>实验记录：${records}</p>` : ''}`,
}] as PPTElement[];
const grounding = (visibleQuote: string, values: Record<string, unknown> = {}) => ({
  index: 0, visibleQuote, status: 'pending', evidenceOrigin: 'none', evidenceQuotes: [], reason: '材料仅说明探究流程，没有实际实验结果', ...values,
});
const response = (entries: unknown) => JSON.stringify({ blockingIssues: [], keyPointCoverage: [], conclusionGrounding: entries });

describe('inquiry conclusion evidence review', () => {
  it('rejects the observed unsupported conclusion even if review labels it pending', async () => {
    const ai = vi.fn().mockResolvedValue(response([grounding(assertedConclusion)]));
    const issues = await reviewSlideInstructionalContent(outline, elements(assertedConclusion), '调试模型参数、观察结果变化并归纳规律。', ai);
    expect(issues).toEqual([expect.stringContaining('页面却写成确定结论')]);
    expect(ai.mock.calls[0][0]).toContain('A hypothesis, experiment instructions, a generic method');
    const input = JSON.parse(ai.mock.calls[0][1]);
    expect(input.inquiryCaseConclusions).toEqual([{ index: 0, visibleQuote: assertedConclusion }]);
    expect(input.visibleInquiryData).not.toContain('增大训练轮数会提升准确率');
    expect(input.visibleInquiryData).not.toContain(assertedConclusion);
  });

  it('accepts a conclusion that visibly remains open until results are available', async () => {
    const ai = vi.fn().mockResolvedValue(response([grounding(pendingConclusion)]));
    expect(await reviewSlideInstructionalContent(outline, elements(pendingConclusion), '', ai)).toEqual([]);
  });

  it('checks the 得出结论 label and permits an open workflow step without asserting an outcome', async () => {
    const conclusion = '归纳影响因素与规律';
    const page = elements(conclusion).map((element) => element.type === 'text' ? { ...element, content: element.content.replace('归纳结论', '得出结论') } : element);
    const ai = vi.fn().mockResolvedValue(response([grounding(conclusion)]));
    expect(await reviewSlideInstructionalContent(outline, page, '', ai)).toEqual([]);
    expect(JSON.parse(ai.mock.calls[0][1]).inquiryCaseConclusions).toHaveLength(1);
  });

  it('validates providers that echo the input collection name without dropping the evidence check', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ blockingIssues: [], keyPointCoverage: [], inquiryCaseConclusions: [grounding(assertedConclusion)] }));
    expect(await reviewSlideInstructionalContent(outline, elements(assertedConclusion), '', ai))
      .toEqual([expect.stringContaining('页面却写成确定结论')]);
  });

  it('accepts a result supported by exact source observations within their stated scope', async () => {
    const conclusion = '在本次两组实验中，10轮准确率高于5轮';
    const ai = vi.fn().mockResolvedValue(response([grounding(conclusion, {
      status: 'supported', evidenceOrigin: 'source', evidenceQuotes: [actualResult], reason: '材料给出的两组准确率支持本次比较',
    })]));
    expect(await reviewSlideInstructionalContent(outline, elements(conclusion), `实验记录：${actualResult}`, ai)).toEqual([]);
  });

  it('accepts actual visible records without using hypotheses or conclusions as evidence', async () => {
    const conclusion = '本次实验中10轮准确率高于5轮';
    const ai = vi.fn().mockResolvedValue(response([grounding(conclusion, {
      status: 'supported', evidenceOrigin: 'visible-data', evidenceQuotes: [actualResult], reason: '页面明确呈现两组实测结果',
    })]));
    expect(await reviewSlideInstructionalContent(outline, elements(conclusion, actualResult), '', ai)).toEqual([]);
  });

  it.each(['source', 'visible-data', 'none'])('rejects invented or absent result evidence from %s', async (evidenceOrigin) => {
    const ai = vi.fn().mockResolvedValue(response([grounding(assertedConclusion, {
      status: 'supported', evidenceOrigin, evidenceQuotes: [actualResult], reason: '据称存在实验数据',
    })]));
    expect(await reviewSlideInstructionalContent(outline, elements(assertedConclusion), '只要求调参和观察变化。', ai))
      .toEqual([expect.stringContaining('没有真实的结果证据')]);
  });

  it('rejects a conclusion quoted as its own visible result evidence', async () => {
    const ai = vi.fn().mockResolvedValue(response([grounding(assertedConclusion, {
      status: 'supported', evidenceOrigin: 'visible-data', evidenceQuotes: [assertedConclusion], reason: '引用页面结论',
    })]));
    expect(await reviewSlideInstructionalContent(outline, elements(assertedConclusion), '', ai))
      .toEqual([expect.stringContaining('没有真实的结果证据')]);
  });

  it.each([undefined, null, [], [null], [{ ...grounding(pendingConclusion), index: undefined }],
    [grounding(pendingConclusion), grounding(pendingConclusion)]])('rejects missing, null or duplicate conclusion coverage: %j', async (entries) => {
    const ai = vi.fn().mockResolvedValue(response(entries));
    await expect(reviewSlideInstructionalContent(outline, elements(pendingConclusion), '', ai))
      .rejects.toMatchObject({ isRetryable: false, message: expect.stringContaining('未逐项核查实验结论') });
  });

  it('retains the existing review contract for pages without all three inquiry labels', async () => {
    const page = [{ id: 'ordinary', type: 'text', left: 60, top: 160, width: 800, height: 90, content: '<p>结论：学生通过反思修正理解</p>' }] as PPTElement[];
    const ai = vi.fn().mockResolvedValue('{"blockingIssues":[],"keyPointCoverage":[]}');
    expect(await reviewSlideInstructionalContent(outline, page, '', ai)).toEqual([]);
    expect(JSON.parse(ai.mock.calls[0][1])).not.toHaveProperty('inquiryCaseConclusions');
  });
});
