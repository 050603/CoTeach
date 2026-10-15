import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import { useStageStore } from '@openmaic/lib/store';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import { useWhiteboardPagesStore } from '@openmaic/lib/store/whiteboard-pages';
import { whiteboardIdForScene } from '@openmaic/lib/api/stage-api-whiteboard';
import { Whiteboard } from './index';

vi.mock('@openmaic/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string, args?: Record<string, unknown>) => args
    ? `${key}:${args.index}/${args.total}` : key }),
}));
vi.mock('./whiteboard-canvas', () => ({
  WhiteboardCanvas: function MockCanvas({ elementsOverride }: { elementsOverride?: PPTElement[] }) {
    const stage = useStageStore.use.stage();
    const elements = elementsOverride ?? stage?.whiteboard?.[0]?.elements ?? [];
    return <div data-testid="board-content">{elements.map((element) => element.id).join(',')}</div>;
  },
}));

const note = (id: string): PPTElement => ({
  id, type: 'text', left: 40, top: 40, width: 250, height: 70, rotate: 0,
  content: `<p>${id}</p>`, defaultFontName: 'Microsoft YaHei', defaultColor: '#333333',
});

function setLive(elements: PPTElement[]) {
  useStageStore.setState({
    stage: {
      id: 'lesson', name: '课堂', createdAt: 1, updatedAt: 1,
      whiteboard: [{
        id: whiteboardIdForScene('scene-1')!, elements, viewportSize: 1000, viewportRatio: 16 / 9,
      }],
    },
    currentSceneId: 'scene-1', mode: 'playback', scenes: [],
  });
}

beforeEach(() => {
  useWhiteboardPagesStore.setState({ pages: [], activePageKeys: {}, reviewPageId: null, reviewStageId: null });
  setLive([note('first-page')]);
  const store = useWhiteboardPagesStore.getState();
  store.startPage('lesson', 'scene-1', 'first');
  store.retainCurrentPage({ stageId: 'lesson', sceneId: 'scene-1', elements: [note('first-page')], completed: true });
  store.startPage('lesson', 'scene-1', 'second');
  setLive([note('second-page')]);
});

afterEach(() => {
  useWhiteboardPagesStore.setState({ pages: [], activePageKeys: {}, reviewPageId: null, reviewStageId: null });
  useCanvasStore.getState().setWhiteboardClearing(false);
});

describe('whiteboard page browsing', () => {
  it('browses earlier pages without overwriting live content and returns to the latest live board', () => {
    render(<Whiteboard isOpen onClose={vi.fn()} />);
    const select = screen.getByRole('combobox', { name: 'whiteboard.selectPage' });
    expect(select.querySelectorAll('option')).toHaveLength(2);
    expect(screen.getByTestId('board-content')).toHaveTextContent('second-page');
    expect(screen.getByRole('button', { name: 'whiteboard.nextPage' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'whiteboard.previousPage' }));
    expect(screen.getByTestId('board-content')).toHaveTextContent('first-page');
    expect(screen.getByRole('button', { name: 'whiteboard.previousPage' })).toBeDisabled();
    expect(useStageStore.getState().stage?.whiteboard?.[0].elements).toEqual([note('second-page')]);

    act(() => setLive([note('second-page'), note('later-branch')]));
    expect(screen.getByTestId('board-content')).toHaveTextContent('first-page');
    expect(screen.getByTestId('board-content')).not.toHaveTextContent('later-branch');

    fireEvent.click(screen.getByRole('button', { name: 'whiteboard.returnToTeaching' }));
    expect(screen.getByTestId('board-content')).toHaveTextContent('second-page,later-branch');
    expect(screen.queryByRole('button', { name: 'whiteboard.returnToTeaching' })).toBeNull();
  });

  it('keeps a reviewed page visible when narration closes the live board, and minimizes without reopening it', async () => {
    const onClose = vi.fn();
    const { rerender, container } = render(<Whiteboard isOpen onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'whiteboard.previousPage' }));
    act(() => useCanvasStore.getState().setWhiteboardClearing(true));
    rerender(<Whiteboard isOpen={false} onClose={onClose} />);
    expect(container.querySelector('[data-whiteboard-page-mode="review"]')).not.toBeNull();
    expect(screen.getByTestId('board-content')).toHaveTextContent('first-page');

    fireEvent.click(screen.getByRole('button', { name: 'whiteboard.minimize' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(useWhiteboardPagesStore.getState().reviewPageId).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('board-content')).toBeNull());
  });

  it.each([
    { stageId: 'another-lesson', sceneId: 'scene-1' },
    { stageId: 'lesson', sceneId: 'scene-2' },
  ])('excludes saved pages from another course or PPT page: $stageId / $sceneId', ({ stageId, sceneId }) => {
    const store = useWhiteboardPagesStore.getState();
    store.startPage(stageId, sceneId, 'other');
    store.retainCurrentPage({ stageId, sceneId, elements: [note('private-other-page')], completed: true });
    render(<Whiteboard isOpen onClose={vi.fn()} />);
    expect(screen.getByRole('combobox').querySelectorAll('option')).toHaveLength(2);
    expect(screen.queryByText(/private-other-page/)).toBeNull();
  });

  it('does not render a stale review that belongs to another PPT page', () => {
    const store = useWhiteboardPagesStore.getState();
    store.startPage('lesson', 'scene-2', 'other');
    const other = store.retainCurrentPage({ stageId: 'lesson', sceneId: 'scene-2',
      elements: [note('other-slide')], completed: true })!;
    store.reviewPage(other.id);
    render(<Whiteboard isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId('board-content')).toBeNull();
  });

  it('orders pages by the teaching timeline even when they were first visited in reverse', () => {
    useWhiteboardPagesStore.setState({ pages: [], activePageKeys: {} });
    const store = useWhiteboardPagesStore.getState();
    store.startPage('lesson', 'scene-1', 'second');
    store.retainCurrentPage({ stageId: 'lesson', sceneId: 'scene-1', elements: [note('second-page')], completed: true });
    store.startPage('lesson', 'scene-1', 'first');
    store.retainCurrentPage({ stageId: 'lesson', sceneId: 'scene-1', elements: [note('first-page')], completed: true });
    setLive([note('first-page')]);
    useStageStore.setState({ scenes: [{
      id: 'scene-1', stageId: 'lesson', title: '课堂', order: 0, type: 'slide',
      content: { type: 'slide', canvas: {
        id: 'slide', viewportSize: 1000, viewportRatio: 16 / 9,
        theme: { themeColors: [], fontColor: '#333333', fontName: 'Microsoft YaHei', backgroundColor: '#ffffff' }, elements: [],
      } },
      actions: [{ id: 'first', type: 'wb_clear' }, { id: 'second', type: 'wb_clear' }],
    }] });
    render(<Whiteboard isOpen onClose={vi.fn()} />);
    const options = screen.getByRole('combobox').querySelectorAll('option');
    expect(options[0].textContent).toContain('first-page');
    expect(options[1].textContent).toContain('second-page');
    expect(screen.getByRole('button', { name: 'whiteboard.previousPage' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'whiteboard.nextPage' }));
    expect(screen.getByTestId('board-content')).toHaveTextContent('second-page');
  });
});
