import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { assessProactiveDocumentComment } from './document-comment-policy';
import { singleReviewResponse } from './single-review-response';
import type { StructuredModelAttempt } from './recorded-structured-response';

const documentText = '改造前用电10度，改造后用电12度，所以节省2度电。';
const positive = { shouldComment: true, severity: 'critical', needsInterventionNow: true, issueType: '数据矛盾',
  quotedText: '所以节省2度电', evidenceSource: 'document', evidenceQuote: '改造前用电10度，改造后用电12度',
  impact: '这会导致错误评价项目的节能效果', comment: '可以先核对改造前后的数值，再计算节能量。' };
function setup(values: unknown[]) {
  const records: StructuredModelAttempt[] = [];
  let index = 0;
  const generate = vi.fn<(repairInstruction?: string) => Promise<string>>(async () => {
    const value = values[index++];
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
  const input = { generate, parse: JSON.parse, record: async (attempt: StructuredModelAttempt) => { records.push(attempt); }, signal: new AbortController().signal };
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
  it.each(['{broken', '{}'])('retains malformed output without broadening retries for %s', async raw => {
    const test = setup([raw]);
    await expect(singleReviewResponse(test.input)).rejects.toThrow('AI_REVIEW_INVALID_STRUCTURE');
    expect(test.generate).toHaveBeenCalledTimes(1); expect(test.records[0].raw).toBe(raw);
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
});
