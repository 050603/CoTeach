'use client';

import { Redo2, Undo2 } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Button } from '@openmaic/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@openmaic/components/ui/tooltip';
import { useI18n } from '@openmaic/lib/hooks/use-i18n';
import { cn } from '@openmaic/lib/utils';
import type { EditorCommand, SurfaceHistory } from '@openmaic/lib/edit/scene-editor-surface';

export interface EditorControlsProps {
  readonly title: string;
  readonly history?: SurfaceHistory;
  readonly commands?: readonly EditorCommand[];
}

/** The same surface actions remain reachable in the top bar or navigation rail. */
export function EditorControls({
  history,
  commands,
  vertical = false,
}: Omit<EditorControlsProps, 'title'> & { readonly vertical?: boolean }) {
  const { t } = useI18n();
  if (!history && !commands?.length) return null;

  return (
    <div className={cn('flex shrink-0 gap-0.5', vertical ? 'flex-col items-center' : 'flex-wrap items-center')}>
      {history && (
        <>
          <EditorIconButton title={t('edit.undo')} disabled={!history.canUndo} onClick={history.undo}>
            <Undo2 className="size-4" />
          </EditorIconButton>
          <EditorIconButton title={t('edit.redo')} disabled={!history.canRedo} onClick={history.redo}>
            <Redo2 className="size-4" />
          </EditorIconButton>
        </>
      )}
      {commands?.map((command) => (
        <EditorIconButton
          key={command.id}
          title={command.tooltip ?? command.label}
          disabled={command.disabled}
          onClick={command.onInvoke}
        >
          {command.icon ?? <span className="truncate px-0.5 text-xs">{command.label}</span>}
        </EditorIconButton>
      ))}
    </div>
  );
}

export function EditorIconButton({
  title,
  children,
  ...props
}: ComponentProps<typeof Button> & { readonly title: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={title}
          title={title}
          className="size-11 shrink-0 rounded-[10px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-inset dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}
