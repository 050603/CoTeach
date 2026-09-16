"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Lock, User } from "lucide-react";
import { TeacherAuthShell } from "@/components/platform/teacher-auth-shell";
import { normalizeTeacherRedirect } from "./login-navigation";

function TeacherLoginPageContent() {
  const search = useSearchParams();
  const redirect = normalizeTeacherRedirect(search.get("redirect"));
  const sessionExpired = search.get("reason") === "session-expired";
  const [bootstrapAvailable, setBootstrapAvailable] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/platform/auth/teacher-register", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (active) setBootstrapAvailable(response.ok && data.mode === "bootstrap" && data.available === true);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    const form = new FormData(e.currentTarget);
    const username = String(form.get("username") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!username || !password) {
      setError("请输入教师账号和密码");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/platform/auth/teacher-login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message ?? "登录失败");
        return;
      }
      const sessionResponse = await fetch("/api/auth/me", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { "X-OpenPBL-Role": "teacher" },
      });
      const session = await sessionResponse.json().catch(() => null);
      if (!sessionResponse.ok || session?.user?.role !== "teacher") {
        setError("浏览器未能保存登录状态。请允许本站使用 Cookie，并确认通过 HTTPS 地址访问后重试。");
        return;
      }
      window.location.replace(redirect);
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络错误,请重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <TeacherAuthShell
      mode="login"
      title="教师登录"
    >
      <div className="pbl-auth-form-stack">
        {sessionExpired ? <p role="status" className="pbl-auth-notice pbl-auth-notice-warning">原登录状态已失效，请重新登录。</p> : null}
        {bootstrapAvailable ? <p role="status" className="pbl-auth-notice">当前还没有教师账号。<Link href="/teacher/register">创建首个教师账号</Link> 后即可开始使用。</p> : null}

        <form className="pbl-auth-fields" onSubmit={onSubmit}>
          <label className="pbl-auth-field">
            <span>账号</span>
            <div className="pbl-auth-input-wrap">
              <User
                aria-hidden="true"
                className="pbl-auth-input-icon"
                size={16}
              />
              <input
                autoComplete="username"
                className="pbl-auth-input"
                name="username"
                placeholder="教师账号"
                required
                type="text"
              />
            </div>
          </label>

          <label className="pbl-auth-field">
            <span>密码</span>
            <div className="pbl-auth-input-wrap">
              <Lock
                aria-hidden="true"
                className="pbl-auth-input-icon"
                size={16}
              />
              <input
                className="pbl-auth-input"
                autoComplete="current-password"
                name="password"
                placeholder="密码"
                required
                type="password"
              />
            </div>
          </label>

          {error ? (
            <p className="pbl-auth-error" role="alert">
              {error}
            </p>
          ) : null}

          <button
            className="pbl-auth-primary"
            disabled={submitting}
            type="submit"
          >
            <span>{submitting ? "登录中..." : "登录"}</span>
            <ArrowRight aria-hidden="true" size={18} />
          </button>
        </form>

        <div className="pbl-auth-form-footer">
          首次使用，还没有教师账号？
          <Link
            href="/teacher/register"
          >
            注册教师账号
          </Link>
        </div>
      </div>
    </TeacherAuthShell>
  );
}

export default function TeacherLoginPage() {
  return (
    <Suspense fallback={<main className="pbl-platform-page grid min-h-screen place-items-center text-sm text-[var(--pbl-text-muted)]">正在打开教师登录…</main>}>
      <TeacherLoginPageContent />
    </Suspense>
  );
}
