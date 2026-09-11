"use client";

import Link from "next/link";
import { ArrowLeft, BookOpen, ChevronDown, Layers3, LogOut, Settings2, UserPlus } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { PraixisLogo } from "@/components/brand/praixis-logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type WorkspaceNavProps = {
  role: "teacher" | "student";
  active?: "classes" | "templates" | "settings";
  backHref?: string;
  backLabel?: string;
  compact?: boolean;
};

type TeacherIdentity = {
  displayName: string;
  username: string;
};

export function WorkspaceAccountMenu({
  role,
  fallbackDisplayName,
}: {
  role: "teacher" | "student";
  fallbackDisplayName?: string;
}) {
  const teacher = role === "teacher";
  const [identity, setIdentity] = useState<TeacherIdentity | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [accountError, setAccountError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch(teacher ? "/api/auth/me" : "/api/platform/auth/student-profile", {
      cache: "no-store",
      headers: { "X-OpenPBL-Role": role },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) return;
      const data = await response.json() as { user?: { role?: string; displayName?: string; username?: string } | null };
      if (data.user?.role === role) {
        setIdentity({ displayName: data.user.displayName || (teacher ? "教师" : "学生"), username: data.user.username || "" });
      }
    }).catch(() => undefined);
    const updateIdentity = (event: Event) => {
      const detail = (event as CustomEvent<TeacherIdentity>).detail;
      if (detail?.displayName) setIdentity(detail);
    };
    if (teacher) window.addEventListener("teacher-profile-updated", updateIdentity);
    return () => {
      controller.abort();
      window.removeEventListener("teacher-profile-updated", updateIdentity);
    };
  }, [teacher, role]);

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setAccountError("");
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "X-OpenPBL-Role": role },
      });
      if (!response.ok) throw new Error("退出失败");
      window.location.assign(teacher ? "/teacher/login" : "/student/login");
    } catch {
      setAccountError("退出失败，请重试");
      setLoggingOut(false);
    }
  }

  const displayName = identity?.displayName || fallbackDisplayName || (teacher ? "教师" : "学生");

  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" className="pbl-teacher-account-trigger" data-role={role} aria-label={`${teacher ? "教师账号" : "学生个人中心"}：${displayName}`}>
        <span className="pbl-teacher-account-avatar" aria-hidden="true">{displayName.trim().charAt(0)}</span>
        <span className="pbl-teacher-account-copy"><strong>{displayName}</strong><small>{identity?.username ? `@${identity.username}` : (teacher ? "教师账号" : "个人中心")}</small></span>
        <ChevronDown size={15}/>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" sideOffset={8} data-role={role} className="pbl-platform-theme pbl-teacher-account-menu w-64">
      <DropdownMenuLabel className="pbl-teacher-account-label">
        <span className="pbl-teacher-account-avatar" aria-hidden="true">{displayName.trim().charAt(0)}</span>
        <span><strong>{displayName}</strong><small>{identity?.username ? `账号：${identity.username}` : (teacher ? "当前登录的教师账号" : "当前登录的学生账号")}</small></span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator/>
      <DropdownMenuItem asChild><Link href={teacher ? "/teacher/settings" : "/student/profile"}><Settings2/>个人中心</Link></DropdownMenuItem>
      {teacher && <DropdownMenuItem asChild><Link href="/teacher/register"><UserPlus/>创建教师账号</Link></DropdownMenuItem>}
      <DropdownMenuSeparator/>
      {accountError ? <p role="alert" className="px-2 py-1.5 text-xs text-[var(--pbl-danger)]">{accountError}</p> : null}
      <DropdownMenuItem variant="destructive" disabled={loggingOut} onSelect={(event) => { event.preventDefault(); void logout(); }}><LogOut/>{loggingOut ? "正在退出…" : "退出登录"}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

function defaultBackTarget(pathname: string, role: WorkspaceNavProps["role"]) {
  if (role === "student") {
    if (pathname === "/student") return { href: "/", label: "返回平台首页" };
    return { href: "/student?all=1", label: "返回我的课程" };
  }

  if (pathname.startsWith("/teacher/templates/") || pathname.startsWith("/teacher/teach/")) {
    return { href: "/teacher/templates", label: "返回课程库" };
  }
  if (pathname === "/teacher/templates" || pathname === "/teacher/settings") {
    return { href: "/teacher/classes", label: "返回教学班" };
  }
  const memberPage = pathname.match(/^\/teacher\/classes\/([^/]+)\/students$/);
  if (memberPage) {
    return { href: `/teacher/classes/${memberPage[1]}`, label: "返回课程" };
  }
  if (pathname.startsWith("/teacher/classes/") || pathname.startsWith("/teacher/classrooms/") || pathname.startsWith("/teacher/participations/")) {
    return { href: "/teacher/classes", label: "返回教学班" };
  }
  return { href: "/", label: "返回平台首页" };
}

export function WorkspaceNav({ role, active = "classes", backHref, backLabel, compact = false }: WorkspaceNavProps) {
  const pathname = usePathname();
  const teacher = role === "teacher";
  const defaultBack = defaultBackTarget(pathname, role);
  const back = { href: backHref ?? defaultBack.href, label: backLabel ?? defaultBack.label };
  const items = teacher ? [
    { href: "/teacher/classes", label: "教学班", icon: Layers3, id: "classes" },
    { href: "/teacher/templates", label: "课程库", icon: BookOpen, id: "templates" },
  ] : [{ href: "/student?all=1", label: "我的课程", icon: BookOpen, id: "classes" }];
  return <header className="pbl-platform-topbar" data-role={role} data-compact={compact || undefined}>
    <div className="pbl-platform-topbar-inner">
      <div className="pbl-platform-topbar-context">
        <Link href={teacher ? "/teacher/classes" : "/student?all=1"} className="pbl-workspace-brand" aria-label="PrAIxis"><PraixisLogo variant="horizontalSolid" height={38} priority /></Link>
        <span className="pbl-platform-topbar-divider" aria-hidden="true" />
        <Link href={back.href} className="pbl-workspace-back"><ArrowLeft size={17}/><span>{back.label}</span></Link>
      </div>
      <div className="pbl-platform-topbar-actions">
        <nav aria-label={teacher ? "教师导航" : "学生导航"}>
          {items.map(({ href, label, icon: Icon, id }) => <Link key={href} href={href} aria-current={(teacher ? id === active : pathname !== "/student/profile") ? "page" : undefined} className="pbl-workspace-nav-link"><Icon size={16}/><span>{label}</span></Link>)}
        </nav>
        <WorkspaceAccountMenu role={role} />
      </div>
    </div>
  </header>;
}
