"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { teacherPlatformFetch } from "@/lib/platform/client";
import type { SurveyKeywordMode } from "@/lib/platform/survey-keyword-settings";
import { cn } from "@/lib/utils";

const MODES: Array<{ mode: SurveyKeywordMode; label: string; description: string }> = [
  { mode: "local", label: "本地高频词", description: "完全离线并过滤套话，按学生统计原词频；不合并同义表达。" },
  { mode: "llm", label: "AI 主题聚合", description: "先提取原文证据，再把全班同义表达归并为简短主题；首次分析稍慢。" },
];

async function readMode(response: Response): Promise<SurveyKeywordMode> {
  const data = await response.json().catch(() => null) as { mode?: unknown; message?: string } | null;
  if (!response.ok || data?.mode !== "local" && data?.mode !== "llm") {
    throw new Error(data?.message || "暂时无法更新问卷分析设置，请重试。");
  }
  return data.mode;
}

export function SurveyKeywordSettings() {
  const [mode, setMode] = useState<SurveyKeywordMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadRevision, setLoadRevision] = useState(0);
  const [saving, setSaving] = useState<SurveyKeywordMode | null>(null);
  const [error, setError] = useState("");
  const [retryMode, setRetryMode] = useState<SurveyKeywordMode | null>(null);
  const [notice, setNotice] = useState("");
  const saveInFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void teacherPlatformFetch("/api/platform/survey-settings", { cache: "no-store", signal: controller.signal })
      .then(readMode)
      .then((savedMode) => { if (!controller.signal.aborted) setMode(savedMode); })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取问卷分析设置。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [loadRevision]);

  async function save(nextMode: SurveyKeywordMode) {
    if (saveInFlight.current || loading || !mode || nextMode === mode) return;
    saveInFlight.current = true;
    setSaving(nextMode);
    setError("");
    setNotice("");
    setRetryMode(null);
    try {
      const response = await teacherPlatformFetch("/api/platform/survey-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: nextMode }),
        cache: "no-store",
      });
      const savedMode = await readMode(response);
      setMode(savedMode);
      setNotice(`已保存：${savedMode === "local" ? "本地高频词" : "AI 主题聚合"}。重新打开问卷或等待看板自动更新即可生效。`);
    } catch (reason) {
      setRetryMode(nextMode);
      setError(reason instanceof Error ? reason.message : "问卷分析设置保存失败。");
    } finally {
      saveInFlight.current = false;
      setSaving(null);
    }
  }

  function retry() {
    if (retryMode) { void save(retryMode); return; }
    setError("");
    setLoading(true);
    setLoadRevision((revision) => revision + 1);
  }

  return <section aria-labelledby="survey-keyword-settings-heading" aria-busy={loading || saving !== null} className="rounded-[14px] border border-[var(--pbl-border)] bg-white p-5 sm:p-6">
    <h2 id="survey-keyword-settings-heading" className="text-xl font-semibold text-[var(--pbl-text-strong)]">问卷主题云分析</h2>
    <p className="mt-2 text-sm leading-6 text-[var(--pbl-text-muted)]">仅对当前教师查看问卷时生效。点击下方按钮即可保存分析方式。</p>
    <div aria-label="问卷词云分析方式" role="group" className="mt-4 grid gap-3 sm:grid-cols-2">
      {MODES.map((option) => <button type="button" key={option.mode} aria-pressed={mode === option.mode} disabled={loading || saving !== null || mode === null} onClick={() => void save(option.mode)} className={cn("min-h-11 rounded-[10px] border px-4 py-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--pbl-teacher)] disabled:cursor-wait disabled:opacity-60", mode === option.mode ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)]" : "border-[var(--pbl-border)] bg-white hover:border-[var(--pbl-teacher)]")}>
        <span className="flex items-center gap-2 text-sm font-semibold text-[var(--pbl-text-strong)]">{saving === option.mode ? <Loader2 aria-hidden="true" className="animate-spin" size={16}/> : mode === option.mode ? <Check aria-hidden="true" size={16}/> : null}{option.label}</span>
        <span className="mt-1 block text-sm leading-6 text-[var(--pbl-text-muted)]">{option.description}</span>
      </button>)}
    </div>
    <p className="mt-3 text-sm leading-6 text-[var(--pbl-text-muted)]">分析结果会缓存；新回答和方式切换产生的分析会在后台更新，看板自动刷新。</p>
    <p role="status" className="mt-2 min-h-6 text-sm text-[var(--pbl-teacher)]">{loading ? "正在读取分析设置…" : saving ? "正在保存分析方式…" : notice}</p>
    {error ? <div role="alert" className="mt-2 flex flex-wrap items-center gap-3 text-sm text-[var(--pbl-danger)]"><span>{error}</span><button type="button" onClick={retry} className="inline-flex min-h-11 items-center gap-2 rounded-[8px] px-3 font-medium underline"><RefreshCw aria-hidden="true" size={15}/>{retryMode ? "重试保存" : "重新加载"}</button></div> : null}
  </section>;
}
