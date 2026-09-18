// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), getCourse: vi.fn(), readClassroom: vi.fn() }));
vi.mock('@/lib/platform/template-access', () => ({ authorizeTemplateRequest: mocks.authorize }));
vi.mock('@/lib/session/server-store', () => ({ getCourse: mocks.getCourse }));
vi.mock('@openmaic/lib/server/classroom-storage', () => ({ readClassroom: mocks.readClassroom }));

import { GET } from './route';

const context = { params: Promise.resolve({ courseId: 'course-1' }) };
const request = new Request('https://app.test/api/courses/course-1/resource-download');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue('teacher-1');
  mocks.getCourse.mockResolvedValue({
    id: 'course-1', name: '测试课程', subject: '科学', grade: '七年级', updatedAt: '2026-09-18',
    aiLearningClassroomId: 'main-1',
    resources: [{ id: 'handout', title: '任务单.pdf', type: 'PDF', size: '1MB', url: '/api/uploads/handout', downloadedBy: [] }],
    content: {
      teacherClassroomId: 'teacher-1',
      adaptiveLearningPlan: { branches: [
        { id: 'branch-1', title: '先修补充', preparedResource: { classroomId: 'branch-classroom' } },
        { id: 'branch-disabled', title: '已关闭', enabled: false, preparedResource: { classroomId: 'disabled-classroom' } },
      ] },
      resourcePackage: {
        source: { id: 'source', fileName: '原始资料.zip', url: '/api/uploads/source' },
        documents: { knowledge: { id: 'knowledge', fileName: '知识资料.docx', url: '/api/uploads/knowledge' } },
      },
    },
  });
  mocks.readClassroom.mockImplementation(async (id: string) => ({ id, stage: { name: id }, scenes: [], createdAt: 'now' }));
});

describe('course resource download route', () => {
  it('returns every enabled classroom and teacher source file', async () => {
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      course: { id: 'course-1', name: '测试课程' },
      classrooms: [
        { kind: 'main', classroom: { id: 'main-1' } },
        { kind: 'teacher', classroom: { id: 'teacher-1' } },
        { kind: 'adaptive', classroom: { id: 'branch-classroom' } },
      ],
      sourceFiles: [
        { fileName: '原始资料.zip', url: '/api/uploads/source' },
        { fileName: '知识资料.docx', url: '/api/uploads/knowledge' },
        { fileName: '任务单.pdf', url: '/api/uploads/handout' },
      ],
    });
    expect(mocks.readClassroom).not.toHaveBeenCalledWith('disabled-classroom');
  });

  it('does not disclose course data after an authorization failure', async () => {
    mocks.authorize.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await GET(request, context)).status).toBe(403);
    expect(mocks.getCourse).not.toHaveBeenCalled();
    expect(mocks.readClassroom).not.toHaveBeenCalled();
  });

  it('reports when the course has no generated classroom resource', async () => {
    mocks.getCourse.mockResolvedValue({ id: 'course-1', name: '空课程', content: {} });
    expect((await GET(request, context)).status).toBe(404);
  });
});
