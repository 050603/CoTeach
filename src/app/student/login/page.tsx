"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Lock, UserRound } from "lucide-react";
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
      title="欢迎回来"
      description="登录后进入已加入的课程，继续你的学习与实践。"
    >
      <form className="pbl-auth-fields" onSubmit={submit}>
        <label className="pbl-auth-field">
          <span>登录账号</span>
          <span className="pbl-auth-input-wrap">
            <UserRound aria-hidden="true" className="pbl-auth-input-icon" size={17} />
            <input
              className="pbl-auth-input"
              autoComplete="username"
              placeholder="输入你的账号"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </span>
        </label>
        <label className="pbl-auth-field">
          <span>密码</span>
          <span className="pbl-auth-input-wrap">
            <Lock aria-hidden="true" className="pbl-auth-input-icon" size={17} />
            <input
              className="pbl-auth-input"
              autoComplete="current-password"
              placeholder="输入密码"
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </span>
        </label>
        {error ? (
          <p role="alert" className="pbl-auth-error">
            {error}
          </p>
        ) : null}
        <button
          className="pbl-auth-primary"
          disabled={busy}
          type="submit"
        >
          <span>{busy ? "登录中…" : "登录并进入课程"}</span>
          <ArrowRight aria-hidden="true" size={18} />
        </button>
      </form>
      <p className="pbl-auth-help">
        忘记密码？请联系任课教师获取重置链接。
      </p>
      <p className="pbl-auth-form-footer">
        首次使用？{" "}
        <Link href="/student/register">
          使用课程邀请码注册
        </Link>
      </p>
    </StudentAuthShell>
  );
}
