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
import { classroomEditOutlinesFixture } from '@openmaic/lib/server/classroom-edit-outlines-fixture';

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
      outlines: course.content._openmaicSceneOutlines,
    });
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });

  it('loads full canonical teaching prose by stable page identity and retains legacy courses without outlines', async () => {
    const input = classroomEditOutlinesFixture();
    input.existing.scenes[0].title = '教师最新标题';
    input.existing.scenes.reverse();
    mocks.getCourse.mockResolvedValue(input.course);
    mocks.readClassroom.mockResolvedValue(input.existing);
    const response = await GET(new Request('https://app.test/api/courses/course-1/classroom-resource'), context);
    const result = await response.json();
    expect(result.outlines[1]).toMatchObject({ id: 'outline-1', title: input.outline.title,
      teachingBrief: { explanation: input.outline.teachingBrief!.explanation, evidence: input.outline.teachingBrief!.evidence } });
    expect(result.classroom.scenes[1].title).toBe('教师最新标题');
    mocks.getCourse.mockResolvedValue({ ...input.course, content: { ...input.course.content, _openmaicSceneOutlines: undefined } });
    const legacy = await GET(new Request('https://app.test/api/courses/course-1/classroom-resource'), context);
    expect((await legacy.json()).outlines).toEqual([]);
  });

  it('saves and reloads split canonical responsibilities while keeping unrelated narration and original evidence', async () => {
    const input = classroomEditOutlinesFixture();
    let savedCourse = input.course;
    let savedClassroom = input.existing;
    mocks.getCourse.mockImplementation(async () => savedCourse);
    mocks.readClassroom.mockImplementation(async () => savedClassroom);
    mocks.updateClassroom.mockImplementation(async (_id, data) => {
      savedClassroom = { ...savedClassroom, ...data, revision: 5 };
      return savedClassroom;
    });
    mocks.updateCourse.mockImplementation(async (_id, updater) => { savedCourse = updater(savedCourse); return savedCourse; });
    const response = await PATCH(editRequest(4, { stage: input.stage, scenes: input.scenes, outlines: input.outlines }), context);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.outlines[1]).toMatchObject({ id: 'outline-1--continuation-2', segmentIndex: 2,
      sourcePageIds: ['outline-1'], visualSourceCatalog: [input.sources[1]],
      teachingBrief: { explanation: input.outline.teachingBrief!.explanation, teachingPlan: { newContent: input.outline.teachingBrief!.teachingPlan!.newContent } } });
    expect(result.classroom.scenes[2].actions).toEqual(input.existing.scenes[1].actions);
    const reloaded = await GET(new Request('https://app.test/api/courses/course-1/classroom-resource'), context);
    expect((await reloaded.json()).outlines).toEqual(result.outlines);
  });

  it('rejects foreign split source identities before writing media, classroom or course data', async () => {
    const input = classroomEditOutlinesFixture();
    mocks.getCourse.mockResolvedValue(input.course);
    mocks.readClassroom.mockResolvedValue(input.existing);
    input.outlines[1].sourcePageIds = ['foreign-textbook'];
    const response = await PATCH(editRequest(4, { stage: input.stage, scenes: input.scenes, outlines: input.outlines }), context);
    expect(response.status).toBe(400);
    expect(mocks.persistAudio).not.toHaveBeenCalled();
    expect(mocks.copyMedia).not.toHaveBeenCalled();
    expect(mocks.updateClassroom).not.toHaveBeenCalled();
    expect(mocks.updateCourse).not.toHaveBeenCalled();
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

  it('forks a classroom kept by a historical draft before editing it', async () => {
    mocks.findPublished.mockImplementation(async ({ where }) =>
      where.status.in.includes('SUPERSEDED') ? { id: 'historical-draft' } : null);
    const response = await PATCH(editRequest(), context);
    expect(response.status).toBe(200);
    expect(mocks.copyMedia).toHaveBeenCalledWith('classroom-1', 'classroom-1-edit-draft123');
    expect(mocks.persistClassroom).toHaveBeenCalledWith(expect.objectContaining({ id: 'classroom-1-edit-draft123' }));
    expect(mocks.updateClassroom).not.toHaveBeenCalled();
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

  it('saves reordered pages and regenerated audio when a generated page has seven laser targets', async () => {
    const laserScene = {
      ...scene,
      title: '建构主义教学设计的七个步骤',
      actions: [
        { id: 'laser-1', type: 'laser', elementId: 'step-1',
          waypoints: Array.from({ length: 6 }, (_, index) => ({ elementId: `step-${index + 2}` })) },
        { id: 'speech-1', type: 'speech', text: '讲稿' },
      ],
    };
    mocks.readClassroom.mockResolvedValue({ ...classroom, scenes: [{ ...scene, id: 'scene-2' }, laserScene] });
    const reordered = [
      { ...laserScene, order: 0 },
      { ...scene, id: 'scene-2', order: 1, actions: [{ id: 'speech-2', type: 'speech', text: '新讲稿', audioId: 'local-audio' }] },
    ];
    const response = await PATCH(editRequest(4, {
      scenes: reordered,
      audioUploads: [{
        sceneId: 'scene-2', actionId: 'speech-2', text: '新讲稿', audioId: 'local-audio',
        format: 'wav', base64: Buffer.from('RIFF-audio').toString('base64'),
      }],
    }), context);
    expect(response.status).toBe(200);
    expect(mocks.updateClassroom).toHaveBeenCalledWith('classroom-1', expect.objectContaining({
      scenes: [
        expect.objectContaining({ title: laserScene.title, order: 0,
          actions: [expect.objectContaining({ waypoints: expect.arrayContaining(
            Array.from({ length: 6 }, (_, index) => ({ elementId: `step-${index + 2}` })),
          ) }), expect.anything()] }),
        expect.objectContaining({ id: 'scene-2', order: 1,
          actions: [expect.objectContaining({ audioUrl: expect.stringContaining('/classroom-media/classroom-1/audio/') })] }),
      ],
    }), 4);
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
      teachingSource: { courseId: 'course-1', classroomId: 'classroom-1' },
    }));
    const updater = mocks.updateCourse.mock.calls[0][1];
    expect(updater(course)).toMatchObject({
      status: 'preparing',
      aiLearningClassroomId: 'classroom-1-edit-draft123',
      content: {
        _openmaicClassroomId: 'classroom-1-edit-draft123',
        teachingRevisionState: { baseClassroomRevision: 4, classroomRevision: 1 },
      },
    });
    await expect(response.json()).resolves.toMatchObject({
      forkedDraft: true,
      dependencyInvalidation: { baseClassroomRevision: 4, classroomRevision: 1 },
    });
  });

  it('carries a same-course server provenance anchor across repeated forks and ignores client replacements', async () => {
    mocks.findPublished.mockResolvedValue({ id: 'published-version' });
    mocks.readClassroom.mockResolvedValue({ ...classroom,
      teachingSource: { courseId: 'course-1', classroomId: 'original-source-classroom' } });
    const response = await PATCH(editRequest(4, { teachingSource: { courseId: 'foreign-course', classroomId: 'forged-source' } }), context);
    expect(response.status).toBe(200);
    expect(mocks.persistClassroom).toHaveBeenCalledWith(expect.objectContaining({
      teachingSource: { courseId: 'course-1', classroomId: 'original-source-classroom' },
    }));
    mocks.readClassroom.mockResolvedValue({ ...classroom,
      teachingSource: { courseId: 'foreign-course', classroomId: 'other-source' } });
    await PATCH(editRequest(), context);
    expect(mocks.persistClassroom).toHaveBeenLastCalledWith(expect.objectContaining({
      teachingSource: { courseId: 'course-1', classroomId: 'classroom-1' },
    }));
  });

  it('denies an unauthorized canonical outline read before loading the course or classroom', async () => {
    mocks.authorize.mockResolvedValue(new Response(null, { status: 403 }));
    const response = await GET(new Request('https://app.test/api/courses/course-1/classroom-resource'), context);
    expect(response.status).toBe(403);
    expect(mocks.getCourse).not.toHaveBeenCalled();
    expect(mocks.readClassroom).not.toHaveBeenCalled();
  });

  it('preserves authorization failures before reading classroom data', async () => {
    mocks.authorize.mockResolvedValue(new Response(null, { status: 403 }));
    const response = await PATCH(editRequest(), context);
    expect(response.status).toBe(403);
    expect(mocks.getCourse).not.toHaveBeenCalled();
    expect(mocks.readClassroom).not.toHaveBeenCalled();
  });
});
