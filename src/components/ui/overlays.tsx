"use client";

import type { ComponentProps, ReactNode } from "react";
import { AlertDialog as AlertPrimitive, Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ children, className, portalContainer, ...props }: ComponentProps<typeof DialogPrimitive.Content> & {
  portalContainer?: ComponentProps<typeof DialogPrimitive.Portal>["container"];
}) {
  return (
    <DialogPrimitive.Portal container={portalContainer}>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[#0f172a]/30 data-[state=open]:animate-fade-in" />
      <DialogPrimitive.Content
        className={cn("fixed left-1/2 top-1/2 z-50 grid max-h-[min(86vh,760px)] w-[min(620px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 gap-5 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--pbl-border)] bg-[var(--pbl-surface-raised)] p-5 shadow-[var(--shadow-floating)] outline-none md:p-6", className)}
        {...props}
      >
        {children}
        <DialogPrimitive.Close aria-label="关闭对话框" className="absolute right-3 top-3 grid min-h-11 min-w-11 place-items-center rounded-[var(--radius-xs)] text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)]">
          <X aria-hidden="true" size={18} />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("space-y-2 pr-10", className)}>{children}</div>;
}
export function DialogTitle(props: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("font-editorial text-xl font-semibold text-[var(--pbl-text-strong)]", props.className)} {...props} />;
}
export function DialogDescription(props: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("text-sm leading-6 text-[var(--pbl-text-muted)]", props.className)} {...props} />;
}
export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col-reverse gap-2 border-t border-[var(--pbl-border-soft)] pt-4 sm:flex-row sm:justify-end", className)}>{children}</div>;
}

export const Drawer = DialogPrimitive.Root;
export const DrawerTrigger = DialogPrimitive.Trigger;
export const DrawerClose = DialogPrimitive.Close;
export function DrawerContent({ children, className, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[#0f172a]/25" />
      <DialogPrimitive.Content className={cn("fixed inset-y-0 right-0 z-50 w-[min(520px,100vw)] overflow-y-auto border-l border-[var(--pbl-border)] bg-[var(--pbl-surface-raised)] p-5 shadow-[var(--shadow-floating)] outline-none md:p-6", className)} {...props}>
        {children}
        <DialogPrimitive.Close aria-label="关闭抽屉" className="absolute right-3 top-3 grid min-h-11 min-w-11 place-items-center rounded-[var(--radius-xs)] text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)]"><X aria-hidden="true" size={18} /></DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const AlertDialog = AlertPrimitive.Root;
export const AlertDialogTrigger = AlertPrimitive.Trigger;

export function AlertDialogContent({ children, className, ...props }: ComponentProps<typeof AlertPrimitive.Content>) {
  return (
    <AlertPrimitive.Portal>
      <AlertPrimitive.Overlay className="fixed inset-0 z-50 bg-[#0f172a]/35" />
      <AlertPrimitive.Content className={cn("fixed left-1/2 top-1/2 z-50 grid max-h-[calc(100dvh-24px)] w-[min(500px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 gap-5 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--pbl-border)] bg-[var(--pbl-surface-raised)] p-5 shadow-[var(--shadow-floating)] outline-none md:p-6", className)} {...props}>{children}</AlertPrimitive.Content>
    </AlertPrimitive.Portal>
  );
}
export function AlertDialogTitle(props: ComponentProps<typeof AlertPrimitive.Title>) {
  return <AlertPrimitive.Title className={cn("font-editorial text-xl font-semibold text-[var(--pbl-text-strong)]", props.className)} {...props} />;
}
export function AlertDialogDescription(props: ComponentProps<typeof AlertPrimitive.Description>) {
  return <AlertPrimitive.Description className={cn("text-sm leading-6 text-[var(--pbl-text-muted)]", props.className)} {...props} />;
}
export function AlertDialogFooter({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{children}</div>;
}
export function AlertDialogCancel({ children = "取消" }: { children?: ReactNode }) {
  return <AlertPrimitive.Cancel asChild><Button variant="secondary">{children}</Button></AlertPrimitive.Cancel>;
}
export function AlertDialogAction({ children, onClick, variant = "danger" }: { children: ReactNode; onClick?: () => void; variant?: "primary" | "danger" }) {
  return <AlertPrimitive.Action asChild><Button onClick={onClick} variant={variant}>{children}</Button></AlertPrimitive.Action>;
}
