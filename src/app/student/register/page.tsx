"use client";

import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_LENGTH_HINT } from "@/lib/auth/password-policy";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { Eye, EyeOff, LoaderCircle, ArrowRight, Badge, KeyRound, Lock, UserRound } from "lucide-react";
import { StudentAuthShell } from "@/components/platform/student-auth-shell";

const INVITE_CODE_LENGTH = 6;

function cleanInviteCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, INVITE_CODE_LENGTH);
}

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
    () => cleanInviteCode(searchParams.get("code") ?? ""),
  );
  const inviteInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateInviteCode(index: number, value: string) {
    const entered = cleanInviteCode(value);
    const next = entered
      ? cleanInviteCode(`${code.slice(0, index)}${entered}${code.slice(index + entered.length)}`)
      : `${code.slice(0, index)}${code.slice(index + 1)}`;

    setCode(next);
    setInvitation(null);
    setError(null);

    if (entered) {
      inviteInputRefs.current[Math.min(index + entered.length, INVITE_CODE_LENGTH - 1)]?.focus();
    }
  }

  function handleInviteKeyDown(index: number, event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace" && !code[index] && index > 0) {
      event.preventDefault();
      updateInviteCode(index - 1, "");
      inviteInputRefs.current[index - 1]?.focus();
    } else if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      inviteInputRefs.current[index - 1]?.focus();
    } else if (event.key === "ArrowRight" && index < INVITE_CODE_LENGTH - 1) {
      event.preventDefault();
      inviteInputRefs.current[index + 1]?.focus();
    }
  }

  async function verifyCode() {
    if (busy || code.trim().length < 4) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/platform/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
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
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
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
          confirmPassword,
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
    >
      <section
        className="pbl-auth-form-stack pbl-student-register"
        data-step={invitation ? "account" : "invite"}
      >
        <ol className="pbl-student-steps" aria-label="注册进度">
          <li data-active={!invitation} aria-current={!invitation ? "step" : undefined}><span>{invitation ? "✓" : "1"}</span>确认课程</li>
          <li data-active={!!invitation} aria-current={invitation ? "step" : undefined}><span>2</span>创建账号</li>
        </ol>
        {!invitation ? <form key="invite" className="pbl-auth-fields pbl-student-step" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void verifyCode(); }}>
        <fieldset className="pbl-auth-field pbl-student-invite-field" disabled={busy}>
          <legend className="sr-only">课程邀请码，6 位字符</legend>
          <div className="pbl-student-invite-heading" aria-hidden="true">
            <span><KeyRound aria-hidden="true" size={15} />课程邀请码</span>
            <small>6 位字符</small>
          </div>
          <div className="pbl-student-code-group" data-busy={busy}>
            {Array.from({ length: INVITE_CODE_LENGTH }, (_, index) => (
              <input
                aria-describedby="invite-hint"
                aria-label={index === 0 ? "课程邀请码" : `邀请码第 ${index + 1} 位`}
                autoCapitalize="characters"
                autoComplete={index === 0 ? "one-time-code" : "off"}
                className="pbl-student-code-cell"
                data-filled={Boolean(code[index])}
                inputMode="text"
                key={index}
                maxLength={index === 0 ? INVITE_CODE_LENGTH : 1}
                onChange={(event) => updateInviteCode(index, event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => handleInviteKeyDown(index, event)}
                ref={(element) => { inviteInputRefs.current[index] = element; }}
                spellCheck={false}
                value={code[index] ?? ""}
              />
            ))}
          </div>
          <span aria-live="polite" className="pbl-student-code-status">
            {code.length === INVITE_CODE_LENGTH ? "邀请码已填写完整" : `还需输入 ${INVITE_CODE_LENGTH - code.length} 位`}
          </span>
        </fieldset>
        <button
          className="pbl-auth-primary"
          disabled={busy || code.length !== INVITE_CODE_LENGTH}
          type="submit"
        >
          <span>{busy ? "验证中…" : "下一步：填写信息"}</span>
          {busy ? <LoaderCircle aria-hidden="true" className="pbl-student-spinner" size={18} /> : <ArrowRight aria-hidden="true" size={18} />}
        </button>
        <p className="pbl-student-hint" id="invite-hint">邀请码由任课教师提供，验证后即可确认你要加入的课程。</p>
        {error ? <p role="alert" className="pbl-auth-error">{error}</p> : null}
        </form> : null}
        {invitation ? (
          <div className="pbl-auth-invitation">
            <span aria-hidden="true"><Badge size={17} /></span>
            <div>
              <span className="pbl-student-course-label">即将加入的课程</span>
              <p>{invitation.offering.name}</p>
              <small>
              教师：{invitation.offering.teacher?.displayName ?? "待公布"}
              {invitation.offering.term ? ` · ${invitation.offering.term}` : ""}
              </small>
            </div>
            <button type="button" className="pbl-student-change" disabled={busy} onClick={() => { setInvitation(null); setError(null); }}>修改</button>
          </div>
        ) : null}
        {invitation ? <form key="account" className="pbl-auth-fields pbl-auth-register-fields pbl-student-step" onSubmit={register} aria-busy={busy}>
          <label className="pbl-auth-field">
            <span>学号</span>
            <span className="pbl-auth-input-wrap">
              <UserRound aria-hidden="true" className="pbl-auth-input-icon" size={17} />
              <input
                className="pbl-auth-input"
                autoFocus
                autoComplete="username"
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="输入你的学号"
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
            <span id="student-password-label">密码</span>
            <span className="pbl-auth-input-wrap">
              <Lock aria-hidden="true" className="pbl-auth-input-icon" size={17} />
              <input
                className="pbl-auth-input"
                aria-labelledby="student-password-label"
                autoComplete="new-password"
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                placeholder={PASSWORD_LENGTH_HINT}
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
          <label className="pbl-auth-field">
            <span>确认密码</span>
            <span className="pbl-auth-input-wrap">
              <Lock aria-hidden="true" className="pbl-auth-input-icon" size={17} />
              <input
                className="pbl-auth-input"
                autoComplete="new-password"
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                placeholder="再次输入密码"
                required
                type={showPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </span>
          </label>
          <p className="pbl-student-hint">{PASSWORD_LENGTH_HINT}，请使用方便记忆且不易被猜到的密码。</p>
          {confirmPassword && password === confirmPassword ? <p className="pbl-student-match" role="status">✓ 两次密码一致</p> : null}
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
            {busy ? <LoaderCircle aria-hidden="true" className="pbl-student-spinner" size={18} /> : <ArrowRight aria-hidden="true" size={18} />}
          </button>
        </form> : null}
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
