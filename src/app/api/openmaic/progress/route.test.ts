import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const courseStore = vi.hoisted(() => ({
  course: null as null | Record<string, unknown>,
  persistStudentAiProgress: vi.fn(),
}));
const classroomStore = vi.hoisted(() => ({
  classroom: null as null | { scenes: Array<{ id: string; outlineId?: string; stageKey?: string; audience?: string; generationPurpose?: string }> },
}));
const auth = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  requireSameOrigin: vi.fn(),
  scope: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ isDatabaseConfigured: () => true, prisma: {} }));
vi.mock('@/lib/courses/student-state-scope', () => ({ resolveStudentStateScope: auth.scope }));

vi.mock('@/lib/auth/request-guards', () => ({
  authenticateRequest: auth.authenticateRequest,
  requireSameOrigin: auth.requireSameOrigin,
}));
vi.mock('@/lib/auth/session', () => ({
  isAuthConfigured: () => true,
}));

vi.mock('@/lib/courses/ai-progress-context', () => ({
  loadAiProgressContext: vi.fn(async () => courseStore.course),
}));
vi.mock('@/lib/courses/ai-progress-service', () => ({
  persistStudentAiProgress: courseStore.persistStudentAiProgress,
}));
vi.mock('@/lib/platform/access', () => ({
  canAccessLegacyCourse: vi.fn(async () => true),
}));
vi.mock('@openmaic/lib/server/classroom-storage', () => ({
  readClassroom: vi.fn(async () => classroomStore.classroom),
}));

import { GET, POST } from './route';
import { loadAiProgressContext } from '@/lib/courses/ai-progress-context';
import { canAccessLegacyCourse } from '@/lib/platform/access';

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/openmaic/progress', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'x-openpbl-role': 'student',
    },
  });
}

describe('progress route integrity', () => {
  beforeEach(() => {
    vi.mocked(loadAiProgressContext).mockClear();
    courseStore.persistStudentAiProgress.mockReset();
    courseStore.persistStudentAiProgress.mockImplementation(async (_courseId, _studentId, progress) => progress);
    courseStore.course = {
      id: 'course-1',
      aiLearningClassroomId: 'classroom-1',
      content: {},
      students: [{ id: 'student-1' }],
      aiLearningProgress: {
        'student-1': { classroomId: 'classroom-1', completedScenes: ['s1'], completionModelVersion: 2 },
      },
    };
    classroomStore.classroom = {
      scenes: [
        { id: 's1', outlineId: 'outline-ai-1' },
        { id: 's2', outlineId: 'outline-ai-2' },
      ],
    };
    auth.requireSameOrigin.mockReturnValue(null);
    auth.scope.mockReset(); auth.scope.mockResolvedValue({ accessible: true });
    vi.mocked(canAccessLegacyCourse).mockReset(); vi.mocked(canAccessLegacyCourse).mockResolvedValue(true);
    auth.authenticateRequest.mockResolvedValue({
      claims: {
        sub: 'student-1',
        role: 'student',
        courseId: 'course-1',
        studentId: 'student-1',
        studentName: '测试学生',
        sv: 1,
      },
    });
  });

  it('rejects another student before querying progress data', async () => {
    const response = await GET(new NextRequest('http://localhost/api/openmaic/progress?courseId=course-1&studentId=other'));
    expect(response.status).toBe(403);
    expect(loadAiProgressContext).not.toHaveBeenCalled();
  });

  it('reads only the authenticated learner progress context', async () => {
    const response = await GET(new NextRequest('http://localhost/api/openmaic/progress?courseId=course-1&studentId=student-1'));
    expect(response.status).toBe(200);
    expect(loadAiProgressContext).toHaveBeenCalledWith('course-1', 'student-1');
    expect(Object.keys((await response.json()).data.progress)).toEqual(['student-1']);
    expect(auth.scope).toHaveBeenCalledWith(expect.anything(), 'course-1', 'student-1');
    expect(canAccessLegacyCourse).not.toHaveBeenCalled();
  });

  it('does not override a denied instance scope, but preserves namespace fallback for null', async () => {
    const body = { courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1', currentSceneIndex: 0, totalScenes: 2, completedScenes: [] };
    auth.scope.mockResolvedValue({ accessible: false });
    expect((await POST(request(body))).status).toBe(403);
    expect(canAccessLegacyCourse).not.toHaveBeenCalled();
    expect(loadAiProgressContext).not.toHaveBeenCalled();
    auth.scope.mockResolvedValue(null);
    expect((await POST(request(body))).status).toBe(200);
    expect(canAccessLegacyCourse).toHaveBeenCalledWith(expect.objectContaining({ sub: 'student-1' }), 'course-1', 'read');
  });

  it('keeps teacher aggregate reads on their established authorization path', async () => {
    auth.authenticateRequest.mockResolvedValue({ claims: { sub: 'teacher', role: 'teacher', sv: 1 } });
    expect((await GET(new NextRequest('http://localhost/api/openmaic/progress?courseId=course-1'))).status).toBe(200);
    expect(auth.scope).not.toHaveBeenCalled();
    expect(canAccessLegacyCourse).toHaveBeenCalledWith(expect.objectContaining({ role: 'teacher' }), 'course-1', 'read');
    expect(loadAiProgressContext).toHaveBeenCalledWith('course-1', undefined);
  });

  it('rejects progress written to a classroom not linked to the course', async () => {
    const response = await POST(request({
      courseId: 'course-1', studentId: 'student-1', classroomId: 'other',
      currentSceneIndex: 0, totalScenes: 99, completedScenes: [],
    }));

    expect(response.status).toBe(400);
    expect(courseStore.persistStudentAiProgress).not.toHaveBeenCalled();
  });

  it('uses persisted scenes and preserves earlier completion', async () => {
    const response = await POST(request({
      courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
      currentSceneIndex: 99, totalScenes: 999,
      completedScenes: ['s2', 's2', 'unknown'],
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.progress).toMatchObject({
      currentSceneIndex: 1,
      totalScenes: 2,
      completedScenes: ['s1', 's2'],
      completedOutlineIds: ['outline-ai-1', 'outline-ai-2'],
      masteryLevel: 'completed',
    });
    expect(courseStore.persistStudentAiProgress).toHaveBeenCalledWith(
      'course-1',
      'student-1',
      expect.objectContaining({ completedScenes: ['s1', 's2'] }),
      classroomStore.classroom!.scenes,
      expect.objectContaining({ requestId: expect.stringMatching(/^legacy-/), fingerprint: expect.any(String), sessionVersion: 1 }),
    );
  });

  it('excludes teacher-only scenes from completion exactly as the student player does', async () => {
    classroomStore.classroom!.scenes = [
      { id: 's1', audience: 'student', stageKey: 'ai-learning', generationPurpose: 'knowledge-teaching' },
      { id: 'teacher', audience: 'teacher', stageKey: 'ai-learning', generationPurpose: 'teacher-resource' },
    ];
    const response = await POST(request({ courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
      currentSceneIndex: 1, totalScenes: 2, completedScenes: ['s1', 'teacher'] }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.progress).toMatchObject({ totalScenes: 1, completedScenes: ['s1'], masteryLevel: 'completed' });
  });

  it('ignores a player-reported score when deciding completion and stored scoring', async () => {
    const response = await POST(request({
      courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
      currentSceneIndex: 1, totalScenes: 2, completedScenes: ['s2'], quizScore: 100,
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.progress.masteryLevel).toBe('completed');
    expect(body.data.progress.quizScore).toBeUndefined();
  });

  it('does not carry completed scenes or quiz attempts from a previous classroom', async () => {
    courseStore.course = {
      ...(courseStore.course ?? {}),
      aiLearningProgress: { 'student-1': { classroomId: 'old-classroom', completedScenes: ['s1'], completionModelVersion: 2, knowledgeLectureAttempts: [{ id: 'old-quiz' }] } },
    };
    const response = await POST(request({
      courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
      currentSceneIndex: 0, totalScenes: 2, completedScenes: [],
    }));
    const body = await response.json();
    expect(body.data.progress).toMatchObject({ completedScenes: [], masteryLevel: 'not-started' });
    expect(body.data.progress.knowledgeLectureAttempts).toBeUndefined();
  });

  it('does not carry forward completion produced by the legacy enter-page model', async () => {
    courseStore.course = {
      ...(courseStore.course ?? {}),
      aiLearningProgress: {
        'student-1': { completedScenes: ['s1', 's2'], masteryLevel: 'completed' },
      },
    };

    const response = await POST(request({
      courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
      currentSceneIndex: 0, totalScenes: 2, completedScenes: [],
    }));
    const body = await response.json();

    expect(body.data.progress).toMatchObject({
      completedScenes: [],
      masteryLevel: 'not-started',
      completionModelVersion: 2,
    });
  });

  it('fingerprints the stable original body rather than mutable progress and supports old clients', async () => {
    const body = { courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1', requestId: 'stable-id', currentSceneIndex: 0, totalScenes: 2, completedScenes: ['s1'] };
    expect((await POST(request(body))).status).toBe(200);
    const first = courseStore.persistStudentAiProgress.mock.calls.at(-1)?.[4];
    courseStore.course!.aiLearningProgress = { 'student-1': { classroomId: 'classroom-1', completedScenes: ['s1', 's2'], completionModelVersion: 2 } };
    expect((await POST(request(Object.fromEntries(Object.entries(body).reverse())))).status).toBe(200);
    expect(courseStore.persistStudentAiProgress.mock.calls.at(-1)?.[4]).toEqual(first);
    await POST(request({ ...body, completedScenes: ['s2'] }));
    expect(courseStore.persistStudentAiProgress.mock.calls.at(-1)?.[4].fingerprint).not.toBe(first.fingerprint);
  });
  it('rejects malformed request identifiers without persisting progress', async () => {
    expect((await POST(request({ courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1', requestId: 'bad id', currentSceneIndex: 0, totalScenes: 1, completedScenes: [] }))).status).toBe(400);
    expect(courseStore.persistStudentAiProgress).not.toHaveBeenCalled();
  });
  it('rejects progress updates for another student identity', async () => {
    const response = await POST(request({
      courseId: 'course-1', studentId: 'student-2', classroomId: 'classroom-1',
      currentSceneIndex: 0, totalScenes: 2, completedScenes: [],
    }));

    expect(response.status).toBe(403);
    expect(courseStore.persistStudentAiProgress).not.toHaveBeenCalled();
  });
});
