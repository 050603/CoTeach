"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Lock, User } from "lucide-react";
import { PraixisLogo } from "@/components/brand/praixis-logo";

export default function TeacherLoginPage() {
  const router = useRouter();
  const search = useSearchParams();
  const redirect = search.get("redirect") ?? "/teacher";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <div className="min-h-screen bg-[var(--pbl-bg)] text-[var(--pbl-text)]">
      <header className="border-b border-[var(--pbl-border)] bg-[var(--pbl-surface)]">
        <div className="mx-auto flex min-h-16 max-w-5xl items-center gap-3 px-5">
          <PraixisLogo variant="horizontalSolid" height={28} />
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--pbl-text-subtle)]">
            · 教师登录
          </span>
          <Link
            className="ml-auto text-sm text-[var(--pbl-text-muted)] transition hover:text-[var(--pbl-text)]"
            href="/"
          >
            返回首页
          </Link>
        </div>
      </header>

      <main className="mx-auto flex max-w-md flex-col gap-6 px-5 py-12 md:py-20">
        <div>
          <h1 className="font-editorial text-3xl font-semibold">教师登录</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--pbl-text-muted)]">
            请输入账号与密码。若服务端尚未配置鉴权，请联系系统管理员完成初始化。
          </p>
        </div>

        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <label className="flex flex-col gap-2">
            <span className="text-sm font-semibold">账号</span>
            <div className="relative">
              <User
                aria-hidden="true"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--pbl-text-muted)]"
                size={16}
              />
              <input
                autoFocus
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

        <div className="rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-4 text-xs leading-5 text-[var(--pbl-text-muted)]">
          <p className="font-semibold text-[var(--pbl-text)]">首次部署提示</p>
          <p className="mt-1">
            首次部署请在服务器执行 <code className="font-mono">pnpm admin:init-teacher</code> 创建教师账号。
          </p>
        </div>
      </main>
    </div>
  );
}
