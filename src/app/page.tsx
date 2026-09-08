import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  ClipboardCheck,
  Flag,
  GraduationCap,
  Layers,
  PenTool,
  Presentation,
  RotateCw,
  UsersRound,
} from "lucide-react";
import { PraixisLogo } from "@/components/brand/praixis-logo";
import { BrandOriginStory } from "@/components/home/brand-origin-story";
import { CosmicReveal } from "@/components/home/cosmic-reveal";
const NEW_STAGES = [
  {
    key: "launch",
    label: "项目启动",
    icon: Flag,
    desc: "教师发布驱动问题，学生确认项目方向与成果要求",
    gradient: "from-slate-700 to-slate-900",
    color: "#1c1917",
  },
  {
    key: "ai-learning",
    label: "知识讲授",
    icon: BookOpen,
    desc: "分节讲授核心知识，支持节末小测、AI 批阅与助教讲解",
    gradient: "from-indigo-500 to-violet-600",
    color: "#6366f1",
  },
  {
    key: "make",
    label: "项目实践",
    icon: PenTool,
    desc: "学生在文档或代码工作台与 AI 组员协作完成真实产物",
    gradient: "from-emerald-500 to-teal-500",
    color: "#10b981",
  },
  {
    key: "showcase",
    label: "成果汇报与评价",
    icon: Presentation,
    desc: "教师通过资源与投屏组织成果汇报和课堂评价",
    gradient: "from-orange-500 to-amber-500",
    color: "#f97316",
  },
  {
    key: "reflection",
    label: "学习反思",
    icon: RotateCw,
    desc: "通过教师资源与课堂引导完成学习回顾",
    gradient: "from-purple-500 to-fuchsia-500",
    color: "#a855f7",
  },
] as const;

const FEATURES = [
  {
    icon: Layers,
    title: "贯通每一步",
    desc: "从驱动问题到成果反思，课程设计、课堂组织与学习证据在同一条实践链路中持续流动。",
    points: ["五阶段清晰衔接", "文档与代码形成真实产物", "每一步都可回看、可延续"],
    accent: "from-indigo-50 to-violet-50",
    iconBg: "from-indigo-500 to-violet-600",
  },
  {
    icon: BookOpen,
    title: "更从容地备课",
    desc: "围绕真实问题设定主题与知识边界，由 AI 协助生成并打磨课程大纲、课堂内容与项目任务。",
    points: ["从真实问题组织课程", "AI 协助生成与打磨", "备课成果直接进入课堂"],
    accent: "from-amber-50 to-orange-50",
    iconBg: "from-amber-500 to-orange-500",
  },
  {
    icon: GraduationCap,
    title: "看见每一次推进",
    desc: "教师掌握课堂节奏与关键判断，AI 在讲授、答疑和过程支持中随时响应，学生进度清晰可见。",
    points: ["教师始终掌握课堂", "AI 在实践现场协同", "学习状态实时同步"],
    accent: "from-blue-50 to-cyan-50",
    iconBg: "from-blue-500 to-cyan-500",
  },
  {
    icon: ClipboardCheck,
    title: "让成长有据可循",
    desc: "把作品、反馈、过程证据与学习反思连接起来，让评价不仅指向结果，也照亮下一次实践。",
    points: ["作品与过程共同评价", "反馈推动持续迭代", "反思沉淀为可迁移经验"],
    accent: "from-emerald-50 to-teal-50",
    iconBg: "from-emerald-500 to-teal-500",
  },
] as const;

export default function Home() {
  return (
    <div className="min-h-screen bg-[var(--pbl-bg)] text-[var(--pbl-text)]">
      <SiteHeader />
      <Hero />
      <BrandOriginStory />
      <Features />
      <Workflow />
      <Entry />
      <SiteFooter />
    </div>
  );
}

/* ============================================================
   1. Header —— 玻璃顶栏
   ============================================================ */
function SiteHeader() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-[var(--pbl-border)] bg-[color-mix(in_srgb,var(--pbl-bg)_80%,transparent)] backdrop-blur-xl">
      <div className="pbl-wide-container flex min-h-16 items-center justify-between px-6 md:px-10">
        <Link
          href="/"
          className="flex items-center transition-opacity hover:opacity-80"
          aria-label="PrAIxis 首页"
        >
          <PraixisLogo variant="horizontalSolid" height={30} priority />
        </Link>
        <nav className="flex items-center gap-2 md:gap-3">
          <a
            href="#features"
            className="hidden rounded-full px-3 py-2 text-[13px] font-semibold text-[var(--pbl-text-muted)] transition-colors hover:bg-[var(--pbl-surface-soft)] hover:text-[var(--pbl-text-strong)] md:inline-block"
          >
            核心能力
          </a>
          <a
            href="#workflow"
            className="hidden rounded-full px-3 py-2 text-[13px] font-semibold text-[var(--pbl-text-muted)] transition-colors hover:bg-[var(--pbl-surface-soft)] hover:text-[var(--pbl-text-strong)] md:inline-block"
          >
            课堂流程
          </a>
          <Link
            href="/teacher"
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--pbl-border-strong)] bg-[var(--pbl-surface)] px-4 py-2 text-[13px] font-semibold text-[var(--pbl-text-strong)] transition-all hover:-translate-y-0.5 hover:border-[var(--pbl-teacher)] hover:text-[var(--pbl-teacher)] hover:shadow-md"
          >
            <GraduationCap size={14} />
            教师端
          </Link>
          <Link
            href="/student"
            className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-2 text-[13px] font-semibold text-white shadow-md shadow-indigo-500/25 transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-indigo-500/40"
          >
            <UsersRound size={14} />
            学生加入
          </Link>
        </nav>
      </div>
    </header>
  );
}

/* ============================================================
   2. Hero —— 亮色 + 渐变 blob + 巨型 Logo
   ============================================================ */
function Hero() {
  return (
    <section className="pbl-aurora-light relative min-h-screen pt-16">
      {/* 渐变光斑背景 */}
      <div className="pbl-aurora">
        <div className="pbl-aurora-3" />
      </div>
      <div className="pbl-grid-light" />
      <div className="pbl-dots-light" />

      {/* 主内容 */}
      <div className="pbl-wide-container relative z-10 flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center px-6 py-20 text-center md:px-10">
        {/* 顶部标签 */}
        <div
          className="pbl-hero-text mb-10 inline-flex items-center gap-2 rounded-full border border-[var(--pbl-border-strong)] bg-[var(--pbl-surface)]/80 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--pbl-text-muted)] backdrop-blur-sm"
          style={{ animationDelay: "0s" }}
        >
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-500 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-indigo-500" />
          </span>
          Praxis + AI · AI inside practice
        </div>

        {/* 巨型横版 Logo —— 不使用 pbl-hero-text（初始 opacity:0），避免动画卡住导致 logo 不可见 */}
        <div className="mb-10 pbl-float-soft">
          <PraixisLogo
            variant="horizontal"
            height={130}
            priority
            style={{ filter: "drop-shadow(0 16px 48px rgba(99, 102, 241, 0.25))" }}
          />
        </div>

        {/* 一句话定位 —— 渐变文字 */}
        <h1
          className="pbl-hero-text text-[length:clamp(2rem,5.5vw,4rem)] font-extrabold leading-[1.08] tracking-tight [text-wrap:balance]"
          style={{ animationDelay: "0.25s" }}
        >
          <span className="pbl-display-gradient">与 AI 一起实践，让学习真正发生</span>
        </h1>

        {/* 副标题 */}
        <p
          className="pbl-hero-text mt-7 max-w-3xl text-[16px] leading-7 text-[var(--pbl-text-muted)] md:text-[17px]"
          style={{ animationDelay: "0.4s" }}
        >
          AI 参与教学实践。学生在 AI 与教师共同指导下探究、设计、创作与反馈，并始终保有判断与行动，让学习真正发生。
        </p>

        {/* 双 CTA */}
        <div
          className="pbl-hero-text mt-10 flex flex-col items-center gap-3 sm:flex-row sm:gap-4"
          style={{ animationDelay: "0.55s" }}
        >
          <Link href="/teacher" className="pbl-cosmic-btn-primary">
            <GraduationCap size={16} />
            进入教师端
            <ArrowRight size={14} />
          </Link>
          <Link href="/student" className="pbl-cosmic-btn-ghost">
            <UsersRound size={16} />
            学生加入课堂
          </Link>
        </div>

      </div>

      {/* 滚动提示 */}
      <div className="absolute inset-x-0 bottom-6 z-10 flex justify-center">
        <div className="pbl-scroll-hint flex flex-col items-center gap-2 text-[var(--pbl-text-subtle)]">
          <span className="text-[10px] font-semibold uppercase tracking-[0.2em]">Scroll</span>
          <svg width="14" height="20" viewBox="0 0 14 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="0.5" y="0.5" width="13" height="19" rx="6.5" stroke="currentColor" />
            <rect x="6" y="4" width="2" height="5" rx="1" fill="currentColor" />
          </svg>
        </div>
      </div>
    </section>
  );
}

/* ============================================================
   4. Features —— 4 个核心能力卡片
   ============================================================ */
function Features() {
  return (
    <section
      id="features"
      className="pbl-light-section border-b border-[var(--pbl-border)] py-24 md:py-32"
    >
      <div className="pbl-wide-container px-6 md:px-10">
        <CosmicReveal className="mb-16">
          <div className="mb-4 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--pbl-text-subtle)]">
            <span className="h-px w-8 bg-[var(--pbl-text-strong)]" />
            TEACH · LEARN · CREATE
          </div>
          <h2 className="text-[length:clamp(2rem,5vw,3.25rem)] font-extrabold leading-[1.05] tracking-tight text-[var(--pbl-text-strong)] [text-wrap:balance]">
            从一堂课，
            <span className="pbl-display-gradient">走向一次真正的创造。</span>
          </h2>
          <p className="mt-5 max-w-4xl text-[15px] leading-7 text-[var(--pbl-text-muted)]">
            PrAIxis 让教师、学生与 AI 围绕同一个真实问题协同工作，让知识进入行动，让每一次行动留下可见的成长证据。
          </p>
        </CosmicReveal>

        <div className="grid gap-6 md:grid-cols-2">
          {FEATURES.map((f, i) => {
            const Icon = f.icon;
            return (
              <CosmicReveal key={f.title} delay={i * 80}>
                <article className="pbl-shine-card group relative h-full overflow-hidden rounded-2xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-8 transition-all duration-300 hover:-translate-y-1 hover:border-[var(--pbl-border-strong)] hover:shadow-xl hover:shadow-indigo-100/50">
                  {/* 背景渐变 */}
                  <div
                    className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${f.accent} opacity-0 transition-opacity duration-500 group-hover:opacity-100`}
                  />
                  <div className="relative">
                    {/* 渐变图标 */}
                    <div
                      className={`mb-5 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br ${f.iconBg} text-white shadow-lg pbl-icon-wiggle`}
                      style={{ boxShadow: "0 8px 20px rgba(99, 102, 241, 0.25)" }}
                    >
                      <Icon size={22} strokeWidth={1.8} />
                    </div>
                    {/* 标题 */}
                    <h3 className="text-xl font-bold tracking-tight text-[var(--pbl-text-strong)]">
                      {f.title}
                    </h3>
                    {/* 描述 */}
                    <p className="mt-3 text-[14px] leading-7 text-[var(--pbl-text-muted)]">
                      {f.desc}
                    </p>
                    {/* 要点 */}
                    <ul className="mt-5 space-y-2">
                      {f.points.map((p) => (
                        <li
                          key={p}
                          className="flex items-start gap-2 text-[13px] leading-6 text-[var(--pbl-text)]"
                        >
                          <svg
                            className="mt-1.5 h-3 w-3 shrink-0 text-indigo-500"
                            viewBox="0 0 12 12"
                            fill="none"
                          >
                            <path
                              d="M2 6L5 9L10 3"
                              stroke="currentColor"
                              strokeWidth="1.6"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                          {p}
                        </li>
                      ))}
                    </ul>
                  </div>
                </article>
              </CosmicReveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ============================================================
   4. Workflow —— 亮色五阶段流程图
   ============================================================ */
function Workflow() {
  const stages = NEW_STAGES;
  return (
    <section
      id="workflow"
      className="pbl-aurora-light border-b border-[var(--pbl-border)] py-24 md:py-32"
    >
      <div className="pbl-aurora">
        <div className="pbl-aurora-3" />
      </div>

      <div className="pbl-wide-container relative z-10 px-6 md:px-10">
        <CosmicReveal className="mb-16 max-w-3xl">
          <div className="pbl-cosmic-chapter mb-4">LEARN BY DOING</div>
          <h2 className="text-[length:clamp(2rem,5vw,3.25rem)] font-extrabold leading-[1.05] tracking-tight text-[var(--pbl-text-strong)]">
            问题引路，
            <span className="pbl-display-gradient">作品作答。</span>
          </h2>
          <p className="mt-5 text-[15px] leading-7 text-[var(--pbl-text-muted)]">
            五个阶段把知识授予、项目实践与课堂资源组织连接起来，学生最终以真实文档或代码成果回应问题。
          </p>
        </CosmicReveal>

        {/* 水平时间线 */}
        <CosmicReveal stagger>
          <div className="relative grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-5 md:gap-x-4">
            {/* 连接线（仅桌面） */}
            <div className="pointer-events-none absolute left-0 right-0 top-[26px] hidden h-px bg-gradient-to-r from-transparent via-[var(--pbl-border-strong)] to-transparent md:block" />

            {stages.map((stage, index) => {
              const Icon = stage.icon;
              return (
                <div key={stage.key} className="group relative">
                  {/* 节点圆 */}
                  <div className="relative mb-6 flex items-center gap-3">
                    <span
                      className={`relative grid h-[52px] w-[52px] shrink-0 place-items-center rounded-full bg-gradient-to-br ${stage.gradient} text-white shadow-lg transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3`}
                      style={{ boxShadow: `0 8px 20px ${stage.color}33` }}
                    >
                      <Icon size={20} strokeWidth={1.8} />
                      {/* 序号 */}
                      <span className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-white text-[10px] font-bold text-[var(--pbl-text-strong)] shadow-md ring-1 ring-[var(--pbl-border)]">
                        {index + 1}
                      </span>
                    </span>
                  </div>

                  {/* 阶段名 */}
                  <h3
                    className="text-base font-bold tracking-tight"
                    style={{ color: stage.color }}
                  >
                    {stage.label}
                  </h3>

                  {/* 描述 */}
                  <p className="mt-2 text-[12px] leading-5 text-[var(--pbl-text-muted)]">
                    {stage.desc}
                  </p>
                </div>
              );
            })}
          </div>
        </CosmicReveal>

        {/* 闭环提示 */}
        <CosmicReveal>
          <div className="mt-16 flex items-center gap-3 rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-5 py-4 shadow-sm">
            <RotateCw size={16} className="shrink-0 text-indigo-500" />
            <p className="text-[13px] leading-6 text-[var(--pbl-text-muted)]">
              <span className="font-semibold text-[var(--pbl-text-strong)]">闭环持续循环</span>
              ：第五阶段的反思产出，会成为下一个项目的起点。
            </p>
          </div>
        </CosmicReveal>
      </div>
    </section>
  );
}

/* ============================================================
   5. Entry —— 教师 / 学生双入口（紧凑卡片，不展开表单）
   ============================================================ */
function Entry() {
  return (
    <section
      id="entry"
      className="pbl-aurora-light relative overflow-hidden border-b border-[var(--pbl-border)] py-24 md:py-32"
    >
      {/* 渐变背景 */}
      <div className="pbl-aurora">
        <div className="pbl-aurora-3" />
      </div>
      <div className="pbl-dots-light" />

      <div className="pbl-wide-container relative z-10 px-6 md:px-10">
        <CosmicReveal className="mb-14 text-center">
          <div className="mb-4 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--pbl-text-subtle)]">
            <span className="h-px w-8 bg-[var(--pbl-text-strong)]" />
            STEP INTO PRACTICE
            <span className="h-px w-8 bg-[var(--pbl-text-strong)]" />
          </div>
          <h2 className="text-[length:clamp(2rem,5vw,3.25rem)] font-extrabold leading-[1.05] tracking-tight text-[var(--pbl-text-strong)]">
            下一次实践，
            <span className="pbl-display-gradient">从这里开始。</span>
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-7 text-[var(--pbl-text-muted)]">
            教师创建并引领项目课堂，学生通过邀请码进入实践现场，与 AI 一起把想法变成作品。
          </p>
        </CosmicReveal>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* 教师端 */}
          <CosmicReveal>
            <Link
              href="/teacher"
              className="pbl-shine-card group relative block overflow-hidden rounded-3xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-8 transition-all duration-300 hover:-translate-y-1 hover:border-indigo-300 hover:shadow-2xl hover:shadow-indigo-100/60"
            >
              {/* 背景渐变 */}
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-indigo-50 via-transparent to-transparent opacity-50 transition-opacity duration-500 group-hover:opacity-100" />

              <div className="relative flex items-start gap-6">
                {/* 渐变图标 */}
                <div className="inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-xl shadow-indigo-500/30 transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3">
                  <GraduationCap size={30} strokeWidth={1.8} />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="mb-1 inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-indigo-600">
                    For Teachers
                  </div>
                  <h3 className="text-2xl font-extrabold tracking-tight text-[var(--pbl-text-strong)]">
                    教师端
                  </h3>
                  <p className="mt-2 text-[14px] leading-6 text-[var(--pbl-text-muted)]">
                    一个平台完成课程创建、五阶段课堂与课程结束：轻量资源授课、分节知识讲授和文档或代码项目实践。
                  </p>

                  {/* 功能标签 */}
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {["课程创建", "资源投屏", "知识讲授", "项目实践"].map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full border border-indigo-100 bg-indigo-50/60 px-2.5 py-1 text-[11px] font-semibold text-indigo-700"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>

                {/* 右侧箭头 */}
                <div className="hidden shrink-0 self-center md:block">
                  <div className="grid h-10 w-10 place-items-center rounded-full bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-muted)] transition-all duration-300 group-hover:bg-indigo-500 group-hover:text-white">
                    <ArrowUpRight size={18} />
                  </div>
                </div>
              </div>
            </Link>
          </CosmicReveal>

          {/* 学生端 */}
          <CosmicReveal delay={100}>
            <Link
              href="/student"
              className="pbl-shine-card group relative block overflow-hidden rounded-3xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-8 transition-all duration-300 hover:-translate-y-1 hover:border-emerald-300 hover:shadow-2xl hover:shadow-emerald-100/60"
            >
              {/* 背景渐变 */}
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-emerald-50 via-transparent to-transparent opacity-50 transition-opacity duration-500 group-hover:opacity-100" />

              <div className="relative flex items-start gap-6">
                {/* 渐变图标 */}
                <div className="inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-xl shadow-emerald-500/30 transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3">
                  <UsersRound size={30} strokeWidth={1.8} />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="mb-1 inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-600">
                    For Students
                  </div>
                  <h3 className="text-2xl font-extrabold tracking-tight text-[var(--pbl-text-strong)]">
                    学生端
                  </h3>
                  <p className="mt-2 text-[14px] leading-6 text-[var(--pbl-text-muted)]">
                    使用教师提供的 6 位邀请码进入课堂，跟随课堂流程完成项目学习与反思。
                  </p>

                  {/* 功能标签 */}
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {["邀请码加入", "项目实践", "成果汇报", "学习反思"].map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full border border-emerald-100 bg-emerald-50/60 px-2.5 py-1 text-[11px] font-semibold text-emerald-700"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>

                {/* 右侧箭头 */}
                <div className="hidden shrink-0 self-center md:block">
                  <div className="grid h-10 w-10 place-items-center rounded-full bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-muted)] transition-all duration-300 group-hover:bg-emerald-500 group-hover:text-white">
                    <ArrowUpRight size={18} />
                  </div>
                </div>
              </div>
            </Link>
          </CosmicReveal>
        </div>
      </div>
    </section>
  );
}

/* ============================================================
   Footer —— 简洁页脚（亮色）
   ============================================================ */
function SiteFooter() {
  return (
    <footer className="pbl-aurora-light border-t border-[var(--pbl-border)] py-12">
      <div className="pbl-wide-container px-6 md:px-10">
        <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
          <div className="flex items-center gap-3">
            <PraixisLogo variant="horizontalCompact" height={28} />
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px] font-medium text-[var(--pbl-text-muted)]">
            <span>Praxis + AI</span>
            <span className="hidden md:inline text-[var(--pbl-text-subtle)]">·</span>
            <span>备课</span>
            <span className="hidden md:inline text-[var(--pbl-text-subtle)]">·</span>
            <span>课堂讲授</span>
            <span className="hidden md:inline text-[var(--pbl-text-subtle)]">·</span>
            <span>课后评价</span>
            <span className="hidden md:inline text-[var(--pbl-text-subtle)]">·</span>
            <span>五阶段课堂</span>
          </div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--pbl-text-subtle)]">
            © 2026 PrAIxis · AI inside practice.
          </div>
        </div>
      </div>
    </footer>
  );
}
