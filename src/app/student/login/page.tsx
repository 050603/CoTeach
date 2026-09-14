"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Eye, EyeOff, LoaderCircle, ArrowRight, Lock, UserRound } from "lucide-react";
import { StudentAuthShell } from "@/components/platform/student-auth-shell";

export default function StudentLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
      title="学生登录"
    >
      <form className="pbl-auth-fields" onSubmit={submit} aria-busy={busy}>
        <label className="pbl-auth-field">
          <span>学号</span>
          <span className="pbl-auth-input-wrap">
            <UserRound aria-hidden="true" className="pbl-auth-input-icon" size={17} />
            <input
              className="pbl-auth-input"
              autoComplete="username"
              placeholder="输入你的学号"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </span>
        </label>
        <label className="pbl-auth-field">
          <span id="student-password-label">密码</span>
          <span className="pbl-auth-input-wrap">
            <Lock aria-hidden="true" className="pbl-auth-input-icon" size={17} />
            <input
              className="pbl-auth-input"
              aria-labelledby="student-password-label"
              autoComplete="current-password"
              placeholder="输入密码"
              required
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
              <button className="pbl-student-password-toggle" type="button" aria-label={showPassword ? "隐藏密码" : "显示密码"} aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
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
          <span>{busy ? "登录中…" : "登录"}</span>
          {busy ? <LoaderCircle aria-hidden="true" className="pbl-student-spinner" size={18} /> : <ArrowRight aria-hidden="true" size={18} />}
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
