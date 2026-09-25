import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/student/classroom/course-1' }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

import { SessionProvider, useSession } from './store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const course = {
  id: 'course-1', name: '课堂', status: 'teaching', updatedAt: '2026-09-25T00:00:00Z',
  students: [], stages: [], currentStageIndex: 0, resources: [], groups: [],
  submissions: [], activityLog: [], uiState: {},
  content: { lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' } },
};

function StudentProbe() {
  const session = useSession();
  useEffect(() => {
    session.connectWebSocket('course-1');
    return () => session.disconnectWebSocket();
    // The provider owns transport callbacks; only mount/unmount matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <span>{session.studentId ?? 'missing-student'}</span>;
}

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

it('keeps authenticated student identity when the first course snapshot races session hydration', async () => {
  window.history.replaceState({}, '', '/student/classroom/course-1');
  const session = deferred<Response>();
  const state = deferred<Response>();
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/courses?')) return session.promise;
    if (url.endsWith('/state')) return state.promise;
    if (url.endsWith('/projection')) return Promise.resolve(Response.json({
      courseId: course.id, courseVersion: 0, projectionVersion: 0,
      projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt,
    }));
    if (url.endsWith('/events?after=0')) return Promise.resolve(Response.json({ events: [], nextCursor: '0' }));
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('WebSocket', class {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = 0;
    close() { this.readyState = 3; }
  });

  render(<SessionProvider><StudentProbe /></SessionProvider>);
  await waitFor(() => {
    expect(fetcher).toHaveBeenCalledWith('/api/courses?courseId=course-1', expect.anything());
    expect(fetcher).toHaveBeenCalledWith('/api/courses/course-1/state', expect.anything());
  });

  await act(async () => {
    session.resolve(Response.json({
      courses: [course], user: { role: 'student', name: '学生' },
      studentId: 'student-1', studentName: '学生', joinedCourseId: course.id,
      updatedAt: course.updatedAt,
    }));
    await Promise.resolve();
    await Promise.resolve();
    state.resolve(Response.json({ course, eventCursor: '0' }));
    await Promise.resolve();
  });
  expect(screen.getByText('student-1')).toBeTruthy();
});
