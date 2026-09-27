import { clientUUID } from '@/lib/uuid';
import { documentVersionDigest } from '@/lib/ai-collaboration/document-version';
import { readDocumentRequestHtml } from '@/lib/ai-collaboration/document-request-input';

export type DocumentReviewBody = {
  action: 'proactive-document-comments';
  courseId: string; studentId: string; stageKey: string; workspaceKind: string;
  paragraphs: Array<{ candidateId: string; blockId?: string; blockIndex: number; targetText: string }>;
  documentHtml: string;
};
export type PendingDocumentReview = {
  key: string; scope: string; requestId: string; createdAt: number;
  /** The exact serialized request is immutable across transport retries. */
  body: string;
};
const prefix = 'openpbl:document-review:v1:';
const scopeFor = (body: DocumentReviewBody) => `${body.courseId}:${body.studentId}:${body.stageKey}:${body.workspaceKind}`;
const scopedPrefix = (scope: string) => `${prefix}${encodeURIComponent(scope)}:`;

export function readPendingDocumentReviews(scope: string): PendingDocumentReview[] {
  const rows: PendingDocumentReview[] = [];
  for (const key of Object.keys(localStorage).filter(key => key.startsWith(scopedPrefix(scope)))) {
    const row = JSON.parse(localStorage.getItem(key) ?? 'null') as PendingDocumentReview | null;
    if (!row || row.key !== key || row.scope !== scope || typeof row.requestId !== 'string' || !row.requestId
      || key !== `${scopedPrefix(scope)}${row.requestId}` || typeof row.body !== 'string' || !Number.isFinite(row.createdAt)) {
      throw new Error('本机批注请求记录无法读取，请保留此浏览器中的记录。');
    }
    const body = JSON.parse(row.body) as DocumentReviewBody & { requestId: string };
    if (body.requestId !== row.requestId || body.action !== 'proactive-document-comments' || scopeFor(body) !== scope
      || typeof body.documentHtml !== 'string' || !Array.isArray(body.paragraphs) || !body.paragraphs.length
      || body.paragraphs.some(item => !item || typeof item.candidateId !== 'string' || typeof item.targetText !== 'string'
        || !Number.isInteger(item.blockIndex) || item.blockIndex < 0)) {
      throw new Error('本机批注请求内容与其归属不一致。');
    }
    rows.push(row);
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId));
}

/** Persist before sending. Repeated scheduling cannot replace an unacknowledged request. */
export function queueDocumentReview(body: DocumentReviewBody): PendingDocumentReview {
  if (!readDocumentRequestHtml(body.documentHtml).ok) throw new Error('文档超过自动 AI 审阅的 120000 字符上限；此次未发送审阅请求，文档保存功能仍可使用。');
  const scope = scopeFor(body);
  const existing = readPendingDocumentReviews(scope);
  const content = JSON.stringify(body);
  const previous = existing.find(row => {
    const { requestId: _requestId, ...stored } = JSON.parse(row.body) as DocumentReviewBody & { requestId: string };
    void _requestId;
    return JSON.stringify(stored) === content;
  });
  if (previous) return previous;
  const requestId = `document-review-${clientUUID()}`;
  const row = { key: `${scopedPrefix(scope)}${requestId}`, scope, requestId,
    createdAt: Math.max(Date.now(), (existing.at(-1)?.createdAt ?? 0) + 1), body: JSON.stringify({ ...body, requestId }) };
  localStorage.setItem(row.key, JSON.stringify(row));
  return row;
}

/** A transport success, processing response, or other document's ACK is insufficient. */
export async function acknowledgeDocumentReview(row: PendingDocumentReview, payload: unknown): Promise<boolean> {
  if (!payload || typeof payload !== 'object') return false;
  const ack = payload as { requestId?: unknown; status?: unknown; documentVersion?: unknown;
    reviewDecision?: { action?: unknown; documentVersion?: unknown } };
  if (ack.requestId !== row.requestId || (ack.status !== 'completed' && ack.status !== 'cancelled')) return false;
  if (ack.status === 'completed') {
    const body = JSON.parse(row.body) as DocumentReviewBody;
    const version = await documentVersionDigest(body.documentHtml);
    if (!version || ack.documentVersion !== version || ack.reviewDecision?.documentVersion !== version
      || ack.reviewDecision?.action !== body.action) throw new Error('批注回执与本机请求不一致，已保留待同步记录。');
  }
  // A stale response cannot erase a replacement/corrupted local entry.
  const current = localStorage.getItem(row.key);
  if (current !== null && current !== JSON.stringify(row)) throw new Error('本机批注请求已变化，拒绝用旧回执清除。');
  if (current !== null) localStorage.removeItem(row.key);
  return true;
}
