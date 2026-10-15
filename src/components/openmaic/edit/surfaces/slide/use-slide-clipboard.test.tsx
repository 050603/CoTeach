import { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import { useStageStore } from '@openmaic/lib/store/stage';
import { createDefaultSlide, createDefaultTextElement } from '@openmaic/lib/edit/slide-edit-elements';
import {
  copySlideElements,
  cutSlideElements,
  pasteSlideElements,
  pasteSlideElementsFromClipboard,
  SLIDE_CLIPBOARD_MIME,
} from '@openmaic/lib/edit/slide-clipboard';
import type { Scene, SlideContent } from '@openmaic/lib/types/stage';
import { useSlideEditSession } from './slide-edit-session';
import { useSlideClipboard } from './use-slide-clipboard';

function scene(id: string): Scene & { type: 'slide'; content: SlideContent } {
  const text = { ...createDefaultTextElement('text'), groupId: 'original-group' };
  return {
    id, stageId: 'classroom', type: 'slide', title: id, order: 0,
    content: { type: 'slide', canvas: {
      ...createDefaultSlide(id),
      elements: [text, { ...text, id: 'second-text', top: 260 }],
      animations: [{ id: 'fade', elId: 'text', effect: 'fadeIn', type: 'in', duration: 300, trigger: 'click' }],
    } },
    actions: [{ id: 'narration', type: 'speech', text: '原讲稿' }],
  };
}

function clipboardData() {
  const values = new Map<string, string>();
  return {
    getData: (type: string) => values.get(type) ?? '',
    setData: (type: string, value: string) => { values.set(type, value); },
  } as DataTransfer;
}

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  useSlideClipboard(ref);
  return <>
    <div ref={ref} tabIndex={0} data-testid="canvas">
      <input aria-label="讲稿" />
      <div contentEditable suppressContentEditableWarning data-testid="text">正文</div>
    </div>
    <button>其他区域</button>
  </>;
}

beforeEach(() => {
  vi.useFakeTimers();
  const first = scene('first');
  const second = scene('second');
  second.content.canvas.elements = [];
  second.content.canvas.animations = [];
  useStageStore.setState({
    stage: { id: 'classroom', name: '课堂', createdAt: 1, updatedAt: 1 },
    scenes: [first, second], currentSceneId: 'first', mode: 'edit',
  });
  useSlideEditSession.getState().seed('first', first.content);
  useCanvasStore.getState().resetCanvasState();
  useCanvasStore.getState().setActiveElementIdList(['text', 'second-text']);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  window.getSelection()?.removeAllRanges();
});

afterEach(() => {
  useSlideEditSession.getState().end();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('slide element clipboard', () => {
  it('pastes independent groups and animations in one saved undo step', () => {
    const original = useSlideEditSession.getState().history!.present;
    expect(copySlideElements()).toBe(true);
    expect(pasteSlideElements()).toBe(true);
    const history = useSlideEditSession.getState().history!;
    const copies = history.present.canvas.elements.slice(2);
    expect(copies).toHaveLength(2);
    expect(copies[0].id).not.toBe('text');
    expect(copies[0]).toMatchObject({ left: 140, top: 140, type: 'text', content: '<p>New text</p>' });
    expect(copies[0].groupId).not.toBe('original-group');
    expect(copies[1].groupId).toBe(copies[0].groupId);
    expect(history.present.canvas.animations?.[1]).toMatchObject({ elId: copies[0].id, effect: 'fadeIn' });
    expect(history.past).toHaveLength(1);
    expect(useCanvasStore.getState().activeElementIdList).toEqual(copies.map((element) => element.id));
    expect(useStageStore.getState().scenes[0].content).toEqual(history.present);
    expect(useStageStore.getState().scenes[0].actions).toEqual([{ id: 'narration', type: 'speech', text: '原讲稿' }]);
    useSlideEditSession.getState().undo();
    expect(useSlideEditSession.getState().history!.present).toEqual(original);
    useSlideEditSession.getState().redo();
    expect(useSlideEditSession.getState().history!.present).toEqual(history.present);
  });

  it('keeps the copied snapshot after source edits and pastes across pages', () => {
    copySlideElements();
    useSlideEditSession.getState().applyOp({ type: 'text.updateContent', elementId: 'text', content: '<p>Changed</p>' });
    const target = useStageStore.getState().scenes[1].content as SlideContent;
    useStageStore.setState({ currentSceneId: 'second' });
    useSlideEditSession.getState().seed('second', target);
    expect(pasteSlideElements()).toBe(true);
    const pasted = useSlideEditSession.getState().history!.present.canvas.elements;
    expect(pasted[0]).toMatchObject({ left: 120, top: 120, content: '<p>New text</p>' });
    expect(pasteSlideElements()).toBe(true);
    const repeated = useSlideEditSession.getState().history!.present.canvas.elements.slice(2);
    expect(repeated[0]).toMatchObject({ left: 140, top: 140 });
    expect(repeated[0].id).not.toBe(pasted[0].id);
    expect(repeated[0].groupId).not.toBe(pasted[0].groupId);
  });

  it('cuts selected elements and restores their animations on undo', () => {
    expect(cutSlideElements()).toBe(true);
    expect(useSlideEditSession.getState().history!.present.canvas.elements).toEqual([]);
    expect(useSlideEditSession.getState().history!.present.canvas.animations).toEqual([]);
    expect(useCanvasStore.getState().activeElementIdList).toEqual([]);
    expect(pasteSlideElements()).toBe(true);
    expect(useSlideEditSession.getState().history!.present.canvas.elements).toHaveLength(2);
    useSlideEditSession.getState().undo();
    useSlideEditSession.getState().undo();
    expect(useSlideEditSession.getState().history!.present.canvas.animations).toHaveLength(1);
    expect(useSlideEditSession.getState().history!.present.canvas.elements[0].id).toBe('text');
  });

  it('uses the local copy when async clipboard permission is denied or unavailable', async () => {
    copySlideElements();
    await pasteSlideElementsFromClipboard();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: vi.fn().mockRejectedValue(new Error('NotAllowedError')),
    } });
    await pasteSlideElementsFromClipboard();
    expect(useSlideEditSession.getState().history!.present.canvas.elements).toHaveLength(6);
  });

  it('ignores invalid clipboard contents and asynchronous paste after switching pages', async () => {
    copySlideElements();
    const original = useSlideEditSession.getState().history;
    for (const text of ['plain text', '{}', '{', JSON.stringify({
      format: 'coteach-slide-elements', version: 1, sourceSceneId: 'first', animations: [],
      elements: [{ type: 'text', id: 'broken' }],
    })]) expect(pasteSlideElements(text)).toBe(false);
    expect(useSlideEditSession.getState().history).toBe(original);
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => { resolve = done; });
    const data = clipboardData();
    copySlideElements(data);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: () => pending } });
    const paste = pasteSlideElementsFromClipboard();
    useStageStore.setState({ currentSceneId: 'second' });
    useSlideEditSession.getState().seed('second', useStageStore.getState().scenes[1].content as SlideContent);
    resolve(data.getData('text/plain'));
    await paste;
    expect(useSlideEditSession.getState().history!.present.canvas.elements).toEqual([]);
  });

  it('does not mutate playback or a session for a departing page', () => {
    copySlideElements();
    useStageStore.setState({ mode: 'playback' });
    expect(pasteSlideElements()).toBe(false);
    expect(cutSlideElements()).toBe(false);
    useStageStore.setState({ mode: 'edit', currentSceneId: 'second' });
    expect(pasteSlideElements()).toBe(false);
  });
});

describe('native canvas clipboard events', () => {
  it('handles copy/paste/cut and releases listeners on unmount', () => {
    const { unmount } = render(<Harness />);
    const canvas = screen.getByTestId('canvas');
    const data = clipboardData();
    expect(fireEvent.copy(canvas, { clipboardData: data })).toBe(false);
    expect(data.getData(SLIDE_CLIPBOARD_MIME)).toBe(data.getData('text/plain'));
    act(() => { expect(fireEvent.paste(canvas, { clipboardData: data })).toBe(false); });
    expect(useSlideEditSession.getState().history!.present.canvas.elements).toHaveLength(4);
    act(() => { expect(fireEvent.cut(canvas, { clipboardData: data })).toBe(false); });
    expect(useSlideEditSession.getState().history!.present.canvas.elements).toHaveLength(2);
    unmount();
    expect(fireEvent.paste(canvas, { clipboardData: data })).toBe(true);
    expect(useSlideEditSession.getState().history!.present.canvas.elements).toHaveLength(2);
  });

  it('leaves input, rich-text and unrelated clipboard operations to the browser', () => {
    render(<Harness />);
    const data = clipboardData();
    copySlideElements(data);
    const original = useSlideEditSession.getState().history;
    for (const target of [screen.getByRole('textbox'), screen.getByTestId('text'), screen.getByRole('button')]) {
      expect(fireEvent.copy(target, { clipboardData: data })).toBe(true);
      expect(fireEvent.cut(target, { clipboardData: data })).toBe(true);
      expect(fireEvent.paste(target, { clipboardData: data })).toBe(true);
    }
    const external = clipboardData();
    external.setData('text/plain', '外部文字');
    expect(fireEvent.paste(screen.getByTestId('canvas'), { clipboardData: external })).toBe(true);
    expect(useSlideEditSession.getState().history).toBe(original);
  });
});
