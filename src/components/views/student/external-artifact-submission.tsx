"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { uploadMultipartWithReceipt } from '@/lib/browser/upload-request';
import { CheckCircle2, Download, FileArchive, FileAudio2, FileImage, FileText, FileUp, FileVideo2, LoaderCircle, UploadCloud } from "lucide-react";
import { Card, Pill } from "@/components/ui";
import type { Course, ProjectPdfVersion } from "@/lib/session/types";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const ACCEPT = [
  ".pdf", ".doc", ".docx", ".pptx", ".xlsx", ".zip", ".rar", ".7z",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm",
  ".mp3", ".wav", ".m4a", ".ogg", ".txt", ".md", ".csv", ".json", ".xml",
  ".yaml", ".yml", ".sql", ".py", ".js", ".jsx", ".ts", ".tsx", ".html",
  ".css", ".java", ".c", ".cpp", ".h",
].join(",");

type UploadMessage = { tone: "ok" | "error"; text: string };

function formatBytes(size?: number): string {
  if (!size || size <= 0) return "大小未知";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function fileKind(name: string): "pdf" | "word" | "image" | "video" | "audio" | "archive" | "file" {
  const lower = name.toLocaleLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".doc") || lower.endsWith(".docx")) return "word";
  if (/\.(png|jpe?g|webp|gif)$/.test(lower)) return "image";
  if (/\.(mp4|mov|webm)$/.test(lower)) return "video";
  if (/\.(mp3|wav|m4a|ogg)$/.test(lower)) return "audio";
  if (/\.(zip|rar|7z)$/.test(lower)) return "archive";
  return "file";
}

function FileKindIcon({ name }: { name: string }) {
  const kind = fileKind(name);
  if (kind === "image") return <FileImage size={16} />;
  if (kind === "video") return <FileVideo2 size={16} />;
  if (kind === "audio") return <FileAudio2 size={16} />;
  if (kind === "archive") return <FileArchive size={16} />;
  return <FileText size={16} />;
}

function canOpen(name: string): boolean {
  const kind = fileKind(name);
  return kind === "pdf" || kind === "word";
}

function versionTime(version: ProjectPdfVersion): string {
  const date = new Date(version.submittedAt || version.createdAt);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN");
}

export function ExternalArtifactSubmission({ course, studentId }: { course: Course; studentId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<UploadMessage>();
  const [localVersions, setLocalVersions] = useState<ProjectPdfVersion[]>([]);
  const versions = useMemo(() => {
    const byId = new Map<string, ProjectPdfVersion>();
    [...(course.projectPdfVersions ?? []), ...localVersions]
      .filter((version) => version.stageKey === "make" && version.studentId === studentId)
      .forEach((version) => byId.set(version.id, version));
    return [...byId.values()].sort((left, right) => right.sequence - left.sequence);
  }, [course.projectPdfVersions, localVersions, studentId]);

  useEffect(() => {
    const open = () => inputRef.current?.click();
    window.addEventListener("openpbl:open-external-upload", open);
    return () => window.removeEventListener("openpbl:open-external-upload", open);
  }, []);

  async function submit(file: File) {
    const extension = file.name.toLocaleLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
    if (!ACCEPT.split(",").includes(extension)) {
      setMessage({ tone: "error", text: "暂不支持该格式，请选择 PDF、Word、PPTX、表格、图片、音视频、压缩包、代码或文本文件。" });
      return;
    }
    if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
      setMessage({ tone: "error", text: "文件不能为空且不能超过 100 MiB。" });
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("title", file.name);
      const response = await uploadMultipartWithReceipt(`local-artifact:${course.id}`, file, body, {
        endpoint: `/api/courses/${encodeURIComponent(course.id)}/showcase/artifacts/pdf`, requestIdField: 'requestId', receiptShape: 'artifact',
      });
      const payload = await response.json().catch(() => ({})) as {
        message?: string;
        versionId?: string;
        sequence?: number;
        submittedAt?: string;
        uploadId?: string;
        kind?: "pdf" | "file";
        mimeType?: string;
        requestId?: string;
      };
      if (!response.ok || !payload.versionId || !payload.uploadId || !payload.sequence) {
        throw new Error(payload.message ?? `提交失败（${response.status}）`);
      }
      const submittedAt = payload.submittedAt ?? new Date().toISOString();
      setLocalVersions((current) => [...current, {
        id: payload.versionId!,
        courseId: course.id,
        studentId: studentId ?? "",
        stageKey: "make",
        sequence: payload.sequence!,
        title: file.name,
        uploadId: payload.uploadId!,
        kind: payload.kind ?? "file",
        mimeType: payload.mimeType,
        size: file.size,
        status: "submitted",
        requestId: payload.requestId,
        submittedAt,
        createdAt: submittedAt,
      }]);
      setMessage({ tone: "ok", text: `本地成果已保存为第 ${payload.sequence} 个版本，教师可以收集和下载。` });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "成果提交失败，请稍后重试。" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-[var(--pbl-student-border)] bg-[color-mix(in_srgb,var(--pbl-student-soft)_35%,white)]" compact>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[var(--pbl-student-soft)] text-[var(--pbl-student)]"><UploadCloud size={19} /></span>
          <div>
            <h2 className="font-bold text-[var(--pbl-text-strong)]">提交本地成果</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--pbl-text-muted)]">PPT、视频、代码、设计稿等成果可继续在本机制作，完成一个阶段就上传一个不可覆盖的版本。系统只记录文件信息，不解析文件内容。</p>
            <p className="mt-1 text-xs text-[var(--pbl-text-subtle)]">支持 PDF、Word、PPTX、表格、图片、音视频、压缩包、代码和文本文件；单个文件不超过 100 MiB。</p>
          </div>
        </div>
        <label className="inline-flex h-10 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-sm)] bg-[var(--pbl-student)] px-4 text-sm font-semibold text-white transition hover:bg-[var(--pbl-student-hover)] has-[:disabled]:cursor-wait has-[:disabled]:opacity-60">
          {busy ? <LoaderCircle className="animate-spin" size={16} /> : <FileUp size={16} />}
          {busy ? "上传中…" : "选择文件上传"}
          <input accept={ACCEPT} className="sr-only" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void submit(file); }} ref={inputRef} type="file" />
        </label>
      </div>

      {message ? (
        <div className="mt-3 flex items-center gap-2 text-sm">
          <Pill tone={message.tone === "ok" ? "green" : "red"}>{message.tone === "ok" ? <CheckCircle2 size={13} /> : <FileUp size={13} />}{message.tone === "ok" ? "已保存" : "提交失败"}</Pill>
          <span className={message.tone === "ok" ? "text-emerald-700" : "text-rose-700"}>{message.text}</span>
        </div>
      ) : null}

      {versions.length ? (
        <div className="mt-4 border-t border-[var(--pbl-student-border)]/60 pt-4">
          <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-bold text-[var(--pbl-text-strong)]">已上传成果版本</h3><span className="text-xs text-[var(--pbl-text-muted)]">共 {versions.length} 个版本</span></div>
          <ul className="mt-2 space-y-2">
            {versions.map((version) => {
              const openable = canOpen(version.title);
              const fileUrl = `/api/uploads/${encodeURIComponent(version.uploadId)}`;
              return (
                <li className="flex flex-col gap-2 rounded-xl border border-[var(--pbl-border)] bg-white px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between" key={version.id}>
                  <div className="flex min-w-0 items-center gap-2"><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-stone-100 text-stone-600"><FileKindIcon name={version.title} /></span><div className="min-w-0"><p className="truncate text-xs font-semibold text-stone-900">第 {version.sequence} 版 · {version.title}</p><p className="mt-0.5 text-[10px] text-stone-500">{version.mimeType || "成果文件"} · {formatBytes(version.size)} · {versionTime(version)}</p></div></div>
                  <div className="flex shrink-0 items-center gap-2 pl-10 sm:pl-0"><span className="text-[10px] text-stone-500">{openable ? "可打开查看" : "暂不支持在线预览"}</span>{openable ? <a className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--pbl-student-border)] px-2.5 text-xs font-semibold text-[var(--pbl-student)] hover:bg-[var(--pbl-student-soft)]" href={fileUrl} rel="noreferrer" target="_blank">打开</a> : null}<a className="inline-flex h-8 items-center gap-1 rounded-lg bg-[var(--pbl-student)] px-2.5 text-xs font-semibold text-white hover:bg-[var(--pbl-student-hover)]" download href={`${fileUrl}?download=1`}><Download size={13} />下载</a></div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-dashed border-[var(--pbl-student-border)] bg-white/70 px-4 py-5 text-center text-xs text-[var(--pbl-text-muted)]">完成本机成果的阶段性版本后，在这里上传；协作稿和 AI 对话不会因上传失败而丢失。</div>
      )}
    </Card>
  );
}
