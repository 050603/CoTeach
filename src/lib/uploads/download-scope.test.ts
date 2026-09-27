import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { $queryRaw: mocks.query } }));
import { readStudentOfferingDownload } from './download-scope';
const row = { id: 'file', offeringId: 'offering', uploadedById: 'student', originalName: 'work.txt', storageKey: 'file.txt', mimeType: 'text/plain',
  resourceId: null, resourceMetadata: null, allowed: true };
describe('student download scope result', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it.each([{ rows: [] }, { rows: [{ ...row, allowed: false }] }])('treats missing files and denied offerings as terminal denials', async ({ rows }) => {
    mocks.query.mockResolvedValue(rows); expect(await readStudentOfferingDownload('student', 'file')).toEqual({ kind: 'denied' });
  });
  it('retains the legacy resolver for offering-less files even when the offering predicate denies', async () => {
    mocks.query.mockResolvedValue([{ ...row, offeringId: null, allowed: false }]);
    expect(await readStudentOfferingDownload('student', 'file')).toEqual({ kind: 'legacy' });
  });
  it('returns only download fields and preserves resource existence separately from null metadata', async () => {
    mocks.query.mockResolvedValue([{ ...row, resourceId: 'resource' }]);
    expect(await readStudentOfferingDownload('student', 'file')).toEqual({ kind: 'allowed', file: {
      id: 'file', offeringId: 'offering', uploadedById: 'student', originalName: 'work.txt', storageKey: 'file.txt', mimeType: 'text/plain', resource: { metadata: null },
    } });
  });
});
