"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  Lock,
  ShieldCheck,
  User,
  UserPlus,
} from "lucide-react";
import { PraixisLogo } from "@/components/brand/praixis-logo";

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
    <div className="min-h-screen bg-[var(--pbl-bg)] text-[var(--pbl-text)]">
      <header className="border-b border-[var(--pbl-border)] bg-[var(--pbl-surface)]">
        <div className="mx-auto flex min-h-16 max-w-5xl items-center px-5">
          <Link href="/" aria-label="PrAIxis 首页">
            <PraixisLogo variant="horizontalSolid" height={28} />
          </Link>
          <span className="ml-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--pbl-text-subtle)]">
            · 首次初始化
          </span>
          <Link
            className="ml-auto inline-flex items-center gap-1.5 text-sm text-[var(--pbl-text-muted)] transition hover:text-[var(--pbl-text)]"
            href="/teacher/login"
          >
            <ArrowLeft size={14} /> 返回登录
          </Link>
        </div>
      </header>

      <main className="mx-auto grid max-w-5xl gap-8 px-5 py-10 md:grid-cols-[minmax(0,1fr)_420px] md:py-16">
        <section className="pt-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] px-3 py-1 text-xs font-semibold text-[var(--pbl-teacher)]">
            <ShieldCheck size={14} /> 安全的一次性初始化
          </div>
          <h1 className="mt-5 font-editorial text-4xl font-semibold leading-tight text-[var(--pbl-text-strong)]">
            创建首个教师账号
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-7 text-[var(--pbl-text-muted)]">
            系统没有教师时可创建首个账号；完成初始化后，已登录教师仍可在这里继续创建其他教师账号。
          </p>
          <div className="mt-8 space-y-4">
            {[
              "密码使用 Argon2id 加密，不保存明文",
              "首个教师创建后自动登录教师工作台",
              "后续教师只能由已登录教师创建",
            ].map((item) => (
              <div
                className="flex items-center gap-3 text-sm text-[var(--pbl-text)]"
                key={item}
              >
                <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--pbl-success-soft)] text-[var(--pbl-success)]">
                  <CheckCircle2 size={15} />
                </span>
                {item}
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-[var(--radius-lg)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-6 shadow-[var(--shadow-floating)]">
          {status.loading ? (
            <div className="space-y-4" aria-label="正在检查注册状态">
              <div className="pbl-skeleton h-7 w-40 rounded-md" />
              <div className="pbl-skeleton h-11 rounded-md" />
              <div className="pbl-skeleton h-11 rounded-md" />
              <div className="pbl-skeleton h-11 rounded-md" />
            </div>
          ) : status.available ? (
            <form className="space-y-4" onSubmit={submit}>
              <div>
                <h2 className="text-xl font-bold text-[var(--pbl-text-strong)]">
                  {status.mode === "bootstrap"
                    ? "设置首个教师信息"
                    : "创建其他教师账号"}
                </h2>
                <p className="mt-1 text-xs leading-5 text-[var(--pbl-text-muted)]">
                  {status.mode === "bootstrap"
                    ? "创建后将使用该账号自动登录。"
                    : "新账号创建后，当前教师仍保持登录。"}
                </p>
              </div>
              {createdTeacher ? (
                <div
                  aria-live="polite"
                  className="rounded-[var(--radius-xs)] border border-[var(--pbl-success)]/20 bg-[var(--pbl-success-soft)] px-3 py-2 text-sm text-[var(--pbl-success)]"
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
                minLength={10}
                onChange={setPassword}
                placeholder="至少 10 个字符"
                type="password"
                value={password}
              />
              <Field
                autoComplete="new-password"
                icon={<Lock size={16} />}
                label="确认密码"
                minLength={10}
                onChange={setConfirmPassword}
                placeholder="再次输入密码"
                type="password"
                value={confirmPassword}
              />
              {error ? (
                <p
                  aria-live="polite"
                  className="rounded-[var(--radius-xs)] bg-[var(--pbl-danger-soft)] px-3 py-2 text-sm text-[var(--pbl-danger)]"
                >
                  {error}
                </p>
              ) : null}
              <button
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-xs)] bg-[var(--pbl-teacher)] px-4 text-sm font-semibold text-white transition hover:bg-[var(--pbl-teacher-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                disabled={
                  submitting ||
                  username.trim().length < 3 ||
                  !displayName.trim() ||
                  password.length < 10 ||
                  confirmPassword.length < 10
                }
                type="submit"
              >
                <UserPlus size={16} />
                {submitting
                  ? "正在创建..."
                  : status.mode === "bootstrap"
                    ? "创建并进入教师端"
                    : "创建教师账号"}
              </button>
            </form>
          ) : (
            <div className="py-5 text-center">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-muted)]">
                <ShieldCheck size={23} />
              </span>
              <h2 className="mt-4 text-lg font-bold text-[var(--pbl-text-strong)]">
                需要教师身份
              </h2>
              <p className="mt-2 text-sm leading-6 text-[var(--pbl-text-muted)]">
                {status.message ?? "请先登录教师账号，再创建其他教师。"}
              </p>
              <Link
                className="mt-5 inline-flex min-h-10 items-center justify-center rounded-[var(--radius-xs)] bg-[var(--pbl-teacher)] px-5 text-sm font-semibold text-white"
                href="/teacher/login"
              >
                前往教师登录
              </Link>
            </div>
          )}
        </section>
      </main>
    </div>
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
    <label className="block">
      <span className="text-sm font-semibold">{label}</span>
      <span className="relative mt-1.5 block">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--pbl-text-muted)]">
          {icon}
        </span>
        <input
          autoComplete={autoComplete}
          className="min-h-11 w-full rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-white pl-9 pr-3 text-sm outline-none transition focus:border-[var(--pbl-teacher)]"
          maxLength={type === "password" ? 256 : 80}
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
