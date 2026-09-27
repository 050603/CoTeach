import { browserRandomUUID } from './random-uuid';
import { boundedFetch } from './bounded-fetch';

const PREFIX = 'openpbl.upload-request.v1:';
/** Keep the logical operation across response loss, reselection and a page reload.
 * The server checks a cryptographic content fingerprint; this local key identifies
 * the pending file selection and never decides whether two uploads are equal. */
export async function uploadMultipartWithReceipt(scope: string, file: File, body: FormData,
  options: { endpoint?: string; requestIdField?: string; receiptShape?: 'upload' | 'artifact' } = {},
): Promise<Response> {
  const endpoint = options.endpoint ?? '/api/uploads';
  const metadata = Array.from(body.entries()).filter(([name, value]) => typeof value === 'string' && name !== options.requestIdField).sort(([a], [b]) => a.localeCompare(b));
  const key = PREFIX + encodeURIComponent(JSON.stringify([options.endpoint ? `${scope}:${endpoint}` : scope, file.name, file.size, file.type, file.lastModified, metadata]));
  const requestId = sessionStorage.getItem(key) || browserRandomUUID();
  sessionStorage.setItem(key, requestId);
  if (options.requestIdField) body.set(options.requestIdField, requestId);
  const acknowledge = () => { if (sessionStorage.getItem(key) === requestId) sessionStorage.removeItem(key); };
  const response = await boundedFetch(endpoint, { method: 'POST', headers: { 'Idempotency-Key': requestId }, body }, 180_000);
  if (response.ok) {
    const payload = await response.clone().json() as { id?: string; url?: string; requestId?: string; versionId?: string; uploadId?: string };
    if (options.receiptShape === 'artifact' ? !payload.versionId || !payload.uploadId : !payload.id || !payload.url) throw new Error('上传结果尚未确认，请重新选择同一文件重试。');
    acknowledge();
  } else if ([400, 403, 404, 409, 413, 415, 422].includes(response.status)) {
    // Explicit rejection did not accept this operation. A new selection may retry
    // with changed content/metadata, while 5xx/network failures retain the key.
    acknowledge();
  }
  return response;
}
