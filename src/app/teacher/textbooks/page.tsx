"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ArrowRight, BookOpen, CheckCircle2, FileUp, LoaderCircle, RotateCcw, Search } from "lucide-react";
import { PlatformEmpty, PlatformError, PlatformLoading } from "@/components/platform/platform-feedback";
import { TeacherPlatformHeader, TeacherPlatformPage } from "@/components/platform/teacher-shell";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { teacherPlatformFetch } from "@/lib/platform/client";
import type { TextbookListItem } from "./textbook-view-types";
import styles from "./textbooks.module.css";

type TextbookListResponse = { items?: TextbookListItem[]; textbooks?: TextbookListItem[]; total?: number; message?: string; error?: string };

type StatusView = {
  label: string;
  tone: "ready" | "working" | "waiting" | "failed" | "neutral";
  group: "ready" | "working" | "waiting" | "failed" | "archived";
};

function statusView(item: TextbookListItem): StatusView {
  if (item.archivedAt) return { label: "已归档", tone: "neutral", group: "archived" };
  const status = (item.currentRevision?.status || item.status || "PENDING").toUpperCase();
  if (["READY", "COMPLETED", "SUCCEEDED", "ACTIVE"].includes(status)) return { label: "可用于课程", tone: "ready", group: "ready" };
  if (status.includes("WAITING") || status.includes("CONFIG")) return { label: "等待向量服务", tone: "waiting", group: "waiting" };
  if (["FAILED", "ERROR", "CANCELLED"].some(value => status.includes(value))) return { label: "解析失败", tone: "failed", group: "failed" };
  if (["PENDING", "QUEUED", "UPLOADED", "VALIDATING"].some(value => status.includes(value))) return { label: "等待解析", tone: "waiting", group: "waiting" };
  return { label: "正在解析", tone: "working", group: "working" };
}

function progressPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value <= 1 ? value * 100 : value)));
}

function displayDate(value: string | undefined) {
  if (!value) return "时间待记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间待记录" : date.toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" });
}

export default function TeacherTextbooksPage() {
  const [items, setItems] = useState<TextbookListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("active");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [archiveTarget, setArchiveTarget] = useState<TextbookListItem | null>(null);

  const load = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const response = await teacherPlatformFetch("/api/textbooks?includeArchived=true", { cache: "no-store" });
      const data = await response.json().catch(() => ({})) as TextbookListResponse;
      if (!response.ok) throw new Error(data.message || data.error || "教材库暂时无法加载");
      setItems(Array.isArray(data.items) ? data.items : Array.isArray(data.textbooks) ? data.textbooks : []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "教材库暂时无法加载");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!items.some(item => ["working", "waiting"].includes(statusView(item).group))) return;
    const timer = window.setTimeout(() => void load({ quiet: true }), 5_000);
    return () => window.clearTimeout(timer);
  }, [items, load]);

  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return items.filter(item => {
      const status = statusView(item);
      const matchesFilter = filter === "all"
        || filter === "active" && status.group !== "archived"
        || filter === status.group;
      if (!matchesFilter) return false;
      if (!normalizedQuery) return true;
      return `${item.title} ${item.author || item.authors || ""}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
    });
  }, [filter, items, query]);

  const librarySummary = useMemo(() => {
    const active = items.filter(item => !item.archivedAt);
    return {
      active: active.length,
      ready: active.filter(item => statusView(item).group === "ready").length,
      processing: active.filter(item => ["working", "waiting"].includes(statusView(item).group)).length,
    };
  }, [items]);

  async function upload(file: File) {
    if (!file.name.toLocaleLowerCase().endsWith(".docx")) {
      setError("教材库首期仅支持 DOCX 文件，请重新选择。");
      return;
    }
    setUploading(true);
    setError("");
    setNotice("");
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await teacherPlatformFetch("/api/textbooks", { method: "POST", body });
      const data = await response.json().catch(() => ({})) as { deduplicated?: boolean; message?: string; error?: string };
      if (!response.ok) throw new Error(data.message || data.error || "教材上传失败，请重试");
      setNotice(data.deduplicated ? "这本教材已在教材库中，已直接复用现有解析结果。" : "教材已上传，系统正在提取章节、知识和插图。");
      await load({ quiet: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "教材上传失败，请重试");
    } finally {
      setUploading(false);
    }
  }

  async function setArchived(item: TextbookListItem) {
    setMutating(true);
    setError("");
    try {
      const response = await teacherPlatformFetch(`/api/textbooks/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: !item.archivedAt }),
      });
      const data = await response.json().catch(() => ({})) as { message?: string; error?: string };
      if (!response.ok) throw new Error(data.message || data.error || `${item.archivedAt ? "恢复" : "归档"}教材失败`);
      setNotice(item.archivedAt ? "教材已恢复，可继续用于新课程。" : "教材已归档，已有课程引用不会受到影响。");
      setArchiveTarget(null);
      await load({ quiet: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "教材状态更新失败");
    } finally {
      setMutating(false);
    }
  }

  return <TeacherPlatformPage>
    <TeacherPlatformHeader active="textbooks" />
    <div className={`pbl-workspace-content ${styles.page}`}>
      <header className={`pbl-page-heading ${styles.heading}`}>
        <div className={styles.headingCopy}>
          <p className={styles.eyebrow}>教学资源</p>
          <h1>教材库</h1>
          <p>集中管理教材版本、章节结构与知识依据，解析完成后可在不同课程中直接复用。</p>
        </div>
        <div className={styles.uploadArea}>
          <label className={styles.uploadControl}>
            <span className={styles.primaryButton} aria-hidden="true">
              {uploading ? <LoaderCircle className="animate-spin" size={17} /> : <FileUp size={17} />}
              {uploading ? "正在上传…" : "导入教材"}
            </span>
            <input
              aria-label="上传 DOCX 教材"
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="sr-only"
              disabled={uploading}
              type="file"
              onChange={event => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void upload(file);
              }}
            />
          </label>
          <small>支持 DOCX，单文件不超过 80 MiB</small>
        </div>
      </header>

      <dl className={styles.librarySummary} aria-label="教材库概况">
        <div><dt>在库教材</dt><dd>{loading ? "—" : librarySummary.active}</dd><small>当前可管理的教材</small></div>
        <div><dt>已就绪</dt><dd>{loading ? "—" : librarySummary.ready}</dd><small>章节与知识索引可用于课程</small></div>
        <div><dt>处理中</dt><dd>{loading ? "—" : librarySummary.processing}</dd><small>解析进度会自动更新</small></div>
      </dl>

      <div className={styles.toolbar}>
        <label className={styles.search}>
          <Search size={18} />
          <input aria-label="搜索教材" placeholder="搜索书名或作者" value={query} onChange={event => setQuery(event.target.value)} />
        </label>
        <div className={styles.toolbarAside}>
          {!loading ? <span className={styles.resultCount}>显示 {visible.length} / {items.length} 本</span> : null}
          <select aria-label="教材状态" className={styles.filter} value={filter} onChange={event => setFilter(event.target.value)}>
            <option value="active">可用与处理中</option>
            <option value="ready">可用于课程</option>
            <option value="working">正在解析</option>
            <option value="waiting">等待处理</option>
            <option value="failed">解析失败</option>
            <option value="archived">已归档</option>
            <option value="all">全部教材</option>
          </select>
        </div>
      </div>

      {notice ? <p role="status" className={styles.notice}><CheckCircle2 size={16} />{notice}</p> : null}
      {error && !loading ? <PlatformError message={error} onRetry={() => void load()} /> : null}

      {loading ? <PlatformLoading label="正在加载教材库…" /> : visible.length ? <div className={styles.libraryList}>
        <div className={styles.listHeader} aria-hidden="true"><span>教材</span><span>解析状态</span><span>操作</span></div>
        {visible.map((item, index) => {
          const status = statusView(item);
          const progress = progressPercent(item.currentRevision?.progress);
          return <article className={styles.bookRow} key={item.id}>
            <span className={styles.bookMark} aria-hidden="true" data-tone={status.tone}>
              <span className={styles.bookSpine} />
              <BookOpen size={24} strokeWidth={1.55} />
              <small>{String(index + 1).padStart(2, "0")}</small>
            </span>
            <div className={styles.bookIdentity}>
              <h2><Link href={`/teacher/textbooks/${item.id}`}>{item.title}</Link></h2>
              <p>{item.author || item.authors || "作者信息待补充"}</p>
              <small><span>版本 {item.currentRevision?.version ?? 1}</span><span>更新于 {displayDate(item.updatedAt || item.createdAt)}</span></small>
            </div>
            <div className={styles.statusCopy}>
              <div className={styles.statusLine}>
                {status.group === "working" ? <LoaderCircle className="animate-spin" size={15} /> : null}
                <span className={styles.statusBadge} data-tone={status.tone}>{status.label}</span>
                {progress != null && status.group !== "ready" ? <span>{progress}%</span> : null}
              </div>
              {progress != null && status.group !== "ready" ? <div className={styles.progressTrack} aria-label={`解析进度 ${progress}%`}><span style={{ width: `${progress}%` }} /></div> : null}
              <small>{status.group === "ready" ? "章节、图谱和检索索引已就绪" : status.group === "archived" ? "已有课程仍可读取固定版本" : "页面会自动更新处理进度"}</small>
            </div>
            <div className={styles.rowActions}>
              <Link aria-label="查看教材" className={styles.openBookButton} href={`/teacher/textbooks/${item.id}`}><span>打开教材</span><ArrowRight size={15} /></Link>
              <button className={styles.quietButton} type="button" aria-label={item.archivedAt ? `恢复 ${item.title}` : `归档 ${item.title}`} onClick={() => setArchiveTarget(item)}>
                {item.archivedAt ? <RotateCcw size={16} /> : <Archive size={16} />}
              </button>
            </div>
          </article>;
        })}
      </div> : <PlatformEmpty title={query ? "没有找到匹配的教材" : filter === "archived" ? "没有已归档的教材" : "教材库还是空的"} description={query ? "请更换书名或作者关键词后重试。" : "上传 DOCX 教材，系统会自动解析章节、知识、案例和插图。"} />}
    </div>

    <AlertDialog open={Boolean(archiveTarget)} onOpenChange={open => { if (!open && !mutating) setArchiveTarget(null); }}>
      <AlertDialogContent className="pbl-platform-theme">
        <AlertDialogHeader>
          <AlertDialogTitle>{archiveTarget?.archivedAt ? "恢复这本教材？" : "归档这本教材？"}</AlertDialogTitle>
          <AlertDialogDescription>
            {archiveTarget?.archivedAt
              ? "恢复后，这本教材可以再次用于新课程。"
              : "归档后不再供新课程选择；已有课程引用、教材原文和解析结果会继续保留。"}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <button className={styles.secondaryButton} disabled={mutating} type="button" onClick={() => setArchiveTarget(null)}>取消</button>
          <button className={styles.dangerButton} disabled={mutating} type="button" onClick={() => { if (archiveTarget) void setArchived(archiveTarget); }}>
            {mutating ? "正在更新…" : archiveTarget?.archivedAt ? "恢复教材" : "确认归档"}
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </TeacherPlatformPage>;
}
