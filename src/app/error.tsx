"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, Home, RefreshCw, Wrench } from "lucide-react";
import {
  isChunkLoadError,
  recoverFromChunkLoadError,
} from "@/lib/runtime/chunk-load-recovery";

export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const chunkLoadFailed = isChunkLoadError(error);

  useEffect(() => {
    // 上报到控制台便于教师排查；未来可接入监控平台
    console.error("[CoTeach] 未捕获错误:", error);
    recoverFromChunkLoadError(error);
  }, [error]);

  const digest = error.digest;

  return (
    <div className="relative min-h-screen overflow-hidden bg-[var(--pbl-bg)] text-[var(--pbl-text)]">
      {/* 背景装饰：破碎的色块 */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -right-32 -top-32 h-96 w-96 rounded-full bg-[var(--pbl-warning-soft)] blur-3xl opacity-70" />
        <div className="absolute -bottom-40 -left-24 h-[28rem] w-[28rem] rounded-full bg-[var(--pbl-danger-soft)] blur-3xl opacity-70" />
      </div>

      <main className="relative mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6 py-16 text-center">
        {/* 警示图标 */}
        <div className="relative mb-10">
          <span className="absolute inset-0 -z-10 animate-pulse rounded-full bg-[var(--pbl-warning)]/10" />
          <span className="relative grid h-24 w-24 place-items-center rounded-full border-2 border-[var(--pbl-warning)]/40 bg-[var(--pbl-surface)] shadow-[var(--shadow-floating)]">
            <AlertTriangle className="text-[var(--pbl-warning)]" size={42} strokeWidth={1.5} />
          </span>
        </div>

        {/* 提示语 */}
        <p className="font-editorial text-2xl font-semibold md:text-3xl">
          课堂遇到了一点意外
        </p>
        <p className="mt-4 max-w-xl text-base leading-7 text-[var(--pbl-text-muted)]">
          可能是网络断开、AI 服务繁忙或本地数据读取失败。
          刷新当前页通常可以恢复，如果问题持续，请回到首页重新进入课堂。
        </p>

        {/* 错误摘要卡片 */}
        {(error.message || digest) && (
          <div className="mt-8 w-full max-w-xl rounded-[var(--radius-sm)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-4 text-left shadow-[var(--shadow-soft)]">
            <div className="flex items-center gap-2 border-b border-[var(--pbl-border-soft)] pb-2 text-xs font-semibold text-[var(--pbl-text-muted)]">
              <Wrench size={13} /> 错误摘要
            </div>
            <div className="mt-2 space-y-1.5 text-xs text-[var(--pbl-text-muted)]">
              {error.message && (
                <div className="break-all">
                  <span className="font-semibold text-[var(--pbl-danger)]">消息：</span>
                  <code className="ml-1 font-mono">{error.message}</code>
                </div>
              )}
              {digest && (
                <div>
                  <span className="font-semibold text-[var(--pbl-text-muted)]">追踪编号：</span>
                  <code className="ml-1 font-mono">{digest}</code>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 行动按钮 */}
        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <button
            onClick={() =>
              chunkLoadFailed ? window.location.reload() : unstable_retry()
            }
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-sm)] bg-[var(--pbl-teacher)] px-6 text-sm font-semibold text-white shadow-[var(--shadow-soft)] transition hover:bg-[var(--pbl-teacher-hover)]"
            type="button"
          >
            <RefreshCw size={16} />
            {chunkLoadFailed ? "刷新并恢复" : "重试当前页"}
          </button>
          <Link
            href="/"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--pbl-border-strong)] bg-[var(--pbl-surface)] px-6 text-sm font-semibold text-[var(--pbl-text)] transition hover:bg-[var(--pbl-surface-soft)]"
          >
            <Home size={16} /> 返回首页
          </Link>
        </div>

        {/* 底部签名 */}
        <p className="mt-16 text-xs text-[var(--pbl-text-subtle)]">
          CoTeach · Teach together. Learn together.
        </p>
      </main>
    </div>
  );
}
