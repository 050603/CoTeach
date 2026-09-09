import type { ReactNode } from "react";
import { BookOpen, CircleAlert } from "lucide-react";

export function PlatformLoading({ label = "正在加载…" }: { label?: string }) {
  return <div role="status" className="pbl-loading"><span className="pbl-loading-label">{label}</span><div aria-hidden="true" className="pbl-skeleton-grid">{[0, 1, 2].map(index => <div className="pbl-skeleton-card" key={index}><div /><span /><span /><span /></div>)}</div></div>;
}

export function PlatformEmpty({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <section className="pbl-empty"><span className="pbl-empty-icon"><BookOpen size={28} strokeWidth={1.5}/></span><h2>{title}</h2><p>{description}</p>{children}</section>;
}

export function PlatformError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div role="alert" className="pbl-error"><CircleAlert size={20} className="shrink-0"/><p className="flex-1">{message}</p>{onRetry && <button className="min-h-11 shrink-0 rounded-lg px-3 font-semibold underline underline-offset-4" onClick={onRetry}>重新加载</button>}</div>;
}
