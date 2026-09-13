"use client";

import Link from "next/link";
import { ArrowLeft, Compass, GraduationCap, Home, UsersRound } from "lucide-react";

export default function NotFound() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[var(--pbl-bg)] text-[var(--pbl-text)]">
      {/* 背景装饰：偏离轨道的轨迹 */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -right-32 -top-32 h-96 w-96 rounded-full bg-[var(--pbl-ai-soft)] blur-3xl opacity-60" />
        <div className="absolute -bottom-40 -left-24 h-[28rem] w-[28rem] rounded-full bg-[var(--pbl-teacher-soft)] blur-3xl opacity-70" />
        <div className="absolute left-1/2 top-1/3 h-72 w-72 -translate-x-1/2 rounded-full bg-[var(--pbl-student-soft)] blur-3xl opacity-50" />
      </div>

      <main className="relative mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6 py-16 text-center">
        {/* 标识区：罗盘偏离 */}
        <div className="relative mb-10">
          <span className="absolute inset-0 -z-10 animate-ping rounded-full bg-[var(--pbl-accent)]/15" />
          <span className="relative grid h-24 w-24 place-items-center rounded-full border-2 border-dashed border-[var(--pbl-accent-border)] bg-[var(--pbl-surface)] shadow-[var(--shadow-floating)]">
            <Compass className="text-[var(--pbl-accent)]" size={42} strokeWidth={1.5} />
          </span>
        </div>

        {/* 404 大字 */}
        <p className="font-editorial text-[5rem] font-bold leading-none tracking-tight text-[var(--pbl-text-strong)] md:text-[7rem]">
          <span className="bg-gradient-to-br from-[var(--pbl-teacher)] via-[var(--pbl-ai)] to-[var(--pbl-student)] bg-clip-text text-transparent">
            404
          </span>
        </p>

        {/* 标语 */}
        <h1 className="font-editorial mt-4 text-2xl font-semibold md:text-3xl">
          这条学习路径没有找到
        </h1>
        <p className="mt-4 max-w-xl text-base leading-7 text-[var(--pbl-text-muted)]">
          可能是课程已被移除、邀请码失效，或链接来自旧版本。
          回到主入口重新出发，新的项目式课堂正在等你。
        </p>

        {/* 行动按钮 */}
        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-sm)] bg-[var(--pbl-teacher)] px-6 text-sm font-semibold text-white shadow-[var(--shadow-soft)] transition hover:bg-[var(--pbl-teacher-hover)]"
          >
            <Home size={16} /> 返回首页
          </Link>
          <Link
            href="/teacher"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] px-6 text-sm font-semibold text-[var(--pbl-teacher)] transition hover:bg-[var(--pbl-teacher-soft)]/70"
          >
            <GraduationCap size={16} /> 进入教师端
          </Link>
          <Link
            href="/student"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--pbl-student-border)] bg-[var(--pbl-student-soft)] px-6 text-sm font-semibold text-[var(--pbl-student)] transition hover:bg-[var(--pbl-student-soft)]/70"
          >
            <UsersRound size={16} /> 进入学生端
          </Link>
        </div>

        {/* 浏览器后退提示 */}
        <button
          onClick={() => {
            if (typeof window !== "undefined" && window.history.length > 1) {
              window.history.back();
            } else {
              window.location.href = "/";
            }
          }}
          className="mt-8 inline-flex items-center gap-1.5 text-sm text-[var(--pbl-text-subtle)] transition hover:text-[var(--pbl-text-muted)]"
          type="button"
        >
          <ArrowLeft size={14} /> 返回上一页
        </button>

        {/* 底部签名 */}
        <p className="mt-16 text-xs text-[var(--pbl-text-subtle)]">
          CoTeach · Teach together. Learn together.
        </p>
      </main>
    </div>
  );
}
