import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
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
import { CoTeachLogo } from "@/components/brand/coteach-logo";
import { CoTeachLogoAnimation } from "@/components/brand/coteach-logo-animation";
import { BrandOriginStory } from "@/components/home/brand-origin-story";
import { CosmicReveal } from "@/components/home/cosmic-reveal";
const CLASSROOM_STAGES = [
  {
    key: "launch",
    label: "课堂导入",
    icon: Flag,
    desc: "教师明确学习主题、目标与任务",
    gradient: "from-slate-700 to-slate-900",
    color: "#1c1917",
  },
  {
    key: "ai-learning",
    label: "知识讲授",
    icon: BookOpen,
    desc: "教师与 AI 参与讲授，结合小测开展讲解与答疑",
    gradient: "from-indigo-500 to-violet-600",
    color: "#6366f1",
  },
  {
    key: "make",
    label: "协作实践",
    icon: PenTool,
    desc: "学生运用所学开展创作，与 AI 协作完成学习任务",
    gradient: "from-emerald-500 to-teal-500",
    color: "#10b981",
  },
  {
    key: "showcase",
    label: "成果交流",
    icon: Presentation,
    desc: "展示学习成果，开展交流与评价",
    gradient: "from-orange-500 to-amber-500",
    color: "#f97316",
  },
  {
    key: "reflection",
    label: "后测",
    icon: RotateCw,
    desc: "回顾学习过程，梳理收获与问题",
    gradient: "from-purple-500 to-fuchsia-500",
    color: "#a855f7",
  },
] as const;

const FEATURES = [
  {
    icon: Layers,
    title: "协同备课",
    desc: "教师与 AI 共同编排课程大纲、课件与教学活动。",
    accent: "from-indigo-50 to-violet-50",
    iconBg: "from-indigo-500 to-violet-600",
  },
  {
    icon: BookOpen,
    title: "AI 授课",
    desc: "AI 讲授课程知识，结合小测开展讲解与答疑。",
    accent: "from-amber-50 to-orange-50",
    iconBg: "from-amber-500 to-orange-500",
  },
  {
    icon: GraduationCap,
    title: "课堂协作",
    desc: "教师组织课堂，学生与 AI 开展学习互动和实践创作。",
    accent: "from-blue-50 to-cyan-50",
    iconBg: "from-blue-500 to-cyan-500",
  },
  {
    icon: ClipboardCheck,
    title: "学习记录与评价",
    desc: "查看学习成果、过程记录与评价反馈。",
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
          aria-label="CoTeach 首页"
        >
          <CoTeachLogo variant="horizontalSolid" height={30} priority />
        </Link>
        <nav className="flex items-center gap-2 md:gap-3">
          <a
            href="#features"
            className="hidden rounded-full px-3 py-2 text-[13px] font-semibold text-[var(--pbl-text-muted)] transition-colors hover:bg-[var(--pbl-surface-soft)] hover:text-[var(--pbl-text-strong)] md:inline-block"
          >
            协同教学
          </a>
          <a
            href="#workflow"
            className="hidden rounded-full px-3 py-2 text-[13px] font-semibold text-[var(--pbl-text-muted)] transition-colors hover:bg-[var(--pbl-surface-soft)] hover:text-[var(--pbl-text-strong)] md:inline-block"
          >
            课堂教学
          </a>
          <Link
            href="/student/login"
            className="pbl-cosmic-btn-primary pbl-cosmic-btn-primary-compact"
          >
            <UsersRound size={14} />
            开始学习
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
    <section className="pbl-brand-hero pbl-aurora-light relative min-h-screen pt-16">
      {/* 渐变光斑背景 */}
      <div className="pbl-aurora">
        <div className="pbl-aurora-3" />
      </div>
      <div className="pbl-grid-light" />
      <div className="pbl-dots-light" />

      {/* 主内容 */}
      <div className="pbl-wide-container relative z-10 flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center px-6 py-20 text-center md:px-10">
        <div className="relative mb-8 w-full max-w-[640px]">
          <CoTeachLogoAnimation playback="once" />
        </div>

        <h1
          aria-label="共同教、共同学、共同创造"
          className="pbl-hero-principles text-[length:clamp(1.75rem,4vw,3rem)] font-bold leading-[1.2] tracking-tight [text-wrap:balance]"
        >
          <span aria-hidden="true" className="inline-block">共同教 · 共同学</span>
          <span aria-hidden="true" className="hidden sm:inline"> · </span>
          <span aria-hidden="true" className="block sm:inline">共同创造</span>
        </h1>

        <p
          className="pbl-hero-text mt-5 text-[16px] font-normal text-black md:text-[18px]"
          style={{ animationDelay: "0.3s" }}
        >
          AI 协同教学平台
        </p>

        {/* 统一学生优先入口 */}
        <div
          className="pbl-hero-text mt-10 flex items-center justify-center"
          style={{ animationDelay: "0.45s" }}
        >
          <Link href="/student/login" className="pbl-cosmic-btn-primary">
            <UsersRound size={16} />
            开始学习
            <ArrowRight size={14} />
          </Link>
        </div>

      </div>

      {/* 滚动提示 */}
      <div className="absolute inset-x-0 bottom-6 z-10 flex justify-center">
        <div className="pbl-scroll-hint flex flex-col items-center gap-1.5 text-indigo-600/85 drop-shadow-[0_2px_6px_rgba(99,102,241,0.18)]">
          <span className="text-[11px] font-semibold tracking-[0.14em]">向下探索</span>
          <svg aria-hidden="true" width="14" height="20" viewBox="0 0 14 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="0.5" y="0.5" width="13" height="19" rx="6.5" stroke="currentColor" strokeWidth="1.2" />
            <rect x="6" y="4" width="2" height="5" rx="1" fill="currentColor" />
          </svg>
        </div>
      </div>
    </section>
  );
}

/* ============================================================
   4. Features —— 协同教学能力
   ============================================================ */
function Features() {
  return (
    <section
      id="features"
      className="pbl-light-section border-b border-[var(--pbl-border)] py-24 md:py-32"
    >
      <div className="pbl-wide-container px-6 md:px-10">
        <CosmicReveal className="mb-16">
          <h2 className="pbl-section-title text-[length:clamp(2rem,5vw,3.25rem)] font-extrabold leading-[1.05] tracking-tight [text-wrap:balance]">
            协同教学
          </h2>
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
   4. Workflow —— 课堂教学环节
   ============================================================ */
function Workflow() {
  const stages = CLASSROOM_STAGES;
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
          <h2 className="pbl-section-title text-[length:clamp(2rem,5vw,3.25rem)] font-extrabold leading-[1.05] tracking-tight">
            课堂教学
          </h2>
        </CosmicReveal>

        {/* 水平时间线 */}
        <CosmicReveal stagger>
          <div
            aria-label="课堂教学环节：从课堂导入依次推进至后测"
            className="relative"
          >
            {/* 桌面端按顺序连接各教学环节。 */}
            <div className="relative hidden md:block">
              <div className="relative grid grid-cols-5 gap-x-4">
                {stages.map((stage, index) => {
                  const Icon = stage.icon;
                  return (
                    <div key={stage.key} className="group relative text-center">
                      {index < stages.length - 1 ? (
                        <div
                          aria-hidden="true"
                          className="absolute left-[calc(50%+34px)] top-[25px] flex w-[calc(100%-52px)] items-center text-indigo-500/85"
                        >
                          <span className="h-0.5 flex-1 rounded-full bg-gradient-to-r from-indigo-300 via-violet-400 to-indigo-400" />
                          <ArrowRight className="-ml-1 shrink-0" size={20} strokeWidth={2.25} />
                        </div>
                      ) : null}

                      <div className="relative mb-6 flex items-center justify-center">
                        <span
                          className={`relative grid h-[52px] w-[52px] shrink-0 place-items-center rounded-full bg-gradient-to-br ${stage.gradient} text-white shadow-lg transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3`}
                          style={{ boxShadow: `0 8px 20px ${stage.color}33` }}
                        >
                          <Icon size={20} strokeWidth={1.8} />
                          <span className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-white text-[10px] font-bold text-[var(--pbl-text-strong)] shadow-md ring-1 ring-[var(--pbl-border)]">
                            {index + 1}
                          </span>
                        </span>
                      </div>

                      <h3 className="text-base font-bold tracking-tight" style={{ color: stage.color }}>
                        {stage.label}
                      </h3>
                      <p className="mt-2 text-[12px] leading-5 text-[var(--pbl-text-muted)]">
                        {stage.desc}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 移动端：纵向排列，明确显示每一次阶段推进。 */}
            <div className="relative mx-auto max-w-md px-2 md:hidden">
              {stages.map((stage, index) => {
                const Icon = stage.icon;
                return (
                  <div key={stage.key}>
                    <div className="group relative flex items-start gap-4">
                      <span
                        className={`relative grid h-[52px] w-[52px] shrink-0 place-items-center rounded-full bg-gradient-to-br ${stage.gradient} text-white shadow-lg`}
                        style={{ boxShadow: `0 8px 20px ${stage.color}33` }}
                      >
                        <Icon size={20} strokeWidth={1.8} />
                        <span className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-white text-[10px] font-bold text-[var(--pbl-text-strong)] shadow-md ring-1 ring-[var(--pbl-border)]">
                          {index + 1}
                        </span>
                      </span>
                      <div className="min-w-0 pt-1">
                        <h3 className="text-base font-bold tracking-tight" style={{ color: stage.color }}>
                          {stage.label}
                        </h3>
                        <p className="mt-1.5 text-[12px] leading-5 text-[var(--pbl-text-muted)]">
                          {stage.desc}
                        </p>
                      </div>
                    </div>

                    {index < stages.length - 1 ? (
                      <div aria-hidden="true" className="my-2 ml-3.5 flex h-7 w-6 items-center justify-center text-indigo-400/75">
                        <ArrowDown size={18} strokeWidth={1.8} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </CosmicReveal>
      </div>
    </section>
  );
}

/* ============================================================
   5. Entry —— 统一学生优先入口
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
          <h2 className="pbl-section-title text-[length:clamp(2rem,5vw,3.25rem)] font-extrabold leading-[1.05] tracking-tight">
            进入学习空间
          </h2>
        </CosmicReveal>

        <CosmicReveal delay={100} className="text-center">
          <Link href="/student/login" className="pbl-cosmic-btn-primary">
            <UsersRound size={16} />
            开始学习
            <ArrowRight size={14} />
          </Link>
        </CosmicReveal>
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
            <CoTeachLogo variant="horizontalCompact" height={28} />
          </div>
          <div className="text-[11px] tracking-[0.08em] text-[var(--pbl-text-subtle)]">
            © 2026 CoTeach
          </div>
        </div>
      </div>
    </footer>
  );
}
