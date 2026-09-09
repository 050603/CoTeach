import type { ReactNode } from "react";
import { WorkspaceNav } from "./workspace-nav";

type TeacherPlatformHeaderProps = {
  active?: "classes" | "templates" | "settings";
  /** @deprecated Breadcrumb content is retained for call-site compatibility. Use backHref/backLabel. */
  leading?: ReactNode;
  backHref?: string;
  backLabel?: string;
};

export function TeacherPlatformHeader({ active, backHref, backLabel }: TeacherPlatformHeaderProps) {
  return <WorkspaceNav role="teacher" active={active} backHref={backHref} backLabel={backLabel} />;
}

export function TeacherPlatformPage({ children }: { children: ReactNode }) {
  return <main className="pbl-platform-page pbl-workspace min-h-screen text-[var(--pbl-text)]">{children}</main>;
}
