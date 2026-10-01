import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Course } from '@/lib/session/types';
import type { CourseResourceIssue } from '@/lib/course-generation/resource-audit-server';

const mocks = vi.hoisted(() => ({ resources: [] as CourseResourceIssue[], refresh: vi.fn(), publish: vi.fn() }));
let course: Course;
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'course' }), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/session/store', () => ({
  useHydrated: () => true, useCourse: () => course,
  useSession: () => ({ user: { name: '张老师' }, refresh: mocks.refresh, publishCourse: mocks.publish }),
}));
vi.mock('@/components/dashboard-shell', () => ({ DashboardShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/hooks/use-course-generation-preview-sync', () => ({ useCourseGenerationPreviewSync: () => ({ refreshKey: 'saved' }) }));
vi.mock('@/components/openmaic-bridge/student-stage-host', () => ({ StudentStageHost: () => null }));
vi.mock('@/components/teacher/teaching-tool-runbook', () => ({ TeachingToolRunbook: () => null }));
vi.mock('@/lib/course-resources/download-course-resources', () => ({ downloadCourseResources: vi.fn() }));
vi.mock('@/lib/classroom/new-system-course', () => ({ getNewSystemCourseReadiness: () => [
  { id: 'basics', label: '课程信息', ok: true, message: '信息完整。' },
  { id: 'full-classroom-generation', label: '完整课程', ok: true, message: '页面完整。' },
  { id: 'timing', label: '讲授时长', ok: false, message: '实测时长仍需教师核对。' },
] }));
vi.mock('@/components/teacher/course-quality-review', async () => {
  const { useEffect } = await import('react');
  return { CourseQualityReview: ({ onDecisionChange }: { onDecisionChange: (value: unknown) => void }) => {
    useEffect(() => { onDecisionChange({ canConfirm: true, signature: 'a'.repeat(64), acceptedIssueIds: [], acknowledgeFailedCheck: false }); }, [onDecisionChange]);
    return null;
  } };
});
import PreviewCoursePage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  course = {
    id: 'course', name: '教学理论与方法', subject: '教育学', grade: '本科一年级', hours: 2,
    status: 'preparing', stages: [], aiLearningClassroomId: 'saved-classroom',
    content: { qualityReviewRequired: true, knowledgePoints: [], _openmaicSceneOutlines: [],
      classroomGenerationRun: { scope: 'full-course', status: 'completed', generatedOutlineIds: [], fullOutlineCount: 23 } },
  } as unknown as Course;
  mocks.resources = [{ id: 'content:source-sequence:source', type: 'source-consistency', title: '教材清单', detail: '完整来源清单待核对。' }];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/resource-repair')
    ? { issues: mocks.resources, repair: { status: 'idle' }, syncRepair: { status: 'idle' } }
    : {})));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('course publication readiness', () => {
  it('allows publication with quality diagnostics and keeps their actual details visible', async () => {
    render(<PreviewCoursePage />);
    await waitFor(() => expect(screen.getByRole('button', { name: '确认并发布' })).toBeEnabled());
    expect(screen.getByText('未发布 · 可以发布')).toBeVisible();
    expect(screen.getAllByText('实测时长仍需教师核对。').length).toBeGreaterThan(0);
    expect(screen.getByText('完整来源清单待核对。', { exact: false })).toBeVisible();
    expect(screen.queryByText('影响发布')).toBeNull();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('still disables publication when an actual narration audio file is missing', async () => {
    mocks.resources.push({ id: 'tts:scene:speech', type: 'tts', title: '讲解音频', detail: '语音文件不存在。' });
    render(<PreviewCoursePage />);
    await screen.findByText('还有 1 项课程资源需要处理');
    expect(screen.getByRole('button', { name: '确认并发布' })).toBeDisabled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
