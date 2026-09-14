import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { CoTeachLogo } from "@/components/brand/coteach-logo";
import { CoTeachLogoAnimation } from "@/components/brand/coteach-logo-animation";

type AuthRole = "teacher" | "student";
type AuthMode = "login" | "register";

const ROLE_CONTENT = {
  teacher: {
    counterpart: "学生入口",
    counterpartHref: "/student/login",
  },
  student: {
    counterpart: "教师入口",
    counterpartHref: "/teacher/login",
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
  description?: string;
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
        <section className="pbl-auth-visual" aria-label="CoTeach 品牌">
          <AuthBrandOrigin role={role} />
        </section>

        <section className={`pbl-auth-content${mode ? ` pbl-auth-content-${mode}` : ""}`}>
          {mode ? (
            <nav aria-label={`${role === "teacher" ? "教师" : "学生"}账号`} className="pbl-auth-mode-switch">
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
            <h1>{title}</h1>
            {description ? <div>{description}</div> : null}
          </div>

          <div className="pbl-auth-body">{children}</div>
        </section>
      </div>
    </main>
  );
}

function AuthBrandOrigin({
  role,
}: {
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
      </div>
    </div>
  );
}
