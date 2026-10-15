'use client';

import { useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Eraser, History, Minimize2, PencilLine, RotateCcw } from 'lucide-react';
import { WhiteboardCanvas } from './whiteboard-canvas';
import type { WhiteboardCanvasHandle } from './whiteboard-canvas';
import { WhiteboardHistory } from './whiteboard-history';
import { WhiteboardPageNavigation } from './whiteboard-page-navigation';
import { useStageStore } from '@openmaic/lib/store';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import { useWhiteboardHistoryStore } from '@openmaic/lib/store/whiteboard-history';
import { getWhiteboardPageId, useWhiteboardPagesStore } from '@openmaic/lib/store/whiteboard-pages';
import { createStageAPI } from '@openmaic/lib/api/stage-api';
import { toast } from 'sonner';
import { useI18n } from '@openmaic/lib/hooks/use-i18n';
import { whiteboardIdForScene } from '@openmaic/lib/api/stage-api-whiteboard';
import { orderedActionExecutionEntries } from '@openmaic/lib/whiteboard/action-timeline';

interface WhiteboardProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
}

/**
 * Whiteboard component
 */
export function Whiteboard({ isOpen, onClose }: WhiteboardProps) {
  const { t } = useI18n();
  const stage = useStageStore.use.stage();
  const currentSceneId = useStageStore.use.currentSceneId();
  const scenes = useStageStore.use.scenes();
  const mode = useStageStore.use.mode();
  const isClearing = useCanvasStore.use.whiteboardClearing();
  const instantTransition = useCanvasStore.use.whiteboardInstantTransition();
  const clearingRef = useRef(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewModified, setViewModified] = useState(false);
  const canvasRef = useRef<WhiteboardCanvasHandle>(null);
  const snapshotCount = useWhiteboardHistoryStore((s) => s.snapshots.length);
  const savedPages = useWhiteboardPagesStore((s) => s.pages);
  const reviewPageId = useWhiteboardPagesStore((s) => s.reviewPageId);
  const reviewStageId = useWhiteboardPagesStore((s) => s.reviewStageId);
  const livePageKey = useWhiteboardPagesStore((s) => stage && currentSceneId
    ? s.getCurrentPageKey(stage.id, currentSceneId) : null);

  // Get element count for indicator
  const activeWhiteboardId = whiteboardIdForScene(currentSceneId);
  const whiteboard = activeWhiteboardId
    ? stage?.whiteboard?.find((item) => item.id === activeWhiteboardId)
    : stage?.whiteboard?.at(-1);
  const elementCount = whiteboard?.elements?.length || 0;
  const retainedPages = useMemo(() => savedPages.filter((page) => page.stageId === stage?.id
    && page.sceneId === currentSceneId), [savedPages, stage?.id, currentSceneId]);
  const reviewedPage = reviewStageId === stage?.id
    ? retainedPages.find((page) => page.id === reviewPageId)
    : undefined;
  const livePageId = stage && currentSceneId
    ? getWhiteboardPageId(stage.id, currentSceneId, livePageKey ?? 'initial') : null;
  const teachingOrder = useMemo(() => new Map(orderedActionExecutionEntries(
    scenes.find((scene) => scene.id === currentSceneId)?.actions ?? [],
  ).map((entry, order) => [entry.action.id, order])), [scenes, currentSceneId]);
  const pageOptions = useMemo(() => {
    const options = retainedPages.map((page) => ({ id: page.id, title: page.title, sceneId: page.sceneId, pageKey: page.pageKey }));
    if (elementCount > 0 && livePageId && !options.some((page) => page.id === livePageId)) {
      options.push({ id: livePageId, title: t('whiteboard.currentTeaching'), sceneId: currentSceneId!, pageKey: livePageKey ?? 'initial' });
    }
    return options.sort((left, right) => (teachingOrder.get(left.pageKey) ?? Infinity)
      - (teachingOrder.get(right.pageKey) ?? Infinity));
  }, [retainedPages, elementCount, livePageId, livePageKey, currentSceneId, teachingOrder, t]);
  const showEditingControls = mode === 'edit' || pageOptions.length === 0;

  const handlePageSelect = (id: string) => {
    const pagesStore = useWhiteboardPagesStore.getState();
    if (id === livePageId && isOpen) pagesStore.returnToLive();
    else pagesStore.reviewPage(id);
    setHistoryOpen(false);
  };
  const handleClose = () => {
    useWhiteboardPagesStore.getState().closeReview();
    setHistoryOpen(false);
    if (isOpen) onClose();
  };

  const stageAPI = createStageAPI(useStageStore);

  const handleClear = async () => {
    if (!whiteboard || elementCount === 0 || clearingRef.current) return;
    clearingRef.current = true;

    // Save snapshot before clearing
    if (whiteboard.elements && whiteboard.elements.length > 0) {
      useWhiteboardHistoryStore.getState().pushSnapshot(whiteboard.elements);
      if (stage && currentSceneId) {
        useWhiteboardPagesStore.getState().retainCurrentPage({
          stageId: stage.id, sceneId: currentSceneId, elements: whiteboard.elements, completed: true,
        });
      }
    }

    // Trigger cascade exit animation
    useCanvasStore.getState().setWhiteboardClearing(true);

    // Wait for cascade: base 380ms + 55ms per element, capped at 1400ms
    const animMs = Math.min(380 + elementCount * 55, 1400);
    await new Promise((resolve) => setTimeout(resolve, animMs));

    // Actually remove elements
    const result = stageAPI.whiteboard.delete(whiteboard.id);
    if (result.success && stage && currentSceneId) {
      useWhiteboardPagesStore.getState().startPage(stage.id, currentSceneId, `manual-clear:${Date.now()}`);
    }
    useCanvasStore.getState().setWhiteboardClearing(false);
    clearingRef.current = false;

    if (result.success) {
      toast.success(t('whiteboard.clearSuccess'));
    } else {
      toast.error(t('whiteboard.clearError') + result.error);
    }
  };

  return (
    <>
      {/* Main Whiteboard Overlay */}
      <AnimatePresence>
        {(isOpen || reviewedPage) && (
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 30 }}
            animate={{
              opacity: 1,
              scale: 1,
              y: 0,
              transition: instantTransition ? { duration: 0.15 } : {
                type: 'spring',
                stiffness: 120,
                damping: 18,
                mass: 1.2,
              },
            }}
            exit={{
              opacity: 0,
              scale: 0.95,
              y: 16,
              transition: { duration: instantTransition ? 0.15 : 0.5, ease: [0.4, 0, 0.2, 1] },
            }}
            className="absolute inset-4 pointer-events-auto bg-white/95 dark:bg-gray-800/95 backdrop-blur-2xl rounded-3xl shadow-[0_32px_80px_-20px_rgba(0,0,0,0.25)] border-2 border-purple-200/60 dark:border-purple-700/60 flex flex-col overflow-hidden z-[120] ring-4 ring-purple-100/40 dark:ring-purple-800/40"
            data-whiteboard-page-mode={reviewedPage ? 'review' : 'live'}
            onClick={(event) => event.stopPropagation()}
          >
            {/* Header */}
            <div className="h-14 gap-1 px-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between shrink-0 bg-white/50 dark:bg-gray-800/50">
              <div className={`${pageOptions.length > 0 ? 'hidden sm:flex' : 'flex'} shrink-0 items-center gap-2`}>
                <div className="w-8 h-8 rounded-xl bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center text-purple-600 dark:text-purple-400">
                  <PencilLine className="w-4 h-4" />
                </div>
                <span className="hidden lg:inline font-bold text-gray-800 dark:text-gray-200 tracking-tight">
                  {t('whiteboard.title')}
                </span>
              </div>

              <WhiteboardPageNavigation
                pages={pageOptions}
                selectedPageId={reviewedPage?.id ?? livePageId}
                reviewing={Boolean(reviewedPage)}
                onSelect={handlePageSelect}
                onReturnToLive={() => useWhiteboardPagesStore.getState().returnToLive()}
              />

              <div className="flex items-center gap-2">
                <AnimatePresence>
                  {viewModified && (
                    <motion.button
                      type="button"
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{ duration: 0.15 }}
                      onClick={() => canvasRef.current?.resetView()}
                      whileTap={{ scale: 0.9 }}
                      className="p-2 text-gray-400 dark:text-gray-500 hover:text-purple-500 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded-lg transition-colors"
                      title={t('whiteboard.resetView')}
                    >
                      <RotateCcw className="w-4 h-4" />
                    </motion.button>
                  )}
                </AnimatePresence>
                {showEditingControls && !reviewedPage && <motion.button
                  type="button"
                  onClick={handleClear}
                  disabled={isClearing || elementCount === 0}
                  whileTap={{ scale: 0.9 }}
                  className="p-2 text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors disabled:opacity-40 disabled:pointer-events-none"
                  title={t('whiteboard.clear')}
                >
                  <motion.div
                    animate={isClearing ? { rotate: [0, -15, 15, -10, 10, 0] } : { rotate: 0 }}
                    transition={
                      isClearing ? { duration: 0.5, ease: 'easeInOut' } : { duration: 0.2 }
                    }
                  >
                    <Eraser className="w-4 h-4" />
                  </motion.div>
                </motion.button>}
                {/* History button + popover wrapper */}
                {showEditingControls && !reviewedPage && <div className="relative">
                  <motion.button
                    type="button"
                    onClick={() => setHistoryOpen(!historyOpen)}
                    whileTap={{ scale: 0.9 }}
                    className="relative p-2 text-gray-400 dark:text-gray-500 hover:text-purple-500 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded-lg transition-colors"
                    title={t('whiteboard.history')}
                  >
                    <History className="w-4 h-4" />
                    {snapshotCount > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-purple-500 text-white text-[10px] font-bold flex items-center justify-center">
                        {snapshotCount}
                      </span>
                    )}
                  </motion.button>
                  <WhiteboardHistory isOpen={historyOpen} onClose={() => setHistoryOpen(false)} />
                </div>}
                <div className="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-1" />
                <button
                  type="button"
                  onClick={handleClose}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  title={t('whiteboard.minimize')}
                >
                  <Minimize2 className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Whiteboard Content Area */}
            <div className="flex-1 relative bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] dark:bg-[radial-gradient(#374151_1px,transparent_1px)] [background-size:24px_24px] overflow-hidden">
              <WhiteboardCanvas
                key={reviewedPage?.id ?? livePageId ?? currentSceneId}
                ref={canvasRef}
                onViewModifiedChange={setViewModified}
                elementsOverride={reviewedPage?.elements}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
