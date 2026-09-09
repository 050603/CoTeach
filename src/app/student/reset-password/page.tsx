"use client";

import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_LENGTH_HINT } from "@/lib/auth/password-policy";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { StudentAuthShell } from "@/components/platform/student-auth-shell";

function StudentResetPasswordPageContent() {
  const router = useRouter();
  const search = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/platform/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: search.get("token") ?? "", password }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message ?? "链接无效");
        return;
      }
      setDone(true);
      setTimeout(() => router.push("/student/login"), 900);
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <StudentAuthShell
      title="设置新密码"
      description="使用教师提供的重置链接，为你的学习账号设置新密码。"
    >
      {done ? (
        <p className="mt-6 rounded-[6px] bg-emerald-50 p-4 text-sm text-emerald-700">
          密码已更新，正在返回登录页。
        </p>
      ) : (
        <form
          className="mt-8 space-y-4 rounded-xl border border-[var(--pbl-border)] bg-white p-5"
          onSubmit={submit}
        >
          <label className="block text-sm font-semibold">
            新密码
            <input
              className="mt-2 min-h-11 w-full rounded-[6px] border border-[var(--pbl-border)] px-3"
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              placeholder={PASSWORD_LENGTH_HINT}
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error ? (
            <p className="rounded-[6px] bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </p>
          ) : null}
          <button
            className="min-h-11 w-full rounded-[6px] bg-[var(--pbl-student)] px-4 text-sm font-bold text-white disabled:opacity-50"
            disabled={busy || !search.get("token")}
            type="submit"
          >
            {busy ? "保存中…" : "保存新密码"}
          </button>
        </form>
      )}
      {!search.get("token") ? (
        <p role="alert" className="mt-4 text-sm text-[var(--pbl-danger)]">
          此链接缺少重置凭据，请联系教师获取完整链接。
        </p>
      ) : null}
      <Link
        href="/student/login"
        className="mt-5 inline-flex min-h-11 items-center text-sm text-[var(--pbl-student)]"
      >
        返回登录
      </Link>
    </StudentAuthShell>
  );
}

export default function StudentResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <main className="grid min-h-screen place-items-center bg-[var(--pbl-bg)] text-sm text-[var(--pbl-text-muted)]">
          <p role="status">正在打开学习空间…</p>
        </main>
      }
    >
      <StudentResetPasswordPageContent />
    </Suspense>
  );
}
