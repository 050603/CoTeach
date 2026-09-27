import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { uploadMultipartWithReceipt } from './upload-request';

const fetchMock = vi.fn();
const file = new File(['image'], 'image.png', { type: 'image/png', lastModified: 10 });
function form() { const value = new FormData(); value.set('file', file); value.set('courseId', 'course'); return value; }
function success() { return Response.json({ id: 'asset', url: '/api/uploads/asset' }, { status: 201 }); }
function key(index: number) { return fetchMock.mock.calls[index][1].headers['Idempotency-Key']; }
describe('upload request identity', () => {
  beforeEach(() => { sessionStorage.clear(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); sessionStorage.clear(); });
  it('retains the operation after a lost response and reads it again after module reload', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('connection reset')).mockResolvedValueOnce(success()).mockResolvedValueOnce(success());
    await expect(uploadMultipartWithReceipt('student:course', file, form())).rejects.toThrow('connection reset');
    vi.resetModules();
    const reloaded = await import('./upload-request');
    await reloaded.uploadMultipartWithReceipt('student:course', file, form());
    expect(key(1)).toBe(key(0));
    await reloaded.uploadMultipartWithReceipt('student:course', file, form());
    expect(key(2)).not.toBe(key(0));
  });
  it('keeps a server-failed upload pending but clears an explicit conflict for a new selection', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 503 })).mockResolvedValueOnce(Response.json({}, { status: 409 })).mockResolvedValueOnce(success());
    await uploadMultipartWithReceipt('student:course', file, form());
    await uploadMultipartWithReceipt('student:course', file, form());
    await uploadMultipartWithReceipt('student:course', file, form());
    expect(key(1)).toBe(key(0));
    expect(key(2)).not.toBe(key(0));
  });
  it('separates actors and metadata while using an end-to-end header independent from request tracing', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    await uploadMultipartWithReceipt('student-a:course', file, form()).catch(() => undefined);
    await uploadMultipartWithReceipt('student-b:course', file, form()).catch(() => undefined);
    const changed = form(); changed.set('title', 'changed title');
    await uploadMultipartWithReceipt('student-a:course', file, changed).catch(() => undefined);
    expect(new Set([key(0), key(1), key(2)]).size).toBe(3);
    expect(fetchMock.mock.calls[0][1].headers['x-request-id']).toBeUndefined();
  });
  it('reuses a failed local artifact operation in the custom endpoint and multipart requestId', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce(Response.json({ versionId: 'version', uploadId: 'file' }));
    const options = { endpoint: '/api/courses/course/showcase/artifacts/pdf', requestIdField: 'requestId', receiptShape: 'artifact' as const };
    const first = form();
    await uploadMultipartWithReceipt('artifact:course', file, first, options).catch(() => undefined);
    const retry = form();
    await uploadMultipartWithReceipt('artifact:course', file, retry, options);
    expect(fetchMock.mock.calls[0][0]).toBe(options.endpoint);
    expect(first.get('requestId')).toBe(key(0));
    expect(retry.get('requestId')).toBe(key(0));
    expect(key(1)).toBe(key(0));
    expect(sessionStorage.length).toBe(0);
  });
  it('bounds a stalled request and keeps its identity for the next retry', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(success());
    const pending = uploadMultipartWithReceipt('timeout:course', file, form());
    const rejected = expect(pending).rejects.toThrow('服务器响应超时');
    await vi.advanceTimersByTimeAsync(180_000);
    await rejected;
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await uploadMultipartWithReceipt('timeout:course', file, form());
    expect(key(1)).toBe(key(0));
  });
});
