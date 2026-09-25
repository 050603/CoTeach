"use client";

import { useState } from "react";
import { FileCheck2, LoaderCircle, Upload } from "lucide-react";
import { Card, Pill } from "@/components/ui";
import type { Course } from "@/lib/session/types";

/** Shared additional-outcome submission entry for project work and showcase preparation. */
export function FinalArtifactSubmission({
  course,
  onSubmitted,
  variant = "artifact",
  compact = false,
}: {
  course: Course;
  onSubmitted?: () => void | Promise<void>;
  variant?: "artifact" | "showcase";
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string }>();

  async function submit(file: File) {
    const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
    const supported = new Set([".pdf", ".doc", ".docx", ".pptx", ".xlsx", ".zip", ".rar", ".7z", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm", ".mp3", ".wav", ".m4a", ".ogg", ".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml", ".sql", ".py", ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".java", ".c", ".cpp", ".h"]);
    if (!supported.has(extension)) {
      setMessage({ tone: "error", text: "支持 PDF、Word、PPTX、表格、图片、音视频、压缩包、代码和文本文件。" });
      return;
    }
    if (file.size <= 0 || file.size > 100 * 1024 * 1024) {
      setMessage({ tone: "error", text: "成果文件不能为空且不能超过 100 MiB。" });
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("title", file.name);
      if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
        body.append("requestId", crypto.randomUUID());
      }
      const response = await fetch(`/api/courses/${encodeURIComponent(course.id)}/showcase/artifacts/pdf`, { method: "POST", body });
      const payload = await response.json().catch(() => null) as { message?: string; sequence?: number } | null;
      if (!response.ok) throw new Error(payload?.message ?? `提交失败（${response.status}）`);
      setMessage({ tone: "ok", text: `项目材料已上传为第 ${payload?.sequence ?? "最新"} 份，教师可查看或下载。` });
      await onSubmitted?.();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "成果提交失败，请稍后重试。" });
    } finally {
      setBusy(false);
    }
  }

  const uploadControl = <label className="inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-sm)] bg-[var(--pbl-student)] px-4 text-sm font-semibold text-white transition hover:bg-[var(--pbl-student-hover)] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--pbl-student)] has-[:disabled]:cursor-wait has-[:disabled]:opacity-60">{busy ? <LoaderCircle className="animate-spin" size={17} /> : <Upload size={17} />}{busy ? "上传中…" : compact ? "上传材料" : "选择成果文件"}<input accept=".pdf,.doc,.docx,.pptx,.xlsx,.zip,.rar,.7z,.png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,.webm,.mp3,.wav,.m4a,.ogg,.txt,.md,.csv,.json,.xml,.yaml,.yml,.sql,.py,.js,.jsx,.ts,.tsx,.html,.css,.java,.c,.cpp,.h" className="sr-only" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void submit(file); }} type="file" />
  </label>;

  if (compact) return <div className="flex min-w-0 flex-wrap items-center gap-2">{uploadControl}{message ? <span aria-live="polite" className={`max-w-[22rem] text-xs ${message.tone === "ok" ? "text-emerald-700" : "text-rose-700"}`} role={message.tone === "error" ? "alert" : undefined}>{message.text}</span> : null}</div>;

  return (
    <Card className="border-[var(--pbl-student-border)]" compact>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[var(--pbl-student-soft)] text-[var(--pbl-student)]"><FileCheck2 size={19} /></span><div><h2 className="font-bold text-[var(--pbl-text-strong)]">{variant === "showcase" ? "上传汇报材料" : "提交本地成果"}</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--pbl-text-muted)]">{variant === "showcase" ? "上传准备在课堂展示的项目材料。轮到你时，教师会在教师端打开材料并发起投屏。" : "如果成果在本机制作，可在这里提交一个版本供教师收集。系统只记录文件信息，不解析或推断文件内容。"}</p><p className="mt-1 text-xs text-[var(--pbl-text-subtle)]">PDF 可直接预览和投屏；其他格式供教师下载查看。单个文件不超过 100 MiB。</p></div></div>
        {uploadControl}
      </div>
      {message ? <div className="mt-3 flex items-center gap-2 text-sm"><Pill tone={message.tone === "ok" ? "green" : "red"}>{message.tone === "ok" ? "已保存" : "提交失败"}</Pill><span className={message.tone === "ok" ? "text-emerald-700" : "text-rose-700"}>{message.text}</span></div> : null}
    </Card>
  );
}
