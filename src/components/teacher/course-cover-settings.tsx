"use client";

import { useRef, useState } from "react";
import { ImageOff, LoaderCircle, Upload, WandSparkles } from "lucide-react";
import { ResilientImage } from "@/components/resilient-image";
import { requestCourseCoverImage, uploadCourseCoverImage } from "@/lib/course-cover";
import { toast } from "@/components/ui";

type Props = {
  courseId: string;
  courseName: string;
  coverImageUrl?: string | null;
  onUpdated: () => Promise<void>;
};

export function CourseCoverSettings({ courseId, courseName, coverImageUrl, onUpdated }: Props) {
  const [updatedUrl, setUpdatedUrl] = useState<string | null>(null);
  const currentUrl = updatedUrl ?? coverImageUrl ?? "";
  const [busy, setBusy] = useState<"generate" | "upload" | null>(null);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  async function run(action: "generate" | "upload", file?: File) {
    if (busy) return;
    setBusy(action);
    setError("");
    try {
      const url = action === "upload" && file
        ? await uploadCourseCoverImage(courseId, file)
        : await requestCourseCoverImage({ id: courseId, name: courseName });
      if (!url) throw new Error("封面已处理，但服务器未返回图片地址，请刷新后重试。");
      setUpdatedUrl(url);
      toast.success(action === "upload" ? "课程封面已上传" : "课程封面已生成");
      void onUpdated().catch(() => undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "封面处理失败，请稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="course-cover-settings-title" className="rounded-[10px] border border-stone-200 bg-white p-4">
      <div className="flex items-start gap-3">
        <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-[7px] border border-stone-200 bg-stone-100">
          {currentUrl ? (
            <ResilientImage src={currentUrl} alt={`${courseName}课程封面`} fill unoptimized className="object-cover" />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-stone-500">
              <ImageOff size={18} aria-hidden="true" />
              <span className="text-[10px]">尚无课程封面</span>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold tracking-[0.12em] text-[var(--pbl-teacher)]">课程设置</p>
          <h2 id="course-cover-settings-title" className="mt-0.5 text-sm font-bold text-stone-950">课程封面</h2>
          <p className="mt-1 text-xs text-stone-500">{currentUrl ? "用于课程库卡片" : "可以生成或上传图片"}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="inline-flex min-h-10 items-center gap-1.5 rounded-[7px] bg-[var(--pbl-teacher)] px-3 text-xs font-semibold text-white disabled:opacity-50" disabled={!!busy} onClick={() => void run("generate")} type="button">
          {busy === "generate" ? <LoaderCircle className="animate-spin" size={16} /> : <WandSparkles size={16} />}
          {busy === "generate" ? "正在生成…" : currentUrl ? "重新生成封面" : "生成封面"}
        </button>
        <button className="inline-flex min-h-10 items-center gap-1.5 rounded-[7px] border border-stone-300 px-3 text-xs font-semibold text-stone-800 disabled:opacity-50" disabled={!!busy} onClick={() => fileInput.current?.click()} type="button">
          {busy === "upload" ? <LoaderCircle className="animate-spin" size={16} /> : <Upload size={16} />}
          {busy === "upload" ? "正在上传…" : "上传封面"}
        </button>
        <input
          ref={fileInput}
          aria-label="选择课程封面图片"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void run("upload", file);
            event.currentTarget.value = "";
          }}
          type="file"
        />
      </div>
      <p className="mt-2 text-[11px] leading-5 text-stone-500">PNG、JPG、WebP · 最大 10 MB · 自动裁切为 16:9</p>
      {error ? <p role="alert" className="mt-2 text-xs text-red-700">{error}</p> : null}
    </section>
  );
}
