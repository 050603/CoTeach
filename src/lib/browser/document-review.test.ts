import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeDocumentReview, queueDocumentReview, readPendingDocumentReviews, type DocumentReviewBody } from './document-review';
import { documentVersionDigest } from '@/lib/ai-collaboration/document-version';

const body = (): DocumentReviewBody => ({ action: 'proactive-document-comments', courseId: 'course', studentId: 'student',
  stageKey: 'make', workspaceKind: 'document', documentHtml: '<p>完整草稿</p>',
  paragraphs: [{ candidateId: 'block:p1', blockId: 'p1', blockIndex: 0, targetText: '完整草稿' }] });
const scope = 'course:student:make:document';
beforeEach(() => localStorage.clear());
describe('durable automatic document review', () => {
  it('keeps surrounding document whitespace unchanged through the saved request and receipt', async () => {
    const original = { ...body(), documentHtml: ' \n<p>完整草稿</p>\t ' };
    const pending = queueDocumentReview(original);
    expect(JSON.parse(pending.body).documentHtml).toBe(original.documentHtml);
    const documentVersion = await documentVersionDigest(original.documentHtml);
    expect(await acknowledgeDocumentReview(pending, { requestId: pending.requestId, status: 'completed', documentVersion,
      reviewDecision: { action: original.action, documentVersion } })).toBe(true);
  });
  it('refuses oversized context before adding any pending request', () => {
    expect(() => queueDocumentReview({ ...body(), documentHtml: '稿'.repeat(120_001) })).toThrow('120000');
    expect(readPendingDocumentReviews(scope)).toEqual([]);
  });
  it('keeps identical request ID and bytes across offline retry and a new page reading storage', () => {
    const first = queueDocumentReview(body());
    expect(queueDocumentReview(body())).toEqual(first);
    expect(readPendingDocumentReviews(scope)).toEqual([first]);
    expect(JSON.parse(first.body).requestId).toBe(first.requestId);
  });
  it('does not replace an older request when the document, candidate or user changes', () => {
    const first = queueDocumentReview(body());
    const changed = queueDocumentReview({ ...body(), documentHtml: '<p>新草稿</p>' });
    const other = queueDocumentReview({ ...body(), studentId: 'other' });
    expect(new Set([first.requestId, changed.requestId, other.requestId]).size).toBe(3);
    expect(readPendingDocumentReviews(scope)).toEqual([first, changed]);
    expect(readPendingDocumentReviews('course:other:make:document')).toEqual([other]);
  });
  it('acknowledges only the original request after a newer document was queued', async () => {
    const old = queueDocumentReview(body());
    const next = queueDocumentReview({ ...body(), documentHtml: '<p>后来的编辑</p>' });
    const documentVersion = await documentVersionDigest(body().documentHtml);
    const receipt = { requestId: old.requestId, status: 'completed', documentVersion,
      reviewDecision: { action: body().action, documentVersion } };
    expect(await acknowledgeDocumentReview(old, receipt)).toBe(true);
    expect(readPendingDocumentReviews(scope)).toEqual([next]);
    expect(await acknowledgeDocumentReview(next, receipt)).toBe(false);
    expect(readPendingDocumentReviews(scope)).toEqual([next]);
  });
  it('keeps pending and failed requests until a complete task receipt confirms the original document', async () => {
    const pending = queueDocumentReview(body());
    for (const status of ['processing', 'failed', undefined]) expect(await acknowledgeDocumentReview(pending, { requestId: pending.requestId, status })).toBe(false);
    expect(await acknowledgeDocumentReview(pending, { requestId: 'other', status: 'completed' })).toBe(false);
    await expect(acknowledgeDocumentReview(pending, { requestId: pending.requestId, status: 'completed', documentVersion: 'wrong' })).rejects.toThrow('回执');
    expect(readPendingDocumentReviews(scope)).toEqual([pending]);
    const documentVersion = await documentVersionDigest(body().documentHtml);
    expect(await acknowledgeDocumentReview(pending, { requestId: pending.requestId, status: 'completed', documentVersion,
      reviewDecision: { action: body().action, documentVersion } })).toBe(true);
    expect(readPendingDocumentReviews(scope)).toEqual([]);
    expect(queueDocumentReview(body()).requestId).not.toBe(pending.requestId);
  });
  it('accepts explicit cancellation without letting its ID be reused for a new request', async () => {
    const pending = queueDocumentReview(body());
    expect(await acknowledgeDocumentReview(pending, { requestId: pending.requestId, status: 'cancelled' })).toBe(true);
    expect(queueDocumentReview(body()).requestId).not.toBe(pending.requestId);
  });
  it('fails before sending if storage is unavailable and never erases damaged evidence', async () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('quota'); });
    expect(() => queueDocumentReview(body())).toThrow('quota'); write.mockRestore();
    const pending = queueDocumentReview(body());
    localStorage.setItem(pending.key, 'damaged');
    expect(() => readPendingDocumentReviews(scope)).toThrow();
    await expect(acknowledgeDocumentReview(pending, { requestId: pending.requestId, status: 'cancelled' })).rejects.toThrow('旧回执');
    expect(localStorage.getItem(pending.key)).toBe('damaged');
  });
});
