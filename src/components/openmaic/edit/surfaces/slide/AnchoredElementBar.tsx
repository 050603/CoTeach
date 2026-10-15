'use client';

import type { PPTElement } from '@openmaic/dsl';
import { AnchoredBar } from './AnchoredBar';
import { DeleteButton } from './DeleteButton';
import { ImageActions } from './ImageActions';
import { ZOrderButtons } from './ZOrderButtons';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import { useI18n } from '@openmaic/lib/hooks/use-i18n';

interface AnchoredElementBarProps {
  /** The selected non-text element, or null when none is selected. */
  readonly element: PPTElement | null;
}

const Separator = () => <div className="h-5 w-px bg-zinc-200 dark:bg-zinc-800" />;

/**
 * The selection-anchored bar for non-text elements (image, shape, line, …).
 * Type-aware: image elements get replace/crop/flip controls; every non-text
 * element gets z-order (to-front/to-back) + delete. Hugs the selected element
 * — see AnchoredBar for the shell. Text elements get their own AnchoredTextBar.
 */
export function AnchoredElementBar({ element }: AnchoredElementBarProps) {
  const { t } = useI18n();
  const elementId = element?.id ?? '';
  return (
    <AnchoredBar elementId={elementId}>
      <div className="flex items-center gap-1">
        {element?.type === 'shape' && !element.lock && (
          <>
            <button
              type="button"
              className="flex min-h-11 items-center rounded-md px-3 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => useCanvasStore.getState().setEditingElementId(element.id)}
            >
              {t('edit.text.edit')}
            </button>
            <Separator />
          </>
        )}
        {element?.type === 'image' && (
          <>
            <ImageActions element={element} />
            <Separator />
          </>
        )}
        <ZOrderButtons elementId={elementId} />
        <Separator />
        <DeleteButton elementId={elementId} />
      </div>
    </AnchoredBar>
  );
}
