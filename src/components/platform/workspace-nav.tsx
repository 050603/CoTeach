"use client";

import Link from "next/link";
import { ArrowLeft, BookOpen, Layers3, Settings2 } from "lucide-react";
import { usePathname } from "next/navigation";
import { PraixisLogo } from "@/components/brand/praixis-logo";

type WorkspaceNavProps = {
  role: "teacher" | "student";
  active?: "classes" | "templates" | "settings";
  backHref?: string;
  backLabel?: string;
};

function defaultBackTarget(pathname: string, role: WorkspaceNavProps["role"]) {
  if (role === "student") {
    if (pathname === "/student") return { href: "/", label: "返回平台首页" };
    return { href: "/student?all=1", label: "返回我的课程" };
  }

  if (pathname.startsWith("/teacher/templates/") || pathname.startsWith("/teacher/teach/")) {
    return { href: "/teacher/templates", label: "返回课程库" };
  }
  if (pathname === "/teacher/templates" || pathname === "/teacher/settings") {
    return { href: "/teacher/classes", label: "返回课程系列" };
  }
  const memberPage = pathname.match(/^\/teacher\/classes\/([^/]+)\/students$/);
  if (memberPage) {
    return { href: `/teacher/classes/${memberPage[1]}`, label: "返回课程" };
  }
  if (pathname.startsWith("/teacher/classes/") || pathname.startsWith("/teacher/classrooms/") || pathname.startsWith("/teacher/participations/")) {
    return { href: "/teacher/classes", label: "返回课程系列" };
  }
  return { href: "/", label: "返回平台首页" };
}

export function WorkspaceNav({ role, active = "classes", backHref, backLabel }: WorkspaceNavProps) {
  const pathname = usePathname();
  const teacher = role === "teacher";
  const defaultBack = defaultBackTarget(pathname, role);
  const back = { href: backHref ?? defaultBack.href, label: backLabel ?? defaultBack.label };
  const items = teacher ? [
    { href: "/teacher/classes", label: "课程系列", icon: Layers3, description: "组织教学与学习任务" },
    { href: "/teacher/templates", label: "课程库", icon: BookOpen, description: "积累可复用的好课" },
  ] : [{ href: "/student?all=1", label: "我的课程", icon: BookOpen, description: "接续你的学习旅程" }];
  return <aside className="pbl-workspace-nav">
    <Link href={teacher ? "/teacher/classes" : "/student?all=1"} className="pbl-workspace-brand" aria-label="PrAIxis"><PraixisLogo variant="horizontalSolid" height={38} priority /></Link>
    <Link href={back.href} className="pbl-workspace-back"><ArrowLeft size={17}/><span>{back.label}</span></Link>
    <p className="pbl-nav-caption">{teacher ? "教学管理" : "学习中心"}</p>
    <nav aria-label={teacher ? "教师导航" : "学生导航"}>
      {items.map(({ href, label, icon: Icon, description }) => <Link key={href} href={href} aria-current={(!teacher || href === `/teacher/${active}`) ? "page" : undefined} className="pbl-workspace-nav-link"><Icon size={19}/><span>{label}<small>{description}</small></span></Link>)}
    </nav>
    <div className="pbl-workspace-nav-bottom">
      <div className="pbl-workspace-note"><span>让学习真正发生</span><p>{teacher ? "将一堂好课，连接成一段完整的学习旅程。" : "带着问题出发，在每一次实践中积累成长。"}</p></div>
      {teacher && <Link href="/teacher/settings" aria-current={active === "settings" ? "page" : undefined} className="pbl-workspace-nav-link"><Settings2 size={18}/><span>AI 设置</span></Link>}
    </div>
  </aside>;
}
