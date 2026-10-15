'use client';

import { ChevronLeft, ChevronRight, Radio } from 'lucide-react';
import { useI18n } from '@openmaic/lib/hooks/use-i18n';

export interface WhiteboardPageOption {
  id: string;
  title: string;
}

/** Page selection is a view operation: it never restores content onto the live board. */
export function WhiteboardPageNavigation({
  pages,
  selectedPageId,
  reviewing,
  onSelect,
  onReturnToLive,
}: {
  pages: WhiteboardPageOption[];
  selectedPageId: string | null;
  reviewing: boolean;
  onSelect: (id: string) => void;
  onReturnToLive: () => void;
}) {
  const { t } = useI18n();
  if (pages.length === 0) return null;
  const selectedIndex = pages.findIndex((page) => page.id === selectedPageId);
  const selectAdjacent = (offset: number) => {
    const page = pages[selectedIndex + offset];
    if (page) onSelect(page.id);
  };
  const buttonClass = 'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-purple-50 hover:text-purple-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 disabled:pointer-events-none disabled:opacity-30 dark:text-gray-400 dark:hover:bg-purple-900/20';

  return (
    <nav aria-label={t('whiteboard.pages')} className="mx-1 flex min-w-0 flex-1 items-center justify-center gap-1">
      <button
        type="button"
        className={buttonClass}
        aria-label={t('whiteboard.previousPage')}
        title={t('whiteboard.previousPage')}
        disabled={selectedIndex <= 0}
        onClick={() => selectAdjacent(-1)}
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      <select
        aria-label={t('whiteboard.selectPage')}
        className="h-11 min-w-11 max-w-80 flex-1 truncate rounded-lg border border-gray-200 bg-white/80 px-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-purple-400 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
        value={selectedPageId ?? ''}
        onChange={(event) => onSelect(event.target.value)}
      >
        {selectedIndex < 0 && <option value="">{t('whiteboard.currentTeaching')}</option>}
        {pages.map((page, index) => (
          <option key={page.id} value={page.id}>
            {t('whiteboard.pageLabel', { index: index + 1, total: pages.length })} · {page.title}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={buttonClass}
        aria-label={t('whiteboard.nextPage')}
        title={t('whiteboard.nextPage')}
        disabled={selectedIndex < 0 || selectedIndex >= pages.length - 1}
        onClick={() => selectAdjacent(1)}
      >
        <ChevronRight className="h-5 w-5" />
      </button>
      {reviewing && (
        <button
          type="button"
          onClick={onReturnToLive}
          aria-label={t('whiteboard.returnToTeaching')}
          title={t('whiteboard.returnToTeaching')}
          className="inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-purple-50 px-3 text-xs font-semibold text-purple-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 dark:bg-purple-900/30 dark:text-purple-300"
        >
          <Radio className="h-4 w-4" />
          <span className="hidden xl:inline">{t('whiteboard.returnToTeaching')}</span>
        </button>
      )}
    </nav>
  );
}
