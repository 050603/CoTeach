import Link from "next/link";
import { ArrowUpRight, BookOpen, GraduationCap, Layers3, Settings2 } from "lucide-react";
import { PraixisLogo } from "@/components/brand/praixis-logo";

export function WorkspaceNav({ role, active = "classes" }: { role: "teacher" | "student"; active?: "classes" | "templates" | "settings" }) {
  const teacher = role === "teacher";
  const items = teacher ? [
    { href: "/teacher/classes", label: "课程系列", icon: Layers3, description: "组织教学与学习任务" },
    { href: "/teacher/templates", label: "课程库", icon: BookOpen, description: "积累可复用的好课" },
  ] : [{ href: "/student?all=1", label: "我的课程", icon: BookOpen, description: "接续你的学习旅程" }];
  return <aside className="pbl-workspace-nav">
    <Link href={teacher ? "/teacher/classes" : "/student?all=1"} className="pbl-workspace-brand" aria-label={`PrAIxis ${teacher ? "教师工作空间" : "学生学习空间"}`}><PraixisLogo variant="horizontalSolid" height={29} /></Link>
    <div className="pbl-workspace-role"><GraduationCap size={16}/>{teacher ? "教师工作空间" : "学生学习空间"}</div>
    <p className="pbl-nav-caption">{teacher ? "教学管理" : "学习中心"}</p>
    <nav aria-label={teacher ? "教师导航" : "学生导航"}>
      {items.map(({ href, label, icon: Icon, description }) => <Link key={href} href={href} aria-current={(!teacher || href === `/teacher/${active}`) ? "page" : undefined} className="pbl-workspace-nav-link"><Icon size={19}/><span>{label}<small>{description}</small></span></Link>)}
    </nav>
    <div className="pbl-workspace-nav-bottom">
      <div className="pbl-workspace-note"><span>让学习真正发生</span><p>{teacher ? "将一堂好课，连接成一段完整的学习旅程。" : "带着问题出发，在每一次实践中积累成长。"}</p></div>
      {teacher && <Link href="/teacher/settings" aria-current={active === "settings" ? "page" : undefined} className="pbl-workspace-nav-link"><Settings2 size={18}/><span>AI 设置</span></Link>}
      <Link href="/" className="pbl-workspace-nav-link"><ArrowUpRight size={18}/><span>平台首页</span></Link>
    </div>
  </aside>;
}
