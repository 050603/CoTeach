import { create } from 'zustand';
import type { PPTElement } from '@openmaic/dsl';

export interface WhiteboardPage {
  id: string;
  stageId: string;
  sceneId: string;
  pageKey: string;
  title: string;
  elements: PPTElement[];
  fingerprint: string;
  completed: boolean;
}

type RetainWhiteboardPage = {
  stageId: string;
  sceneId: string;
  elements: ReadonlyArray<PPTElement>;
  completed: boolean;
  fallbackTitle?: string;
};

export interface WhiteboardPagesState {
  /** Session-only teaching pages, without the destructive undo stack's cap. */
  pages: WhiteboardPage[];
  activePageKeys: Record<string, string>;
  activeStageId: string | null;
  reviewPageId: string | null;
  reviewStageId: string | null;
  setActiveStage: (stageId: string | null) => void;
  startPage: (stageId: string, sceneId: string, pageKey: string) => void;
  resetCurrentPage: (stageId: string, sceneId: string) => void;
  getCurrentPageKey: (stageId: string, sceneId: string) => string | null;
  retainCurrentPage: (page: RetainWhiteboardPage) => WhiteboardPage | null;
  reviewPage: (pageId: string) => boolean;
  returnToLive: () => void;
  closeReview: () => void;
}

const scopeKey = (stageId: string, sceneId: string) => JSON.stringify([stageId, sceneId]);

export function getWhiteboardPageId(stageId: string, sceneId: string, pageKey: string): string {
  return JSON.stringify([stageId, sceneId, pageKey]);
}

function pageTitle(elements: ReadonlyArray<PPTElement>, fallbackTitle?: string): string {
  const title = elements.find((element) => element.type === 'text');
  const text = title?.type === 'text' ? title.content.replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() : '';
  return text || fallbackTitle?.trim() || '白板';
}

export const useWhiteboardPagesStore = create<WhiteboardPagesState>((set, get) => ({
  pages: [],
  activePageKeys: {},
  activeStageId: null,
  reviewPageId: null,
  reviewStageId: null,

  setActiveStage: (stageId) => {
    if (get().activeStageId === stageId) return;
    set({ activeStageId: stageId, reviewPageId: null, reviewStageId: null });
  },
  startPage: (stageId, sceneId, pageKey) => {
    const key = scopeKey(stageId, sceneId);
    if (get().activePageKeys[key] === pageKey) return;
    set((state) => ({ activePageKeys: { ...state.activePageKeys, [key]: pageKey } }));
  },
  resetCurrentPage: (stageId, sceneId) => {
    const key = scopeKey(stageId, sceneId);
    if (!(key in get().activePageKeys)) return;
    set((state) => {
      const activePageKeys = { ...state.activePageKeys };
      delete activePageKeys[key];
      return { activePageKeys };
    });
  },
  getCurrentPageKey: (stageId, sceneId) => get().activePageKeys[scopeKey(stageId, sceneId)] ?? null,

  retainCurrentPage: ({ stageId, sceneId, elements, completed, fallbackTitle }) => {
    if (!elements.length) return null;
    const pageKey = get().getCurrentPageKey(stageId, sceneId) ?? 'initial';
    const id = getWhiteboardPageId(stageId, sceneId, pageKey);
    const existing = get().pages.find((page) => page.id === id);
    // A backwards seek or page navigation must never replace a completed
    // teaching page with the currently visible, partial projection.
    if (existing?.completed && !completed) return existing;
    const fingerprint = JSON.stringify(elements);
    if (existing?.fingerprint === fingerprint && existing.completed === completed) return existing;
    const page: WhiteboardPage = { id, stageId, sceneId, pageKey, title: pageTitle(elements, fallbackTitle),
      elements: JSON.parse(fingerprint) as PPTElement[], fingerprint, completed };
    set((state) => ({
      activePageKeys: { ...state.activePageKeys, [scopeKey(stageId, sceneId)]: pageKey },
      pages: existing ? state.pages.map((entry) => entry.id === id ? page : entry) : [...state.pages, page],
    }));
    return page;
  },

  reviewPage: (pageId) => {
    const page = get().pages.find((entry) => entry.id === pageId);
    if (!page || get().activeStageId !== null && page.stageId !== get().activeStageId) return false;
    set({ reviewPageId: page.id, reviewStageId: page.stageId });
    return true;
  },
  returnToLive: () => set({ reviewPageId: null, reviewStageId: null }),
  closeReview: () => get().returnToLive(),
}));
