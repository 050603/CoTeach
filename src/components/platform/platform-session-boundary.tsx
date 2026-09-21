"use client";

import "./platform.css";
import "./desktop-layout.css";
import "./mobile-layout.css";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session/store";

/** Course-platform pages use their own authenticated API, while classroom
 * implementation routes retain their existing session provider. */
export function PlatformSessionBoundary({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/internal/slide-layout-audit") return children;
  const platformPage = pathname === "/student" || pathname === "/student/profile" || pathname === "/teacher" ||
    ["/student/login", "/student/register", "/student/reset-password", "/student/courses", "/student/activities", "/student/participations", "/teacher/participations", "/teacher/classrooms", "/teacher/classes", "/teacher/surveys", "/teacher/templates", "/teacher/textbooks", "/teacher/login", "/teacher/register"].some((path) => pathname === path || pathname.startsWith(`${path}/`));
  if (pathname === "/teacher/settings" || pathname.startsWith("/teacher/settings/")) {
    return <SessionProvider><div className="pbl-platform-theme">{children}</div></SessionProvider>;
  }
  return platformPage ? <div className="pbl-platform-theme">{children}</div> : <SessionProvider>{children}</SessionProvider>;
}
