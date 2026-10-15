import type { ReactNode } from "react";
import { AlertCircle, Check, CircleDashed, LoaderCircle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

export type SaveState = "idle" | "unsaved" | "saving" | "saved" | "error";

export function SaveStatus({ lastSavedAt, onRetry, state = "idle" }: { lastSavedAt?: string | Date; onRetry?: () => void; state?: SaveState }) {
  const content = {
    idle: { icon: CircleDashed, label: "已就绪" },
    unsaved: { icon: CircleDashed, label: "未保存" },
    saving: { icon: LoaderCircle, label: "保存中" },
    saved: { icon: Check, label: lastSavedAt ? `已保存 ${new Date(lastSavedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "已保存" },
    error: { icon: AlertCircle, label: "保存失败" },
  }[state];
  const Icon = content.icon;
  return (
    <div aria-live="polite" data-slot="save-status" title={content.label} className={cn("inline-flex min-h-9 items-center gap-2 text-sm text-[var(--pbl-text-muted)]", state === "error" && "text-[var(--pbl-danger)]") }>
      <Icon aria-hidden="true" className={state === "saving" ? "animate-spin" : ""} size={16} />
      <span>{content.label}</span>
      {state === "error" && onRetry ? <button className="inline-flex min-h-11 min-w-11 items-center gap-1 font-semibold underline-offset-4 hover:underline" onClick={onRetry} type="button"><RefreshCw size={14} />重试</button> : null}
    </div>
  );
}

export function PageState({ action, description, icon, title, tone = "neutral" }: { action?: ReactNode; description: string; icon?: ReactNode; title: string; tone?: "neutral" | "error" | "success" }) {
  return (
    <section className={cn("border-y border-[var(--pbl-border)] py-10 text-center", tone === "error" && "text-[var(--pbl-danger)]")}>
      {icon ? <div className="mx-auto mb-3 flex justify-center">{icon}</div> : null}
      <h2 className="font-editorial text-xl font-semibold">{title}</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-[var(--pbl-text-muted)]">{description}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </section>
  );
}

export function FlowActionBar({
  back,
  children,
  fullBleed = false,
  persistent = false,
  reserveSpace = true,
  saveStatus,
}: {
  back?: ReactNode;
  children: ReactNode;
  fullBleed?: boolean;
  persistent?: boolean;
  reserveSpace?: boolean;
  saveStatus?: ReactNode;
}) {
  const bar = (
    <div
      className={cn(
        "pbl-safe-bottom z-30 border-t border-[var(--pbl-border)] bg-[color-mix(in_srgb,var(--pbl-surface)_96%,transparent)] px-4 pt-3 shadow-[0_-8px_24px_rgba(31,41,51,0.06)] backdrop-blur-sm md:px-6",
        persistent ? "fixed inset-x-0 bottom-0" : "sticky bottom-0 mt-8",
      )}
      style={fullBleed && !persistent
        ? { marginLeft: "calc(50% - 50vw)", width: "100vw" }
        : undefined}
    >
      <div className="mx-auto flex max-w-[96rem] items-center justify-between gap-3">
        <div className="min-w-0">{back}</div>
        <div className="hidden flex-1 justify-center sm:flex">{saveStatus}</div>
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      </div>
    </div>
  );

  return (
    <>
      {persistent && reserveSpace ? <div aria-hidden="true" className="h-24" /> : null}
      {bar}
    </>
  );
}
