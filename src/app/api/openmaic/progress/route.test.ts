import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const courseStore = vi.hoisted(() => ({
  course: null as null | Record<string, unknown>,
  persistStudentAiProgress: vi.fn(),
}));
const classroomStore = vi.hoisted(() => ({
  classroom: null as null | { scenes: Array<{ id: string; outlineId?: string }> },
}));
const auth = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  requireSameOrigin: vi.fn(),
}));

vi.mock('@/lib/auth/request-guards', () => ({
  authenticateRequest: auth.authenticateRequest,
  requireSameOrigin: auth.requireSameOrigin,
}));
vi.mock('@/lib/auth/session', () => ({
  isAuthConfigured: () => true,
}));

vi.mock('@/lib/session/server-store', () => ({
  getCourse: vi.fn(async () => courseStore.course),
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

import { POST } from './route';

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
      100,
    );
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

  it('rejects progress updates for another student identity', async () => {
    const response = await POST(request({
      courseId: 'course-1', studentId: 'student-2', classroomId: 'classroom-1',
      currentSceneIndex: 0, totalScenes: 2, completedScenes: [],
    }));

    expect(response.status).toBe(403);
    expect(courseStore.persistStudentAiProgress).not.toHaveBeenCalled();
  });
});
