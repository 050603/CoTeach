import { LearningArt } from "./learning-art";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, BookOpen, Layers3, Presentation } from "lucide-react";
import { PraixisLogo } from "@/components/brand/praixis-logo";

export function TeacherAuthShell({ children }: { children: ReactNode }) {
  return <main className="pbl-platform-page min-h-screen text-[var(--pbl-text)]">
    <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5"><Link href="/" className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--pbl-text-muted)]"><ArrowLeft size={16}/>返回首页</Link><Link href="/teacher/login" className="inline-flex min-h-11 items-center text-xs text-[var(--pbl-text-muted)]">教师工作空间</Link></div>
    <div className="pbl-auth-layout">
      <aside className="pbl-auth-story pbl-auth-story-teacher"><LearningArt /><PraixisLogo variant="horizontalSolid" height={34}/><div><span className="pbl-auth-eyebrow">为每一次教学，留出更多可能</span></div><h2>从一堂好课，<br/>到一段成长旅程。</h2><p>将课程设计、教学安排与学生学习连接起来，在同一个工作空间，从容组织每一次实践。</p><div className="pbl-auth-journey"><div><BookOpen size={19}/><span><strong>设计与积累</strong><small>把教学想法沉淀为可复用的课程</small></span></div><div><Layers3 size={19}/><span><strong>编排与组织</strong><small>按章节串联课堂、问卷、作业与资料</small></span></div><div><Presentation size={19}/><span><strong>授课与陪伴</strong><small>进入课堂，关注学生的每一次推进</small></span></div></div></aside>
      {children}
    </div>
  </main>;
}
