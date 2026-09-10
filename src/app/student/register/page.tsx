"use client";

import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_LENGTH_HINT } from "@/lib/auth/password-policy";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ArrowRight, Badge, KeyRound, Lock, UserRound } from "lucide-react";
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
      description="验证课程邀请码，创建账号后即可进入对应课程。"
    >
      <section className="pbl-auth-form-stack">
        <label className="pbl-auth-field">
          <span>课程邀请码</span>
          <span className="pbl-auth-input-wrap">
            <KeyRound aria-hidden="true" className="pbl-auth-input-icon" size={17} />
            <input
              className="pbl-auth-input uppercase"
              value={code}
              disabled={busy}
              onChange={(event) => {
                setCode(event.target.value.toUpperCase());
                setInvitation(null);
                setError(null);
              }}
              placeholder="例如 A2K9QP"
            />
          </span>
        </label>
        <button
          className="pbl-auth-secondary"
          disabled={busy || code.trim().length < 4}
          onClick={() => void verifyCode()}
          type="button"
        >
          {busy && !invitation ? "验证中…" : "验证邀请码"}
        </button>
        {invitation ? (
          <div className="pbl-auth-invitation">
            <span aria-hidden="true"><Badge size={17} /></span>
            <div>
              <p>{invitation.offering.name}</p>
              <small>
              教师：{invitation.offering.teacher?.displayName ?? "待公布"}
              {invitation.offering.term ? ` · ${invitation.offering.term}` : ""}
              </small>
            </div>
          </div>
        ) : null}
        <form className="pbl-auth-fields pbl-auth-register-fields" onSubmit={register}>
          <label className="pbl-auth-field">
            <span>登录账号</span>
            <span className="pbl-auth-input-wrap">
              <UserRound aria-hidden="true" className="pbl-auth-input-icon" size={17} />
              <input
                className="pbl-auth-input"
                autoComplete="username"
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="至少 3 个字符"
              />
            </span>
          </label>
          <label className="pbl-auth-field">
            <span>姓名</span>
            <span className="pbl-auth-input-wrap">
              <Badge aria-hidden="true" className="pbl-auth-input-icon" size={17} />
              <input
                className="pbl-auth-input"
                autoComplete="name"
                placeholder="输入你的姓名"
                required
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </span>
          </label>
          <label className="pbl-auth-field">
            <span>密码</span>
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
            <p
              role="alert"
              className="pbl-auth-error"
            >
              {error}
            </p>
          ) : null}
          <button
            className="pbl-auth-primary"
            disabled={!invitation || busy}
            type="submit"
          >
            <span>{busy && invitation ? "创建中…" : "创建账号并加入课程"}</span>
            <ArrowRight aria-hidden="true" size={18} />
          </button>
        </form>
      </section>
      <p className="pbl-auth-form-footer">
        已有账号？
        <Link href="/student/login">
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
