"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { StudentAuthShell } from "@/components/platform/student-auth-shell";

export default function StudentLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/platform/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message ?? "登录失败");
        return;
      }
      if (data.enrollments?.length === 1)
        router.push(`/student/courses/${data.enrollments[0].offeringId}`);
      else router.push("/student");
      router.refresh();
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <StudentAuthShell
      mode="login"
      title="欢迎回到学习空间"
      description="登录后进入已加入的课程，查看章节与学习任务。"
    >
      <form className="mt-7 space-y-5" onSubmit={submit}>
        <label className="block text-sm font-medium">
          登录账号
          <input
            className="mt-2 min-h-11 w-full rounded-[6px] border border-[var(--pbl-border)] bg-transparent px-3"
            autoComplete="username"
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label className="block text-sm font-medium">
          密码
          <input
            className="mt-2 min-h-11 w-full rounded-[6px] border border-[var(--pbl-border)] bg-transparent px-3"
            autoComplete="current-password"
            required
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-[var(--pbl-danger)]">
            {error}
          </p>
        ) : null}
        <button
          className="min-h-11 w-full rounded-[6px] bg-[var(--pbl-student)] px-4 text-sm font-semibold text-white disabled:opacity-50"
          disabled={busy}
          type="submit"
        >
          {busy ? "登录中…" : "登录并进入课程"}
        </button>
      </form>
      <p className="mt-5 text-sm leading-6 text-[var(--pbl-text-muted)]">
        忘记密码？请联系任课教师获取重置链接。
      </p>
      <p className="mt-5 border-t border-[var(--pbl-border)] pt-5 text-sm text-[var(--pbl-text-muted)]">
        首次使用？{" "}
        <Link
          className="font-semibold text-[var(--pbl-student)]"
          href="/student/register"
        >
          使用课程邀请码注册
        </Link>
      </p>
    </StudentAuthShell>
  );
}
