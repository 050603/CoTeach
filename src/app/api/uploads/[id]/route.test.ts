// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ file: vi.fn(), resource: vi.fn(), update: vi.fn(), remove: vi.fn(), count: vi.fn(),
  access: vi.fn(), templateAccess: vi.fn(), query: vi.fn(), claims: { sub: 'teacher-1', role: 'teacher' }, event: vi.fn(), resourceUpdate: vi.fn() }));
vi.mock('@/lib/auth/request-guards', () => ({ authenticateRequest: async () => ({ claims: mocks.claims }), requireSameOrigin: () => null }));
vi.mock('@/lib/platform/access', () => ({ canAccessLegacyCourse: mocks.access }));
vi.mock('@/lib/db/client', () => {
  const tx = { $queryRaw: mocks.query, fileAsset: { findFirst: mocks.file, update: mocks.update }, resource: { findFirst: mocks.resource, findUniqueOrThrow: mocks.resource, update: mocks.resourceUpdate, delete: mocks.remove },
    artifactVersion: { count: mocks.count }, courseOffering: { update: async () => ({ version: 2 }) }, domainEvent: { create: mocks.event } };
  return { prisma: { ...tx, $transaction: async (fn: (db: typeof tx) => unknown) => fn(tx) } };
});
vi.mock("@/lib/uploads/scope", () => ({ canReadTemplateAsset: mocks.templateAccess }));
import { DELETE, GET, PATCH } from './route';
const id = '11111111-1111-4111-8111-111111111111';
const context = { params: Promise.resolve({ id }) };
const resource = { id, offeringId: 'offering-1', type: 'PDF', metadata: { stageKey: 'practice' }, fileAsset: { deletedAt: null } };
const file = { id, offeringId: 'offering-1', uploadedById: 'teacher-1', originalName: 'lesson.pdf', storageKey: `${id}.pdf`, mimeType: 'application/pdf', resource, artifactVersions: [] };
const target = path.resolve('.openpbl-data/uploads', file.storageKey);
beforeEach(() => { vi.clearAllMocks(); mocks.claims = { sub: 'teacher-1', role: 'teacher' }; mocks.access.mockResolvedValue(true); mocks.templateAccess.mockResolvedValue(false); mocks.file.mockResolvedValue(file); mocks.resource.mockResolvedValue(resource); mocks.count.mockResolvedValue(0); mocks.event.mockResolvedValue({ id: 'event' }); mocks.query.mockResolvedValue([{ referenced: false }]); });
afterEach(async () => { await rm(target, { force: true }); });
describe('V2 FileAsset routes', () => {
  it('serves offering resources with byte ranges to enrolled students without legacy course claims', async () => {
    mocks.claims = { sub: 'student-1', role: 'student' };
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, '%PDF-1.7 content');
    const response = await GET(new Request(`http://localhost/api/uploads/${id}`, { headers: { Range: 'bytes=0-3' } }), context);
    expect(response.status).toBe(206); expect(await response.text()).toBe('%PDF'); expect(mocks.access).toHaveBeenCalledWith(mocks.claims, 'offering-1', 'read');
  });
  it('delegates an authenticated file response to the internal Nginx media location', async () => {
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, '%PDF-1.7 content');
    const response = await GET(new Request(`http://localhost/api/uploads/${id}`, { headers: { 'X-OpenPBL-Accel-Redirect': '1' } }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-accel-redirect')).toBe(`/_openpbl_uploads/${file.storageKey}`);
    expect(response.headers.get('content-disposition')).toContain('lesson.pdf');
    expect(await response.text()).toBe('');
  });
  it('falls back to the application stream when the gateway cannot read a private file', async () => {
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, '%PDF-1.7 content'); await chmod(target, 0o600);
    const response = await GET(new Request(`http://localhost/api/uploads/${id}`, { headers: { 'X-OpenPBL-Accel-Redirect': '1' } }), context);
    expect(response.headers.get('x-accel-redirect')).toBeNull();
    expect(await response.text()).toBe('%PDF-1.7 content');
  });
  it('denies teachers outside the offering and unowned private assets', async () => {
    mocks.access.mockResolvedValue(false);
    expect((await GET(new Request(`http://localhost/api/uploads/${id}`), context)).status).toBe(404);
    mocks.file.mockResolvedValue({ ...file, offeringId: null, uploadedById: 'other', resource: null });
    expect((await DELETE(new Request(`http://localhost/api/uploads/${id}`, { method: 'DELETE' }), context)).status).toBe(404);
  });
  it('resolves a classroom preview through the V2 Resource metadata and FileAsset', async () => {
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, '%PDF preview');
    mocks.file.mockResolvedValueOnce({ ...file, originalName: 'lesson.pptx', resource: { ...resource, metadata: { previewAssetId: 'preview-asset' } } });
    mocks.file.mockResolvedValueOnce({ storageKey: file.storageKey, mimeType: 'application/pdf' });
    const response = await GET(new Request(`http://localhost/api/uploads/${id}?variant=classroom`), context);
    expect(response.status).toBe(200); expect(await response.text()).toBe('%PDF preview');
    expect(mocks.file).toHaveBeenLastCalledWith({ where: { id: 'preview-asset', offeringId: 'offering-1', deletedAt: null } });
  });
  it('denies students access to another student private upload', async () => {
    mocks.claims = { sub: 'student-1', role: 'student' }; mocks.file.mockResolvedValue({ ...file, resource: null, uploadedById: 'student-2' });
    expect((await GET(new Request(`http://localhost/api/uploads/${id}`), context)).status).toBe(404);
  });
  it.each(['package.zip', 'knowledge.docx', 'lesson.docx'])('denies students direct and preview URLs for teacher-only %s', async (name) => {
    mocks.claims = { sub: 'student-1', role: 'student' };
    mocks.file.mockResolvedValue({ ...file, originalName: name, offeringId: null, resource: null });
    for (const suffix of ['', '?variant=classroom']) {
      expect((await GET(new Request(`http://localhost/api/uploads/${id}${suffix}`), context)).status).toBe(404);
    }
    expect(mocks.templateAccess).toHaveBeenCalledWith('student-1', expect.objectContaining({ id }));
    expect(mocks.access).not.toHaveBeenCalled();
  });
  it('serves the package launch PDF through its explicitly published template resource', async () => {
    mocks.claims = { sub: 'student-1', role: 'student' };
    mocks.templateAccess.mockResolvedValue(true);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, '%PDF launch');
    mocks.file.mockResolvedValueOnce({ ...file, originalName: 'launch.pptx', offeringId: null, resource: null });
    mocks.file.mockResolvedValueOnce({ storageKey: file.storageKey, mimeType: 'application/pdf' });
    const response = await GET(new Request(`http://localhost/api/uploads/${id}?variant=classroom`), context);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('%PDF launch');
    expect(mocks.file).toHaveBeenLastCalledWith({ where: { storageKey: `${id}.classroom.pdf`, uploadedById: 'teacher-1', offeringId: null, deletedAt: null } });
  });
  it('preserves artifact files and their references', async () => {
    mocks.count.mockResolvedValue(1);
    const response = await DELETE(new Request(`http://localhost/api/uploads/${id}`, { method: 'DELETE' }), context);
    expect(response.status).toBe(409); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('preserves files embedded in immutable JSON or HTML research snapshots', async () => {
    mocks.query.mockResolvedValue([{ referenced: true }]);
    expect((await DELETE(new Request(`http://localhost/api/uploads/${id}`, { method: 'DELETE' }), context)).status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('soft-deletes unreferenced files and records a durable V2 resource event', async () => {
    const response = await DELETE(new Request(`http://localhost/api/uploads/${id}`, { method: 'DELETE' }), context);
    expect(response.status).toBe(204); expect(mocks.update).toHaveBeenCalledWith({ where: { id }, data: { deletedAt: expect.any(Date) } });
    expect(mocks.event).toHaveBeenCalledWith({ data: expect.objectContaining({ offeringId: 'offering-1', eventType: 'resource_updated' }) });
  });
  it('updates PDF metadata while preserving stage information', async () => {
    const response = await PATCH(new Request(`http://localhost/api/uploads/${id}`, { method: 'PATCH', body: JSON.stringify({ displayMode: 'slides' }) }), context);
    expect(response.status).toBe(200); expect(mocks.resourceUpdate).toHaveBeenCalledWith({ where: { id }, data: { metadata: { stageKey: 'practice', displayMode: 'slides' } } });
  });
});
