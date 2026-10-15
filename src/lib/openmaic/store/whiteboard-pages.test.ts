import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import { whiteboardActionToElement } from '../whiteboard/projection';
import { whiteboardIdForScene } from '../api/stage-api-whiteboard';
import { useStageStore } from './stage';
import { useCanvasStore } from './canvas';
import { getWhiteboardPageId, useWhiteboardPagesStore } from './whiteboard-pages';

const note = (id: string, content: string): PPTElement => whiteboardActionToElement({
  id, type: 'wb_draw_text', elementId: id, content, x: 40, y: 40, fontSize: 24,
})!;

beforeEach(() => {
  vi.useFakeTimers();
  useStageStore.setState({ stage: null, scenes: [], currentSceneId: null });
  useWhiteboardPagesStore.setState({ pages: [], activePageKeys: {}, activeStageId: null,
    reviewPageId: null, reviewStageId: null });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('retained whiteboard teaching pages', () => {
  it('retains every completed page and scopes duplicate action keys to their course and PPT page', () => {
    const pages = useWhiteboardPagesStore.getState();
    for (let index = 0; index < 25; index++) {
      pages.startPage('course', 'slide', `clear-${index}`);
      pages.retainCurrentPage({ stageId: 'course', sceneId: 'slide', elements: [note('title', `板书 ${index}`)], completed: true });
    }
    pages.startPage('other-course', 'slide', 'clear-0');
    pages.retainCurrentPage({ stageId: 'other-course', sceneId: 'slide', elements: [note('title', '另一门课')], completed: true });
    pages.startPage('course', 'other-slide', 'clear-0');
    pages.retainCurrentPage({ stageId: 'course', sceneId: 'other-slide', elements: [note('title', '另一页')], completed: true });
    expect(useWhiteboardPagesStore.getState().pages).toHaveLength(27);
    expect(new Set(useWhiteboardPagesStore.getState().pages.map((page) => page.id)).size).toBe(27);
    expect(getWhiteboardPageId('a:b', 'c', 'd')).not.toBe(getWhiteboardPageId('a', 'b:c', 'd'));
  });

  it('deduplicates the same page, upgrades a partial page, and protects the completed version from a backwards seek', () => {
    const pages = useWhiteboardPagesStore.getState();
    pages.startPage('course', 'slide', 'clear');
    const first = note('first', '学习者分析');
    const second = note('second', '教学目标分析');
    const partial = pages.retainCurrentPage({ stageId: 'course', sceneId: 'slide', elements: [first], completed: false });
    const complete = pages.retainCurrentPage({ stageId: 'course', sceneId: 'slide', elements: [first, second], completed: true });
    expect(complete?.id).toBe(partial?.id);
    expect(complete?.completed).toBe(true);
    expect(pages.retainCurrentPage({ stageId: 'course', sceneId: 'slide', elements: [first], completed: false })).toBe(complete);
    expect(pages.retainCurrentPage({ stageId: 'course', sceneId: 'slide', elements: [first, second], completed: true })).toBe(complete);
    expect(useWhiteboardPagesStore.getState().pages).toEqual([complete]);
  });

  it('copies native content and styles without retaining empty boards', () => {
    const pages = useWhiteboardPagesStore.getState();
    expect(pages.getCurrentPageKey('course', 'slide')).toBeNull();
    expect(pages.retainCurrentPage({ stageId: 'course', sceneId: 'slide', elements: [], completed: true })).toBeNull();
    const elements = [note('title', '前期分析')];
    const retained = pages.retainCurrentPage({ stageId: 'course', sceneId: 'slide', elements, completed: false });
    expect(retained?.pageKey).toBe('initial');
    expect(retained?.title).toBe('前期分析');
    elements[0].left = 300;
    expect(retained?.elements[0].left).toBe(40);
    const colored = { ...note('title', '前期分析'), defaultColor: '#ff0000' } as PPTElement;
    const updated = pages.retainCurrentPage({ stageId: 'course', sceneId: 'slide', elements: [colored], completed: false });
    expect(updated?.fingerprint).not.toBe(retained?.fingerprint);
    expect(useWhiteboardPagesStore.getState().pages).toHaveLength(1);
  });

  it('keeps scoped live keys independent and resets a seek projection without deleting retained pages', () => {
    const pages = useWhiteboardPagesStore.getState();
    pages.startPage('course', 'slide', 'first-clear');
    pages.retainCurrentPage({ stageId: 'course', sceneId: 'slide', elements: [note('a', '旧板')], completed: true });
    pages.startPage('course', 'slide-2', 'other-clear');
    pages.startPage('course-2', 'slide', 'foreign-clear');
    pages.resetCurrentPage('course', 'slide');
    expect(pages.getCurrentPageKey('course', 'slide')).toBeNull();
    expect(pages.getCurrentPageKey('course', 'slide-2')).toBe('other-clear');
    expect(pages.getCurrentPageKey('course-2', 'slide')).toBe('foreign-clear');
    expect(useWhiteboardPagesStore.getState().pages[0].pageKey).toBe('first-clear');
  });

  it('browses saved pages without changing the live stage and prevents a stale cross-course review', () => {
    const pages = useWhiteboardPagesStore.getState();
    const retained = pages.retainCurrentPage({ stageId: 'course', sceneId: 'slide', elements: [note('saved', '旧板')], completed: true })!;
    const foreign = pages.retainCurrentPage({ stageId: 'foreign', sceneId: 'slide', elements: [note('saved', '别课')], completed: true })!;
    const live = useStageStore.getState().stage;
    pages.setActiveStage('course');
    expect(pages.reviewPage(retained.id)).toBe(true);
    expect(useWhiteboardPagesStore.getState()).toMatchObject({ reviewPageId: retained.id, reviewStageId: 'course' });
    expect(pages.reviewPage(foreign.id)).toBe(false);
    expect(useStageStore.getState().stage).toBe(live);
    pages.returnToLive();
    expect(useWhiteboardPagesStore.getState().reviewPageId).toBeNull();
    pages.reviewPage(retained.id);
    pages.closeReview();
    expect(useWhiteboardPagesStore.getState().reviewStageId).toBeNull();
    expect(useWhiteboardPagesStore.getState().pages).toHaveLength(2);
  });

  it('retains a departing PPT page as partial and closes review on navigation and course replacement', () => {
    const elements = [note('first', '已讲的要点')];
    const whiteboard = { id: whiteboardIdForScene('slide-1')!, viewportSize: 1000, viewportRatio: 16 / 9,
      elements, background: { type: 'solid' as const, color: '#ffffff' }, animations: [] };
    useStageStore.setState({ stage: { id: 'course', name: '课堂', createdAt: 1, updatedAt: 1, whiteboard: [whiteboard] }, currentSceneId: 'slide-1' });
    const pages = useWhiteboardPagesStore.getState();
    pages.startPage('course', 'slide-1', 'clear-1');
    const saved = pages.retainCurrentPage({ stageId: 'course', sceneId: 'earlier', elements: [note('saved', '此前板书')], completed: true })!;
    pages.reviewPage(saved.id);
    useCanvasStore.getState().setWhiteboardOpen(true);
    useStageStore.getState().setCurrentSceneId('slide-2');
    const partial = useWhiteboardPagesStore.getState().pages.find((page) => page.sceneId === 'slide-1');
    expect(partial).toMatchObject({ completed: false, pageKey: 'clear-1', elements });
    expect(useWhiteboardPagesStore.getState().reviewPageId).toBeNull();
    expect(useCanvasStore.getState().whiteboardOpen).toBe(false);
    pages.reviewPage(saved.id);
    useStageStore.getState().setStage({ id: 'next-course', name: '下一门课', createdAt: 1, updatedAt: 1 });
    expect(useWhiteboardPagesStore.getState()).toMatchObject({ activeStageId: 'next-course', reviewPageId: null, reviewStageId: null });
    expect(useWhiteboardPagesStore.getState().pages).toHaveLength(2);
    expect(pages.reviewPage(saved.id)).toBe(false);
  });

  it('does not downgrade a completed page when leaving a partially restored version of the same page', () => {
    const pages = useWhiteboardPagesStore.getState();
    const elements = [note('first', '第一项'), note('second', '第二项')];
    pages.startPage('course', 'slide', 'clear');
    const complete = pages.retainCurrentPage({ stageId: 'course', sceneId: 'slide', elements, completed: true });
    useStageStore.setState({ stage: { id: 'course', name: '课堂', createdAt: 1, updatedAt: 1, whiteboard: [{
      id: whiteboardIdForScene('slide')!, viewportSize: 1000, viewportRatio: 16 / 9, elements: [elements[0]],
      background: { type: 'solid', color: '#ffffff' }, animations: [],
    }] }, currentSceneId: 'slide' });
    useStageStore.getState().setCurrentSceneId('next-slide');
    expect(useWhiteboardPagesStore.getState().pages).toEqual([complete]);
  });
});
