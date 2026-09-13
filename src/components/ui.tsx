import type { CSSProperties, ReactNode } from "react";
import {
  Bot,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { courseResourceTypeLabel } from "@/lib/user-facing-labels";

/* ============================================================
   CoTeach 基础组件库 v2
   - 统一圆角（8/12/16）
   - 语义化变体
   - 克制字重（去除 font-bold 滥用，最多到 font-bold）
   - 身份色通过 role 传入
   ============================================================ */

type Role = "teacher" | "student" | "ai";

type CardProps = {
  children: ReactNode;
  className?: string;
  compact?: boolean;
  raised?: boolean;
};

export function Card({ children, className, compact = false, raised = false }: CardProps) {
  return (
    <section
      className={cn(
        "min-w-0 rounded-[var(--radius-md)]",
        raised ? "pbl-card-raised" : "pbl-card",
        compact ? "p-4" : "p-5",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function SectionTitle({
  title,
  action,
  hint,
}: {
  title: string;
  action?: ReactNode;
  hint?: string;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[18px] font-bold leading-tight text-[var(--pbl-text-strong)]">
          {title}
        </h2>
        {hint ? <p className="mt-1 text-[13px] text-[var(--pbl-text-muted)]">{hint}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

type PillTone = "blue" | "green" | "orange" | "amber" | "gray" | "red" | "teal" | "violet";

export function Pill({
  children,
  tone = "blue",
  className,
  size = "md",
}: {
  children: ReactNode;
  tone?: PillTone;
  className?: string;
  size?: "sm" | "md";
}) {
  const tones: Record<PillTone, string> = {
    blue: "bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)] ring-[var(--pbl-teacher-border)]",
    violet: "bg-[var(--pbl-ai-soft)] text-[var(--pbl-ai)] ring-[var(--pbl-ai-border)]",
    green: "bg-[var(--pbl-success-soft)] text-[var(--pbl-success)] ring-[var(--pbl-success-border)]",
    teal: "bg-[var(--pbl-student-soft)] text-[var(--pbl-student)] ring-[var(--pbl-student-border)]",
    orange: "bg-[var(--pbl-accent-soft)] text-[var(--pbl-accent)] ring-[var(--pbl-accent-border)]",
    amber: "bg-[var(--pbl-warning-soft)] text-[var(--pbl-warning)] ring-[var(--pbl-warning-border)]",
    gray: "bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-muted)] ring-[var(--pbl-border)]",
    red: "bg-[var(--pbl-danger-soft)] text-[var(--pbl-danger)] ring-[var(--pbl-danger-border)]",
  };
  const sizes = {
    sm: "h-6 px-2.5 text-xs",
    md: "h-7 px-3 text-[13px]",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full font-semibold ring-1",
        tones[tone],
        sizes[size],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* 状态徽章：用语义色而非任意色块 */
export function StatusPill({
  status,
  label,
}: {
  status: "draft" | "preparing" | "ready" | "teaching" | "finished";
  label: string;
}) {
  const toneMap: Record<typeof status, PillTone> = {
    draft: "gray",
    preparing: "amber",
    ready: "green",
    teaching: "violet",
    finished: "gray",
  };
  return (
    <Pill tone={toneMap[status]} size="sm">
      {label}
    </Pill>
  );
}

type ButtonTone = "blue" | "green" | "orange" | "red" | "violet" | "teal" | "slate";

export function PrimaryButton({
  children,
  variant = "solid",
  tone = "blue",
  className,
  type = "button",
  disabled,
  onClick,
  size = "md",
}: {
  children: ReactNode;
  variant?: "solid" | "outline" | "ghost";
  tone?: ButtonTone;
  className?: string;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  size?: "sm" | "md" | "lg";
}) {
  const solid: Record<ButtonTone, string> = {
    blue: "bg-[var(--pbl-teacher)] text-white hover:bg-[var(--pbl-teacher-hover)]",
    violet: "bg-[var(--pbl-ai)] text-white hover:bg-[var(--pbl-ai-hover)]",
    teal: "bg-[var(--pbl-student)] text-white hover:bg-[var(--pbl-student-hover)]",
    green: "bg-[var(--pbl-success)] text-white hover:bg-[var(--pbl-success-hover)]",
    orange: "bg-[var(--pbl-accent)] text-white hover:bg-[var(--pbl-accent-hover)]",
    red: "bg-[var(--pbl-danger)] text-white hover:bg-[var(--pbl-danger-hover)]",
    slate: "bg-stone-800 text-white hover:bg-stone-900",
  };
  const outline: Record<ButtonTone, string> = {
    blue: "border-[var(--pbl-teacher)] text-[var(--pbl-teacher)] hover:bg-[var(--pbl-teacher-soft)]",
    violet: "border-[var(--pbl-ai)] text-[var(--pbl-ai)] hover:bg-[var(--pbl-ai-soft)]",
    teal: "border-[var(--pbl-student)] text-[var(--pbl-student)] hover:bg-[var(--pbl-student-soft)]",
    green: "border-[var(--pbl-success)] text-[var(--pbl-success)] hover:bg-[var(--pbl-success-soft)]",
    orange: "border-[var(--pbl-accent)] text-[var(--pbl-accent)] hover:bg-[var(--pbl-accent-soft)]",
    red: "border-[var(--pbl-danger)] text-[var(--pbl-danger)] hover:bg-[var(--pbl-danger-soft)]",
    slate: "border-[var(--pbl-border-strong)] text-[var(--pbl-text)] hover:bg-[var(--pbl-surface-soft)]",
  };
  const sizes = {
    sm: "h-9 px-3.5 text-[13px]",
    md: "h-11 px-5 text-sm",
    lg: "h-12 px-6 text-base",
  };

  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-[var(--radius-sm)] font-semibold transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-55",
        variant === "solid" && solid[tone],
        variant === "outline" && "border bg-[var(--pbl-surface)] " + outline[tone],
        variant === "ghost" && "text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)]",
        sizes[size],
        className,
      )}
      disabled={disabled}
      onClick={onClick}
      type={type}
    >
      {children}
    </button>
  );
}

export function TextInput({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-[var(--radius-sm)] border border-[var(--pbl-border-strong)] bg-[var(--pbl-surface)] px-3 text-sm outline-none transition placeholder:text-[var(--pbl-text-subtle)] focus:border-[var(--pbl-teacher)] focus:ring-2 focus:ring-[var(--pbl-teacher-soft)]",
        className,
      )}
      {...props}
    />
  );
}

export function TextArea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full resize-none rounded-[var(--radius-sm)] border border-[var(--pbl-border-strong)] bg-[var(--pbl-surface)] p-3 text-sm leading-7 outline-none transition placeholder:text-[var(--pbl-text-subtle)] focus:border-[var(--pbl-teacher)] focus:ring-2 focus:ring-[var(--pbl-teacher-soft)]",
        className,
      )}
      {...props}
    />
  );
}

export function Select({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-11 w-full rounded-[var(--radius-sm)] border border-[var(--pbl-border-strong)] bg-[var(--pbl-surface)] px-3 text-sm outline-none transition focus:border-[var(--pbl-teacher)] focus:ring-2 focus:ring-[var(--pbl-teacher-soft)]",
        className,
      )}
      {...props}
    />
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-end justify-between gap-5">
      <div className="min-w-0">
        {eyebrow ? (
          <div className="mb-2 text-[13px] font-semibold uppercase tracking-[0.14em] text-[var(--pbl-text-muted)]">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="text-[28px] font-bold leading-tight tracking-tight text-[var(--pbl-text-strong)]">
          {title}
        </h1>
        {description ? (
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--pbl-text-muted)]">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function StageTimeline({
  items,
  currentIndex,
}: {
  items: { label: string; description?: string }[];
  currentIndex: number;
}) {
  return (
    <Card className="px-6 py-5">
      <div className="grid" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((item, index) => {
          const done = index < currentIndex;
          const active = index === currentIndex;
          return (
            <div className="relative text-center" key={item.label}>
              {index > 0 ? (
                <div
                  className={cn(
                    "absolute left-0 right-1/2 top-[17px] h-1 -translate-x-1/2 rounded-full",
                    done || active ? "bg-[var(--pbl-teacher)]" : "bg-[var(--pbl-border)]",
                  )}
                />
              ) : null}
              {index < items.length - 1 ? (
                <div
                  className={cn(
                    "absolute left-1/2 right-0 top-[17px] h-1 translate-x-1/2 rounded-full",
                    done ? "bg-[var(--pbl-teacher)]" : "bg-[var(--pbl-border)]",
                  )}
                />
              ) : null}
              <div
                className={cn(
                  "relative z-10 mx-auto grid h-9 w-9 place-items-center rounded-full text-sm font-bold",
                  done && "bg-[var(--pbl-teacher)] text-white",
                  active && "bg-[var(--pbl-teacher)] text-white ring-4 ring-[var(--pbl-teacher-soft)]",
                  !done && !active && "bg-[var(--pbl-border-strong)] text-white",
                )}
              >
                {done ? <CheckCircle2 size={18} /> : index + 1}
              </div>
              <div className="mt-3 text-sm font-bold text-[var(--pbl-text-strong)]">{item.label}</div>
              {item.description ? (
                <div className="mt-1 text-xs text-[var(--pbl-text-muted)]">{item.description}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function AIAdvicePanel({
  title = "AI 建议",
  items,
  action,
}: {
  title?: string;
  items: string[];
  action?: ReactNode;
}) {
  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="inline-flex items-center gap-2 text-lg font-bold">
          <Bot className="text-[var(--pbl-ai)]" size={18} /> {title}
        </h2>
        {action}
      </div>
      <div className="space-y-3">
        {items.map((item, index) => (
          <div className="flex gap-3 text-sm leading-6" key={item}>
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--pbl-ai-soft)] text-[11px] font-bold text-[var(--pbl-ai)] ring-1 ring-[var(--pbl-ai-border)]">
              {index + 1}
            </span>
            <p className="text-[var(--pbl-text)]">{item}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function UploadRow({
  type,
  title,
  rule,
  file,
  status = "已上传",
}: {
  type: string;
  title: string;
  rule: string;
  file?: string;
  status?: string;
}) {
  return (
    <div className="grid grid-cols-[52px_1fr_1fr_96px] items-center gap-3 border-b border-[var(--pbl-border)] px-5 py-4 last:border-b-0">
      <FileBadge type={type} />
      <div>
        <div className="font-bold text-[var(--pbl-text-strong)]">{title}</div>
        <div className="mt-1 text-[13px] text-[var(--pbl-text-muted)]">{rule}</div>
      </div>
      <div className="truncate text-[13px] font-medium text-[var(--pbl-text)]">
        {file ?? "点击上传或拖拽文件"}
      </div>
      <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-[var(--pbl-success)]">
        <CheckCircle2 size={14} /> {status}
      </span>
    </div>
  );
}

export function ActivityFeed({
  items,
}: {
  items: { id?: string; time?: string; actor: string; action: string; detail?: string }[];
}) {
  return (
    <div className="space-y-4">
      {items.map((item, index) => (
        <div className="relative flex gap-3" key={item.id ?? `${item.actor}-${index}`}>
          <span
            className={cn(
              "mt-1.5 h-2.5 w-2.5 rounded-full",
              index === 0 ? "bg-[var(--pbl-success)]" : "bg-[var(--pbl-border-strong)]",
            )}
          />
          {index < items.length - 1 ? (
            <div className="absolute left-[4px] top-6 h-8 w-px bg-[var(--pbl-border)]" />
          ) : null}
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-[var(--pbl-text-strong)]">
              {item.time ? `${item.time}　` : null}
              {item.actor} {item.action}
            </div>
            {item.detail ? <div className="mt-1 text-[13px] text-[var(--pbl-text-muted)]">{item.detail}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ResourceList({
  resources,
}: {
  resources: { type: string; title: string; meta: string }[];
}) {
  return (
    <div className="space-y-2">
      {resources.map((resource) => (
        <button
          className="flex w-full items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-3 py-2.5 text-left transition hover:border-[var(--pbl-teacher-border)] hover:bg-[var(--pbl-teacher-soft)]"
          key={resource.title}
          type="button"
        >
          <FileBadge type={resource.type} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-[var(--pbl-text-strong)]">
              {resource.title}
            </span>
            <span className="mt-0.5 block text-xs text-[var(--pbl-text-muted)]">{resource.meta}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function EmptyHint({ text }: { text: string }) {
  return (
    <div className="pbl-dot-grid grid place-items-center rounded-[var(--radius-sm)] border border-dashed border-[var(--pbl-border-strong)] bg-[var(--pbl-surface-soft)]/40 py-10 text-center text-sm text-[var(--pbl-text-muted)]">
      <Bot className="mb-2 text-[var(--pbl-text-subtle)]" size={22} />
      {text}
    </div>
  );
}

export function RubricScoreTable({
  rows,
}: {
  rows: { name: string; weight: number; score: number }[];
}) {
  return (
    <table className="w-full border-collapse text-left text-sm">
      <thead className="bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-muted)]">
        <tr>
          <th className="p-3 font-semibold">评分维度</th>
          <th className="p-3 font-semibold">权重</th>
          <th className="p-3 font-semibold">得分</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr className="border-b border-[var(--pbl-border)] last:border-b-0" key={row.name}>
            <td className="p-3 font-semibold text-[var(--pbl-text)]">{row.name}</td>
            <td className="p-3 text-[var(--pbl-text-muted)]">{row.weight}%</td>
            <td className="p-3 font-bold text-[var(--pbl-teacher)]">{row.score}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type ProgressTone = "blue" | "green" | "orange" | "red" | "slate" | "violet" | "teal";

export function ProgressBar({
  value,
  tone = "blue",
  className,
}: {
  value: number;
  tone?: ProgressTone;
  className?: string;
}) {
  const colors: Record<ProgressTone, string> = {
    blue: "bg-[var(--pbl-teacher)]",
    violet: "bg-[var(--pbl-ai)]",
    teal: "bg-[var(--pbl-student)]",
    green: "bg-[var(--pbl-success)]",
    orange: "bg-[var(--pbl-accent)]",
    red: "bg-[var(--pbl-danger)]",
    slate: "bg-slate-500",
  };
  return (
    <div className={cn("h-2 rounded-full bg-[var(--pbl-surface-soft)]", className)}>
      <div
        className={cn("h-full rounded-full transition-all", colors[tone])}
        style={{ width: `${Math.max(0, Math.min(value, 100))}%` }}
      />
    </div>
  );
}

export function CircularProgress({
  value,
  label,
  size = 128,
  tone = "#1d4ed8",
}: {
  value: number;
  label?: string;
  size?: number;
  tone?: string;
}) {
  const style = {
    "--progress": `${value * 3.6}deg`,
    "--tone": tone,
    width: size,
    height: size,
  } as CSSProperties;

  return (
    <div
      className="grid place-items-center rounded-full bg-[conic-gradient(var(--tone)_var(--progress),var(--pbl-surface-soft)_0)] p-1.5"
      style={style}
    >
      <div className="grid h-full w-full place-items-center rounded-full bg-[var(--pbl-surface)] text-center">
        <div>
          <div className="text-2xl font-bold leading-none text-[var(--pbl-text-strong)]">
            {value}%
          </div>
          {label ? (
            <div className="mt-1.5 text-[13px] font-medium text-[var(--pbl-text-muted)]">
              {label}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* 指标卡：用于仪表盘统计 */
export function Metric({
  icon,
  label,
  value,
  helper,
  tone = "blue",
}: {
  icon?: ReactNode;
  label: string;
  value: ReactNode;
  helper?: string;
  tone?: "blue" | "teal" | "amber" | "rose" | "slate";
}) {
  const toneMap = {
    blue: "bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]",
    teal: "bg-[var(--pbl-student-soft)] text-[var(--pbl-student)]",
    amber: "bg-[var(--pbl-warning-soft)] text-[var(--pbl-warning)]",
    rose: "bg-[var(--pbl-danger-soft)] text-[var(--pbl-danger)]",
    slate: "bg-[var(--pbl-surface-soft)] text-[var(--pbl-text)]",
  };
  return (
    <div className="flex min-w-0 items-center gap-3">
      {icon ? (
        <div className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-sm)]", toneMap[tone])}>
          {icon}
        </div>
      ) : null}
      <div className="min-w-0">
        <div className="text-[13px] text-[var(--pbl-text-muted)]">{label}</div>
        <div className="mt-0.5 text-xl font-bold text-[var(--pbl-text-strong)]">{value}</div>
        {helper ? <div className="text-xs text-[var(--pbl-text-subtle)]">{helper}</div> : null}
      </div>
    </div>
  );
}

export function FileBadge({ type }: { type: string }) {
  const label = courseResourceTypeLabel(type);
  const tone =
    label === "PDF"
      ? "bg-[var(--pbl-danger)]"
      : label === "Excel"
        ? "bg-[var(--pbl-success)]"
        : label === "PPT"
          ? "bg-[var(--pbl-accent)]"
          : label === "视频"
            ? "bg-[var(--pbl-ai)]"
            : "bg-[var(--pbl-teacher)]";

  return (
    <span
      className={cn(
        "grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-sm)] text-[11px] font-bold text-white",
        tone,
      )}
    >
      {label}
    </span>
  );
}

/* 角色色辅助：返回当前角色应使用的主色 token */
export function roleColor(role: Role): string {
  return role === "teacher" ? "var(--pbl-teacher)" : role === "student" ? "var(--pbl-student)" : "var(--pbl-ai)";
}

// OPENPBL_DEV_ENTRY: v2 components are exported here so legacy imports can be
// migrated incrementally without duplicating page-level Tailwind recipes.
export { Button } from "@/components/ui/button";
export { FormField, Input, NativeSelect, Textarea } from "@/components/ui/form";
export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTrigger,
} from "@/components/ui/overlays";
export { FlowActionBar, PageState, SaveStatus } from "@/components/ui/states";
export { toast } from "@/components/ui/feedback";
