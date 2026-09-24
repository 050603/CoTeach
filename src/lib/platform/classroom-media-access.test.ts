import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(), user: vi.fn(), versions: vi.fn(), templates: vi.fn(), template: vi.fn(),
  instances: vi.fn(), instance: vi.fn(), offering: vi.fn(), participation: vi.fn(), teacher: vi.fn(),
  stat: vi.fn(), readFile: vi.fn(), jobs: vi.fn(), sourceTemplates: vi.fn(),
}));
vi.mock('@/lib/auth/request-guards', () => ({ authenticateRequest: mocks.authenticate }));
vi.mock('@/lib/auth/session', async (original) => ({ ...await original<typeof import('@/lib/auth/session')>(), isAuthConfigured: () => true }));
vi.mock('@/lib/db/client', () => ({ prisma: {
  user: { findUnique: mocks.user },
  classroomTemplateVersion: { findMany: mocks.versions },
  classroomTemplate: { findMany: (args: { select?: { ownerId?: boolean } }) => args.select?.ownerId ? mocks.sourceTemplates(args) : mocks.templates(args), findUnique: mocks.template },
  generationJob: { findMany: mocks.jobs },
  classroomInstance: { findMany: mocks.instances, findUnique: mocks.instance },
  courseOffering: { findUnique: mocks.offering },
  classroomParticipation: { findFirst: mocks.participation },
  courseTeacher: { findFirst: mocks.teacher },
} }));
import { authorizeClassroomMediaRead, classroomMediaPath } from './classroom-media-access';
import { authorizeLegacyClassroomRead } from './access';
import { GET as mediaGET } from '@/app/api/openmaic/classroom-media/[classroomId]/[...path]/route';

const exact = '/api/openmaic/classroom-media/source-test/audio/speech-1.mp3';
const request = () => new NextRequest('http://localhost' + exact);
const adoptedSnapshot = { design: { aiLearningClassroomId: 'full-course', content: { _openmaicClassroomId: 'full-course' } } };
let revision = 0;
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(fs, 'stat').mockImplementation(mocks.stat);
  vi.spyOn(fs, 'readFile').mockImplementation(mocks.readFile);
  revision++;
  mocks.authenticate.mockResolvedValue({ claims: { sub: 'owner', role: 'teacher' } });
  mocks.user.mockResolvedValue({ id: 'owner', role: 'TEACHER', status: 'ACTIVE', username: 'owner', displayName: 'Owner', sessionVersion: 1 });
  mocks.versions.mockResolvedValue([]);
  mocks.jobs.mockResolvedValue([{ targetId: 'original-template' }]);
  mocks.sourceTemplates.mockResolvedValue([{ ownerId: 'owner' }]);
  mocks.templates.mockResolvedValue([{ versions: [{ snapshot: adoptedSnapshot }] }]);
  mocks.instances.mockResolvedValue([]);
  mocks.template.mockResolvedValue(null);
  mocks.offering.mockResolvedValue(null);
  mocks.stat.mockImplementation(async () => ({ dev: BigInt(1), ino: BigInt(1), size: BigInt(100), mtimeNs: BigInt(revision), ctimeNs: BigInt(revision) }));
  mocks.readFile.mockImplementation(async (file: string) => file.endsWith('.json')
    ? JSON.stringify({ scenes: [{ actions: [{ type: 'speech', audioUrl: exact }] }] })
    : Buffer.from('persisted-audio'));
});

afterEach(() => { vi.restoreAllMocks(); });

describe('precisely adopted classroom media access', () => {
  it('serves reused test audio through the full-course owner without granting the old classroom or other source assets', async () => {
    const response = await mediaGET(request(), { params: Promise.resolve({ classroomId: 'source-test', path: ['audio', 'speech-1.mp3'] }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.text()).toBe('persisted-audio');
    expect((await authorizeLegacyClassroomRead(request(), 'source-test'))?.status).toBe(403);
    expect((await authorizeClassroomMediaRead(request(), 'source-test', ['audio', 'private.mp3']))?.status).toBe(403);
    expect(mocks.templates).toHaveBeenCalledWith(expect.objectContaining({
      where: { ownerId: 'owner', status: { in: ['ACTIVE', 'active'] } },
    }));
  });

  it('allows a participating student only through the adopted published instance and rechecks revoked enrollment', async () => {
    mocks.authenticate.mockResolvedValue({ claims: { sub: 'student', role: 'student' } });
    mocks.user.mockResolvedValue({ id: 'student', role: 'STUDENT', status: 'ACTIVE', username: 'student', displayName: 'Student', sessionVersion: 1 });
    mocks.instances.mockResolvedValue([{ id: 'published-run', templateVersion: { snapshot: adoptedSnapshot, template: { ownerId: 'owner' } } }]);
    mocks.instance.mockResolvedValue({ id: 'published-run', status: 'TEACHING', activity: { chapter: { offeringId: 'offering', offering: { status: 'OPEN' } } } });
    mocks.participation.mockResolvedValue({ id: 'member', enrollment: { status: 'ACTIVE' } });
    expect(await authorizeClassroomMediaRead(request(), 'source-test', ['audio', 'speech-1.mp3'])).toBeNull();
    expect(mocks.templates).not.toHaveBeenCalled();
    expect(mocks.participation).toHaveBeenCalledWith(expect.objectContaining({
      where: { instanceId: 'published-run', enrollment: { userId: 'student', offeringId: 'offering', status: { in: ['ACTIVE', 'active', 'COMPLETED', 'completed'] } } },
    }));
    mocks.participation.mockResolvedValue(null);
    expect((await authorizeClassroomMediaRead(request(), 'source-test', ['audio', 'speech-1.mp3']))?.status).toBe(403);
    expect((await authorizeLegacyClassroomRead(request(), 'source-test'))?.status).toBe(403);
  });

  it('denies unaffiliated users and never treats a quoted URL in narration as media adoption', async () => {
    mocks.templates.mockResolvedValue([]);
    expect((await authorizeClassroomMediaRead(request(), 'source-test', ['audio', 'speech-1.mp3']))?.status).toBe(403);
    expect(mocks.readFile).not.toHaveBeenCalled();
    mocks.templates.mockResolvedValue([{ versions: [{ snapshot: adoptedSnapshot }] }]);
    mocks.readFile.mockResolvedValue(JSON.stringify({ scenes: [{ actions: [{ type: 'speech', text: exact }] }] }));
    expect((await authorizeClassroomMediaRead(request(), 'source-test', ['audio', 'speech-1.mp3']))?.status).toBe(403);
  });

  it('invalidates exact references when the persisted full classroom changes, while caching unchanged parsing only', async () => {
    expect(await authorizeClassroomMediaRead(request(), 'source-test', ['audio', 'speech-1.mp3'])).toBeNull();
    expect(await authorizeClassroomMediaRead(request(), 'source-test', ['audio', 'speech-1.mp3'])).toBeNull();
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
    expect(mocks.templates).toHaveBeenCalledTimes(2);
    revision++;
    mocks.readFile.mockResolvedValue(JSON.stringify({ scenes: [] }));
    expect((await authorizeClassroomMediaRead(request(), 'source-test', ['audio', 'speech-1.mp3']))?.status).toBe(403);
    expect(mocks.readFile).toHaveBeenCalledTimes(2);
  });

  it('matches exact canonical paths for old deployment origins and encoded filenames, not path prefixes', async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ scenes: [{ actions: [{ audioUrl: 'https://old.example/api/openmaic/classroom-media/source-test/audio/part%3A1.mp3?v=4' }] }] }));
    expect(await authorizeClassroomMediaRead(request(), 'source-test', ['audio', 'part:1.mp3'])).toBeNull();
    expect((await authorizeClassroomMediaRead(request(), 'source-test', ['audio', 'part:1.mp3-other']))?.status).toBe(403);
    expect(classroomMediaPath('source-test', ['audio', '..', 'private.mp3'])).toBeNull();
    expect(classroomMediaPath('source-test', ['audio/private.mp3'])).toBeNull();
    expect(classroomMediaPath('../source', ['audio', 'part.mp3'])).toBeNull();
  });


  it('rejects a teacher adopting private media generated for someone else, even with an exact persisted reference', async () => {
    mocks.sourceTemplates.mockResolvedValue([{ ownerId: 'other-teacher' }]);
    expect((await authorizeClassroomMediaRead(request(), 'source-test', ['audio', 'speech-1.mp3']))?.status).toBe(403);
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("rejects a student borrowing another template owner's media through their own readable instance", async () => {
    mocks.authenticate.mockResolvedValue({ claims: { sub: 'student', role: 'student' } });
    mocks.user.mockResolvedValue({ id: 'student', role: 'STUDENT', status: 'ACTIVE' });
    mocks.instances.mockResolvedValue([{ id: 'my-instance', templateVersion: { snapshot: adoptedSnapshot, template: { ownerId: 'other-teacher' } } }]);
    mocks.instance.mockResolvedValue({ id: 'my-instance', status: 'TEACHING', activity: { chapter: { offeringId: 'offering', offering: { status: 'OPEN' } } } });
    mocks.participation.mockResolvedValue({ id: 'member' });
    expect((await authorizeClassroomMediaRead(request(), 'source-test', ['audio', 'speech-1.mp3']))?.status).toBe(403);
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('fails closed without server-written origin, ignoring client-editable generation requests and snapshot URLs', async () => {
    mocks.jobs.mockResolvedValue([]);
    expect((await authorizeClassroomMediaRead(request(), 'source-test', ['audio', 'speech-1.mp3']))?.status).toBe(403);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.jobs).toHaveBeenCalledWith({
      where: {
        targetType: 'CLASSROOM_TEMPLATE', jobType: 'COURSE_CONTENT',
        OR: [
          { result: { path: ['id'], equals: 'source-test' } },
          { result: { path: ['teacherClassroomId'], equals: 'source-test' } },
          { checkpoints: { some: { step: 'classroom-media-origin:source-test', state: { path: ['classroomId'], equals: 'source-test' } } } },
          { checkpoints: { some: { step: 'course-finalization', OR: [
            { state: { path: ['split', 'studentClassroomId'], equals: 'source-test' } },
            { state: { path: ['split', 'teacherClassroomId'], equals: 'source-test' } },
          ] } } },
        ],
      },
      select: { targetId: true },
    });
    mocks.jobs.mockResolvedValue([{ targetId: 'deleted-template' }]);
    mocks.sourceTemplates.mockResolvedValue([]);
    expect((await authorizeClassroomMediaRead(request(), 'source-test', ['audio', 'speech-1.mp3']))?.status).toBe(403);
  });

  it('preserves direct source ownership and authentication failures without consulting adoption candidates', async () => {
    mocks.versions.mockResolvedValue([{ template: { ownerId: 'owner' }, instances: [] }]);
    expect(await authorizeClassroomMediaRead(request(), 'source-test', ['audio', 'private.mp3'])).toBeNull();
    expect(mocks.templates).not.toHaveBeenCalled();
    mocks.authenticate.mockResolvedValue({ response: new Response('Unauthorized', { status: 401 }) });
    expect((await authorizeClassroomMediaRead(request(), 'source-test', ['audio', 'speech-1.mp3']))?.status).toBe(401);
  });
});

