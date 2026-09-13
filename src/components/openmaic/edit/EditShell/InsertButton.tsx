'use client';

import { Popover, PopoverContent, PopoverTrigger } from '@openmaic/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@openmaic/components/ui/tooltip';
import type { InsertPaletteItem } from '@openmaic/lib/edit/scene-editor-surface';

/**
 * Single insert-palette button. Reused by both the (legacy) CommandBar
 * insert slot and the FloatingInsertToolbar that lives above the
 * canvas now.
 *
 * When the item declares `popoverContent`, the button doubles as a
 * popover trigger — and PopoverTrigger's `asChild` Slot is chained
 * directly onto the real `<button>` so wrapping a `<Tooltip>`
 * (provider, not DOM) doesn't drop the popover trigger handler.
 */
export function InsertButton({ item }: { readonly item: InsertPaletteItem }) {
  const button = (
    <button
      type="button"
      aria-label={item.label}
      aria-pressed={item.active}
      disabled={item.disabled}
      onClick={item.popoverContent ? undefined : item.onInvoke}
      className={`group flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] px-2 transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current disabled:pointer-events-none disabled:opacity-40 sm:px-3 ${
        item.active
          ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300'
          : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
      }`}
    >
      {item.icon && <span className="flex size-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">
        {item.icon}
      </span>}
      <span className={`whitespace-nowrap text-xs font-medium ${item.icon ? 'hidden sm:inline' : ''}`}>{item.label}</span>
    </button>
  );

  const triggerWithTooltip = (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      {item.tooltip && <TooltipContent>{item.tooltip}</TooltipContent>}
    </Tooltip>
  );

  if (!item.popoverContent) return triggerWithTooltip;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>{button}</PopoverTrigger>
        </TooltipTrigger>
        {item.tooltip && <TooltipContent>{item.tooltip}</TooltipContent>}
      </Tooltip>
      <PopoverContent side="bottom" align="center" className="w-80 p-3">
        {item.popoverContent()}
      </PopoverContent>
    </Popover>
  );
}
