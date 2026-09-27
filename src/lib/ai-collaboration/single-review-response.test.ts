import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { assessProactiveDocumentComment } from './document-comment-policy';
import { singleReviewResponse, type SingleReviewAttempt } from './single-review-response';

const documentText = '改造前用电10度，改造后用电12度，所以节省2度电。';
const positive = { shouldComment: true, severity: 'critical', needsInterventionNow: true, issueType: '数据矛盾',
  quotedText: '所以节省2度电', evidenceSource: 'document', evidenceQuote: '改造前用电10度，改造后用电12度',
  impact: '这会导致错误评价项目的节能效果', comment: '可以先核对改造前后的数值，再计算节能量。' };
function setup(values: unknown[]) {
  const records: SingleReviewAttempt[] = [];
  let index = 0;
  const generate = vi.fn<(repairInstruction?: string) => Promise<string>>(async () => {
    const value = values[index++];
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
  const input = { generate, parse: JSON.parse, evidenceContext: { targetText: documentText, documentText }, record: async (attempt: SingleReviewAttempt) => { records.push(attempt); }, signal: new AbortController().signal };
  return { input, records, generate };
}
describe('single positive review structure repair', () => {
  it('records missing-source output before one explicit repair and retains both raw hashes', async () => {
    const missing = { ...positive, evidenceSource: undefined };
    const test = setup([missing, positive]);
    const result = await singleReviewResponse(test.input);
    expect(test.generate).toHaveBeenCalledTimes(2);
    expect(test.generate.mock.calls[1]?.[0]).toContain('evidenceSource');
    expect(test.records.map(item => [item.attempt, item.validation])).toEqual([[1, 'invalid-schema'], [2, 'valid']]);
    expect(test.records[0].raw).toBe(JSON.stringify(missing));
    for (const raw of test.records) expect(raw.sha256).toBe(createHash('sha256').update(raw.raw).digest('hex'));
    expect(assessProactiveDocumentComment(result, { targetText: documentText, documentText }).result.shouldComment).toBe(true);
  });
  it('never manufactures source when the repair is also missing it', async () => {
    const missing = { ...positive, evidenceSource: undefined };
    const test = setup([missing, missing]);
    await expect(singleReviewResponse(test.input)).rejects.toThrow('AI_RESPONSE_INVALID_STRUCTURE');
    expect(test.generate).toHaveBeenCalledTimes(2); expect(test.records).toHaveLength(2);
    expect(test.records.every(item => item.validation === 'invalid-schema')).toBe(true);
  });
  it.each([{ shouldComment: false, comment: '' }, { ...positive, evidenceSource: 'untrusted' }, { ...positive, evidenceQuote: '不存在的独立证据' }])('does not retry complete decisions or semantic policy rejections %#', async value => {
    const test = setup([value]);
    const result = await singleReviewResponse(test.input);
    expect(test.generate).toHaveBeenCalledTimes(1); expect(test.records).toHaveLength(1);
    expect(assessProactiveDocumentComment(result, { targetText: documentText, documentText }).result.shouldComment).toBe(false);
  });
  it('accepts a genuine no-comment after repair without fabricating a positive proposal', async () => {
    const test = setup([{ ...positive, evidenceSource: undefined }, { shouldComment: false }]);
    expect(await singleReviewResponse(test.input)).toEqual({ shouldComment: false });
  });
  it.each(['{broken', '{}'])('retains both malformed outputs and fails after one repair for %s', async raw => {
    const test = setup([raw, raw]);
    await expect(singleReviewResponse(test.input)).rejects.toThrow('AI_RESPONSE_INVALID_STRUCTURE');
    expect(test.generate).toHaveBeenCalledTimes(2); expect(test.records.map(item => item.raw)).toEqual([raw, raw]);
  });
  it('does not retry after a raw persistence failure', async () => {
    const test = setup([{ ...positive, evidenceSource: undefined }, positive]);
    test.input.record = async () => { throw new Error('AUDIT_UNAVAILABLE'); };
    await expect(singleReviewResponse(test.input)).rejects.toThrow('AUDIT_UNAVAILABLE');
    expect(test.generate).toHaveBeenCalledTimes(1);
  });
  it('records returned raw before noticing cancellation and never repairs an aborted call', async () => {
    const test = setup([]); const controller = new AbortController();
    test.input.signal = controller.signal;
    test.input.generate = vi.fn(async () => { controller.abort(); return JSON.stringify(positive); });
    await expect(singleReviewResponse(test.input)).rejects.toThrow();
    expect(test.records).toHaveLength(1); expect(test.input.generate).toHaveBeenCalledTimes(1);
  });
  it('repairs the observed unescaped inner quotes through the model, never a local text substitution', async () => {
    const raw = JSON.stringify(positive).replace(positive.impact, '把耗电增加说成节省，会让"用测量证据比较改进前后用电量"这个核心结论方向反了');
    const test = setup([raw, positive]);
    const result = await singleReviewResponse(test.input);
    expect(result).toEqual(positive);
    expect(test.records[0]).toMatchObject({ raw, validation: 'invalid-json', attempt: 1 });
    expect(test.generate.mock.calls[1]?.[0]).toContain('双引号');
    expect(test.records[1]).toMatchObject({ validation: 'valid', policyReasonCodes: [] });
  });
  it('repairs a full-paragraph target only when the strict policy rejects solely overlapping evidence', async () => {
    const original = { ...positive, quotedText: documentText };
    const test = setup([original, positive]);
    expect(await singleReviewResponse(test.input)).toEqual(positive);
    expect(test.records[0]).toMatchObject({ raw: JSON.stringify(original), validation: 'valid', policyReasonCodes: ['EVIDENCE_NOT_INDEPENDENT'] });
    expect(test.generate.mock.calls[1]?.[0]).toContain('EVIDENCE_NOT_INDEPENDENT');
    expect(test.generate.mock.calls[1]?.[0]).toContain('不能相互包含');
    expect(test.records[1]).toMatchObject({ validation: 'valid', policyReasonCodes: [] });
  });
  it('never bypasses strict policy when the model repeats an overlapping quote after repair', async () => {
    const original = { ...positive, quotedText: documentText };
    const test = setup([original, original]);
    const result = await singleReviewResponse(test.input);
    expect(result).toEqual(original);
    expect(assessProactiveDocumentComment(result, test.input.evidenceContext).decision.reasonCodes).toEqual(['EVIDENCE_NOT_INDEPENDENT']);
    expect(test.generate).toHaveBeenCalledTimes(2);
    expect(test.records.every(item => item.policyReasonCodes?.[0] === 'EVIDENCE_NOT_INDEPENDENT')).toBe(true);
  });
  it('does not invent independent evidence or retry missing authoritative course evidence', async () => {
    const original = { ...positive, quotedText: documentText, evidenceQuote: documentText, evidenceSource: 'course' };
    const test = setup([original]);
    expect(await singleReviewResponse(test.input)).toEqual(original);
    expect(test.generate).toHaveBeenCalledTimes(1);
    expect(test.records[0].policyReasonCodes).toEqual(['EVIDENCE_NOT_IN_COURSE']);
  });
  it('never allows a third call when a malformed response is followed by an overlapping quote', async () => {
    const original = { ...positive, quotedText: documentText };
    const test = setup(['{invalid', original]);
    const result = await singleReviewResponse(test.input);
    expect(test.generate).toHaveBeenCalledTimes(2);
    expect(assessProactiveDocumentComment(result, test.input.evidenceContext).result.shouldComment).toBe(false);
  });

  it('does not retry an overlap proposal with additional policy failures', async () => {
    const original = { ...positive, severity: 'style', quotedText: documentText };
    const test = setup([original]);
    expect(await singleReviewResponse(test.input)).toEqual(original);
    expect(test.generate).toHaveBeenCalledTimes(1);
    expect(test.records[0].policyReasonCodes).toEqual(['NOT_CRITICAL', 'EVIDENCE_NOT_INDEPENDENT']);
  });

});
