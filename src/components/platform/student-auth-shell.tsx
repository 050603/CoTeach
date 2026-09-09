import { LearningArt } from "./learning-art";
import Link from "next/link";
import { ArrowLeft, BookOpen, Compass, FolderCheck, UsersRound } from "lucide-react";
import type { ReactNode } from "react";
import { PraixisLogo } from "@/components/brand/praixis-logo";

export function StudentAuthShell({ title, description, children, mode }: {
  title: string; description: string; children: ReactNode; mode?: "login" | "register";
}) {
  return <main className="pbl-platform-page pbl-platform-page-student min-h-screen text-[var(--pbl-text)]">
    <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5"><Link href="/" className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--pbl-text-muted)]"><ArrowLeft size={16}/>返回首页</Link><span className="text-xs text-[var(--pbl-text-muted)]">PrAIxis · 学生学习空间</span></div>
    <div className="pbl-auth-layout">
      <aside className="pbl-auth-story"><LearningArt />
        <PraixisLogo variant="horizontalSolid" height={34}/>
        <div><span className="pbl-auth-eyebrow"><Compass size={16}/>每一次探索，都从这里开始</span></div>
        <h2>带着好奇出发，<br/>让想法成为作品。</h2>
        <p>在课程中发现问题，在课堂中连接知识。和同伴、AI 一起实践，留下属于你的学习成果。</p>
        <div className="pbl-auth-journey">
          <div><BookOpen size={19}/><span><strong>课程有序展开</strong><small>章节、课堂与任务，一处轻松掌握</small></span></div>
          <div><UsersRound size={19}/><span><strong>一起解决真实问题</strong><small>进入课堂，接续每一次协作与探索</small></span></div>
          <div><FolderCheck size={19}/><span><strong>让成长有迹可循</strong><small>保存作品与反馈，积累你的学习历程</small></span></div>
        </div>
      </aside>
      <section className="pbl-platform-panel pbl-auth-form">
        {mode && <nav aria-label="学生账号" className="mb-8 flex gap-2 rounded-xl bg-[var(--pbl-surface-soft)] p-1">{([['login','登录'],['register','注册']] as const).map(([value,label]) => <Link key={value} href={`/student/${value}`} aria-current={mode === value ? 'page' : undefined} className={`inline-flex min-h-11 flex-1 items-center justify-center rounded-lg text-sm ${mode === value ? 'bg-white font-semibold text-[var(--pbl-student)] shadow-sm' : 'text-[var(--pbl-text-muted)]'}`}>{label}</Link>)}</nav>}
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--pbl-text-strong)]">{title}</h1>
        <p className="mt-3 text-sm leading-7 text-[var(--pbl-text-muted)]">{description}</p>
        {children}
      </section>
    </div>
  </main>;
}
