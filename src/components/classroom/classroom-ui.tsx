"use client";

import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import { ArrowLeft, CheckCircle2, CircleAlert, Clock3 } from "lucide-react";
import { CoTeachLogoMark } from "@/components/brand/coteach-logo";
import { cn } from "@/lib/utils";

type Role = "teacher" | "student";
type StageTone = "teacher" | "student" | "neutral" | "warning";

const toneClasses: Record<StageTone, { accent: string; soft: string; border: string }> = {
  teacher: {
    accent: "text-[var(--pbl-teacher)]",
    soft: "bg-[var(--pbl-teacher-soft)]",
    border: "border-[var(--pbl-teacher-border)]",
  },
  student: {
    accent: "text-[var(--pbl-student)]",
    soft: "bg-[var(--pbl-student-soft)]",
    border: "border-[var(--pbl-student-border)]",
  },
  neutral: {
    accent: "text-[var(--pbl-text-muted)]",
    soft: "bg-[var(--pbl-surface-soft)]",
    border: "border-[var(--pbl-border)]",
  },
  warning: {
    accent: "text-[var(--pbl-warning)]",
    soft: "bg-[var(--pbl-warning-soft)]",
    border: "border-[var(--pbl-warning-border)]",
  },
};

export function StagePageHeader({
  title,
  description,
  status,
  action,
  variant = "plain",
}: {
  title: string;
  description?: string;
  status?: ReactNode;
  action?: ReactNode;
  variant?: "plain" | "student-card";
}) {
  return (
    <header className={cn("classroom-stage-header", variant === "student-card" && "classroom-stage-header--student-card")}>
      <div className="relative z-10 min-w-0">
        {variant === "student-card" ? <p className="classroom-eyebrow mb-2 text-[var(--pbl-student)]">当前学习任务</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="classroom-stage-title">{title}</h1>
          {status ? <span className="shrink-0">{status}</span> : null}
        </div>
        {description ? <p className="classroom-stage-description">{description}</p> : null}
      </div>
      {action ? <div className="relative z-10 shrink-0">{action}</div> : null}
    </header>
  );
}

export function StageSplitLayout({
  main,
  aside,
  className,
  asideClassName,
}: {
  main: ReactNode;
  aside: ReactNode;
  className?: string;
  asideClassName?: string;
}) {
  return (
    <div className={cn("classroom-split-layout", className)}>
      <div className="min-w-0">{main}</div>
      <aside className={cn("classroom-split-aside", asideClassName)}>{aside}</aside>
    </div>
  );
}

export function StageEmptyState({
  icon: Icon = CircleAlert,
  eyebrow,
  title,
  description,
  action,
  tone = "neutral",
  className,
}: {
  icon?: ComponentType<{ size?: number; className?: string }>;
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
  tone?: StageTone;
  className?: string;
}) {
  const colors = toneClasses[tone];
  return (
    <section className={cn("classroom-empty-state", colors.border, className)}>
      <span className={cn("classroom-empty-icon", colors.soft, colors.accent)}>
        <Icon size={22} />
      </span>
      {eyebrow ? <p className={cn("classroom-eyebrow mt-4", colors.accent)}>{eyebrow}</p> : null}
      <h2 className="mt-2 text-lg font-semibold text-[var(--pbl-text-strong)]">{title}</h2>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-[var(--pbl-text-muted)]">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </section>
  );
}

export function ClassroomContextHeader({
  role,
  courseName,
  stageLabel,
  stageIndex,
  totalStages,
  status,
  userName,
  homeHref,
  leadingAction,
  showBackButton = true,
  actions,
}: {
  role: Role;
  courseName: string;
  stageLabel: string;
  stageIndex?: number;
  totalStages?: number;
  status?: ReactNode;
  userName?: string;
  homeHref: string;
  leadingAction?: ReactNode;
  showBackButton?: boolean;
  actions?: ReactNode;
}) {
  const roleColor = role === "teacher" ? "var(--pbl-teacher)" : "var(--pbl-student)";
  return (
    <header className="classroom-context-header">
      <div className="classroom-context-inner pbl-wide-container">
        <div className="flex min-w-0 items-center gap-3">
          {showBackButton ? (leadingAction ?? (
            <Link aria-label="返回课堂" className="classroom-icon-button" href={homeHref}>
              <ArrowLeft size={17} />
            </Link>
          )) : null}
          <Link className="flex min-w-0 items-center gap-2.5" href={homeHref}>
            <span className="relative grid size-8 shrink-0 place-items-center">
              <CoTeachLogoMark size={30} />
              <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-white" style={{ backgroundColor: roleColor }} />
            </span>
            <span className="hidden min-w-0 sm:block">
              <span className="block text-sm font-bold tracking-tight text-[var(--pbl-text-strong)]">CoTeach</span>
              <span className="block max-w-64 truncate text-xs text-[var(--pbl-text-muted)]">{courseName}</span>
            </span>
          </Link>
          <span className="h-7 w-px bg-[var(--pbl-border)]" />
          <div className="min-w-0">
            <p className="truncate text-[11px] font-medium text-[var(--pbl-text-muted)]">{stageIndex !== undefined && totalStages ? `阶段 ${stageIndex + 1}/${totalStages}` : "课堂"}</p>
            <p className="truncate text-sm font-semibold text-[var(--pbl-text-strong)]">{stageLabel}</p>
          </div>
          {status ? <span className="hidden shrink-0 md:inline-flex">{status}</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          {userName ? <span className="hidden max-w-28 truncate text-xs font-medium text-[var(--pbl-text-muted)] lg:inline">{userName}</span> : null}
        </div>
      </div>
    </header>
  );
}

export function ClassroomStatus({
  state,
  label,
}: {
  state: "active" | "complete" | "waiting" | "attention";
  label: string;
}) {
  const tone = state === "complete" ? "green" : state === "attention" ? "amber" : state === "active" ? "blue" : "gray";
  const Icon = state === "complete" ? CheckCircle2 : state === "waiting" ? Clock3 : undefined;
  return (
    <span className={cn(
      "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold ring-1",
      tone === "green" && "bg-[var(--pbl-success-soft)] text-[var(--pbl-success)] ring-[var(--pbl-success-border)]",
      tone === "amber" && "bg-[var(--pbl-warning-soft)] text-[var(--pbl-warning)] ring-[var(--pbl-warning-border)]",
      tone === "blue" && "bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)] ring-[var(--pbl-teacher-border)]",
      tone === "gray" && "bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-muted)] ring-[var(--pbl-border)]",
    )}>
      {Icon ? <Icon size={13} /> : <span className="size-1.5 rounded-full bg-current" />}
      {label}
    </span>
  );
}
