import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PPTTextElement } from '@openmaic/dsl';
import { SceneProvider } from '@openmaic/lib/contexts/scene-context';
import { classroomFingerprint } from '@/lib/openmaic-bridge/classroom-editor-save';
import { createDefaultSlide, createDefaultTextElement } from '@openmaic/lib/edit/slide-edit-elements';
import { initProsemirrorEditor } from '@openmaic/lib/prosemirror';
import { runActiveTextCommand } from '@openmaic/lib/prosemirror/active-editor-registry';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import { useStageStore } from '@openmaic/lib/store/stage';
import type { Scene, SlideContent } from '@openmaic/lib/types/stage';
import { TextElement } from '@openmaic/components/slide-renderer/components/element/TextElement';
import { useSlideEditSession } from './slide-edit-session';
import { useSlideCanvasController } from './use-slide-surface';

vi.mock('@openmaic/lib/prosemirror', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openmaic/lib/prosemirror')>();
  return { ...actual, initProsemirrorEditor: vi.fn(actual.initProsemirrorEditor) };
});
vi.mock('@openmaic/lib/hooks/use-history-snapshot', () => ({
  useHistorySnapshot: () => ({ addHistorySnapshot: vi.fn() }),
}));
vi.mock('@openmaic/lib/utils/stage-storage', () => ({ saveStageData: vi.fn() }));

const observers = new Set<ResizeObserverCallback>();

function slide(id: string): Scene {
  return { id, type: 'slide', stageId: 'classroom', order: 0, title: id,
    content: { type: 'slide', schemaVersion: 1, canvas: { ...createDefaultSlide(id), elements: [
      { ...createDefaultTextElement('note'), content: '<p class="source">保留原文</p>', height: 73 },
      { ...createDefaultTextElement('vertical'), content: '<p>竖排原文</p>', vertical: true, width: 73 },
      { ...createDefaultTextElement('empty'), content: '<p></p>' },
      { ...createDefaultTextElement('locked'), content: '<p>锁定文字</p>', lock: true },
    ] } }, actions: [{ id: 'speech', type: 'speech', text: '原讲稿' }] };
}

function Harness() {
  const { controller } = useSlideCanvasController();
  const scene = useStageStore((state) => state.scenes.find((item) => item.id === state.currentSceneId)!);
  const elements = (scene.content as SlideContent).canvas.elements as PPTTextElement[];
  return <SceneProvider key={controller.sceneId} controller={controller}>
    {elements.map((element) => <section key={element.id} data-testid={element.id}>
      <TextElement elementInfo={element} />
    </section>)}
  </SceneProvider>;
}

function view(id = 'note') {
  const result = vi.mocked(initProsemirrorEditor).mock.results
    .map((item) => item.value as ReturnType<typeof initProsemirrorEditor>)
    .findLast((item) => item.dom.closest('section')?.dataset.testid === id);
  if (!result) throw new Error(`Missing editor ${id}`);
  return result;
}

function fingerprint() {
  const state = useStageStore.getState();
  return classroomFingerprint(state.stage, state.scenes);
}

function saved(id = 'note', sceneId = 'first') {
  return (useStageStore.getState().scenes.find((scene) => scene.id === sceneId)!.content as SlideContent)
    .canvas.elements.find((element) => element.id === id) as PPTTextElement | undefined;
}

function edit(text: string, id = 'note') {
  const editor = view(id);
  act(() => editor.dispatch(editor.state.tr.insertText(text, 1, editor.state.doc.content.size - 1)));
  act(() => vi.advanceTimersByTime(300));
}

function resizeAndLoadFont() {
  act(() => {
    fireEvent(window, new Event('resize'));
    // Layout observers must never turn font loading or a viewport change into
    // an authoring operation, even when measured geometry differs greatly.
    for (const callback of observers) callback([
      { contentRect: { width: 300, height: 240 } } as ResizeObserverEntry,
    ], {} as ResizeObserver);
    vi.advanceTimersByTime(600);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  observers.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { observers.add(callback); }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.mocked(initProsemirrorEditor).mockClear();
  useCanvasStore.getState().resetCanvasState();
  useSlideEditSession.getState().end();
  useStageStore.setState({
    stage: { id: 'classroom', name: '课堂', createdAt: 1, updatedAt: 1 },
    scenes: [slide('first'), slide('second')], currentSceneId: 'first', mode: 'edit',
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('text element authoring lifecycle', () => {
  it('preserves the full document while opening, selecting, loading fonts, resizing and visiting every page', () => {
    const initial = fingerprint();
    render(<Harness />);
    resizeAndLoadFont();
    act(() => useCanvasStore.getState().setActiveElementIdList(['note']));
    fireEvent.focus(view().dom);
    fireEvent.keyDown(view().dom, { key: 'a', ctrlKey: true });
    fireEvent.blur(view().dom);
    resizeAndLoadFont();
    act(() => useStageStore.getState().setCurrentSceneId('second'));
    resizeAndLoadFont();
    act(() => useStageStore.getState().setCurrentSceneId('first'));
    resizeAndLoadFont();
    expect(fingerprint()).toBe(initial);
    expect(saved('empty')).toBeDefined();
    expect(useSlideEditSession.getState().history!.past).toHaveLength(0);
  });

  it.each(['note', 'vertical'])('commits %s content and geometry in one undo step, including formatting', (id) => {
    const initial = fingerprint();
    render(<Harness />);
    const node = screen.getByTestId(id).querySelector('.element-content')!;
    Object.defineProperty(node, id === 'vertical' ? 'offsetWidth' : 'offsetHeight', { configurable: true, value: 120 });
    edit('用户输入的完整新内容', id);
    const typed = fingerprint();
    expect(saved(id)).toMatchObject({ [id === 'vertical' ? 'width' : 'height']: 120 });
    expect(useSlideEditSession.getState().history!.past).toHaveLength(1);
    act(() => useCanvasStore.getState().setActiveElementIdList([id]));
    act(() => runActiveTextCommand(id, { command: 'bold' }));
    act(() => vi.advanceTimersByTime(300));
    expect(saved(id)?.content).toContain('<strong>');
    expect(useSlideEditSession.getState().history!.past).toHaveLength(2);
    act(() => useSlideEditSession.getState().undo());
    expect(fingerprint()).toBe(typed);
    act(() => useSlideEditSession.getState().undo());
    resizeAndLoadFont();
    expect(fingerprint()).toBe(initial);
    act(() => useSlideEditSession.getState().redo());
    resizeAndLoadFont();
    expect(fingerprint()).toBe(typed);
  });

  it('cleans up only text explicitly cleared by the user after blur', () => {
    render(<Harness />);
    edit('');
    expect(saved()).toBeDefined();
    fireEvent.blur(view().dom);
    act(() => vi.advanceTimersByTime(300));
    expect(saved()).toBeUndefined();
    expect(saved('empty')).toBeDefined();
  });

  it('does not delete restored text when undo occurs during the empty cleanup delay', () => {
    render(<Harness />);
    edit('');
    fireEvent.blur(view().dom);
    act(() => useSlideEditSession.getState().undo());
    act(() => vi.advanceTimersByTime(600));
    expect(saved()?.content).toBe('<p class="source">保留原文</p>');
  });

  it('uses the canvas history for text keyboard undo, including pending input and exact initial geometry', () => {
    const initial = fingerprint();
    render(<Harness />);
    const node = screen.getByTestId('note').querySelector('.element-content')!;
    Object.defineProperty(node, 'offsetHeight', { value: 120 });
    const editor = view();
    act(() => editor.dispatch(editor.state.tr.insertText('还未防抖提交的新内容', 1, editor.state.doc.content.size - 1)));
    fireEvent.keyDown(editor.dom, { key: 'z', ctrlKey: true });
    resizeAndLoadFont();
    expect(fingerprint()).toBe(initial);
    expect(editor.state.doc.textContent).toBe('保留原文');
    fireEvent.keyDown(editor.dom, { key: 'Z', metaKey: true, shiftKey: true });
    expect(saved()?.content).toContain('还未防抖提交的新内容');
    expect(saved()?.height).toBe(120);
    fireEvent.keyDown(editor.dom, { key: 'z', ctrlKey: true });
    expect(fingerprint()).toBe(initial);
    fireEvent.keyDown(editor.dom, { key: 'y', ctrlKey: true });
    expect(saved()?.content).toContain('还未防抖提交的新内容');
  });

  it('keeps intervening edits to other elements when delayed empty cleanup runs', () => {
    render(<Harness />);
    edit('');
    fireEvent.blur(view().dom);
    act(() => useSlideEditSession.getState().applyOp({
      type: 'text.updateContent', elementId: 'vertical', content: '<p>清理等待期间更新的文字</p>',
    }));
    act(() => useSlideEditSession.getState().applyOp({
      type: 'element.add', element: createDefaultTextElement('new-text'),
    }));
    act(() => vi.advanceTimersByTime(300));
    expect(saved()).toBeUndefined();
    expect(saved('vertical')?.content).toBe('<p>清理等待期间更新的文字</p>');
    expect(saved('new-text')).toBeDefined();
  });

  it('cancels delayed cleanup when changing pages that reuse element IDs', () => {
    render(<Harness />);
    edit('');
    fireEvent.blur(view().dom);
    act(() => useStageStore.getState().setCurrentSceneId('second'));
    act(() => vi.advanceTimersByTime(600));
    expect(saved('note', 'first')).toBeDefined();
    expect(saved('note', 'second')?.content).toBe('<p class="source">保留原文</p>');
  });
});
