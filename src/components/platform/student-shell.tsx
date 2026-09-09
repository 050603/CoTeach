import { LearningArt } from "./learning-art";
import Image from "next/image";
import type { ReactNode } from "react";
import { WorkspaceNav } from "./workspace-nav";

export function StudentShell({ children, focus = false, backHref, backLabel }: { children: ReactNode; focus?: boolean; backHref?: string; backLabel?: string }) {
  if (focus) {
    return <main className="pbl-platform-page-student min-h-screen text-[var(--pbl-text)]"><div className="mx-auto min-h-screen w-full">{children}</div></main>;
  }
  return (
    <main className="pbl-platform-page pbl-platform-page-student pbl-workspace min-h-screen text-[var(--pbl-text)]">
      <WorkspaceNav role="student" backHref={backHref} backLabel={backLabel} />
      <div className="pbl-workspace-content">{children}</div>
    </main>
  );
}

export const studentInput =
  "mt-2 min-h-11 w-full rounded-[6px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pbl-student)]";
export const studentPrimary =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[6px] bg-[var(--pbl-student)] px-5 text-sm font-semibold text-white disabled:opacity-50";
export function courseDate(value?: string | null) {
  if (!value) return "待教师公布";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "待教师公布"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(date);
}
export function CourseCover({
  url,
  name,
  className = "",
}: {
  url?: string | null;
  name: string;
  className?: string;
}) {
  return url ? (
    <div className={`relative overflow-hidden bg-[var(--pbl-student-soft)] ${className}`}>
      <Image
        src={url}
        alt={`${name}课程封面`}
        fill
        unoptimized
        className="object-cover"
      />
    </div>
  ) : (
    <div
      className={`relative flex flex-col justify-between overflow-hidden pbl-course-cover p-7 text-[var(--pbl-student)] ${className}`}
    >
      <LearningArt /><span className="text-[10px] tracking-[0.15em]">探索 · 实践 · 成长</span>
      <span aria-hidden="true" className="h-10" />
      <p className="max-w-[20ch] font-serif text-xl leading-relaxed">{name}</p>
    </div>
  );
}
