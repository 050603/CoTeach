'use client';

import { useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Maximize2, Play } from 'lucide-react';
import { cn } from '@openmaic/lib/utils';
import { SceneRenderer } from '@openmaic/components/stage/scene-renderer';
import { SceneProvider } from '@openmaic/lib/contexts/scene-context';
import { Whiteboard } from '@openmaic/components/whiteboard';
import { CanvasToolbar } from '@openmaic/components/canvas/canvas-toolbar';
import type { CanvasToolbarProps } from '@openmaic/components/canvas/canvas-toolbar';
import type { Scene, StageMode } from '@openmaic/lib/types/stage';
import { useI18n } from '@openmaic/lib/hooks/use-i18n';
import { ClassroomCompletePageConnected } from '@openmaic/components/scene-renderers/classroom-complete';

interface CanvasAreaProps extends CanvasToolbarProps {
  readonly currentScene: Scene | null;
  readonly mode: StageMode;
  readonly hideToolbar?: boolean;
  readonly isPendingScene?: boolean;
  readonly isCourseComplete?: boolean;
  readonly isGenerationFailed?: boolean;
  readonly onRetryGeneration?: () => void;
  readonly readOnly?: boolean;
  readonly showCourseComplete?: boolean;
  readonly minimalToolbar?: boolean;
  readonly integrated?: boolean;
  readonly autoAdvancePending?: boolean;
}

export function CanvasArea({
  currentScene,
  currentSceneIndex,
  scenesCount,
  mode,
  engineState,
  isLiveSession,
  whiteboardOpen,
  sidebarCollapsed,
  chatCollapsed,
  onToggleSidebar,
  onToggleChat,
  onPrevSlide,
  onNextSlide,
  onPlayPause,
  onWhiteboardClose,
  isPresenting,
  onTogglePresentation,
  showStopDiscussion,
  onStopDiscussion,
  hideToolbar,
  isPendingScene,
  isCourseComplete,
  isGenerationFailed,
  onRetryGeneration,
  readOnly = false,
  showCourseComplete = true,
  minimalToolbar = false,
  integrated = false,
  autoAdvancePending = false,
}: CanvasAreaProps) {
  const { t } = useI18n();
  const whiteboardWasOpened = useRef(false);
  useEffect(() => {
    if (whiteboardOpen) whiteboardWasOpened.current = true;
  }, [whiteboardOpen]);
  const showControls = mode === 'playback' && !whiteboardOpen && !readOnly && !minimalToolbar;
  const showWhiteboardRestore =
    !whiteboardOpen &&
    whiteboardWasOpened.current &&
    !readOnly &&
    Boolean(hideToolbar || minimalToolbar);
  const showPlayHint =
    showControls &&
    engineState !== 'playing' &&
    currentScene?.type === 'slide' &&
    !isLiveSession &&
    !isPendingScene &&
    !autoAdvancePending;

  const handleSlideClick = useCallback(
    (e: React.MouseEvent) => {
      if (!showControls || isLiveSession || autoAdvancePending || currentScene?.type !== 'slide') return;
      // Don't trigger page play/pause when clicking inside a video element's visual area.
      // Video elements may be visually covered by other slide elements (e.g. text),
      // so we check click coordinates against all video element bounding rects.
      const container = e.currentTarget as HTMLElement;
      const videoEls = container.querySelectorAll('[data-video-element]');
      for (const el of videoEls) {
        const rect = el.getBoundingClientRect();
        if (
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom
        ) {
          return;
        }
      }
      onPlayPause();
    },
    [showControls, isLiveSession, autoAdvancePending, onPlayPause, currentScene?.type],
  );

  return (
    <div className={cn(
      'group/canvas flex h-full w-full flex-col',
      integrated ? 'bg-white dark:bg-slate-950' : 'bg-gray-50 dark:bg-gray-900',
    )}>
      {/* Slide area — takes remaining space */}
      <div
        className={cn(
          'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden transition-colors duration-500',
          integrated ? 'bg-white p-0 dark:bg-slate-950' : 'p-2',
          currentScene?.type === 'interactive'
            ? 'bg-blue-50/30 dark:bg-blue-900/10'
            : 'bg-gray-50/30 dark:bg-gray-900/30',
        )}
      >
        <div
          className={cn(
            'relative aspect-[16/9] h-full max-h-full max-w-full overflow-hidden bg-white transition-all duration-700 dark:bg-gray-800',
            integrated ? 'rounded-none shadow-none ring-0' : 'rounded-lg shadow-2xl',
            showControls && !isLiveSession && !autoAdvancePending && currentScene?.type === 'slide' && 'cursor-pointer',
            readOnly && 'pointer-events-none select-none',
            currentScene?.type === 'interactive'
              ? !integrated && 'shadow-blue-200/50 dark:shadow-blue-900/50 ring-1 ring-blue-900/5 dark:ring-blue-500/10'
              : !integrated && 'shadow-gray-200/50 dark:shadow-gray-800/50 ring-1 ring-gray-950/5 dark:ring-white/5',
          )}
          onClick={handleSlideClick}
        >
          {/* Whiteboard Layer */}
          <div className="absolute inset-0 z-[110] pointer-events-none">
            <SceneProvider>
              <Whiteboard isOpen={whiteboardOpen} onClose={onWhiteboardClose} />
            </SceneProvider>
          </div>


          {/* Scene Content */}
          {currentScene && !whiteboardOpen && (
            <div className="absolute inset-0">
              <SceneProvider>
                <SceneRenderer scene={currentScene} mode={mode} />
              </SceneProvider>
            </div>
          )}

          {/* Pending Scene Loading / Completion Overlay */}
          <AnimatePresence>
            {showCourseComplete && isPendingScene && !currentScene && isCourseComplete && (
              <motion.div
                key="course-complete"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="absolute inset-0"
              >
                <ClassroomCompletePageConnected />
              </motion.div>
            )}
            {isPendingScene && !currentScene && !isCourseComplete && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, ease: 'easeOut' }}
                className="absolute inset-0 z-[105] flex flex-col items-center justify-center bg-white dark:bg-gray-800"
              >
                {isGenerationFailed ? (
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-red-50 dark:bg-red-900/20 flex items-center justify-center">
                      <svg
                        className="w-6 h-6 text-red-400 dark:text-red-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.5}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                        />
                      </svg>
                    </div>
                    <span className="text-sm text-red-500 dark:text-red-400 font-medium">
                      {t('stage.generationFailed')}
                    </span>
                    {onRetryGeneration && (
                      <button
                        onClick={onRetryGeneration}
                        className="mt-1 px-4 py-1.5 text-xs font-medium rounded-full bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors active:scale-95"
                      >
                        {t('generation.retryScene')}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-4">
                    {/* Spinner */}
                    <div className="relative w-12 h-12">
                      <div className="absolute inset-0 rounded-full border-2 border-gray-100 dark:border-gray-700" />
                      <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-purple-500 dark:border-t-purple-400 animate-spin" />
                    </div>
                    {/* Text */}
                    <motion.span
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.2, duration: 0.3 }}
                      className="text-sm text-gray-400 dark:text-gray-500 font-medium"
                    >
                      {t('stage.generatingNextPage')}
                    </motion.span>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {showWhiteboardRestore && (
              <motion.button
                type="button"
                aria-label="重新打开白板"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.2 }}
                className="absolute bottom-4 right-4 z-[115] inline-flex h-9 items-center gap-2 rounded-full border border-violet-200 bg-white/95 px-3 text-xs font-semibold text-violet-700 shadow-lg backdrop-blur transition hover:bg-violet-50 focus:outline-none focus:ring-2 focus:ring-violet-400 dark:border-violet-700 dark:bg-gray-800/95 dark:text-violet-300 dark:hover:bg-violet-950/50"
                onClick={(event) => {
                  event.stopPropagation();
                  onWhiteboardClose();
                }}
              >
                <Maximize2 className="h-3.5 w-3.5" />
                重新打开白板
              </motion.button>
            )}
          </AnimatePresence>

          {/* Scene Number Badge */}
          {currentScene && (
            <div className="absolute top-4 right-4 text-gray-200 dark:text-gray-700 font-bold text-4xl opacity-50 pointer-events-none select-none mix-blend-multiply dark:mix-blend-screen">
              {(currentSceneIndex + 1).toString().padStart(2, '0')}
            </div>
          )}

          {/* Play hint — breathing button when idle or paused (slides only) */}
          <AnimatePresence>
            {showPlayHint && (
              <motion.div
                data-canvas-play-hint
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="absolute inset-0 z-[102] flex items-center justify-center pointer-events-none"
              >
                <motion.div
                  className="opacity-50 group-hover/canvas:opacity-100 transition-opacity duration-300 pointer-events-auto cursor-pointer"
                  exit={{ pointerEvents: 'none' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPlayPause();
                  }}
                >
                  <motion.div
                    initial={{ scale: 0.85 }}
                    animate={{ scale: [1, 1.06] }}
                    exit={{ scale: 1.15, opacity: 0 }}
                    transition={{
                      default: { duration: 0.3, ease: [0.4, 0, 0.2, 1] },
                      scale: {
                        repeat: Infinity,
                        repeatType: 'mirror',
                        duration: 1,
                        ease: 'easeInOut',
                      },
                    }}
                    className="w-20 h-20 rounded-full bg-white/95 dark:bg-gray-800/95 flex items-center justify-center shadow-[0_4px_30px_rgba(147,51,234,0.15),inset_0_0_0_1px_rgba(233,213,255,0.5)] dark:shadow-[0_4px_30px_rgba(147,51,234,0.3),inset_0_0_0_1px_rgba(126,34,206,0.3)]"
                    style={{ willChange: 'transform' }}
                  >
                    <Play className="w-7 h-7 text-purple-600 dark:text-purple-400 fill-purple-600/90 dark:fill-purple-400/90 ml-0.5" />
                  </motion.div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ── Canvas Toolbar — in document flow, only when not merged into roundtable ── */}
      {!hideToolbar && !minimalToolbar && (
        <CanvasToolbar
          className={cn(
            'shrink-0 h-9 px-2',
            'bg-white/80 dark:bg-gray-800/80 backdrop-blur-xl',
            'border-t border-gray-200/40 dark:border-gray-700/40',
          )}
          currentSceneIndex={currentSceneIndex}
          scenesCount={scenesCount}
          engineState={engineState}
          isLiveSession={isLiveSession}
          whiteboardOpen={whiteboardOpen}
          sidebarCollapsed={sidebarCollapsed}
          chatCollapsed={chatCollapsed}
          onToggleSidebar={onToggleSidebar}
          onToggleChat={onToggleChat}
          onPrevSlide={onPrevSlide}
          onNextSlide={onNextSlide}
          onPlayPause={onPlayPause}
          onWhiteboardClose={onWhiteboardClose}
          isPresenting={isPresenting}
          onTogglePresentation={onTogglePresentation}
          showStopDiscussion={showStopDiscussion}
          onStopDiscussion={onStopDiscussion}
          minimal={minimalToolbar}
        />
      )}
    </div>
  );
}
