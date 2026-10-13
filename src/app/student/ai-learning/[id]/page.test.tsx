import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Course } from '@/lib/session/types';
import StudentAiLearningPage from './page';

const state = vi.hoisted(() => ({
  classroomId: 'player-1' as string | undefined,
  query: 'courseId=course-1',
  hydrated: false,
  course: undefined as Course | undefined,
  studentId: undefined as string | undefined,
  connectWebSocket: vi.fn(),
  disconnectWebSocket: vi.fn(),
  runtime: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: state.classroomId }),
  useSearchParams: () => new URLSearchParams(state.query),
}));
vi.mock('@/lib/session/store', () => ({
  useCourse: (id: string | undefined) => state.course?.id === id ? state.course : undefined,
  useHydrated: () => state.hydrated,
  useSession: () => ({
    studentId: state.studentId, studentName: '学生甲', user: { name: '学生甲' },
    connectWebSocket: state.connectWebSocket, disconnectWebSocket: state.disconnectWebSocket,
    realtimeMode: 'polling',
  }),
}));
vi.mock('@/components/views/student/adaptive-ai-learning-runtime', () => ({
  AdaptiveAiLearningRuntime: (props: unknown) => {
    state.runtime(props);
    return <div>全屏课程播放器</div>;
  },
}));

describe('standalone student learning player hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.classroomId = 'player-1';
    state.query = 'courseId=course-1';
    state.hydrated = false;
    state.course = undefined;
    state.studentId = undefined;
  });
  afterEach(cleanup);

  it('subscribes on a cold direct entry and mounts the fullscreen player after hydration', () => {
    const view = render(<StudentAiLearningPage />);
    expect(state.connectWebSocket).toHaveBeenCalledWith('course-1');
    expect(screen.getByText('正在准备学习环境...')).toBeTruthy();
    expect(screen.queryByText(/缺少课堂/)).toBeNull();
    expect(screen.queryByText(/学生身份未初始化/)).toBeNull();
    expect(state.runtime).not.toHaveBeenCalled();

    state.hydrated = true;
    state.course = { id: 'course-1' } as Course;
    state.studentId = 'student-1';
    view.rerender(<StudentAiLearningPage />);
    expect(screen.getByText('全屏课程播放器')).toBeTruthy();
    expect(state.runtime).toHaveBeenCalledWith(expect.objectContaining({
      course: state.course, classroomId: 'player-1', studentId: 'student-1',
      studentName: '学生甲', backHref: '/student/classroom/course-1', variant: 'fullscreen',
    }));
    view.unmount();
    expect(state.disconnectWebSocket).toHaveBeenCalledOnce();
  });

  it.each(['', 'courseId='])('distinguishes missing course parameters (%s) from a loading course', query => {
    state.query = query;
    render(<StudentAiLearningPage />);
    expect(screen.getByText('缺少课堂或课程 ID 参数，请从课程空间重新进入')).toBeTruthy();
    expect(screen.queryByText('正在准备学习环境...')).toBeNull();
    expect(state.runtime).not.toHaveBeenCalled();
  });

  it('reports a missing classroom identifier separately from course hydration', () => {
    state.classroomId = undefined;
    render(<StudentAiLearningPage />);
    expect(screen.getByText('缺少课堂或课程 ID 参数，请从课程空间重新进入')).toBeTruthy();
  });

  it('reports an unavailable course after hydration instead of claiming the URL is incomplete', () => {
    state.hydrated = true;
    render(<StudentAiLearningPage />);
    expect(screen.getByText('未找到课程，请从课程空间重新进入')).toBeTruthy();
    expect(screen.queryByText(/缺少课堂/)).toBeNull();
    expect(state.runtime).not.toHaveBeenCalled();
  });

  it('retains the identity guard after the requested course has loaded', () => {
    state.hydrated = true;
    state.course = { id: 'course-1' } as Course;
    render(<StudentAiLearningPage />);
    expect(screen.getByText('学生身份未初始化，请重新进入课堂')).toBeTruthy();
    expect(state.runtime).not.toHaveBeenCalled();
  });
});
