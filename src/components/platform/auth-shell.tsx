import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { PraixisLogo } from "@/components/brand/praixis-logo";
import { PraixisOriginWord } from "@/components/brand/praixis-origin-word";

type AuthRole = "teacher" | "student";
type AuthMode = "login" | "register";

const ROLE_CONTENT = {
  teacher: {
    portal: "教师工作空间",
    portalCode: "TEACHER STUDIO",
    counterpart: "学生入口",
    counterpartHref: "/student/login",
    explanation: "在 PrAIxis 中，AI 进入教学实践，教学判断始终由教师掌握。",
  },
  student: {
    portal: "学生学习空间",
    portalCode: "LEARNING SPACE",
    counterpart: "教师入口",
    counterpartHref: "/teacher/login",
    explanation: "在 PrAIxis 中，AI 进入学习实践，学生始终保有自己的判断和行动。",
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
        <Link aria-label="返回 PrAIxis 首页" className="pbl-auth-brand" href="/">
          <PraixisLogo variant="horizontalSolid" height={31} priority />
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
      <div
        aria-label="Praxis 演变为 PrAIxis"
        className="pbl-auth-origin-word-wrap"
        role="img"
      >
        <PraixisOriginWord className="pbl-auth-origin-word" />
      </div>
      <div aria-hidden="true" className="pbl-auth-origin-equation">
        <span>PRAXIS · 实践</span>
        <i />
        <strong>+ AI</strong>
        <i />
        <span>PRAIXIS · 共创实践</span>
      </div>
      <div aria-hidden="true" className="pbl-auth-origin-narrative">
        <div className="pbl-auth-origin-state pbl-auth-origin-state-praxis">
          <span>亚里士多德 · 三种重要的活动形态</span>
          <div className="pbl-auth-origin-triad">
            <span>
              <b>θεωρία</b>
              <small>THEORIA · 思辨</small>
            </span>
            <i />
            <span>
              <b>ποίησις</b>
              <small>POIESIS · 创制</small>
            </span>
            <i />
            <span className="is-origin">
              <b>πρᾶξις</b>
              <small>PRAXIS · 实践</small>
            </span>
          </div>
          <p>
            Praxis 源自古希腊语 πρᾶξις，意为实践、行动。在亚里士多德这里，它指目的就在行动本身的实践；PrAIxis 的命名正承接于此。
          </p>
        </div>
        <div className="pbl-auth-origin-state pbl-auth-origin-state-praixis">
          <span>PRAXIS + AI · PRAIXIS</span>
          <p>{explanation}</p>
        </div>
      </div>
      <p className="sr-only">
        亚里士多德将人的活动区分为 θεωρία（思辨）、ποίησις（制作）与
        πρᾶξις（实践）三种重要形态。Praxis 源自古希腊语 πρᾶξις，指目的就在行动本身的实践；PrAIxis
        的命名正承接于此。
        {explanation}
      </p>
    </div>
  );
}
