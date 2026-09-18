"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { KeyRound, Loader2, Save, ShieldCheck, UserRound } from "lucide-react";
import { PrimaryButton, TextInput } from "@/components/ui";
import { cn } from "@/lib/utils";

type TeacherProfile = { username: string; displayName: string };

export function TeacherProfilePanel() {
  const [profile, setProfile] = useState<TeacherProfile>({ username: "", displayName: "" });
  const [passwords, setPasswords] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<"profile" | "password" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/me", { cache: "no-store", headers: { "X-OpenPBL-Role": "teacher" }, signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { user?: { role?: string; username?: string; displayName?: string } | null };
        if (!response.ok || data.user?.role !== "teacher") throw new Error("无法读取教师账号信息");
        setProfile({ username: data.user.username || "", displayName: data.user.displayName || "" });
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取教师账号信息"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  async function updateProfile(payload: Record<string, string>, kind: "profile" | "password") {
    if (saving) return;
    setSaving(kind);
    setNotice("");
    setError("");
    try {
      const response = await fetch("/api/platform/auth/teacher-profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json().catch(() => ({})) as { message?: string; user?: TeacherProfile };
      if (!response.ok || !data.user) throw new Error(data.message || "个人信息保存失败");
      setProfile(data.user);
      window.dispatchEvent(new CustomEvent("teacher-profile-updated", { detail: data.user }));
      if (kind === "password") setPasswords({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setNotice(kind === "profile" ? "个人信息已更新" : "登录密码已更新");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "个人信息保存失败");
    } finally {
      setSaving(null);
    }
  }

  function saveName(event: FormEvent) {
    event.preventDefault();
    void updateProfile({ displayName: profile.displayName.trim() }, "profile");
  }

  function savePassword(event: FormEvent) {
    event.preventDefault();
    void updateProfile(passwords, "password");
  }

  return <section className="grid items-start gap-5 xl:grid-cols-2" aria-labelledby="teacher-profile-heading">
    <form onSubmit={saveName} className="rounded-[14px] border border-[var(--pbl-border)] bg-white p-5 sm:p-6">
      <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]"><UserRound size={19}/></span><div><h2 id="teacher-profile-heading" className="font-semibold text-[var(--pbl-text-strong)]">个人信息</h2><p className="mt-1 text-xs leading-5 text-[var(--pbl-text-muted)]">用于教师端账号区域以及学生看到的教师姓名。</p></div></div>
      <div className="mt-5 grid gap-4">
        <label className="text-sm font-medium">登录账号<TextInput className="mt-2" value={profile.username} readOnly disabled={loading}/><small className="mt-1.5 block font-normal text-[var(--pbl-text-muted)]">登录账号暂不支持修改。</small></label>
        <label className="text-sm font-medium">显示姓名<TextInput className="mt-2" value={profile.displayName} required maxLength={64} disabled={loading} onChange={(event) => setProfile((current) => ({ ...current, displayName: event.target.value }))}/></label>
      </div>
      <PrimaryButton type="submit" className="mt-5 h-10" disabled={loading || saving !== null || !profile.displayName.trim()}>{saving === "profile" ? <Loader2 size={15} className="animate-spin"/> : <Save size={15}/>}保存个人信息</PrimaryButton>
    </form>
    <form onSubmit={savePassword} className="rounded-[14px] border border-[var(--pbl-border)] bg-white p-5 sm:p-6">
      <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]"><ShieldCheck size={19}/></span><div><h2 className="font-semibold text-[var(--pbl-text-strong)]">登录安全</h2><p className="mt-1 text-xs leading-5 text-[var(--pbl-text-muted)]">修改密码需要先验证当前密码，更新后当前设备会保持登录。</p></div></div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium sm:col-span-2">当前密码<TextInput className="mt-2" type="password" autoComplete="current-password" required value={passwords.currentPassword} onChange={(event) => setPasswords((current) => ({ ...current, currentPassword: event.target.value }))}/></label>
        <label className="text-sm font-medium">新密码<TextInput className="mt-2" type="password" autoComplete="new-password" minLength={10} maxLength={256} required value={passwords.newPassword} onChange={(event) => setPasswords((current) => ({ ...current, newPassword: event.target.value }))}/></label>
        <label className="text-sm font-medium">确认新密码<TextInput className="mt-2" type="password" autoComplete="new-password" minLength={10} maxLength={256} required value={passwords.confirmPassword} onChange={(event) => setPasswords((current) => ({ ...current, confirmPassword: event.target.value }))}/></label>
      </div>
      <PrimaryButton type="submit" className="mt-5 h-10" disabled={saving !== null}>{saving === "password" ? <Loader2 size={15} className="animate-spin"/> : <KeyRound size={15}/>}更新登录密码</PrimaryButton>
    </form>
    {(notice || error) ? <p className={cn("rounded-[8px] border px-4 py-3 text-sm xl:col-span-2", error ? "border-red-200 bg-red-50 text-[var(--pbl-danger)]" : "border-emerald-200 bg-emerald-50 text-emerald-700")} role={error ? "alert" : "status"}>{error || notice}</p> : null}
  </section>;
}
