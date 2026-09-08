"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Invitation = { code: string; offering: { id: string; name: string; description: string | null; term: string | null; status: string; teacher: { displayName: string } } };

export default function StudentRegisterPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verifyCode() {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/platform/auth/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      const data = await response.json();
      if (!response.ok) { setError(data.message ?? "邀请码无效"); setInvitation(null); return; }
      setInvitation(data.invitation);
    } catch { setError("网络错误，请稍后重试"); } finally { setBusy(false); }
  }

  async function register(event: React.FormEvent) {
    event.preventDefault(); if (!invitation || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/platform/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invitationCode: code, username, displayName, password }) });
      const data = await response.json();
      if (!response.ok) { setError(data.message ?? "注册失败"); return; }
      router.push(`/student/courses/${data.offeringId}`); router.refresh();
    } catch { setError("网络错误，请稍后重试"); } finally { setBusy(false); }
  }

  return <main className="min-h-screen bg-[var(--pbl-bg)] px-5 py-12 text-[var(--pbl-text)]"><div className="mx-auto max-w-md"><Link href="/student" className="text-sm text-[var(--pbl-text-muted)]">← 返回学生端</Link><h1 className="mt-8 text-3xl font-bold">创建学生账号</h1><p className="mt-2 text-sm leading-6 text-[var(--pbl-text-muted)]">账号可以加入多个教学班。首次注册需要任课教师提供的邀请码。</p><section className="mt-8 rounded-xl border border-[var(--pbl-border)] bg-white p-5 shadow-sm"><label className="block text-sm font-semibold">课程邀请码<input className="mt-2 min-h-11 w-full rounded-lg border border-[var(--pbl-border)] px-3 uppercase" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="例如 A2K9QP" /></label><button className="mt-3 min-h-10 w-full rounded-lg border border-indigo-300 text-sm font-semibold text-indigo-700 disabled:opacity-50" disabled={busy || code.trim().length < 4} onClick={() => void verifyCode()} type="button">{busy && !invitation ? "验证中…" : "验证邀请码"}</button>{invitation ? <div className="mt-4 rounded-lg bg-indigo-50 p-3 text-sm"><p className="font-bold">{invitation.offering.name}</p><p className="mt-1 text-[var(--pbl-text-muted)]">教师：{invitation.offering.teacher.displayName}{invitation.offering.term ? ` · ${invitation.offering.term}` : ""}</p></div> : null}<form className="mt-5 space-y-4" onSubmit={register}><label className="block text-sm font-semibold">登录账号<input className="mt-2 min-h-11 w-full rounded-lg border border-[var(--pbl-border)] px-3" autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} placeholder="至少 3 个字符" /></label><label className="block text-sm font-semibold">姓名<input className="mt-2 min-h-11 w-full rounded-lg border border-[var(--pbl-border)] px-3" required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label><label className="block text-sm font-semibold">密码<input className="mt-2 min-h-11 w-full rounded-lg border border-[var(--pbl-border)] px-3" autoComplete="new-password" minLength={8} required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}<button className="min-h-11 w-full rounded-lg bg-indigo-600 px-4 text-sm font-bold text-white disabled:opacity-50" disabled={!invitation || busy} type="submit">{busy && invitation ? "创建中…" : "创建账号并加入课程"}</button></form></section><p className="mt-5 text-center text-sm text-[var(--pbl-text-muted)]">已有账号？ <Link className="font-semibold text-indigo-600" href="/student/login">登录</Link></p></div></main>;
}

