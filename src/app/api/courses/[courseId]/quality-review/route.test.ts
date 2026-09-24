// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), enqueue: vi.fn(), load: vi.fn(), confirm: vi.fn(), save: vi.fn(), startRender: vi.fn(), freshQuality: vi.fn(), freshRender: vi.fn(), structureIssues: vi.fn() }));
vi.mock('@/lib/platform/template-access', () => ({ authorizeTemplateRequest: mocks.authorize }));
vi.mock('@/lib/course-quality-review/job-runner', () => ({ enqueueCourseQualityReview: mocks.enqueue }));
vi.mock('@/lib/course-quality-review/semantic-review', () => ({ collectCourseStructureIssues: mocks.structureIssues }));
vi.mock('@/lib/course-quality-review/review-service', () => ({
  CourseReviewError: class extends Error {},
  loadCourseReviewContext: mocks.load,
  requiresCourseTeacherReview: () => true,
  freshQualityReport: mocks.freshQuality,
  freshRenderReview: mocks.freshRender,
  confirmCourseTeacherReview: mocks.confirm,
  saveCourseRenderPage: mocks.save,
  startCourseRenderReview: mocks.startRender,
}));
import { GET, POST } from './route';
const context = { params: Promise.resolve({ courseId: 'course' }) };
const url = 'http://localhost/api/courses/course/quality-review';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.structureIssues.mockReturnValue([]);
  mocks.freshQuality.mockReturnValue(undefined);
  mocks.freshRender.mockReturnValue(undefined);
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
  it('reports the selected test lesson and marks the rest unchecked', async () => {
    mocks.load.mockResolvedValue({ course: { content: { classroomGenerationRun: {
      scope: 'test-lesson', testLesson: { sectionId: 'unit-a', sectionTitle: '方法基础', sceneOutlineIds: ['parent-a', 'parent-b'] },
      generatedOutlineIds: ['child-a1', 'child-a2', 'child-b'], fullOutlineCount: 8,
    }, teachingBlueprint: { sections: [{}, {}, {}] } } }, classroom: { id: 'classroom', scenes: [] }, signature: 'a'.repeat(64) });
    const body = await (await GET(new Request(url), context)).json();
    expect(body.reviewScope).toEqual({ kind: 'test-lesson', checkedSectionId: 'unit-a', checkedSectionTitle: '方法基础',
      checkedOutlineIds: ['parent-a', 'parent-b'], uncheckedOutlineCount: 6, unreviewedSectionCount: 2 });
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
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith('course', { mode: 'check' });
  });
  it('separates a full check from retrying failed sections', async () => {
    const response = await POST(new Request(url, { method: 'POST', body: JSON.stringify({ action: 'retry' }) }), context);
    expect(response.status).toBe(200);
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith('course', { mode: 'retry' });
  });
  it('returns only live structural publication blockers when an optional report is stale', async () => {
    mocks.structureIssues.mockReturnValue([{ id: 'live', origin: 'structure', severity: 'error', blocking: true, title: '缺少实际讲稿', evidence: '页 A', suggestion: '补齐' }]);
    mocks.freshQuality.mockReturnValue({ status: 'completed', issues: [
      { id: 'live', origin: 'structure', severity: 'error', blocking: true, title: '旧证据', evidence: '', suggestion: '' },
      { id: 'old', origin: 'semantic', severity: 'error', blocking: true, title: '旧规则阻断', evidence: '', suggestion: '' },
    ] });
    const body = await (await GET(new Request(url), context)).json();
    expect(body.blockingIssues).toEqual([expect.objectContaining({ id: 'live', title: '缺少实际讲稿' })]);
    expect(body.quality.issues).toEqual([expect.objectContaining({ id: 'old', blocking: false, severity: 'suggestion' })]);
  });
  it('never treats saved browser measurements as publication blockers', async () => {
    mocks.freshRender.mockReturnValue({ pages: [{ sceneId: 'slide', status: 'completed', issues: [
      { id: 'old-render', origin: 'render', severity: 'error', blocking: true, title: '旧布局判定', evidence: '', suggestion: '' },
    ] }] });
    const body = await (await GET(new Request(url), context)).json();
    expect(body.renderReview.pages[0].issues).toEqual([expect.objectContaining({ blocking: false, severity: 'suggestion' })]);
    expect(body.blockingIssues).toEqual([]);
  });
  it('starts a render batch and requires its id on every saved page', async () => {
    const signature = 'a'.repeat(64);
    const renderReview = { runId: '123e4567-e89b-42d3-a456-426614174000', reviewPolicyVersion: 'render-visible-content-v2', pages: [] };
    mocks.startRender.mockResolvedValue(renderReview);
    const start = await POST(new Request(url, { method: 'POST', body: JSON.stringify({ action: 'render-start', signature, mode: 'all' }) }), context);
    expect(await start.json()).toMatchObject({ renderReview });
    expect(mocks.startRender).toHaveBeenCalledWith('course', signature, 'check');
    const page = { sceneId: 'slide', status: 'completed', issues: [] };
    const missingBatch = await POST(new Request(url, { method: 'POST', body: JSON.stringify({ action: 'render-page', signature, page }) }), context);
    expect(missingBatch.status).toBe(400);
    const saved = await POST(new Request(url, { method: 'POST', body: JSON.stringify({ action: 'render-page', signature, runId: renderReview.runId, page }) }), context);
    expect(saved.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith('course', signature, renderReview.runId, expect.objectContaining({ sceneId: 'slide' }));
  });
  it('retains authorization before loading or checking', async () => {
    mocks.authorize.mockResolvedValue(new Response('Forbidden', { status: 403 }));
    expect((await GET(new Request(url), context)).status).toBe(403);
    expect((await POST(new Request(url, { method: 'POST', body: JSON.stringify({ action: 'check' }) }), context)).status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
