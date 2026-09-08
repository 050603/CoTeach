"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

export default function StudentResetPasswordPage() {
  const router = useRouter(); const search = useSearchParams(); const [password, setPassword] = useState(""); const [error, setError] = useState<string | null>(null); const [done, setDone] = useState(false); const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) { event.preventDefault(); setBusy(true); setError(null); try { const response = await fetch("/api/platform/auth/reset-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: search.get("token") ?? "", password }) }); const data = await response.json(); if (!response.ok) { setError(data.message ?? "链接无效"); return; } setDone(true); setTimeout(() => router.push("/student/login"), 900); } catch { setError("网络错误，请稍后重试"); } finally { setBusy(false); } }
  return <main className="min-h-screen bg-[var(--pbl-bg)] px-5 py-12 text-[var(--pbl-text)]"><div className="mx-auto max-w-md"><Link href="/student/login" className="text-sm text-[var(--pbl-text-muted)]">← 返回登录</Link><h1 className="mt-8 text-3xl font-bold">设置新密码</h1>{done ? <p className="mt-6 rounded-lg bg-emerald-50 p-4 text-sm text-emerald-700">密码已更新，正在返回登录页。</p> : <form className="mt-8 space-y-4 rounded-xl border border-[var(--pbl-border)] bg-white p-5 shadow-sm" onSubmit={submit}><label className="block text-sm font-semibold">新密码<input className="mt-2 min-h-11 w-full rounded-lg border border-[var(--pbl-border)] px-3" minLength={8} required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}<button className="min-h-11 w-full rounded-lg bg-indigo-600 px-4 text-sm font-bold text-white disabled:opacity-50" disabled={busy || !search.get("token")} type="submit">{busy ? "保存中…" : "保存新密码"}</button></form>}</div></main>;
}

