'use client';

import { LayoutTemplate, LoaderCircle, Lock, LockOpen } from 'lucide-react';
import { getTeachingVisualComponentForElement } from '@openmaic/lib/edit/teaching-visual-edits';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import { useResolvedSlideContent } from './use-slide-surface';
import { useSlideEditSession } from './slide-edit-session';
import { useTeachingVisualRecompose } from './use-teaching-visual-actions';
import { AnchoredBar } from './AnchoredBar';
import { resolveSelectedElement } from './editing-state';

const BUTTON = 'flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-600 transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#344A6A] disabled:cursor-default disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800';

/** Ownership controls stay beside an element without exposing authoring IDs. */
export function TeachingVisualActions({ elementId }: { readonly elementId: string }) {
  const content = useResolvedSlideContent();
  const component = getTeachingVisualComponentForElement(content, elementId);
  const { pending, recompose, messages } = useTeachingVisualRecompose();
  if (!component) return null;
  const protectedComponent = component.locked || component.modified;
  const LockIcon = component.locked ? Lock : LockOpen;
  return (
    <div className="flex items-center gap-1 border-l border-zinc-200 pl-1 dark:border-zinc-800">
      <button
        type="button"
        aria-label={component.locked ? messages.unlock : messages.lock}
        aria-pressed={!!component.locked}
        title={component.locked ? messages.locked : messages.lock}
        className={BUTTON}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => useSlideEditSession.getState().applyOp({
          type: 'visual.setLocked', componentId: component.id, locked: !component.locked,
        })}
      >
        <LockIcon className="h-4 w-4" aria-hidden />
        <span>{component.locked ? messages.unlock : messages.lock}</span>
      </button>
      <button
        type="button"
        aria-label={pending ? messages.pending : messages.recompose}
        title={component.modified ? messages.modified : component.locked ? messages.locked : messages.recompose}
        disabled={!!protectedComponent || pending}
        className={BUTTON}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void recompose(component.id)}
      >
        {pending ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <LayoutTemplate className="h-4 w-4" aria-hidden />}
        <span>{component.modified ? messages.modified : messages.recompose}</span>
      </button>
    </div>
  );
}

/** A grouped diagram may select several native elements simultaneously. */
export function TeachingVisualSelectionBar() {
  const content = useResolvedSlideContent();
  const selection = useCanvasStore.use.activeElementIdList();
  const activeGroupElementId = useCanvasStore.use.activeGroupElementId();
  if (selection.length < 2) return null;
  if (resolveSelectedElement(selection, content.canvas.elements, activeGroupElementId)) return null;
  const component = getTeachingVisualComponentForElement(content, selection[0]);
  if (!component || selection.some((id) => !component.elementIds.includes(id))) return null;
  return (
    <AnchoredBar elementId={selection[0]}>
      <TeachingVisualActions elementId={selection[0]} />
    </AnchoredBar>
  );
}
