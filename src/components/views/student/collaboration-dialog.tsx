"use client";

import type { ReactElement, ReactNode } from "react";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";

/** Keep workspace dialogs above the classroom header and AI member panel. */
export function CollaborationDialog({ title, trigger, children }: {
  title: string;
  trigger: ReactElement;
  children: ReactNode;
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-stone-950/35" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[101] flex max-h-[calc(100dvh-2rem)] w-[min(48rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] text-[var(--pbl-text)] shadow-xl outline-none"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--pbl-border)] px-4 py-2 sm:px-6">
            <Dialog.Title className="text-base font-bold text-[var(--pbl-text-strong)]">{title}</Dialog.Title>
            <Dialog.Close aria-label="关闭对话框" className="grid size-11 shrink-0 place-items-center rounded-lg text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pbl-student)]">
              <X aria-hidden="true" size={18} />
            </Dialog.Close>
          </div>
          <div className="min-h-0 overflow-y-auto overscroll-contain p-4 [overflow-wrap:anywhere] sm:p-6">
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
