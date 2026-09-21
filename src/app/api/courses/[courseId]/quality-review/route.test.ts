// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), enqueue: vi.fn(), load: vi.fn(), confirm: vi.fn(), save: vi.fn(), structureIssues: vi.fn() }));
vi.mock('@/lib/platform/template-access', () => ({ authorizeTemplateRequest: mocks.authorize }));
vi.mock('@/lib/course-quality-review/job-runner', () => ({ enqueueCourseQualityReview: mocks.enqueue }));
vi.mock('@/lib/course-quality-review/semantic-review', () => ({ collectCourseStructureIssues: mocks.structureIssues }));
vi.mock('@/lib/course-quality-review/review-service', () => ({
  CourseReviewError: class extends Error {},
  loadCourseReviewContext: mocks.load,
  requiresCourseTeacherReview: () => true,
  freshQualityReport: () => undefined,
  confirmCourseTeacherReview: mocks.confirm,
  saveCourseRenderPage: mocks.save,
}));
import { GET, POST } from './route';
const context = { params: Promise.resolve({ courseId: 'course' }) };
const url = 'http://localhost/api/courses/course/quality-review';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.structureIssues.mockReturnValue([]);
  mocks.authorize.mockResolvedValue('teacher');
  mocks.load.mockResolvedValue({ course: { content: {} }, classroom: { id: 'classroom', scenes: [] }, signature: 'a'.repeat(64) });
});
describe('optional teacher checks', () => {
  it('GET is read-only and reports absent checks as null', async () => {
    const response = await GET(new Request(url), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      quality: null,
      blockingIssues: [],
      renderReview: null,
      teacherReview: null,
      teacherReviewItems: [],
      teacherReviewSummary: null,
      teacherReviewVersion: null,
    });
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('always returns deterministic publication blockers without starting the optional review', async () => {
    mocks.structureIssues.mockReturnValue([{ id: 'hard', origin: 'structure', severity: 'error', blocking: true, title: '必需知识缺少讲授页面', evidence: '知识点 A', suggestion: '补齐讲授页' }]);
    const response = await GET(new Request(url), context);
    expect(await response.json()).toMatchObject({
      blockingIssues: [expect.objectContaining({ id: 'hard', blocking: true })],
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('starts content checking only after an explicit request', async () => {
    const response = await POST(new Request(url, { method: 'POST', body: JSON.stringify({ action: 'check' }) }), context);
    expect(response.status).toBe(200);
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith('course', { force: true });
  });
  it('retains authorization before loading or checking', async () => {
    mocks.authorize.mockResolvedValue(new Response('Forbidden', { status: 403 }));
    expect((await GET(new Request(url), context)).status).toBe(403);
    expect((await POST(new Request(url, { method: 'POST', body: JSON.stringify({ action: 'check' }) }), context)).status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
