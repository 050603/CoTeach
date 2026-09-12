'use client';

import responsiveStyles from './lecture-subtitle-dock.module.css';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Maximize2,
  MousePointer2,
  Repeat2,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { EngineMode } from '@openmaic/lib/playback';
import { cn } from '@openmaic/lib/utils';
import { useStageStore } from '@openmaic/lib/store';
import { KnowledgeGraphFlow } from '@/components/knowledge-graph-flow';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';
import { useTeachingKnowledgeGraph } from '@/components/openmaic-bridge/knowledge-graph-context';

export type LectureCue = { actionIndex: number; text: string; actionIndexes?: number[] };

interface LectureSubtitleDockProps {
  readonly cues: ReadonlyArray<LectureCue>;
  readonly activeActionIndex: number;
  readonly currentText: string;
  readonly speechProgress?: number;
  readonly teacherAvatar: string;
  readonly teacherName: string;
  readonly engineMode: EngineMode;
  readonly playbackCompleted?: boolean;
  readonly muted: boolean;
  readonly playbackSpeed: number;
  readonly autoPlay: boolean;
  readonly sceneIndex: number;
  readonly scenesCount: number;
  readonly canGoPrevious: boolean;
  readonly canGoNext: boolean;
  readonly canGoPreviousCue: boolean;
  readonly canGoNextCue: boolean;
  readonly interactionAssistance?: {
    readonly active: boolean;
    readonly onContinue: () => void;
  };
  readonly onPlayPause?: () => void;
  readonly onPreviousCue?: () => boolean;
  readonly onNextCue?: () => boolean;
  readonly onCueSelect?: (actionIndex: number, startRatio: number) => boolean;
  readonly onToggleMute: () => void;
  readonly onCycleSpeed: () => void;
  readonly onPrevious?: () => void;
  readonly onNext?: () => void;
  readonly onToggleAutoPlay: () => void;
}

export type SubtitleLine = {
  actionIndex: number;
  cueIndex: number;
  text: string;
  start: number;
  end: number;
};

function isCompleteSubtitleSentence(text: string): boolean {
  return /[。！？!?；;.](?:[”’"'）)】\]》」』]*)$/.test(text.trim());
}

function joinSubtitleFragments(left: string, right: string): string {
  const trimmedLeft = left.trimEnd();
  const trimmedRight = right.trimStart();
  const needsSpace = /[A-Za-z0-9]$/.test(trimmedLeft) && /^[A-Za-z0-9]/.test(trimmedRight);
  return `${trimmedLeft}${needsSpace ? ' ' : ''}${trimmedRight}`;
}

/** Normalize legacy micro-lessons without changing their underlying audio actions. */
export function mergeFragmentedLectureCues(cues: ReadonlyArray<LectureCue>): LectureCue[] {
  const merged: LectureCue[] = [];
  for (const cue of cues) {
    const previous = merged.at(-1);
    const previousIndexes = previous?.actionIndexes ?? (previous ? [previous.actionIndex] : []);
    const previousLastAction = previousIndexes.at(-1);
    if (
      previous
      && previousLastAction !== undefined
      && cue.actionIndex === previousLastAction + 1
      && !isCompleteSubtitleSentence(previous.text)
    ) {
      merged[merged.length - 1] = {
        ...previous,
        text: joinSubtitleFragments(previous.text, cue.text),
        actionIndexes: [...previousIndexes, cue.actionIndex],
      };
      continue;
    }
    merged.push({ ...cue, actionIndexes: cue.actionIndexes ?? [cue.actionIndex] });
  }
  return merged;
}

/** Split narration into readable, progress-addressable display units. */
export function splitSubtitleText(text: string): string[] {
  const source = text.trim();
  if (!source) return [];
  const sentences: string[] = [];
  const closingMarks = new Set(['”', '’', '"', "'", '）', ')', '】', ']', '》', '」', '』']);
  let sentenceStart = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    let punctuationEnd = index + 1;
    while (
      punctuationEnd < source.length &&
      ('。！？!?…；;'.includes(source[punctuationEnd]) ||
        source[punctuationEnd] === '.' ||
        closingMarks.has(source[punctuationEnd]))
    ) {
      punctuationEnd += 1;
    }
    const nextCharacter = source[punctuationEnd];
    const isStrongEnding = '。！？!?…；;'.includes(character);
    const isWesternPeriod = character === '.' && (!nextCharacter || /\s/.test(nextCharacter));
    const isParagraphBreak = character === '\n';
    if (!isStrongEnding && !isWesternPeriod && !isParagraphBreak) continue;

    const sentenceEnd = punctuationEnd;
    const sentence = source.slice(sentenceStart, sentenceEnd).trim();
    if (sentence) sentences.push(sentence);
    sentenceStart = sentenceEnd;
    while (sentenceStart < source.length && /\s/.test(source[sentenceStart])) {
      sentenceStart += 1;
    }
    index = sentenceStart - 1;
  }

  const remainder = source.slice(sentenceStart).trim();
  if (remainder) sentences.push(remainder);
  // Long complete sentences wrap inside one card. Never cut them at an
  // arbitrary character: doing so separates predicates and objects from the
  // clause the learner is actually hearing.
  return sentences;
}

export function buildSubtitleLines(cues: ReadonlyArray<LectureCue>): SubtitleLine[] {
  return cues.flatMap((cue, cueIndex) => {
    let offset = 0;
    return splitSubtitleText(cue.text).map((text) => {
      const start = offset;
      offset += text.length;
      return { actionIndex: cue.actionIndex, cueIndex, text, start, end: offset };
    });
  });
}

export function resolveActiveSubtitleLineIndex(
  lines: ReadonlyArray<SubtitleLine>,
  activeCueIndex: number,
  progress: number,
): number {
  const cueLines = lines.filter((line) => line.cueIndex === activeCueIndex);
  if (!cueLines.length) return 0;
  const total = cueLines.at(-1)?.end ?? 1;
  const target = Math.min(total - Number.EPSILON, Math.max(0, progress) * total);
  const active = cueLines.find((line) => target < line.end) ?? cueLines.at(-1)!;
  return Math.max(0, lines.indexOf(active));
}

export function resolveActiveCueIndex(
  cues: ReadonlyArray<LectureCue>,
  activeActionIndex: number,
  currentText: string,
): number {
  const exactAction = cues.findIndex((cue) =>
    (cue.actionIndexes ?? [cue.actionIndex]).includes(activeActionIndex),
  );
  if (exactAction >= 0) return exactAction;
  const exactText = cues.findIndex((cue) => cue.text === currentText.trim());
  return exactText >= 0 ? exactText : 0;
}

export function scrollSubtitleIntoView(
  container: HTMLElement,
  active: HTMLElement,
  behavior: ScrollBehavior = 'smooth',
): void {
  // The scroll viewport is positioned, so each direct subtitle button's
  // offsetTop is local to this container. Avoid scrollIntoView here: browsers
  // may choose a page ancestor and move the whole lesson instead of the rail.
  const targetTop = active.offsetTop + active.offsetHeight / 2 - container.clientHeight / 2;
  const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const top = Math.min(maxTop, Math.max(0, targetTop));
  if (typeof container.scrollTo === 'function') {
    container.scrollTo({ top, behavior });
  } else {
    container.scrollTop = top;
  }
}

export function LectureSubtitleDock({
  cues,
  activeActionIndex,
  currentText,
  speechProgress = 0,
  teacherAvatar,
  teacherName,
  engineMode,
  playbackCompleted,
  muted,
  playbackSpeed,
  autoPlay,
  sceneIndex,
  scenesCount,
  canGoPrevious,
  canGoNext,
  canGoPreviousCue,
  canGoNextCue,
  interactionAssistance,
  onPlayPause,
  onPreviousCue,
  onNextCue,
  onCueSelect,
  onToggleMute,
  onCycleSpeed,
  onPrevious,
  onNext,
  onToggleAutoPlay,
}: LectureSubtitleDockProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const browsingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; scrollTop: number } | null>(null);
  const didDragRef = useRef(false);
  const [isBrowsingSubtitles, setIsBrowsingSubtitles] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const currentScene = useStageStore((state) => state.getCurrentScene());
  const { graph, points } = useTeachingKnowledgeGraph();
  const displayCues = useMemo(
    () => mergeFragmentedLectureCues(
      cues.length ? cues : currentText ? [{ actionIndex: -1, text: currentText }] : [],
    ),
    [cues, currentText],
  );
  const activeCueIndex = useMemo(
    () => resolveActiveCueIndex(displayCues, activeActionIndex, currentText),
    [activeActionIndex, currentText, displayCues],
  );
  const subtitleLines = useMemo(() => buildSubtitleLines(displayCues), [displayCues]);
  const activeSubtitleLineIndex = useMemo(
    () => resolveActiveSubtitleLineIndex(subtitleLines, activeCueIndex, speechProgress),
    [activeCueIndex, speechProgress, subtitleLines],
  );
  const isPlaying = engineMode === 'playing';
  const activeKnowledgePointId = useMemo(() => {
    const knownIds = new Set([
      ...(graph?.nodes.map((node) => node.id) ?? []),
      ...points.map((point) => point.id),
    ]);
    const direct = currentScene?.knowledgePointIds?.find((id) => knownIds.has(id));
    if (direct) return direct;
    return graph?.nodes.find((node) => node.relatedLessonIds?.includes(currentScene?.id ?? ''))?.id ?? null;
  }, [currentScene?.id, currentScene?.knowledgePointIds, graph?.nodes, points]);
  const hasKnowledgeGraph = Boolean(graph?.nodes.length || points.length);

  const revealSubtitleHistory = useCallback(() => {
    setIsBrowsingSubtitles(true);
    if (browsingTimerRef.current) clearTimeout(browsingTimerRef.current);
    browsingTimerRef.current = setTimeout(() => setIsBrowsingSubtitles(false), 1600);
  }, []);

  const handleSubtitlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    revealSubtitleHistory();
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      scrollTop: event.currentTarget.scrollTop,
    };
    didDragRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [revealSubtitleHistory]);

  const handleSubtitlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = event.clientY - drag.startY;
    if (Math.abs(distance) > 4) didDragRef.current = true;
    event.currentTarget.scrollTop = drag.scrollTop - distance;
    revealSubtitleHistory();
  }, [revealSubtitleHistory]);

  const handleSubtitlePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    globalThis.setTimeout(() => { didDragRef.current = false; }, 0);
  }, []);

  const centerActiveSubtitle = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const container = scrollRef.current;
    const active = container?.querySelector<HTMLElement>('[data-active-line="true"]');
    if (!container || !active) return;
    scrollSubtitleIntoView(container, active, behavior);
  }, []);

  useLayoutEffect(() => {
    // Playback always owns the viewport. Manual browsing is allowed while
    // paused, then the rail returns to the spoken sentence after the short
    // browsing grace period.
    if (isBrowsingSubtitles && !isPlaying) return;
    centerActiveSubtitle('smooth');
  }, [activeSubtitleLineIndex, centerActiveSubtitle, isBrowsingSubtitles, isPlaying]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!isBrowsingSubtitles || isPlaying) centerActiveSubtitle('auto');
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [centerActiveSubtitle, isBrowsingSubtitles, isPlaying]);

  useEffect(() => () => {
    if (browsingTimerRef.current) clearTimeout(browsingTimerRef.current);
  }, []);

  return (
    <aside
      aria-label="AI 授课字幕与播放控制"
      className={cn(responsiveStyles.dock, "relative z-10 flex min-h-0 w-full shrink-0 overflow-hidden border-t border-slate-200/80 bg-white/96 dark:border-white/10 dark:bg-slate-950/96 xl:h-full xl:w-[304px] xl:border-l xl:border-t-0 xl:bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(252,254,253,0.97)_48%,rgba(241,249,246,0.94)_76%,rgba(255,255,255,0.98)_100%)] xl:dark:bg-[linear-gradient(180deg,rgba(2,6,23,0.98)_0%,rgba(8,20,31,0.97)_52%,rgba(10,36,34,0.82)_76%,rgba(2,6,23,0.98)_100%)]")}
    >
      <div className="grid h-full min-h-0 min-w-0 flex-1 grid-rows-[auto_auto_minmax(0,1fr)_auto_auto] overflow-hidden px-4 py-3 xl:px-5 xl:py-4">
        <header className="flex items-center gap-3 xl:items-start">
          <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-[14px] bg-[#edf5f2] ring-1 ring-slate-900/8 dark:ring-white/10 xl:h-12 xl:w-12">
            <img alt={teacherName} className="h-full w-full object-cover" src={teacherAvatar} />
            <span
              className={cn(
                'absolute bottom-1 right-1 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-slate-950',
                isPlaying ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600',
              )}
            />
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-bold text-slate-900 dark:text-white">{teacherName}</h3>
              {isPlaying ? (
                <span className="flex h-4 items-end gap-[2px]" aria-label="正在讲解">
                  {[8, 13, 10].map((height, index) => (
                    <span
                      className="w-[2px] animate-pulse rounded-full bg-teal-600 dark:bg-teal-400"
                      key={height}
                      style={{ height, animationDelay: `${index * 120}ms` }}
                    />
                  ))}
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {isPlaying ? `${teacherName}正在讲解` : playbackCompleted ? '本页讲解完成' : '讲解已暂停'}
            </p>
          </div>
          <span className="pt-1 text-[11px] font-semibold tabular-nums text-slate-400">
            {Math.max(1, sceneIndex + 1)} / {Math.max(1, scenesCount)}
          </span>
        </header>

        <div className="my-3 h-px bg-slate-100 dark:bg-white/8 xl:my-4" />

        <div
          className={cn(
            'relative min-h-0 min-w-0 overflow-hidden',
            hasKnowledgeGraph && 'xl:grid xl:grid-rows-[minmax(0,3fr)_minmax(0,2fr)]',
          )}
          data-teaching-rail-content
        >
          <div className="relative h-[112px] min-h-0 min-w-0 overflow-hidden xl:h-full" data-subtitle-viewport-frame>
            <div
              aria-live="polite"
              aria-label="讲解字幕，可滚动浏览或拖动查看"
              className="scrollbar-hide absolute inset-0 cursor-grab snap-y snap-proximity touch-pan-y overflow-y-auto overscroll-contain active:cursor-grabbing"
              onPointerCancel={handleSubtitlePointerEnd}
              onPointerDown={handleSubtitlePointerDown}
              onPointerMove={handleSubtitlePointerMove}
              onPointerUp={handleSubtitlePointerEnd}
              onTouchMove={revealSubtitleHistory}
              onWheel={(event) => {
                event.stopPropagation();
                revealSubtitleHistory();
              }}
              ref={scrollRef}
            >
              <div aria-hidden="true" className="min-h-4" style={{ height: 'calc(50% - 48px)' }} />
              {subtitleLines.map((line, index) => {
                const active = index === activeSubtitleLineIndex;
                return (
                  <button
                    aria-label={`从此处重新播放：${line.text}`}
                    className={cn(
                      'flex min-h-20 w-full snap-center items-center px-1 py-3 text-left text-[15px] leading-6 transition-[color,opacity,transform] duration-300',
                      active
                        ? 'translate-x-0.5 font-semibold text-slate-900 opacity-100 dark:text-slate-50'
                        : isBrowsingSubtitles
                          ? index < activeSubtitleLineIndex
                            ? 'cursor-pointer text-slate-400 opacity-45 hover:text-teal-800 hover:opacity-100 dark:text-slate-500 dark:hover:text-teal-200'
                            : 'cursor-pointer text-slate-500 opacity-60 hover:text-slate-800 hover:opacity-100 dark:text-slate-400 dark:hover:text-slate-100'
                          : 'pointer-events-none text-slate-400 opacity-0 dark:text-slate-500',
                    )}
                    data-active-line={active ? 'true' : undefined}
                    key={`${line.actionIndex}-${index}`}
                    onClick={() => {
                      if (didDragRef.current) return;
                      if (line.actionIndex < 0) return;
                      const cueLength = Math.max(1, displayCues[line.cueIndex]?.text.length ?? line.end);
                      if (onCueSelect?.(line.actionIndex, line.start / cueLength)) {
                        setIsBrowsingSubtitles(false);
                      }
                    }}
                    type="button"
                  >
                    {line.text}
                  </button>
                );
              })}
              <div aria-hidden="true" className="min-h-4" style={{ height: 'calc(50% - 48px)' }} />
            </div>
          </div>

          {hasKnowledgeGraph ? (
            <div className="hidden min-h-0 xl:-mx-5 xl:block xl:overflow-hidden">
              <div
                aria-label="当前课程知识图谱"
                className="relative h-full min-h-0 w-full overflow-hidden bg-[radial-gradient(ellipse_78%_70%_at_50%_50%,rgba(190,229,217,0.64)_0%,rgba(228,244,238,0.34)_52%,transparent_100%)] dark:bg-[radial-gradient(ellipse_78%_70%_at_50%_50%,rgba(35,111,94,0.3)_0%,rgba(15,54,51,0.16)_54%,transparent_100%)]"
              >
                <div className="pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_88%_82%_at_50%_50%,black_48%,rgba(0,0,0,0.72)_68%,transparent_100%)]">
                  <KnowledgeGraphFlow
                    activeNodeId={activeKnowledgePointId}
                    activeZoom={0.76}
                    appearance="teaching-rail"
                    autoRestoreView
                    fillAvailableHeight
                    focusActiveNode
                    graph={graph}
                    points={points}
                    showControls={false}
                    showMiniMap={false}
                  />
                </div>
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-white/82 to-transparent dark:from-slate-950/72"
                />
                <button
                  aria-label="完整浏览知识图谱"
                  className="absolute right-4 top-3 z-10 grid h-8 w-8 place-items-center rounded-full bg-white/58 text-slate-500 backdrop-blur-md transition hover:scale-105 hover:bg-white/90 hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 dark:bg-slate-900/42 dark:text-slate-300 dark:hover:bg-slate-800/80 dark:hover:text-teal-300"
                  onClick={() => setGraphOpen(true)}
                  type="button"
                >
                  <Maximize2 size={14} />
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {interactionAssistance?.active ? (
          <div
            aria-live="polite"
            className="mt-3 flex items-center gap-3 border-t border-slate-100 pt-3 dark:border-white/8 xl:mt-4 xl:pt-4"
            role="status"
          >
            <span
              aria-hidden="true"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300"
            >
              <MousePointer2 size={15} strokeWidth={1.8} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">互动操作进行中</p>
              <button
                className="mt-0.5 inline-flex max-w-full items-center gap-0.5 text-left text-[11px] text-slate-400 transition hover:text-amber-700 dark:hover:text-amber-300"
                onClick={interactionAssistance.onContinue}
                type="button"
              >
                <span className="truncate">页面未响应？继续讲解</span>
                <ChevronRight className="shrink-0" size={12} />
              </button>
            </div>
          </div>
        ) : null}

        <div
          className="relative z-20 mt-3 flex shrink-0 items-center justify-between border-t border-slate-100 bg-white/98 pt-3 dark:border-white/8 dark:bg-slate-950/98 xl:mt-4 xl:flex-col xl:items-stretch xl:gap-4 xl:pt-4"
          data-subtitle-controls
        >
          <div className="flex items-center justify-center gap-1 xl:justify-between">
            <IconButton disabled={!canGoPreviousCue} label="上一句" onClick={onPreviousCue}>
              <SkipBack size={17} strokeWidth={1.8} />
            </IconButton>
            <IconButton label={muted ? '打开声音' : '静音'} onClick={onToggleMute}>
              {muted ? <VolumeX size={17} strokeWidth={1.8} /> : <Volume2 size={17} strokeWidth={1.8} />}
            </IconButton>
            <button
              aria-label={isPlaying ? '暂停讲解' : '继续讲解'}
              className="mx-1 grid h-11 w-11 place-items-center rounded-full bg-teal-700 text-white transition hover:bg-teal-800 active:scale-95 dark:bg-teal-500 dark:text-slate-950"
              onClick={onPlayPause}
              type="button"
            >
              {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play className="ml-0.5" size={18} fill="currentColor" />}
            </button>
            <IconButton label="切换播放倍速" onClick={onCycleSpeed}>
              <span className="text-[11px] font-bold tabular-nums">{playbackSpeed}x</span>
            </IconButton>
            <IconButton disabled={!canGoNextCue} label="下一句" onClick={onNextCue}>
              <SkipForward size={17} strokeWidth={1.8} />
            </IconButton>
          </div>

          <div className="flex items-center gap-1 xl:justify-between">
            <button
              className="inline-flex h-8 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-slate-500 transition hover:text-teal-700 disabled:opacity-25 dark:text-slate-400 dark:hover:text-teal-300"
              disabled={!canGoPrevious}
              onClick={onPrevious}
              type="button"
            >
              <ChevronLeft size={15} /> 上一页
            </button>
            <button
              aria-pressed={autoPlay}
              className={cn(
                'hidden h-8 items-center gap-1 rounded-md px-2 text-xs font-semibold transition sm:inline-flex',
                autoPlay ? 'text-teal-700 dark:text-teal-300' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300',
              )}
              onClick={onToggleAutoPlay}
              type="button"
            >
              <Repeat2 size={14} /> 自动
            </button>
            <button
              className="inline-flex h-8 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-slate-700 transition hover:text-teal-700 disabled:opacity-25 dark:text-slate-200 dark:hover:text-teal-300"
              disabled={!canGoNext}
              onClick={onNext}
              type="button"
            >
              下一页 <ChevronRight size={15} />
            </button>
          </div>
        </div>
      </div>

      <Dialog onOpenChange={setGraphOpen} open={graphOpen}>
        <DialogContent className="w-[min(960px,calc(100vw-24px))] max-w-none overflow-hidden p-0">
          <DialogHeader className="px-6 pt-6">
            <DialogTitle>课程知识图谱</DialogTitle>
            <DialogDescription>
              知识沿真实依赖关系自动展开；当前讲授节点及其直接路径会保持清晰高亮。
            </DialogDescription>
          </DialogHeader>
          <div className="h-[min(68vh,620px)] min-h-[420px] border-t border-slate-100 dark:border-white/8">
            <KnowledgeGraphFlow
              activeNodeId={activeKnowledgePointId}
              activeZoom={0.82}
              autoRestoreView
              focusActiveNode
              graph={graph}
              height={520}
              points={points}
              showMiniMap
            />
          </div>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

function IconButton({
  children,
  disabled,
  label,
  onClick,
}: {
  readonly children: React.ReactNode;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onClick?: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="grid h-9 min-w-9 place-items-center rounded-full px-1 text-slate-500 transition hover:bg-slate-100 hover:text-teal-700 active:scale-95 disabled:pointer-events-none disabled:opacity-20 dark:text-slate-400 dark:hover:bg-white/8 dark:hover:text-teal-300"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}
