'use client';

import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useI18n } from '@openmaic/lib/hooks/use-i18n';
import { cn } from '@openmaic/lib/utils';
import type { EditorCommand, SurfaceHistory } from '@openmaic/lib/edit/scene-editor-surface';
import { EditorControls, EditorIconButton } from './EditorControls';

interface CommandBarProps {
  readonly title: string;
  readonly history?: SurfaceHistory;
  readonly commands?: readonly EditorCommand[];
  /**
   * Right-edge slot owned by Stage. In Pro mode it carries the
   * HeaderControls (settings pill + Pro Switch + Download) since Stage
   * Header is unmounted to keep top chrome to a single bar.
   */
  readonly trailing?: ReactNode;
}

/**
 * Top bar of the Pro mode chrome. Undo/redo + title on the left, insert
 * primitives in the center, surface commands on the right. History /
 * insertItems / commands are all optional so the bar renders cleanly when
 * no surface is registered for the current scene type.
 *
 * Exiting Pro mode is handled by the global Pro Switch in the playback
 * Header (which stays mounted above this bar) — Pro mode is a toggle,
 * not a one-way state, so we deliberately do *not* place a "Done" pill
 * here that would compete with the Switch's affordance.
 */
export function CommandBar({ title, history, commands, trailing }: CommandBarProps) {
  const { t } = useI18n();
  const router = useRouter();

  return (
    <header className="flex h-20 shrink-0 items-center gap-3 border-b border-zinc-200/60 px-8 dark:border-zinc-800/60">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* Back-to-home — mirrors playback Header's leftmost button so the
            user has the same global-out affordance across modes. */}
        <EditorIconButton title={t('generation.backToHome')} onClick={() => router.push('/')}>
          <ArrowLeft className="h-4 w-4" />
        </EditorIconButton>
        <EditorControls history={history} />
        <span
          className={cn('ml-2 truncate text-sm font-semibold text-zinc-700 dark:text-zinc-200')}
          title={title}
        >
          {title}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <EditorControls commands={commands} />
        {trailing}
      </div>
    </header>
  );
}
