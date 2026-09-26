"use client";

import { useState, type FormEvent } from "react";
import { FileUp, LoaderCircle } from "lucide-react";
import type { Course } from "@/lib/session/types";

type UploadResult = { id?: string; message?: string };

export function LaunchPresentationReplacement({
  course,
  disabled,
  onUpdated,
}: {
  course: Course;
  disabled: boolean;
  onUpdated: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File>();
  const [uploadedId, setUploadedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const currentId = course.content.resourcePackage?.launchResourceId;
  const current = course.resources?.find((resource) => resource.id === currentId)
    ?? course.resources?.find((resource) => resource.stageKey === "launch" && resource.type.toUpperCase() === "PPTX");

  async function replace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busy || disabled) return;
    if (!/\.pptx$/i.test(file.name) || file.size === 0 || file.size > 50 * 1024 * 1024) {
      setError("请选择不超过 50 MiB 的 PPTX 文件。");
      return;
    }
    if (!Number.isInteger(course.version)) {
      setError("课程版本尚未加载，请刷新页面后重试。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let uploadId = uploadedId;
      if (!uploadId) {
        const form = new FormData();
        form.append("file", file);
        form.append("courseId", course.id);
        form.append("purpose", "launch-presentation-replacement");
        const upload = await fetch("/api/uploads", { method: "POST", body: form });
        const result = await upload.json().catch(() => ({})) as UploadResult;
        if (!upload.ok || !result.id) throw new Error(result.message || "PPT 上传或课堂预览生成失败。");
        uploadId = result.id;
        setUploadedId(uploadId);
      }
      const response = await fetch(`/api/courses/${encodeURIComponent(course.id)}/launch-presentation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId, expectedVersion: course.version }),
      });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(result.message || "替换启动课件失败。");
      await onUpdated();
      setNotice(`已用“${file.name}”替换第一阶段 PPT，请在发布中心核对新草稿。`);
      setFile(undefined);
      setUploadedId(undefined);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "替换启动课件失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border-t border-stone-200 pt-4">
      <p className="text-xs font-semibold text-stone-700">第一阶段教师 PPT</p>
      <p className="mt-1 break-all text-xs text-stone-600">{current?.title ?? course.content.resourcePackage?.classroomPresentation?.fileName ?? "尚未上传"}</p>
      {current?.url ? <a className="mt-1 inline-block text-xs font-semibold text-[var(--pbl-teacher)] hover:underline" href={current.url}>下载当前 PPT</a> : null}
      <button className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-[8px] border border-stone-300 bg-white px-3 text-xs font-bold text-stone-800 hover:border-[var(--pbl-teacher)] disabled:opacity-50" disabled={disabled || busy} onClick={() => { setOpen((value) => !value); setError(""); }} type="button"><FileUp size={15} />{course.content.resourcePackage ? "替换资源包中的 PPT" : "上传第一阶段 PPT"}</button>
      {disabled ? <p className="mt-2 text-xs text-amber-700">请先保存左侧的课程定位修改，再替换课件。</p> : null}
      {open ? <form className="mt-3 space-y-3" onSubmit={(event) => void replace(event)}>
        <label className="block text-xs font-semibold text-stone-700">上传新的 PPTX 文件
          <input accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" className="mt-1.5 block w-full min-w-0 text-xs text-stone-600 file:mr-2 file:rounded-[6px] file:border file:border-stone-300 file:bg-white file:px-3 file:py-2 file:text-xs file:font-semibold" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0]); setUploadedId(undefined); setError(""); }} type="file" />
        </label>
        <p className="text-xs leading-5 text-stone-500">上传后将整份 PPT 用作第一阶段课件，并生成 PDF 课堂版。资源包中的知识点和教案文档保持原样。</p>
        <button className="inline-flex min-h-10 items-center gap-2 rounded-[8px] bg-[var(--pbl-teacher)] px-4 text-xs font-bold text-white disabled:opacity-50" disabled={!file || busy || disabled} type="submit">{busy ? <LoaderCircle className="animate-spin" size={15} /> : <FileUp size={15} />}{busy ? "正在上传并替换…" : "上传并替换"}</button>
      </form> : null}
      {error ? <p className="mt-2 text-xs font-semibold text-red-700" role="alert">{error}</p> : null}
      {notice ? <p className="mt-2 text-xs font-semibold text-emerald-700" role="status">{notice}</p> : null}
    </div>
  );
}
