import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { CoTeachLogo } from "@/components/brand/coteach-logo";
import { CoTeachLogoAnimation } from "@/components/brand/coteach-logo-animation";

type AuthRole = "teacher" | "student";
type AuthMode = "login" | "register";

const ROLE_CONTENT = {
  teacher: {
    portal: "教师工作空间",
    portalCode: "TEACHER STUDIO",
    counterpart: "学生入口",
    counterpartHref: "/student/login",
    explanation: "在 CoTeach 中，AI 参与教学协作，教学判断始终由教师掌握。",
  },
  student: {
    portal: "学生学习空间",
    portalCode: "LEARNING SPACE",
    counterpart: "教师入口",
    counterpartHref: "/teacher/login",
    explanation: "在 CoTeach 中，AI 参与学习协作，学生始终保有自己的判断和行动。",
  },
} as const;

export function AuthShell({
  children,
  description,
  mode,
  role,
  title,
}: {
  children: ReactNode;
  description: string;
  mode?: AuthMode;
  role: AuthRole;
  title: string;
}) {
  const content = ROLE_CONTENT[role];

  return (
    <main className={`pbl-auth-scene pbl-auth-scene-${role}`}>
      <div aria-hidden="true" className="pbl-auth-glow pbl-auth-glow-one" />
      <div aria-hidden="true" className="pbl-auth-glow pbl-auth-glow-two" />
      <div aria-hidden="true" className="pbl-auth-grid" />

      <header className="pbl-auth-header">
        <Link aria-label="返回 CoTeach 首页" className="pbl-auth-brand" href="/">
          <CoTeachLogo variant="horizontalSolid" height={31} priority />
        </Link>
        <nav aria-label="身份入口" className="pbl-auth-header-actions">
          <Link className="pbl-auth-counterpart" href={content.counterpartHref}>
            {content.counterpart}
            <ArrowUpRight aria-hidden="true" size={15} />
          </Link>
          <Link className="pbl-auth-home" href="/">
            <ArrowLeft aria-hidden="true" size={16} />
            返回首页
          </Link>
        </nav>
      </header>

      <div className="pbl-auth-stage">
        <section className="pbl-auth-visual" aria-label={`${content.portal}学习路径`}>
          <div className="pbl-auth-visual-heading">
            <span className="pbl-auth-visual-index">01</span>
            <div>
              <p>{content.portalCode}</p>
              <h2>{content.portal}</h2>
            </div>
          </div>
          <AuthBrandOrigin explanation={content.explanation} role={role} />
        </section>

        <section className={`pbl-auth-content${mode ? ` pbl-auth-content-${mode}` : ""}`}>
          {mode ? (
            <nav aria-label={`${content.portal}账号`} className="pbl-auth-mode-switch">
              {(["login", "register"] as const).map((value) => (
                <Link
                  aria-current={mode === value ? "page" : undefined}
                  href={`/${role}/${value}`}
                  key={value}
                >
                  {value === "login" ? "登录" : "注册"}
                </Link>
              ))}
            </nav>
          ) : null}

          <div className="pbl-auth-title">
            <p>
              <span aria-hidden="true" />
              {content.portal}
            </p>
            <h1>{title}</h1>
            <div>{description}</div>
          </div>

          <div className="pbl-auth-body">{children}</div>
        </section>
      </div>
    </main>
  );
}

function AuthBrandOrigin({
  explanation,
  role,
}: {
  explanation: string;
  role: AuthRole;
}) {
  return (
    <div className={`pbl-auth-origin pbl-auth-origin-${role}`}>
      <div aria-hidden="true" className="pbl-auth-origin-glow" />
      <div className="pbl-auth-origin-word-wrap">
        <CoTeachLogoAnimation playback="once" />
      </div>
      <div className="pbl-auth-brand-caption">
        <p className="pbl-auth-brand-motto">共同教 · 共同学 · 共同创造</p>
        <p>{explanation}</p>
      </div>
      <p className="sr-only">
        CoTeach 连接教师、学生与 AI，让教学成为共同设计、共同实践与共同成长的过程。
        {explanation}
      </p>
    </div>
  );
}
