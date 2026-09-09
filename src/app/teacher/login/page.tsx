"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Lock, User } from "lucide-react";
import { TeacherAuthShell } from "@/components/platform/teacher-auth-shell";

function TeacherLoginPageContent() {
  const router = useRouter();
  const search = useSearchParams();
  const redirect = search.get("redirect") ?? "/teacher";
  const sessionExpired = search.get("reason") === "session-expired";
  const [bootstrapAvailable, setBootstrapAvailable] = useState(false);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
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

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/platform/auth/teacher-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.message ?? "登录失败");
        return;
      }
      router.push(redirect);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络错误,请重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <TeacherAuthShell>
      <div className="pbl-platform-panel pbl-auth-form flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold">教师登录</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--pbl-text-muted)]">
            登录工作空间，继续编排课程、管理学生与开展教学。
          </p>
          {sessionExpired ? <p role="status" className="mt-4 rounded-[var(--radius-xs)] border border-[var(--pbl-warning)]/30 bg-[var(--pbl-warning-soft)] px-3 py-2 text-sm text-[var(--pbl-warning)]">原登录状态已失效，请重新登录。</p> : null}
          {bootstrapAvailable ? <p role="status" className="mt-4 rounded-[var(--radius-xs)] border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] px-3 py-3 text-sm leading-6 text-[var(--pbl-teacher)]">当前数据库还没有教师账号。<Link className="ml-1 font-semibold underline" href="/teacher/register">创建首个教师账号</Link> 后即可保存课程数据。</p> : null}
        </div>

        <form className="flex flex-col gap-5" onSubmit={onSubmit}>
          <label className="flex flex-col gap-2">
            <span className="text-sm font-semibold">账号</span>
            <div className="relative">
              <User
                aria-hidden="true"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--pbl-text-muted)]"
                size={16}
              />
              <input
                autoComplete="username"
                className="min-h-11 w-full rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-white pl-9 pr-3 text-sm transition focus:border-[var(--pbl-teacher)] focus:outline-none"
                onChange={(e) => setUsername(e.target.value)}
                placeholder="教师账号"
                required
                type="text"
                value={username}
              />
            </div>
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-semibold">密码</span>
            <div className="relative">
              <Lock
                aria-hidden="true"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--pbl-text-muted)]"
                size={16}
              />
              <input
                className="min-h-11 w-full rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-white pl-9 pr-3 text-sm transition focus:border-[var(--pbl-teacher)] focus:outline-none"
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="密码"
                required
                type="password"
                value={password}
              />
            </div>
          </label>

          {error ? (
            <p className="rounded-[var(--radius-xs)] bg-[var(--pbl-danger-soft)] px-3 py-2 text-sm text-[var(--pbl-danger)]">
              {error}
            </p>
          ) : null}

          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-xs)] bg-[var(--pbl-teacher)] px-4 text-sm font-semibold text-white transition hover:bg-[var(--pbl-teacher-hover)] disabled:opacity-60"
            disabled={submitting || !username.trim() || !password}
            type="submit"
          >
            {submitting ? "登录中..." : "登录"}
          </button>
        </form>

        <div className="text-center text-sm text-[var(--pbl-text-muted)]">
          首次使用，还没有教师账号？
          <Link
            className="ml-1 font-semibold text-[var(--pbl-teacher)] hover:underline"
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
