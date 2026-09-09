"use client";

import {
  BarChart3,
  Image as ImageIcon,
  Leaf,
  Loader2,
  Presentation,
  RefreshCw,
  Sparkles,
  Upload,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { Course } from "@/lib/session/types";
import {
  requestCourseCoverImage,
  uploadCourseCoverImage,
} from "@/lib/course-cover";

/**
 * ProjectCoverImage — 课程封面图显示与生成。
 *
 * 行为：
 * - 若 course.coverImageUrl 已存在（教师备课阶段生成），直接显示，不重复生成。
 * - 若无缓存图，显示渐变占位。教师端可通过 `allowGenerate` 开启生成按钮；
 *   学生端默认不生成（依赖教师备课阶段产出的封面图）。
 * - AI 生成和教师上传均通过课程封面接口校验并持久化为 16:9 图片。
 */
export function ProjectCoverImage({
  course,
  className,
  allowGenerate = false,
}: {
  course: Course;
  className?: string;
  /** 教师端设为 true 可显示生成/重新生成按钮 */
  allowGenerate?: boolean;
}) {
  const [imageOverride, setImageOverride] = useState<{
    courseId: string;
    previousUrl: string | null;
    url: string;
  } | null>(null);
  const [operation, setOperation] = useState<"generate" | "upload" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loading = operation !== null;

  const generate = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setOperation("generate");
    setError(null);

    try {
      const finalUrl = await requestCourseCoverImage(course, ctrl.signal);

      if (finalUrl) {
        setImageOverride({
          courseId: course.id,
          previousUrl: course.coverImageUrl ?? null,
          url: finalUrl,
        });
      } else {
        setError("图片服务未返回可用的封面，请重试");
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      console.warn("Cover image generation failed:", e);
      setError(e instanceof Error ? e.message : "封面生成失败，请重试");
    } finally {
      setOperation(null);
    }
  }, [course]);

  const upload = useCallback(async (file: File) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setOperation("upload");
    setError(null);
    try {
      const finalUrl = await uploadCourseCoverImage(course.id, file, ctrl.signal);
      if (!finalUrl) throw new Error("图片服务未返回可用的封面，请重试");
      setImageOverride({
        courseId: course.id,
        previousUrl: course.coverImageUrl ?? null,
        url: finalUrl,
      });
    } catch (reason) {
      if ((reason as Error).name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "封面上传失败，请重试");
    } finally {
      setOperation(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [course.id, course.coverImageUrl]);

  // 已有图片：直接显示
  const displayImageUrl = imageOverride
    && imageOverride.courseId === course.id
    && imageOverride.previousUrl === (course.coverImageUrl ?? null)
    ? imageOverride.url
    : course.coverImageUrl ?? null;
  if (displayImageUrl) {
    return (
      <div
        aria-busy={loading}
        className={cn("group relative overflow-hidden rounded-[var(--radius-sm)] bg-stone-200", className)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={displayImageUrl}
          alt={course.name || "项目封面"}
          className={cn(
            "h-full w-full object-cover transition duration-700 ease-out",
            loading && "scale-[1.035] blur-[7px] saturate-50",
          )}
        />
        {loading ? (
          <div
            aria-live="polite"
            className="absolute inset-0 grid place-items-center overflow-hidden bg-stone-950/28 text-white"
          >
            <div className="absolute inset-y-0 -left-1/2 w-1/2 animate-[pulse_1.7s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/20 to-transparent blur-xl" />
            <div className="relative flex items-center gap-2 rounded-full border border-white/25 bg-black/35 px-4 py-2 text-xs font-semibold shadow-lg backdrop-blur-md">
              <Loader2 className="animate-spin" size={15} />
              {operation === "upload" ? "正在处理上传图片" : "正在重新生成"}
            </div>
          </div>
        ) : null}
        {allowGenerate ? (
          <>
            <input
              ref={fileInputRef}
              accept="image/png,image/jpeg,image/webp"
              aria-label="选择课堂封面图片"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
              tabIndex={-1}
              type="file"
            />
            <div className="absolute inset-x-0 bottom-0 flex items-center justify-end gap-2 bg-gradient-to-t from-black/65 via-black/25 to-transparent px-3 pb-3 pt-8 opacity-100">
              <button
                aria-label="重新生成封面"
                className="inline-flex min-h-10 items-center gap-1.5 rounded-[8px] bg-white/92 px-3 text-xs font-semibold text-stone-800 shadow-sm backdrop-blur transition hover:bg-white disabled:cursor-wait"
                disabled={loading}
                onClick={() => void generate()}
                type="button"
              >
                <RefreshCw className={operation === "generate" ? "animate-spin" : ""} size={14} />
                AI 重绘
              </button>
              <button
                aria-label="上传封面图片"
                className="inline-flex min-h-10 items-center gap-1.5 rounded-[8px] bg-white/92 px-3 text-xs font-semibold text-stone-800 shadow-sm backdrop-blur transition hover:bg-white disabled:cursor-wait"
                disabled={loading}
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                <Upload size={14} />上传图片
              </button>
            </div>
          </>
        ) : null}
        {error ? <p role="alert" className="absolute inset-x-3 top-3 rounded-[8px] bg-red-950/80 px-3 py-2 text-xs text-white">{error}</p> : null}
      </div>
    );
  }

  // 教师端加载中
  if (loading) {
    return (
      <div
        className={cn(
          "relative flex items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-gradient-to-br from-[var(--pbl-teacher-soft)] via-[var(--pbl-surface-soft)] to-[var(--pbl-student-soft)]",
          className,
        )}
      >
        <div className="flex flex-col items-center gap-2 text-[var(--pbl-text-muted)]">
          <Loader2 size={28} className="animate-spin" />
          <span className="text-xs font-medium">{operation === "upload" ? "正在裁切并保存封面…" : "正在理解课程内容、绘制并检查封面…"}</span>
        </div>
      </div>
    );
  }

  // 教师端：未生成或生成失败，显示生成按钮
  if (allowGenerate) {
    return (
      <div
        className={cn(
          "group relative flex items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-gradient-to-br from-[var(--pbl-teacher-soft)] via-[var(--pbl-surface-soft)] to-[var(--pbl-student-soft)]",
          className,
        )}
      >
        <input
          ref={fileInputRef}
          accept="image/png,image/jpeg,image/webp"
          aria-label="选择课堂封面图片"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
          tabIndex={-1}
          type="file"
        />
        <div className="absolute inset-0 bg-[linear-gradient(110deg,var(--pbl-student-soft)_0%,var(--pbl-success-soft)_32%,var(--pbl-teacher-soft)_33%,var(--pbl-ai-soft)_54%,var(--pbl-student-soft)_55%,var(--pbl-success-soft)_100%)] opacity-40" />
        <div className="relative flex flex-col items-center gap-3 px-5 text-center text-[var(--pbl-text)]">
          <ImageIcon size={26} />
          <span className="text-xs font-semibold">创建与课程主题相关的 16:9 课堂封面</span>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button className="inline-flex min-h-10 items-center gap-1.5 rounded-[8px] bg-[var(--pbl-ai)] px-3 text-xs font-semibold text-white" onClick={() => void generate()} type="button"><Sparkles size={14} />AI 生成</button>
            <button className="inline-flex min-h-10 items-center gap-1.5 rounded-[8px] border border-stone-300 bg-white px-3 text-xs font-semibold" onClick={() => fileInputRef.current?.click()} type="button"><Upload size={14} />上传图片</button>
          </div>
          {error ? <span role="alert" className="max-w-sm text-xs leading-5 text-red-700">{error}</span> : <span className="text-[11px] text-stone-500">支持 PNG、JPG、WebP，最大 10 MB</span>}
        </div>
      </div>
    );
  }

  // 学生端：无封面图时显示渐变占位（不自动生成，依赖教师备课阶段产出）
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[var(--radius-sm)] bg-gradient-to-br from-[var(--pbl-teacher-soft)] via-[var(--pbl-surface-soft)] to-[var(--pbl-student-soft)]",
        className,
      )}
    >
      <div className="absolute inset-0 bg-[linear-gradient(110deg,var(--pbl-student-soft)_0%,var(--pbl-success-soft)_32%,var(--pbl-teacher-soft)_33%,var(--pbl-ai-soft)_54%,var(--pbl-student-soft)_55%,var(--pbl-success-soft)_100%)] opacity-30" />
    </div>
  );
}

/** @deprecated 使用 ProjectCoverImage 替代 */
export function CampusPhoto({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[8px] bg-emerald-100",
        className,
      )}
    >
      <div className="absolute inset-0 bg-[linear-gradient(110deg,#a7f3d0_0%,#dcfce7_32%,#bfdbfe_33%,#e0f2fe_54%,#86efac_55%,#bbf7d0_100%)]" />
      <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-emerald-900/25 to-transparent" />
      <div className="absolute left-10 top-7 h-24 w-44 rounded-t-[5px] bg-white/70 shadow-lg">
        <div className="grid h-full grid-cols-5 gap-1 p-3">
          {Array.from({ length: 15 }).map((_, index) => (
            <span className="rounded-sm bg-sky-200/80" key={index} />
          ))}
        </div>
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-20 bg-[linear-gradient(12deg,#d9f99d_0_34%,#f8fafc_35%_48%,#86efac_49%_100%)]" />
      <div className="absolute bottom-6 right-16 flex gap-2">
        {["#2563eb", "#16a34a", "#64748b", "#ef4444"].map((color) => (
          <span
            className="grid h-16 w-12 place-items-center rounded-t-[4px] text-white shadow-md"
            key={color}
            style={{ backgroundColor: color }}
          >
            <Leaf size={18} />
          </span>
        ))}
      </div>
      <div className="absolute left-6 top-0 h-full w-10 bg-[linear-gradient(90deg,transparent_0_45%,#14532d_46%_54%,transparent_55%)]">
        <span className="absolute -left-10 top-3 h-16 w-24 rounded-full bg-emerald-700/55" />
        <span className="absolute -left-7 top-20 h-14 w-20 rounded-full bg-emerald-600/50" />
      </div>
    </div>
  );
}

export function SlidePreview({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-[8px] border border-dashed border-stone-300 bg-stone-50 text-center",
        className,
      )}
    >
      <CampusPhoto className="h-[60%] w-[80%] rounded-[6px] opacity-50" />
      <div className="px-6 pb-4">
        <p className="text-base font-bold text-stone-600">演示预览占位</p>
        <p className="mt-1 text-sm text-stone-500">
          上传 PPT 或视频后，将在此处显示真实预览。
        </p>
      </div>
    </div>
  );
}

export function EvidenceStrip() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_1fr_1fr_6rem]">
      <CampusPhoto className="h-32" />
      <div className="rounded-[8px] bg-[linear-gradient(135deg,#fef3c7,#fdba74)] p-4">
        <div className="grid h-full place-items-center rounded-[6px] border-2 border-dashed border-orange-200 bg-white/40">
          <ImageIcon className="text-orange-700" size={34} />
        </div>
      </div>
      <div className="rounded-[8px] bg-[linear-gradient(135deg,#dbeafe,#e0e7ff)] p-4">
        <div className="flex h-full items-center justify-center gap-2 rounded-[6px] bg-white/60">
          <Presentation className="text-blue-700" size={30} />
          <BarChart3 className="text-blue-700" size={30} />
        </div>
      </div>
      <div className="grid h-32 place-items-center rounded-[8px] border border-stone-200 bg-stone-50 text-2xl font-semibold text-stone-600">
        +3
      </div>
    </div>
  );
}
