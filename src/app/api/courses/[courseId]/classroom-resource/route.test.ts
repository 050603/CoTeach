// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  enqueueReview: vi.fn(),
  getCourse: vi.fn(),
  updateCourse: vi.fn(),
  findPublished: vi.fn(),
  readClassroom: vi.fn(),
  updateClassroom: vi.fn(),
  persistClassroom: vi.fn(),
  copyMedia: vi.fn(),
  persistAudio: vi.fn(),
  alignSpeech: vi.fn(),
}));

vi.mock('@/lib/course-quality-review/job-runner', () => ({ enqueueCourseQualityReview: mocks.enqueueReview }));
vi.mock('@/lib/platform/template-access', () => ({ authorizeTemplateRequest: mocks.authorize }));
vi.mock('@/lib/session/server-store', () => ({
  getCourse: mocks.getCourse,
  updateCourse: mocks.updateCourse,
}));
vi.mock('@/lib/db/client', () => ({
  prisma: { classroomTemplateVersion: { findFirst: mocks.findPublished } },
}));
vi.mock('nanoid', () => ({ nanoid: () => 'draft123' }));
vi.mock('@openmaic/lib/server/classroom-edit-audio', async (importOriginal) => ({
  ...await importOriginal<typeof import('@openmaic/lib/server/classroom-edit-audio')>(),
  persistClassroomAudioUploads: mocks.persistAudio,
}));
vi.mock('@openmaic/lib/server/classroom-media-generation', () => ({
  alignClassroomSpeechActions: mocks.alignSpeech,
}));
vi.mock('@openmaic/lib/server/classroom-storage', async (importOriginal) => {
  const original = await importOriginal<typeof import('@openmaic/lib/server/classroom-storage')>();
  return {
    ...original,
    readClassroom: mocks.readClassroom,
    updatePersistedClassroomForEditing: mocks.updateClassroom,
    persistClassroom: mocks.persistClassroom,
    copyClassroomMedia: mocks.copyMedia,
  };
});

import { GET, PATCH } from './route';

const context = { params: Promise.resolve({ courseId: 'course-1' }) };
const stage = { id: 'classroom-1', name: 'AI 课堂', createdAt: 1, updatedAt: 1 };
const scene = {
  id: 'scene-1',
  stageId: 'classroom-1',
  title: '第一页',
  type: 'slide',
  order: 0,
  content: { type: 'slide', canvas: { id: 'canvas-1', elements: [] } },
  actions: [{ id: 'speech-1', type: 'speech', text: '讲稿' }],
};
const classroom = {
  id: 'classroom-1',
  stage,
  scenes: [scene],
  revision: 4,
  createdAt: '2026-09-12T00:00:00.000Z',
};
const course = {
  id: 'course-1',
  name: '测试课程',
  status: 'preparing',
  aiLearningClassroomId: 'classroom-1',
  content: {
    _openmaicClassroomId: 'classroom-1',
    _openmaicSceneOutlines: [{
      id: 'scene-1',
      type: 'slide',
      title: '第一页',
      description: '说明',
      keyPoints: [],
      estimatedDuration: 60,
      order: 0,
    }],
  },
};

function editRequest(revision = 4, extra: Record<string, unknown> = {}) {
  return new Request('https://app.test/api/courses/course-1/classroom-resource', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', origin: 'https://app.test' },
    body: JSON.stringify({ revision, stage, scenes: [scene], ...extra }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue('teacher-1');
  mocks.getCourse.mockResolvedValue(course);
  mocks.readClassroom.mockResolvedValue(classroom);
  mocks.findPublished.mockResolvedValue(null);
  mocks.updateClassroom.mockImplementation(async (_id, data) => ({
    ...classroom,
    ...data,
    revision: 5,
  }));
  mocks.persistClassroom.mockImplementation(async (data) => ({
    ...data,
    createdAt: classroom.createdAt,
    revision: 1,
  }));
  mocks.updateCourse.mockImplementation(async (_id, updater) => updater(course));
  mocks.alignSpeech.mockResolvedValue({ aligned: 1, failed: 0, total: 1 });
});

describe('teacher classroom resource route', () => {
  it('loads only the classroom linked to the authorized course', async () => {
    const response = await GET(new Request('https://app.test/api/courses/course-1/classroom-resource'), context);
    expect(response.status).toBe(200);
    expect(mocks.readClassroom).toHaveBeenCalledWith('classroom-1');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      classroom: { id: 'classroom-1', revision: 4 },
    });
  });

  it('rejects a stale edit without changing storage', async () => {
    const response = await PATCH(editRequest(3), context);
    expect(response.status).toBe(409);
    expect(mocks.updateClassroom).not.toHaveBeenCalled();
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('rejects a different classroom even when the revision number matches', async () => {
    const response = await PATCH(editRequest(4, { classroomId: 'previous-published-classroom' }), context);
    expect(response.status).toBe(409);
    expect(mocks.updateClassroom).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('preserves a newer draft link when another tab forks during this save', async () => {
    mocks.findPublished.mockResolvedValue({ id: 'published-version' });
    mocks.updateCourse.mockImplementation(async (_id, updater) => updater({
      ...course, aiLearningClassroomId: 'other-tab-draft',
    }));
    const response = await PATCH(editRequest(), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('saves freshly generated audio for edited text as a shared media URL', async () => {
    const editedScene = {
      ...scene,
      actions: [{ id: 'speech-1', type: 'speech', text: '新讲稿', audioId: 'local-audio' }],
    };
    const response = await PATCH(editRequest(4, {
      scenes: [editedScene],
      audioUploads: [{
        sceneId: scene.id, actionId: 'speech-1', text: '新讲稿', audioId: 'local-audio',
        format: 'wav', base64: Buffer.from('RIFF-audio').toString('base64'),
      }],
    }), context);
    expect(response.status).toBe(200);
    expect(mocks.enqueueReview).not.toHaveBeenCalled();
    expect(mocks.persistAudio).toHaveBeenCalledWith('classroom-1', [expect.objectContaining({ filename: expect.stringMatching(/^edit-.*\.wav$/) })]);
    expect(mocks.alignSpeech).toHaveBeenCalledWith(expect.objectContaining({
      classroomId: 'classroom-1',
      actionKeys: new Set(['["scene-1","speech-1"]']),
    }));
    await expect(response.json()).resolves.toMatchObject({
      narrationChanged: false,
      dependencyInvalidation: {
        baseClassroomRevision: 4,
        classroomRevision: 5,
        changeType: 'narration',
        affectedSceneIds: ['scene-1'],
        invalidated: expect.arrayContaining(['audio', 'narration-anchors', 'timing-audit', 'assessment-opportunity']),
      },
      classroom: { scenes: [{ actions: [{ text: '新讲稿', audioUrl: expect.stringContaining('/classroom-media/classroom-1/audio/') }] }] },
    });
  });

  it('updates an unpublished classroom with optimistic concurrency', async () => {
    const response = await PATCH(editRequest(), context);
    expect(response.status).toBe(200);
    expect(mocks.updateClassroom).toHaveBeenCalledWith(
      'classroom-1',
      expect.objectContaining({ scenes: [expect.objectContaining({ id: 'scene-1' })] }),
      4,
    );
    expect(mocks.copyMedia).not.toHaveBeenCalled();
    expect(mocks.updateCourse).toHaveBeenCalledWith(
      'course-1',
      expect.any(Function),
      { actor: { id: 'teacher-1', role: 'teacher' } },
    );
  });

  it('forks a published resource before saving the new draft', async () => {
    mocks.findPublished.mockResolvedValue({ id: 'published-version' });
    const response = await PATCH(editRequest(), context);
    expect(response.status).toBe(200);
    expect(mocks.copyMedia).toHaveBeenCalledWith(
      'classroom-1',
      'classroom-1-edit-draft123',
    );
    expect(mocks.persistClassroom).toHaveBeenCalledWith(expect.objectContaining({
      id: 'classroom-1-edit-draft123',
      stage: expect.objectContaining({ id: 'classroom-1-edit-draft123' }),
      scenes: [expect.objectContaining({ stageId: 'classroom-1-edit-draft123' })],
    }));
    const updater = mocks.updateCourse.mock.calls[0][1];
    expect(updater(course)).toMatchObject({
      status: 'preparing',
      aiLearningClassroomId: 'classroom-1-edit-draft123',
      content: { _openmaicClassroomId: 'classroom-1-edit-draft123' },
    });
    await expect(response.json()).resolves.toMatchObject({ forkedDraft: true });
  });

  it('preserves authorization failures before reading classroom data', async () => {
    mocks.authorize.mockResolvedValue(new Response(null, { status: 403 }));
    const response = await PATCH(editRequest(), context);
    expect(response.status).toBe(403);
    expect(mocks.getCourse).not.toHaveBeenCalled();
    expect(mocks.readClassroom).not.toHaveBeenCalled();
  });
});
