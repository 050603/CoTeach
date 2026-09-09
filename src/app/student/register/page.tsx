"use client";

import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_LENGTH_HINT } from "@/lib/auth/password-policy";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { StudentAuthShell } from "@/components/platform/student-auth-shell";

type Invitation = {
  code: string;
  offering: {
    id: string;
    name: string;
    description: string | null;
    term: string | null;
    status: string;
    teacher: { displayName: string } | null;
  };
};

function StudentRegisterPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [code, setCode] = useState(
    () => searchParams.get("code")?.toUpperCase() ?? "",
  );
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verifyCode() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/platform/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message ?? "邀请码无效");
        setInvitation(null);
        return;
      }
      setInvitation(data.invitation);
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  async function register(event: React.FormEvent) {
    event.preventDefault();
    if (!invitation || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/platform/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invitationCode: invitation.code,
          username,
          displayName,
          password,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message ?? "注册失败");
        return;
      }
      router.push(`/student/courses/${data.offeringId}`);
      router.refresh();
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <StudentAuthShell
      mode="register"
      title="创建学生账号"
      description="先验证教师提供的邀请码，再创建账号。注册后直接进入对应课程。"
    >
      <section className="mt-7">
        <label className="block text-sm font-semibold">
          课程邀请码
          <input
            className="mt-2 min-h-11 w-full rounded-[6px] border border-[var(--pbl-border)] px-3 uppercase"
            value={code}
            disabled={busy}
            onChange={(event) => {
              setCode(event.target.value.toUpperCase());
              setInvitation(null);
              setError(null);
            }}
            placeholder="例如 A2K9QP"
          />
        </label>
        <button
          className="mt-3 min-h-11 w-full rounded-[6px] border border-[var(--pbl-border)] text-sm font-semibold text-[var(--pbl-student)] disabled:opacity-50"
          disabled={busy || code.trim().length < 4}
          onClick={() => void verifyCode()}
          type="button"
        >
          {busy && !invitation ? "验证中…" : "验证邀请码"}
        </button>
        {invitation ? (
          <div className="mt-4 rounded-[6px] bg-[var(--pbl-bg)] p-3 text-sm">
            <p className="font-semibold">{invitation.offering.name}</p>
            <p className="mt-1 text-[var(--pbl-text-muted)]">
              教师：{invitation.offering.teacher?.displayName ?? "待公布"}
              {invitation.offering.term ? ` · ${invitation.offering.term}` : ""}
            </p>
          </div>
        ) : null}
        <form className="mt-5 space-y-4" onSubmit={register}>
          <label className="block text-sm font-semibold">
            登录账号
            <input
              className="mt-2 min-h-11 w-full rounded-[6px] border border-[var(--pbl-border)] px-3"
              autoComplete="username"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="至少 3 个字符"
            />
          </label>
          <label className="block text-sm font-semibold">
            姓名
            <input
              className="mt-2 min-h-11 w-full rounded-[6px] border border-[var(--pbl-border)] px-3"
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <label className="block text-sm font-semibold">
            密码
            <input
              className="mt-2 min-h-11 w-full rounded-[6px] border border-[var(--pbl-border)] px-3"
              autoComplete="new-password"
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
            <p
              role="alert"
              className="rounded-[6px] bg-rose-50 px-3 py-2 text-sm text-rose-700"
            >
              {error}
            </p>
          ) : null}
          <button
            className="min-h-11 w-full rounded-[6px] bg-[var(--pbl-student)] px-4 text-sm font-semibold text-white disabled:opacity-50"
            disabled={!invitation || busy}
            type="submit"
          >
            {busy && invitation ? "创建中…" : "创建账号并加入课程"}
          </button>
        </form>
      </section>
      <p className="mt-5 text-sm text-[var(--pbl-text-muted)]">
        已有账号？
        <Link
          href="/student/login"
          className="ml-2 font-semibold text-[var(--pbl-student)]"
        >
          登录学习空间
        </Link>
      </p>
    </StudentAuthShell>
  );
}

export default function StudentRegisterPage() {
  return (
    <Suspense
      fallback={
        <main className="grid min-h-screen place-items-center bg-[var(--pbl-bg)] text-sm text-[var(--pbl-text-muted)]">
          <p role="status">正在打开学习空间…</p>
        </main>
      }
    >
      <StudentRegisterPageContent />
    </Suspense>
  );
}
