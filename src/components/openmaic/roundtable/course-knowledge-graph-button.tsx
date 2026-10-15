'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { KnowledgeGraphFlow } from '@/components/knowledge-graph-flow';
import { CourseMindMapFlow } from '@/components/course-mind-map-flow';
import { useActiveCourseMindMapNode, type MindMapPlaybackProps } from '@/components/openmaic-bridge/course-mind-map-focus';
import { useTeachingKnowledgeGraph } from '@/components/openmaic-bridge/knowledge-graph-context';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/overlays';
import { dispatchPlaybackModalBlock } from '@openmaic/lib/playback/activity-events';
import { useStageStore } from '@openmaic/lib/store';
import { cn } from '@openmaic/lib/utils';
import styles from './lecture-subtitle-dock.module.css';

/** One graph interaction for the ordinary teaching rail and native fullscreen. */
export function CourseKnowledgeGraphButton({ showLabel = false, ...playbackPosition }: MindMapPlaybackProps & { readonly showLabel?: boolean }) {
  const { graph, points, mindMap } = useTeachingKnowledgeGraph();
  const activeConceptId = useActiveCourseMindMapNode(playbackPosition);
  const scene = useStageStore(state => state.getCurrentScene());
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeNodeId = useMemo(() => {
    const knownIds = new Set([...(graph?.nodes.map(node => node.id) ?? []), ...points.map(point => point.id)]);
    return scene?.knowledgePointIds?.find(id => knownIds.has(id))
      ?? graph?.nodes.find(node => node.relatedLessonIds?.includes(scene?.id ?? ''))?.id
      ?? null;
  }, [graph, points, scene]);

  useLayoutEffect(() => {
    if (!open) return;
    dispatchPlaybackModalBlock({ blocked: true, source: 'course-knowledge-graph', restorePlayback: true });
    return () => dispatchPlaybackModalBlock({ blocked: false, source: 'course-knowledge-graph', restorePlayback: true });
  }, [open]);

  if (!mindMap?.nodes.length && !graph?.nodes.length && !points.length) return null;
  return <>
    <button
      aria-label="完整浏览课程思维导图"
      className={cn('inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-sm text-slate-400 transition-colors hover:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 dark:text-slate-400 dark:hover:text-slate-200', showLabel && 'px-3 text-xs font-medium')}
      onClick={() => setOpen(true)}
      ref={triggerRef}
      title="完整浏览课程思维导图"
      type="button"
    ><Maximize2 size={14} strokeWidth={1.6} />{showLabel ? <span>课程思维导图</span> : null}</button>
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent
        className={styles.graphDialog}
        portalContainer={typeof document === 'undefined' ? undefined : document.fullscreenElement as HTMLElement | null}
        onCloseAutoFocus={event => { event.preventDefault(); triggerRef.current?.focus(); }}
        onEscapeKeyDown={event => {
          event.stopPropagation();
          if (event.isComposing || event.keyCode === 229) event.preventDefault();
        }}
        onKeyDown={event => event.stopPropagation()}
        onKeyUp={event => event.stopPropagation()}
      >
        <DialogHeader className={styles.graphHeader}>
          <DialogTitle>课程思维导图</DialogTitle>
          <DialogDescription>从课程总览进入主题，逐层展开概念；点击节点查看完整说明与关联。</DialogDescription>
        </DialogHeader>
        <div className={cn(styles.graphViewport, 'border-t border-slate-100 dark:border-white/8')}>
          {mindMap?.nodes.length ? <CourseMindMapFlow map={mindMap} activeNodeId={activeConceptId}
            fillAvailableHeight focusActiveNode showMiniMap />
            : <KnowledgeGraphFlow activeNodeId={activeNodeId} activeZoom={0.82} autoRestoreView
              fillAvailableHeight focusActiveNode graph={graph} points={points} showMiniMap />}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
