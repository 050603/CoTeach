"use client";

import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_LENGTH_HINT } from "@/lib/auth/password-policy";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ShieldCheck,
  Lock,
  User,
  UserPlus,
} from "lucide-react";
import { TeacherAuthShell } from "@/components/platform/teacher-auth-shell";

type RegistrationStatus = {
  loading: boolean;
  available: boolean;
  mode?: "bootstrap" | "authenticated";
  message?: string;
};

type CreatedTeacher = {
  username: string;
  displayName: string;
};

export default function TeacherRegisterPage() {
  const router = useRouter();
  const [status, setStatus] = useState<RegistrationStatus>({
    loading: true,
    available: false,
  });
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [createdTeacher, setCreatedTeacher] = useState<CreatedTeacher>();

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/platform/auth/teacher-register", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | {
              available?: boolean;
              mode?: "bootstrap" | "authenticated";
              message?: string;
            }
          | null;
        if (!cancelled) {
          setStatus({
            loading: false,
            available: response.ok && body?.available === true,
            mode: body?.mode,
            message: body?.message,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus({
            loading: false,
            available: false,
            message: "无法连接注册服务，请确认数据库已启动。",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(undefined);
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch("/api/platform/auth/teacher-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          displayName,
          password,
          confirmPassword,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | {
            bootstrap?: boolean;
            code?: string;
            message?: string;
            user?: CreatedTeacher;
          }
        | null;
      if (!response.ok) {
        setError(body?.message ?? "教师账号创建失败");
        if (response.status === 401) {
          setStatus({
            loading: false,
            available: false,
            message: body?.message,
          });
        }
        return;
      }
      if (body?.bootstrap) {
        router.replace("/teacher");
        router.refresh();
        return;
      }
      if (body?.user) setCreatedTeacher(body.user);
      setUsername("");
      setDisplayName("");
      setPassword("");
      setConfirmPassword("");
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <TeacherAuthShell
      mode="register"
      title={status.loading
        ? "创建教师账号"
        : status.available
          ? status.mode === "bootstrap" ? "创建首个教师账号" : "创建教师账号"
          : "创建教师账号"}
    >
        <section className="pbl-auth-form-stack">
          {status.loading ? (
            <div className="pbl-auth-skeleton" aria-label="正在检查注册状态">
              <div className="pbl-skeleton" />
              <div className="pbl-skeleton" />
              <div className="pbl-skeleton" />
              <div className="pbl-skeleton" />
            </div>
          ) : status.available ? (
            <form className="pbl-auth-fields" onSubmit={submit}>
              {createdTeacher ? (
                <div
                  aria-live="polite"
                  className="pbl-auth-success"
                >
                  已创建教师账号：
                  <span className="font-semibold">
                    {createdTeacher.displayName}（{createdTeacher.username}）
                  </span>
                </div>
              ) : null}
              <Field
                autoComplete="username"
                icon={<User size={16} />}
                label="登录账号"
                onChange={setUsername}
                pattern="[A-Za-z0-9._-]+"
                placeholder="例如：teacher"
                value={username}
              />
              <Field
                autoComplete="name"
                icon={<UserPlus size={16} />}
                label="教师姓名"
                onChange={setDisplayName}
                placeholder="例如：王老师"
                value={displayName}
              />
              <Field
                autoComplete="new-password"
                icon={<Lock size={16} />}
                label="登录密码"
                minLength={PASSWORD_MIN_LENGTH}
                onChange={setPassword}
                placeholder={PASSWORD_LENGTH_HINT}
                type="password"
                value={password}
              />
              <Field
                autoComplete="new-password"
                icon={<Lock size={16} />}
                label="确认密码"
                minLength={PASSWORD_MIN_LENGTH}
                onChange={setConfirmPassword}
                placeholder="再次输入密码"
                type="password"
                value={confirmPassword}
              />
              {error ? (
                <p
                  aria-live="polite"
                  className="pbl-auth-error"
                >
                  {error}
                </p>
              ) : null}
              <button
                className="pbl-auth-primary"
                disabled={
                  submitting ||
                  username.trim().length < 3 ||
                  !displayName.trim() ||
                  password.length < 10 ||
                  confirmPassword.length < 10
                }
                type="submit"
              >
                <span>{submitting
                  ? "正在创建..."
                  : status.mode === "bootstrap"
                    ? "创建并进入教师端"
                    : "创建教师账号"}</span>
                <ArrowRight aria-hidden="true" size={18} />
              </button>
            </form>
          ) : (
            <div className="pbl-auth-restricted">
              <span>
                <ShieldCheck size={23} />
              </span>
              <p>
                {status.message ?? "请先登录教师账号。"}
              </p>
              <Link
                className="pbl-auth-inline-action"
                href="/teacher/login"
              >
                前往教师登录
              </Link>
            </div>
          )}
        </section>
    </TeacherAuthShell>
  );
}

function Field({
  autoComplete,
  icon,
  label,
  minLength,
  onChange,
  pattern,
  placeholder,
  type = "text",
  value,
}: {
  autoComplete: string;
  icon: React.ReactNode;
  label: string;
  minLength?: number;
  onChange: (value: string) => void;
  pattern?: string;
  placeholder: string;
  type?: "text" | "password";
  value: string;
}) {
  return (
    <label className="pbl-auth-field">
      <span>{label}</span>
      <span className="pbl-auth-input-wrap">
        <span className="pbl-auth-input-icon">
          {icon}
        </span>
        <input
          autoComplete={autoComplete}
          className="pbl-auth-input"
          maxLength={type === "password" ? PASSWORD_MAX_LENGTH : 80}
          minLength={minLength}
          onChange={(event) => onChange(event.target.value)}
          pattern={pattern}
          placeholder={placeholder}
          required
          type={type}
          value={value}
        />
      </span>
    </label>
  );
}
