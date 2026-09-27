import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ usePathname: () => '/teacher/teach/course-1/classroom' }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
import { SessionProvider, useSession } from './store';
function deferred() { let resolve!: (response: Response) => void; const promise = new Promise<Response>(done => { resolve = done; }); return { promise, resolve }; }
const course = { id: 'course-1', name: 'Course', status: 'teaching', version: 1, updatedAt: '2026-09-27T00:00:00Z', students: [], stages: [], currentStageIndex: 0, resources: [], groups: [], submissions: [], activityLog: [], uiState: {}, content: { lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' } } };
function Probe() {
  const session = useSession();
  useEffect(() => { session.connectWebSocket('course-1'); return () => session.disconnectWebSocket(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const current = session.courses.find(item => item.id === 'course-1');
  return <><span data-testid="version">{current?.version}</span><span data-testid="projection">{current?.uiState?.projectionVersion ?? 0}</span><span data-testid="saved">{session.saveState}</span><button onClick={() => session.setStage('course-1', 0)}>save</button></>;
}
async function flush() { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

it('serializes polling and WS invalidations while projection and save acknowledgements remain immediate', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
  window.history.replaceState({}, '', '/teacher/teach/course-1/classroom');
  const first = deferred(); let snapshots = 0;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/courses?')) return Promise.resolve(Response.json({ courses: [course], user: { role: 'teacher', name: 'teacher' }, updatedAt: course.updatedAt }));
    if (url.endsWith('/state')) {
      snapshots++;
      return snapshots === 1 ? first.promise : Promise.resolve(Response.json({ course: { ...course, version: 44 }, eventCursor: '44' }));
    }
    if (url.endsWith('/projection')) return Promise.resolve(Response.json({ courseId: course.id, courseVersion: 1, projectionVersion: 0, projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt }));
    if (url.includes('/events?')) return Promise.resolve(Response.json({ events: [{ type: 'COURSE_ACTION', cursor: '2', courseVersion: 2 }], nextCursor: '2', hasMore: false }));
    if (url.endsWith('/actions')) return Promise.resolve(Response.json({ requestId: 'saved', courseVersion: 3, eventCursor: '3' }));
    throw new Error(`Unexpected ${url}`);
  }));
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static current: Socket;
    readyState = 0; onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null; onclose: (() => void) | null = null;
    constructor() { Socket.current = this; }
    send() {}
    close() { this.readyState = 3; }
    emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  vi.stubGlobal('WebSocket', Socket);
  const mounted = render(<SessionProvider><Probe /></SessionProvider>); await flush(); expect(snapshots).toBe(1);
  await act(async () => {
    Socket.current.readyState = 1; Socket.current.onopen?.();
    Socket.current.emit({ type: 'subscribed', courseId: course.id });
    for (let i = 4; i <= 44; i++) Socket.current.emit({ type: 'course-event', courseId: course.id, event: { type: 'course-updated', payload: { eventCursor: String(i), courseVersion: i, actionType: 'UPSERT_SUBMISSION' } } });
    Socket.current.emit({ type: 'course-event', courseId: course.id, event: { type: 'projection-changed', payload: { courseVersion: 2, projectionVersion: 7, resourceProjection: null, teacherResourceProjection: null, projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt } } });
  });
  await flush(); expect(screen.getByTestId('projection').textContent).toBe('7');
  fireEvent.click(screen.getByText('save')); await flush();
  expect(screen.getByTestId('saved').textContent).toBe('saved'); expect(screen.getByTestId('version').textContent).toBe('3');
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); }); expect(snapshots).toBe(1);
  await act(async () => { first.resolve(Response.json({ course, eventCursor: '1' })); }); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(750); }); await flush();
  expect(snapshots).toBe(2); expect(screen.getByTestId('version').textContent).toBe('44'); expect(screen.getByTestId('projection').textContent).toBe('7');
  mounted.unmount();
});
