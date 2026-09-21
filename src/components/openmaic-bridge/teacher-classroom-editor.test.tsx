import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene, Stage } from '@openmaic/lib/types/stage';

interface TestState {
  stage: Stage | null;
  scenes: Scene[];
  currentSceneId: string | null;
  clearStore: () => void;
}

const mocks = vi.hoisted(() => {
  const listeners = new Set<(state: TestState) => void>();
  const reset = () => { state = { stage: null, scenes: [], currentSceneId: null, clearStore: reset }; };
  let state: TestState = { stage: null, scenes: [], currentSceneId: null, clearStore: reset };
  return {
    fetch: vi.fn(),
    toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
    canvas: { clearSelection: vi.fn(), setActiveElementIdList: vi.fn() },
    store: {
      getState: () => state,
      setState: (patch: Partial<TestState>) => {
        state = { ...state, ...patch };
        listeners.forEach((listener) => listener(state));
      },
      subscribe: (listener: (state: TestState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
});

vi.mock('@openmaic/lib/store', () => ({ useStageStore: mocks.store, useCanvasStore: { getState: () => mocks.canvas } }));
vi.mock('@openmaic/components/stage', () => ({ Stage: () => <div>课堂编辑区域</div> }));
vi.mock('@openmaic/components/server-providers-init', () => ({ ServerProvidersInit: () => null }));
vi.mock('@openmaic/lib/contexts/media-stage-context', () => ({ MediaStageProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@openmaic/lib/hooks/use-theme', () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@openmaic/lib/hooks/use-i18n', () => ({ I18nProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@openmaic/lib/edit/slide-schema', () => ({ migrateScene: (scene: Scene) => scene }));
vi.mock('@openmaic/lib/edit/preload-editor', () => ({ preloadEditor: async () => {} }));
vi.mock('@openmaic/lib/audio/classroom-edit-audio', () => ({ collectClassroomAudioUploads: async () => [] }));
vi.mock('@openmaic/components/edit/surfaces/slide/slide-edit-session', () => ({ useSlideEditSession: { getState: () => ({ sceneId: null }) } }));
vi.mock('@openmaic/components/edit/surfaces/quiz/quiz-edit-session', () => ({ useQuizEditSession: { getState: () => ({ sceneId: null }) } }));
vi.mock('@/components/ui', () => ({ toast: mocks.toast }));

import { TeacherClassroomEditor } from './teacher-classroom-editor';

function classroom(id = 'c1') {
  const stage: Stage = { id, name: '课堂', createdAt: 1, updatedAt: 1 };
  const scenes: Scene[] = ['s1', 's2'].map((sceneId, order) => ({
    id: sceneId, stageId: id, type: 'slide', title: sceneId, order,
    content: { type: 'slide', canvas: {
      id: sceneId, elements: [], viewportSize: 1000, viewportRatio: 0.5625,
      theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: 'Arial' },
    } },
    actions: [{ id: `${sceneId}-speech`, type: 'speech', text: '原讲稿' }],
  } as Scene));
  return { id, stage, scenes, revision: 4 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const editor = (courseId = 'course-1') => <TeacherClassroomEditor courseId={courseId} courseName="课程" backHref="/teacher" />;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.getState().clearStore();
  vi.stubGlobal('fetch', mocks.fetch);
});

describe('teacher classroom save lifecycle', () => {
  it('opens the requested review scene and selects a valid slide element', async () => {
    const initial = classroom();
    const reviewScene = initial.scenes[1];
    if (reviewScene.content.type !== 'slide') throw new Error('Expected a slide fixture');
    reviewScene.content.canvas.elements = [{ id: 'problem-element' }] as typeof reviewScene.content.canvas.elements;
    mocks.fetch.mockResolvedValueOnce(Response.json({ success: true, classroom: initial }));
    render(<TeacherClassroomEditor
      backHref="/teacher"
      courseId="course-1"
      courseName="课程"
      initialElementId="problem-element"
      initialSceneId="s2"
    />);
    await screen.findByText('课堂编辑区域');
    expect(mocks.store.getState().currentSceneId).toBe('s2');
    expect(mocks.canvas.setActiveElementIdList).toHaveBeenCalledWith(['problem-element']);
  });

  it('keeps editing and the selected page while a save response is pending', async () => {
    const initial = classroom();
    const pending = deferred<Response>();
    mocks.fetch.mockResolvedValueOnce(Response.json({ success: true, classroom: initial }));
    mocks.fetch.mockReturnValueOnce(pending.promise);
    render(editor());
    await screen.findByText('课堂编辑区域');
    act(() => mocks.store.setState({ scenes: initial.scenes.map((scene) => ({ ...scene, title: '已提交的标题' })) }));
    fireEvent.click(screen.getByRole('button', { name: '保存课堂' }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    const body = JSON.parse(mocks.fetch.mock.calls[1][1].body);
    expect(body.classroomId).toBe('c1');
    act(() => mocks.store.setState({
      currentSceneId: 's2',
      scenes: mocks.store.getState().scenes.map((scene) => ({ ...scene, title: '保存期间继续修改' })),
    }));
    await act(async () => pending.resolve(Response.json({
      success: true, classroom: { ...initial, scenes: body.scenes, revision: 5 },
    })));
    expect(mocks.store.getState().scenes[0].title).toBe('保存期间继续修改');
    expect(mocks.store.getState().currentSceneId).toBe('s2');
    expect(screen.getByText(/有修改尚未保存/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存课堂' })).toBeEnabled();
  });

  it('ignores a late classroom load after navigating to another course', async () => {
    const oldLoad = deferred<Response>();
    mocks.fetch.mockReturnValueOnce(oldLoad.promise);
    mocks.fetch.mockResolvedValueOnce(Response.json({ success: true, classroom: classroom('c2') }));
    const { rerender } = render(editor());
    rerender(editor('course-2'));
    await screen.findByText('课堂编辑区域');
    expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => oldLoad.resolve(Response.json({ success: true, classroom: classroom('c1') })));
    expect(mocks.store.getState().stage?.id).toBe('c2');
  });

  it('keeps local changes when the user declines a conflict reload', async () => {
    const initial = classroom();
    mocks.fetch.mockResolvedValueOnce(Response.json({ success: true, classroom: initial }));
    mocks.fetch.mockResolvedValueOnce(Response.json({ code: 'REVISION_CONFLICT' }, { status: 409 }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(editor());
    await screen.findByText('课堂编辑区域');
    act(() => mocks.store.setState({ scenes: initial.scenes.map((scene) => ({ ...scene, title: '未保存修改' })) }));
    fireEvent.click(screen.getByRole('button', { name: '保存课堂' }));
    fireEvent.click(await screen.findByRole('button', { name: '重新加载' }));
    expect(confirm).toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.store.getState().scenes[0].title).toBe('未保存修改');
    confirm.mockRestore();
  });
});
