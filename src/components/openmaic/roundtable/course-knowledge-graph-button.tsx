'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { KnowledgeGraphFlow } from '@/components/knowledge-graph-flow';
import { useTeachingKnowledgeGraph } from '@/components/openmaic-bridge/knowledge-graph-context';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/overlays';
import { dispatchPlaybackModalBlock } from '@openmaic/lib/playback/activity-events';
import { useStageStore } from '@openmaic/lib/store';
import { cn } from '@openmaic/lib/utils';
import styles from './lecture-subtitle-dock.module.css';

/** One graph interaction for the ordinary teaching rail and native fullscreen. */
export function CourseKnowledgeGraphButton() {
  const { graph, points } = useTeachingKnowledgeGraph();
  const scene = useStageStore(state => state.getCurrentScene());
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeNodeId = useMemo(() => {
    const knownIds = new Set([...(graph?.nodes.map(node => node.id) ?? []), ...points.map(point => point.id)]);
    return scene?.knowledgePointIds?.find(id => knownIds.has(id))
      ?? graph?.nodes.find(node => node.relatedLessonIds?.includes(scene?.id ?? ''))?.id
      ?? null;
  }, [graph, points, scene]);

  useEffect(() => {
    if (!open) return;
    dispatchPlaybackModalBlock({ blocked: true, source: 'course-knowledge-graph' });
    return () => dispatchPlaybackModalBlock({ blocked: false, source: 'course-knowledge-graph' });
  }, [open]);

  if (!graph?.nodes.length && !points.length) return null;
  return <>
    <button
      aria-label="完整浏览课程思维导图"
      className="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 dark:text-slate-300 dark:hover:bg-slate-800"
      onClick={() => setOpen(true)}
      ref={triggerRef}
      title="课程思维导图"
      type="button"
    ><Maximize2 size={16} /></button>
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
          <DialogDescription>沿课程知识脉络浏览各个概念；当前讲授内容及其关联会保持清晰高亮。</DialogDescription>
        </DialogHeader>
        <div className={cn(styles.graphViewport, 'border-t border-slate-100 dark:border-white/8')}>
          <KnowledgeGraphFlow activeNodeId={activeNodeId} activeZoom={0.82} autoRestoreView
            fillAvailableHeight focusActiveNode graph={graph} points={points} showMiniMap />
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
