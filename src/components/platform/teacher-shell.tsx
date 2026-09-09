import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRight, GraduationCap } from "lucide-react";
import { WorkspaceNav } from "./workspace-nav";

export function TeacherPlatformHeader({ active, leading }: { active?: "classes" | "templates" | "settings"; leading?: ReactNode }) {
  return <>
    <WorkspaceNav role="teacher" active={active} />
    <header className="pbl-platform-topbar pbl-workspace-topbar">
      <div className="flex min-h-18 flex-wrap items-center justify-between gap-3 px-5 py-3 lg:px-10">
        <div className="flex min-w-0 items-center gap-3 text-sm text-[var(--pbl-text-muted)]">{leading ?? <><Link href="/teacher/classes">教学工作台</Link><ChevronRight size={14}/><span className="font-medium text-[var(--pbl-text)]">{active === "settings" ? "AI 服务设置" : active === "templates" ? "课程库" : "课程系列"}</span></>}</div>
        <span className="inline-flex items-center gap-2 text-xs text-[var(--pbl-text-muted)]"><span className="grid size-8 place-items-center rounded-full bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]"><GraduationCap size={17}/></span>教师端</span>
      </div>
    </header>
  </>;
}

export function TeacherPlatformPage({ children }: { children: ReactNode }) {
  return <main className="pbl-platform-page pbl-workspace min-h-screen text-[var(--pbl-text)]">{children}</main>;
}
