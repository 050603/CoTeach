import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PPTShapeElement } from '@openmaic/dsl';
import { initProsemirrorEditor } from '@openmaic/lib/prosemirror';
import { focusActiveTextEditor, runActiveTextCommand } from '@openmaic/lib/prosemirror/active-editor-registry';
import { SceneProvider } from '@openmaic/lib/contexts/scene-context';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import { useStageStore } from '@openmaic/lib/store/stage';
import { createDefaultSlide, createDefaultTextElement } from '@openmaic/lib/edit/slide-edit-elements';
import type { Scene, SlideContent } from '@openmaic/lib/types/stage';
import { ShapeElement } from '@openmaic/components/slide-renderer/components/element/ShapeElement';
import { ProsemirrorEditor } from '@openmaic/components/slide-renderer/components/element/ProsemirrorEditor';
import { useSlideEditSession } from './slide-edit-session';
import { resolveEditingElementId } from './editing-state';
import { useEditingTextElementId, useSlideCanvasController, useSyncEditingElementId } from './use-slide-surface';

vi.mock('@openmaic/lib/prosemirror', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openmaic/lib/prosemirror')>();
  return { ...actual, initProsemirrorEditor: vi.fn(actual.initProsemirrorEditor) };
});
vi.mock('@openmaic/lib/hooks/use-history-snapshot', () => ({
  useHistorySnapshot: () => ({ addHistorySnapshot: vi.fn() }),
}));
vi.mock('@openmaic/lib/utils/stage-storage', () => ({ saveStageData: vi.fn() }));

const shape: PPTShapeElement = {
  id: 'step', type: 'shape', left: 100, top: 150, width: 200, height: 60, rotate: 0,
  viewBox: [100, 100], path: 'M0 0 L100 0 L100 100 L0 100 Z', fixedRatio: false, fill: '#EFF6FF',
  text: { content: '<p>搭脚手架：明确任务</p>', defaultFontName: 'Noto Sans SC', defaultColor: '#1E3A8A', align: 'middle' },
};

function slide(id: string): Scene & { content: SlideContent } {
  return { id, type: 'slide', stageId: 'classroom', order: 0, title: id,
    content: { type: 'slide', canvas: { ...createDefaultSlide(id), elements: [
      structuredClone(shape), { ...shape, id: 'empty', text: undefined, top: 230 },
      { ...shape, id: 'locked', lock: true, top: 310 },
    ] } }, actions: [{ id: 'speech', type: 'speech', text: '完整原讲稿' }] };
}

function Harness() {
  const { controller } = useSlideCanvasController();
  const editingId = useEditingTextElementId();
  useSyncEditingElementId(editingId);
  const scene = useStageStore((s) => s.scenes.find((item) => item.id === s.currentSceneId)!);
  const elements = (scene.content as SlideContent).canvas.elements as PPTShapeElement[];
  return <>
    <output data-testid="editing">{editingId}</output>
    <button onClick={() => useCanvasStore.getState().setEditingElementId('step')}>编辑文字</button>
    <SceneProvider key={controller.sceneId} controller={controller}>
      {elements.map((element) => <section data-testid={element.id} key={element.id}>
        <ShapeElement elementInfo={element} selectElement={(_event, selected) => {
          useCanvasStore.getState().setActiveElementIdList([selected.id]);
        }} />
      </section>)}
    </SceneProvider>
  </>;
}

function view(id = 'step') {
  const result = vi.mocked(initProsemirrorEditor).mock.results
    .map((item) => item.value as ReturnType<typeof initProsemirrorEditor>)
    .findLast((item) => item.dom.closest('section')?.dataset.testid === id);
  if (!result) throw new Error(`Missing editor ${id}`);
  return result;
}

function edit(text: string, id = 'step') {
  const editor = view(id);
  act(() => editor.dispatch(editor.state.tr.insertText(text, 1, editor.state.doc.content.size - 1)));
}

function saved(id = 'step', sceneId = 'first') {
  return (useStageStore.getState().scenes.find((scene) => scene.id === sceneId)!.content as SlideContent)
    .canvas.elements.find((element) => element.id === id) as PPTShapeElement;
}

beforeEach(() => {
  vi.useFakeTimers();
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
});

it('selects shapes for movement, then double click focuses their text and registers formatting', () => {
  render(<Harness />);
  const content = screen.getByTestId('step').querySelector('.element-content')!;
  fireEvent.mouseDown(content);
  expect(screen.getByTestId('editing')).toBeEmptyDOMElement();
  expect(view().dom).toHaveAttribute('contenteditable', 'false');
  fireEvent.doubleClick(content);
  expect(view().dom).toHaveAttribute('contenteditable', 'true');
  expect(view().dom).toHaveFocus();
  expect(useCanvasStore.getState().disableHotkeys).toBe(true);
  screen.getByRole('button', { name: '编辑文字' }).focus();
  act(() => focusActiveTextEditor('step'));
  expect(view().dom).toHaveFocus();
  edit('中文节点内容');
  act(() => runActiveTextCommand('step', { command: 'bold' }));
  act(() => vi.advanceTimersByTime(300));
  expect(saved().text?.content).toContain('<strong>中文节点内容</strong>');
  expect(saved('locked').text?.content).toBe(shape.text!.content);
  expect(useSlideEditSession.getState().history!.past).toHaveLength(1);
});

it('commits input immediately when switching nodes and lets toolbar undo and redo restore it', () => {
  render(<Harness />);
  act(() => useCanvasStore.getState().setActiveElementIdList(['step']));
  fireEvent.click(screen.getByRole('button', { name: '编辑文字' }));
  edit('立即切换前的中文');
  act(() => useCanvasStore.getState().setActiveElementIdList(['empty']));
  expect(saved().text?.content).toContain('立即切换前的中文');
  expect(view().dom).toHaveAttribute('contenteditable', 'false');
  act(() => useSlideEditSession.getState().undo());
  expect(saved().text?.content).toBe(shape.text!.content);
  expect(view().state.doc.textContent).toBe('搭脚手架：明确任务');
  act(() => vi.advanceTimersByTime(600));
  act(() => useSlideEditSession.getState().redo());
  expect(saved().text?.content).toContain('立即切换前的中文');
  expect(view().state.doc.textContent).toBe('立即切换前的中文');
});

it('flushes departing editors to their own page when the next page reuses element IDs', () => {
  render(<Harness />);
  act(() => {
    useCanvasStore.getState().setActiveElementIdList(['step']);
    useCanvasStore.getState().setEditingElementId('step');
  });
  edit('只属于第一页');
  act(() => useStageStore.getState().setCurrentSceneId('second'));
  expect(saved().text?.content).toContain('只属于第一页');
  expect(saved('step', 'second').text?.content).toBe(shape.text!.content);
  act(() => vi.advanceTimersByTime(600));
  expect(saved('step', 'second').text?.content).toBe(shape.text!.content);
  expect(useCanvasStore.getState().editingElementId).toBe('');
  expect(useCanvasStore.getState().disableHotkeys).toBe(false);
});

it('supports an empty shape and commits its new text before unmount', () => {
  const { unmount } = render(<Harness />);
  const content = screen.getByTestId('empty').querySelector('.element-content')!;
  fireEvent.mouseDown(content);
  fireEvent.doubleClick(content);
  expect(view('empty').dom).toHaveFocus();
  edit('新增文字', 'empty');
  unmount();
  expect(saved('empty').text?.content).toContain('新增文字');
  expect(useCanvasStore.getState().editingElementId).toBe('');
});

it('exits text editing on multi-selection and excludes locked shapes and missing targets', () => {
  render(<Harness />);
  act(() => {
    useCanvasStore.getState().setActiveElementIdList(['step']);
    useCanvasStore.getState().setEditingElementId('step');
  });
  act(() => useCanvasStore.getState().setActiveElementIdList(['step', 'empty']));
  expect(view().dom).toHaveAttribute('contenteditable', 'false');
  expect(useCanvasStore.getState().editingElementId).toBe('');
  const elements = [shape, { ...shape, id: 'locked', lock: true }];
  expect(resolveEditingElementId(['locked'], elements, 'locked')).toBe('');
  expect(resolveEditingElementId(['missing'], elements, 'missing')).toBe('');
  expect(resolveEditingElementId(['step', 'locked'], elements, 'step')).toBe('');
});

it('keeps newer input when an earlier save returns and applies external undo without saving it again', () => {
  const onUpdate = vi.fn();
  const editor = (value: string) => <section data-testid="step">
    <ProsemirrorEditor elementId="step" editable value={value} onUpdate={onUpdate}
      defaultColor="#000000" defaultFontName="Noto Sans SC" />
  </section>;
  const { rerender } = render(editor('<p>原文</p>'));
  edit('第一版');
  act(() => vi.advanceTimersByTime(300));
  const firstSave = onUpdate.mock.calls[0][0].value as string;
  edit('第一版及继续输入的中文');
  rerender(editor(firstSave));
  expect(view().state.doc.textContent).toBe('第一版及继续输入的中文');
  act(() => vi.advanceTimersByTime(300));
  const finalSave = onUpdate.mock.calls[1][0].value as string;
  expect(finalSave.replace(/ style=""/g, '')).toBe('<p>第一版及继续输入的中文</p>');
  expect(onUpdate.mock.calls[1][0].ignore).toBe(false);
  rerender(editor(finalSave));
  rerender(editor('<p>原文</p>'));
  expect(view().state.doc.textContent).toBe('原文');
  rerender(editor(finalSave));
  expect(view().state.doc.textContent).toBe('第一版及继续输入的中文');
  act(() => vi.advanceTimersByTime(300));
  expect(onUpdate).toHaveBeenCalledTimes(2);
});

it('keeps text redo available after automatic height measurement following undo', () => {
  const content = slide('first').content;
  content.canvas.elements = [{ ...createDefaultTextElement('note'), content: '<p>原文</p>', height: 50 }];
  const session = useSlideEditSession.getState();
  session.seed('first', content);
  session.applyOp({ type: 'text.updateContent', elementId: 'note', content: '<p>修改后的正文</p><p>新增的一段说明</p>' });
  const measured = structuredClone(useSlideEditSession.getState().history!.present);
  Object.assign(measured.canvas.elements[0], { height: 100 });
  session.commitContent(measured, false);
  session.undo();
  const remeasured = structuredClone(useSlideEditSession.getState().history!.present);
  Object.assign(remeasured.canvas.elements[0], { height: 48 });
  session.commitContent(remeasured, false);
  expect(useSlideEditSession.getState().history!.future).toHaveLength(1);
  session.redo();
  expect(useSlideEditSession.getState().history!.present.canvas.elements[0])
    .toMatchObject({ content: '<p>修改后的正文</p><p>新增的一段说明</p>' });
});
