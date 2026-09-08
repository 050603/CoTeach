"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function StudentLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) { event.preventDefault(); if (busy) return; setBusy(true); setError(null); try { const response = await fetch("/api/platform/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) }); const data = await response.json(); if (!response.ok) { setError(data.message ?? "登录失败"); return; } if (data.enrollments?.length === 1) router.push(`/student/courses/${data.enrollments[0].offeringId}`); else router.push("/student"); router.refresh(); } catch { setError("网络错误，请稍后重试"); } finally { setBusy(false); } }
  return <main className="min-h-screen bg-[var(--pbl-bg)] px-5 py-12 text-[var(--pbl-text)]"><div className="mx-auto max-w-md"><Link href="/student" className="text-sm text-[var(--pbl-text-muted)]">← 返回学生端</Link><h1 className="mt-8 text-3xl font-bold">学生登录</h1><p className="mt-2 text-sm leading-6 text-[var(--pbl-text-muted)]">登录后可以在“我的课程”中继续所有教学班的学习。</p><form className="mt-8 space-y-4 rounded-xl border border-[var(--pbl-border)] bg-white p-5 shadow-sm" onSubmit={submit}><label className="block text-sm font-semibold">登录账号<input className="mt-2 min-h-11 w-full rounded-lg border border-[var(--pbl-border)] px-3" autoFocus autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label><label className="block text-sm font-semibold">密码<input className="mt-2 min-h-11 w-full rounded-lg border border-[var(--pbl-border)] px-3" autoComplete="current-password" required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}<button className="min-h-11 w-full rounded-lg bg-indigo-600 px-4 text-sm font-bold text-white disabled:opacity-50" disabled={busy} type="submit">{busy ? "登录中…" : "登录"}</button></form><p className="mt-5 text-center text-sm text-[var(--pbl-text-muted)]">还没有账号？ <Link className="font-semibold text-indigo-600" href="/student/register">使用邀请码注册</Link></p></div></main>;
}

