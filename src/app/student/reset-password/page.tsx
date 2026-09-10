"use client";

import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_LENGTH_HINT } from "@/lib/auth/password-policy";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ArrowLeft, ArrowRight, Lock } from "lucide-react";
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
        <p className="pbl-auth-success">
          密码已更新，正在返回登录页。
        </p>
      ) : (
        <form
          className="pbl-auth-fields"
          onSubmit={submit}
        >
          <label className="pbl-auth-field">
            <span>新密码</span>
            <span className="pbl-auth-input-wrap">
              <Lock aria-hidden="true" className="pbl-auth-input-icon" size={17} />
              <input
                className="pbl-auth-input"
                autoComplete="new-password"
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                placeholder={PASSWORD_LENGTH_HINT}
                required
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </span>
          </label>
          {error ? (
            <p className="pbl-auth-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="pbl-auth-primary"
            disabled={busy || !search.get("token")}
            type="submit"
          >
            <span>{busy ? "保存中…" : "保存新密码"}</span>
            <ArrowRight aria-hidden="true" size={18} />
          </button>
        </form>
      )}
      {!search.get("token") ? (
        <p role="alert" className="pbl-auth-error">
          此链接缺少重置凭据，请联系教师获取完整链接。
        </p>
      ) : null}
      <Link
        href="/student/login"
        className="pbl-auth-back-link"
      >
        <ArrowLeft aria-hidden="true" size={16} />
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
