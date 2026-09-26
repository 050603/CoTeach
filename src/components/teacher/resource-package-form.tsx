"use client";

import { browserRandomUUID } from "@/lib/browser/random-uuid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCircle2, CircleAlert, Clock3, FileArchive, FileCheck2, LoaderCircle, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { readJsonResponse } from "@/lib/http/read-json-response";
import {
  RESOURCE_PACKAGE_STAGE_LABELS,
  inferResourcePackageShowcasePlan,
  resourcePackageDraftIssues,
  type CourseResourcePackage,
  type ResourcePackageDraft,
  type ResourcePackageDraftIssueSection,
  type ResourcePackageJobSnapshot,
  type ResourcePackageRole,
  type ResourcePackageSource,
} from "@/lib/resource-package/types";

const ROLES: Record<ResourcePackageRole, string> = {
  knowledge: "知识点文档", lessonPlan: "完整教案", launchPresentation: "项目启动 PPT",
};
const CONTROL = "min-h-11 w-full rounded-[10px] border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 disabled:bg-stone-50";
const BUTTON = "inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-stone-300 px-3 py-2 text-sm font-medium hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500";
type PackageResponse = { job: ResourcePackageJobSnapshot | null; error?: string; message?: string; detail?: string };

function Field({ label, value, onChange, multiline = false, numeric = false, min, max, hint, invalid = false }: {
  label: string; value: string | number | null; onChange: (value: string) => void; multiline?: boolean; numeric?: boolean;
  min?: number; max?: number; hint?: string; invalid?: boolean;
}) {
  return <label className="block min-w-0 space-y-1.5 text-sm font-medium text-stone-700">
    <span>{label}</span>
    {multiline
      ? <textarea aria-invalid={invalid || undefined} className={`${CONTROL} min-h-24 resize-y font-normal leading-6 ${invalid ? "border-red-500" : ""}`} onChange={(event) => onChange(event.target.value)} value={value ?? ""} />
      : <input aria-invalid={invalid || undefined} className={`${CONTROL} font-normal ${invalid ? "border-red-500" : ""}`} max={numeric ? max : undefined} min={numeric ? (min ?? 1) : undefined} onChange={(event) => onChange(event.target.value)} step={numeric ? 1 : undefined} type={numeric ? "number" : "text"} value={value ?? ""} />}
    {hint ? <span className="block text-xs font-normal leading-5 text-stone-500">{hint}</span> : null}
  </label>;
}

const REVIEW_SECTIONS: { key: ResourcePackageDraftIssueSection; label: string; description: string }[] = [
  { key: "overview", label: "课程概况", description: "核对对象、目标与成果" },
  { key: "schedule", label: "课时计划", description: "核对总时长与课次" },
  { key: "stages", label: "五阶段安排", description: "核对任务、角色与产出" },
  { key: "knowledge", label: "知识与证据", description: "核对知识范围与来源" },
  { key: "assessment", label: "交付与评价", description: "核对交付物、量规与反思" },
];

const EVIDENCE_STATUS = { SUPPORTED: "已有来源支持", PARTIAL: "部分内容待核对", UNSUPPORTED: "缺少来源支持" } as const;

function SourceEvidence({ sources }: { sources?: ResourcePackageSource[] }) {
  if (!sources?.length) return null;
  return <details className="mt-2 text-xs text-stone-600">
    <summary className="min-h-11 cursor-pointer py-2 font-medium text-stone-600 underline decoration-stone-300 underline-offset-4">查看解析来源 · {sources.length} 条</summary>
    <ul className="space-y-2 pb-2">{sources.map((source, index) => <li className="border-l-2 border-stone-200 pl-3 leading-5" key={`${source.documentRole}-${source.locator}-${index}`}>
      <p className="font-medium text-stone-700">{ROLES[source.documentRole]} · {source.locator}</p>
      <p className="whitespace-pre-wrap break-words text-stone-600">{source.quote}</p>
    </li>)}</ul>
  </details>;
}

function optionalNumber(value: string): number | undefined {
  return value === "" ? undefined : Number(value);
}

export function ResourcePackageForm({ courseId, disabled, onConfirmed, onPackagePresent }: {
  courseId: string;
  disabled: boolean;
  onConfirmed: (value: CourseResourcePackage | null) => void;
  onPackagePresent?: (value: boolean) => void;
}) {
  const [snapshot, setSnapshot] = useState<ResourcePackageJobSnapshot | null>(null);
  const [draft, setDraft] = useState<ResourcePackageDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [selections, setSelections] = useState<Partial<Record<ResourcePackageRole, string>>>({});
  const [planningAcknowledged, setPlanningAcknowledged] = useState(false);
  const restoredKey = useRef("");
  const dirtyRef = useRef(false);
  const endpoint = `/api/courses/${encodeURIComponent(courseId)}/resource-package`;
  const storageKey = `openpbl:resource-package-draft:${courseId}`;
  const processing = snapshot?.status === "running" || snapshot?.status === "queued";
  const locked = disabled || busy || processing || !loaded;
  const validationIssues = useMemo(() => draft ? resourcePackageDraftIssues(draft) : [], [draft]);
  const validation = validationIssues.map((issue) => issue.message);
  const stageTotal = draft?.stages.reduce((sum, stage) => sum + (stage.durationMin || 0), 0) ?? 0;
  const requiredPlanningIssues = snapshot?.package?.planningIssues?.filter((issue) => issue.requiresAcknowledgement) ?? [];
  const sectionIssueCounts = Object.fromEntries(REVIEW_SECTIONS.map((section) => [section.key, validationIssues.filter((issue) => issue.section === section.key).length])) as Record<ResourcePackageDraftIssueSection, number>;
  const sourceEvidenceCount = draft ? Object.values(draft.sourceEvidence ?? {}).reduce((total, sources) => total + sources.length, 0)
    + draft.knowledgePoints.reduce((total, point) => total + (point.source ? 1 : 0) + (point.children?.filter((child) => child.source).length ?? 0), 0) : 0;
  const knowledgeItemCount = draft?.knowledgePoints.reduce((total, point) => total + (point.children?.length || point.subPoints.length), 0) ?? 0;
  const workflowStep = !snapshot ? 0 : processing || snapshot.status === "needs_selection" ? 0 : draft && !snapshot.package?.confirmedAt ? 1 : dirty ? 1 : 2;

  const applySnapshot = useCallback((next: ResourcePackageJobSnapshot | null, discardLocal = false) => {
    setSnapshot(next);
    onPackagePresent?.(Boolean(next));
    setLoaded(true);
    const pack = next?.package;
    const key = pack ? `${pack.id}:${pack.revision}` : "";
    if (discardLocal || key !== restoredKey.current) {
      restoredKey.current = key;
      let restored: ResourcePackageDraft | null = null;
      if (pack && !discardLocal) {
        try {
          const saved = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null") as { key?: string; draft?: ResourcePackageDraft } | null;
          if (saved?.key === key && saved.draft) restored = saved.draft;
        } catch { /* Storage may be unavailable; the server copy remains authoritative. */ }
      }
      setDraft(restored ?? pack?.draft ?? null);
      setDirty(Boolean(restored));
      dirtyRef.current = Boolean(restored);
      const requiredIssueIds = (pack?.planningIssues ?? []).filter((issue) => issue.requiresAcknowledgement).map((issue) => issue.id).sort();
      const savedIssueIds = [...(pack?.planningAcknowledgement?.issueIds ?? [])].sort();
      setPlanningAcknowledged(!restored && Boolean(requiredIssueIds.length && pack?.planningIssueVersion === pack?.planningAcknowledgement?.issueVersion
        && requiredIssueIds.join("\n") === savedIssueIds.join("\n")));
      onConfirmed(next?.status === "ready" && pack?.confirmedAt && !restored ? pack : null);
    } else {
      onConfirmed(next?.status === "ready" && pack?.confirmedAt && !dirtyRef.current ? pack : null);
    }
    if (next?.candidates) setSelections((current) => {
      const selected: Partial<Record<ResourcePackageRole, string>> = {};
      for (const role of Object.keys(ROLES) as ResourcePackageRole[]) {
        const candidates = next.candidates?.[role] ?? [];
        const retained = current[role];
        if (retained && candidates.includes(retained)) selected[role] = retained;
        else if (next.package?.documents[role]) selected[role] = candidates.find((name) => name.split("/").pop() === next.package?.documents[role]?.fileName) ?? "";
        else if (candidates.length === 1) selected[role] = candidates[0];
      }
      return selected;
    });
  }, [onConfirmed, onPackagePresent, storageKey]);

  const load = useCallback(async () => {
    const response = await fetch(endpoint, { cache: "no-store" });
    const payload = await readJsonResponse<PackageResponse>(response, "无法读取资源包，请重试。");
    if (!response.ok) throw new Error(payload.detail || payload.message || payload.error || "无法读取资源包");
    applySnapshot(payload.job);
    setError(undefined);
  }, [applySnapshot, endpoint]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch((cause) => setError(cause instanceof Error ? cause.message : "资源包读取失败")), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(() => void load().catch((cause) => setError(cause instanceof Error ? cause.message : "状态同步失败，请重试")), 2_000);
    return () => window.clearInterval(timer);
  }, [load, processing]);

  function change(next: ResourcePackageDraft) {
    setDraft(next);
    setDirty(true);
    dirtyRef.current = true;
    setPlanningAcknowledged(false);
    onConfirmed(null);
    try { window.sessionStorage.setItem(storageKey, JSON.stringify({ key: restoredKey.current, draft: next })); } catch { /* Optional draft recovery. */ }
  }

  function restoreParsedDraft() {
    const pack = snapshot?.package;
    if (!pack) return;
    setDraft(pack.draft);
    setDirty(false);
    dirtyRef.current = false;
    const expected = (pack.planningIssues ?? []).filter((issue) => issue.requiresAcknowledgement).map((issue) => issue.id).sort();
    const saved = [...(pack.planningAcknowledgement?.issueIds ?? [])].sort();
    setPlanningAcknowledged(Boolean(expected.length && pack.planningIssueVersion === pack.planningAcknowledgement?.issueVersion && expected.join("\n") === saved.join("\n")));
    try { window.sessionStorage.removeItem(storageKey); } catch { /* Optional draft recovery. */ }
    onConfirmed(snapshot?.status === "ready" && pack.confirmedAt ? pack : null);
  }

  function updateStage(index: number, patch: Partial<ResourcePackageDraft["stages"][number]>, refreshShowcasePlan = false) {
    if (!draft) return;
    const stages = draft.stages.map((stage, current) => current === index ? { ...stage, ...patch } : stage);
    const updated = stages[index];
    change({ ...draft, stages, ...(refreshShowcasePlan && updated?.key === "showcase" ? { showcasePlan: { ...draft.showcasePlan, ...inferResourcePackageShowcasePlan(updated) } } : {}) });
  }

  async function update(body: Record<string, unknown>) {
    setBusy(true);
    setError(undefined);
    onConfirmed(null);
    setDirty(true);
    dirtyRef.current = true;
    setPlanningAcknowledged(false);
    try {
      const response = await fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await readJsonResponse<PackageResponse>(response, "资源包保存失败，请重试。");
      if (!response.ok) throw new Error(payload.detail || payload.message || payload.error || "资源包保存失败");
      try { window.sessionStorage.removeItem(storageKey); } catch { /* Optional storage. */ }
      applySnapshot(payload.job, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "资源包保存失败");
    } finally { setBusy(false); }
  }

  async function upload(file: File) {
    if (locked) return;
    if (!/\.zip$/i.test(file.name)) { setError("请上传 ZIP 格式的完整资源包。"); return; }
    if (file.size > 50 * 1024 * 1024) { setError("资源包不能超过 50 MiB。"); return; }
    onPackagePresent?.(true);
    setBusy(true);
    setError(undefined);
    onConfirmed(null);
    setDirty(true);
    dirtyRef.current = true;
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("courseId", courseId);
      form.append("purpose", "course-resource-package");
      const uploadResponse = await fetch("/api/uploads", { method: "POST", body: form });
      const uploaded = await readJsonResponse<{ id?: string; error?: string; message?: string }>(uploadResponse, "资源包上传失败，请重试。");
      if (!uploadResponse.ok || !uploaded.id) throw new Error(uploaded.message || uploaded.error || "资源包上传失败");
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uploadId: uploaded.id }) });
      const payload = await readJsonResponse<PackageResponse>(response, "资源包解析未启动，请重试。");
      if (!response.ok) throw new Error(payload.detail || payload.message || payload.error || "资源包解析未启动");
      try { window.sessionStorage.removeItem(storageKey); } catch { /* Optional storage. */ }
      applySnapshot(payload.job, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "资源包上传失败");
    } finally { setBusy(false); }
  }

  return <section aria-label="课堂资源包" className="mb-6 space-y-5 rounded-[14px] border border-stone-300 bg-white p-4 sm:p-6">
    <header className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">课程资料导入</p>
          <h1 className="text-xl font-semibold text-stone-950">解析并确认课程资源包</h1>
          <p className="max-w-2xl text-sm leading-6 text-stone-600">系统从知识点文档、完整教案和启动课件中提取课程要求。请先核对必填项、时间与证据，再用于课堂生成。</p>
        </div>
        <label className={`${BUTTON} ${!snapshot ? "border-stone-900 bg-stone-900 text-white hover:bg-stone-800" : ""} ${locked ? "cursor-not-allowed opacity-45" : "cursor-pointer"}`}>
          {busy ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <FileArchive aria-hidden className="size-4" />}
          {snapshot ? "更换资源包" : "上传资源包（必填）"}
          <input accept=".zip,application/zip,application/x-zip-compressed" aria-label="上传课堂资源包" className="sr-only" disabled={locked} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} type="file" />
        </label>
      </div>
      <ol aria-label="资源包处理步骤" className="grid grid-cols-3 gap-2 border-y border-stone-200 py-3">
        {["导入资料", "核对解析", "确认使用"].map((label, index) => <li className={`flex min-w-0 items-center gap-2 text-xs sm:text-sm ${index <= workflowStep ? "font-medium text-stone-900" : "text-stone-400"}`} key={label}>
          <span aria-hidden className={`grid size-7 shrink-0 place-items-center rounded-full border ${index < workflowStep ? "border-emerald-700 bg-emerald-700 text-white" : index === workflowStep ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300"}`}>{index < workflowStep ? <Check className="size-4" /> : index + 1}</span>
          <span className="truncate">{label}</span>
        </li>)}
      </ol>
      <p className="text-xs leading-5 text-stone-500">ZIP 最大 50 MiB，需包含 KNOWLEDGE Markdown、LESSON_PLAN Markdown 和项目启动 PPTX。历史课程中已保存的 DOCX 仍可继续使用。</p>
    </header>
    {!loaded && !error ? <p aria-live="polite" className="text-sm text-stone-500">正在读取已保存的资源包…</p> : null}
    {snapshot ? <div aria-live="polite" className="space-y-3 border-l-2 border-stone-300 pl-4 text-sm text-stone-600">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="break-all font-medium text-stone-900">{snapshot.package?.source.fileName ?? "资源包已上传"}</p>
        <span className="text-xs text-stone-500">{processing ? `解析 ${snapshot.progress}%` : snapshot.status === "ready" ? "解析完成" : snapshot.status === "blocked" ? "等待处理冲突" : "等待核对"}</span>
      </div>
      <p>{snapshot.message || (processing ? "正在解析资源包…" : "请确认识别结果")}</p>
      {processing ? <progress aria-label="资源包解析进度" className="h-2 w-full accent-stone-700" max={100} value={snapshot.progress} /> : null}
      {processing ? <p className="text-xs text-stone-500">当前步骤：{snapshot.step === "convert" ? "转换启动课件" : "识别资料并提取字段"}。刷新页面不会中断处理。</p> : null}
    </div> : null}
    {error || snapshot?.status === "failed" ? <div className="space-y-2 rounded-[10px] bg-red-50 p-3 text-sm text-red-800" role="alert">
      <p>{error || snapshot?.error || snapshot?.message || "解析未完成，请重试。"}</p>
      <button className={BUTTON} disabled={disabled || busy || processing} onClick={() => void (snapshot?.status === "failed" ? update({ action: "retry", selections }) : load().catch((cause) => setError(cause instanceof Error ? cause.message : "读取失败")))} type="button"><RefreshCw aria-hidden className="size-4" />{snapshot?.status === "failed" ? "重试解析与课件转换" : "重新读取状态"}</button>
    </div> : null}
    {snapshot?.package?.conflicts?.length && !snapshot.package.adaptation ? <section aria-label="资源包兼容性冲突" className="space-y-3 rounded-[10px] border border-amber-300 bg-amber-50 p-4">
      <h2 className="font-semibold text-amber-950">先处理课堂流程冲突</h2>
      <p className="text-sm leading-6 text-amber-900">以下内容与本课堂流程不同，尚未改写。可以下载反馈让上游系统修正，也可以在补齐教学要求后明确授权统一适配。</p>
      {snapshot.package.conflicts.map((issue) => <details key={issue.id} className="border-t border-amber-200 pt-3"><summary className="cursor-pointer font-medium">{issue.summary}</summary><div className="space-y-2 pt-2 text-sm leading-6"><p>{issue.reason}</p><p>建议：{issue.suggestion}</p><ul className="space-y-2">{issue.evidence.map((source, index) => <li key={index} className="rounded bg-white/70 p-2"><strong>{ROLES[source.documentRole]} · {source.locator}</strong><p className="whitespace-pre-wrap">{source.quote}</p></li>)}</ul></div></details>)}
      <a className={BUTTON} download href={`${endpoint}?download=feedback`}>下载上游修改反馈</a>
    </section> : null}
    {snapshot?.package?.adaptation ? <details className="rounded-[10px] border border-emerald-200 bg-emerald-50 p-4"><summary className="cursor-pointer font-medium text-emerald-950">已按教师授权统一适配 · 查看变更</summary><ul className="mt-3 space-y-2 text-sm text-emerald-900">{snapshot.package.adaptation.changes.map((item) => <li key={item}>{item}</li>)}</ul>{snapshot.package.classroomPresentation ? <a className={`${BUTTON} mt-3`} href={snapshot.package.classroomPresentation.url}>下载适配授课版 PPT</a> : null}</details> : null}
    {snapshot?.package?.handoff ? <section aria-label="上游交接版本" className="rounded-[10px] border border-stone-200 bg-stone-50 p-4 text-sm leading-6 text-stone-700">
      <h2 className="font-semibold text-stone-900">上游交接版本</h2>
      <p>格式 v{snapshot.package.handoff.handoffFormatVersion} · 项目 {snapshot.package.handoff.projectId} · 交接包 {snapshot.package.handoff.packageId} · 演示版本 {snapshot.package.handoff.presentationVersion}</p>
      <p>知识点资源 v{snapshot.package.handoff.documents.knowledge.resourceVersion} · 教案资源 v{snapshot.package.handoff.documents.lessonPlan.resourceVersion}</p>
    </section> : null}
    {draft && snapshot && ["ready", "blocked"].includes(snapshot.status) ? <section aria-label="解析概览" className="space-y-4 border-y border-stone-200 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="font-semibold text-stone-950">解析概览</h2><p className="mt-1 text-sm text-stone-600">按分区核对；带有待处理标记的内容会阻止确认。</p></div>
        <span className={`inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium ${validation.length ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-900"}`}>{validation.length ? <CircleAlert className="size-4" /> : <CheckCircle2 className="size-4" />}{validation.length ? `${validation.length} 项待处理` : "必填项已完整"}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <div><dt className="text-xs text-stone-500">已识别资料</dt><dd className="mt-1 text-lg font-semibold text-stone-900">{Object.keys(snapshot.package?.documents ?? {}).length} 份</dd></div>
        <div><dt className="text-xs text-stone-500">知识条目</dt><dd className="mt-1 text-lg font-semibold text-stone-900">{knowledgeItemCount} 项</dd></div>
        <div><dt className="text-xs text-stone-500">阶段时长</dt><dd className="mt-1 text-lg font-semibold text-stone-900">{stageTotal} 分钟</dd></div>
        <div><dt className="text-xs text-stone-500">来源定位</dt><dd className="mt-1 text-lg font-semibold text-stone-900">{sourceEvidenceCount} 条</dd></div>
      </dl>
      <nav aria-label="解析结果分区" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">{REVIEW_SECTIONS.map((section, index) => <a className="min-h-16 rounded-[10px] border border-stone-200 px-3 py-2 text-sm hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500" href={`#resource-package-${section.key}`} key={section.key}>
        <span className="flex items-center justify-between gap-2 font-medium text-stone-900"><span>{index + 1}. {section.label}</span>{sectionIssueCounts[section.key] ? <span className="text-xs text-amber-800">待处理 {sectionIssueCounts[section.key]}</span> : <CheckCircle2 aria-label="已完整" className="size-4 text-emerald-700" />}</span>
        <span className="mt-1 block text-xs leading-5 text-stone-500">{section.description}</span>
      </a>)}</nav>
    </section> : null}
    {snapshot?.package?.planningIssues?.length ? <section aria-label="上游规划核对" className="space-y-3 rounded-[10px] border border-amber-300 bg-amber-50 p-4">
      <h2 className="font-semibold text-amber-950">上游规划核对</h2>
      {snapshot.package.planningIssues.map((issue) => <details key={issue.id} className="border-t border-amber-200 pt-3" open={issue.requiresAcknowledgement}>
        <summary className="cursor-pointer font-medium text-amber-950">{issue.requiresAcknowledgement ? "待确认" : "证据提示"} · {issue.summary}</summary>
        <div className="space-y-2 pt-2 text-sm leading-6 text-amber-900"><p>{issue.detail}</p><p>处理建议：{issue.suggestion}</p>{issue.evidence.length ? <ul className="space-y-2">{issue.evidence.map((source, index) => <li className="rounded bg-white/70 p-2" key={index}><strong>{ROLES[source.documentRole]} · {source.locator}</strong><p className="whitespace-pre-wrap">{source.quote}</p></li>)}</ul> : null}</div>
      </details>)}
      {requiredPlanningIssues.length ? <label className="flex items-start gap-2 text-sm font-medium text-amber-950">
        <input checked={planningAcknowledged} className="mt-1 size-4" disabled={locked} onChange={(event) => setPlanningAcknowledged(event.target.checked)} type="checkbox" />
        <span>我已核对上述规划问题；未修改的冲突按当前五阶段时间表和个人任务方式继续。</span>
      </label> : null}
    </section> : null}
    {validation.length ? <section aria-label="待补充或修正的信息" className="rounded-[10px] border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <h2 className="flex items-center gap-2 font-semibold"><CircleAlert className="size-4" />确认前还需处理 {validation.length} 项</h2>
      <ul className="mt-2 space-y-1.5">{validationIssues.map((issue) => <li key={issue.id}><a className="underline decoration-amber-400 underline-offset-4" href={`#resource-package-${issue.section}`}>{issue.message}</a></li>)}</ul>
    </section> : null}
    {snapshot?.candidates && !processing ? <details open={snapshot.status === "needs_selection"} className="border-b border-stone-200 pb-3"><summary className="min-h-11 cursor-pointer py-2 font-medium">资料对应关系与教师原件</summary><fieldset className="space-y-3 pt-2" disabled={locked}>
      <legend className="mb-2 text-sm font-semibold">请选择各类资料对应的文件</legend>
      {(Object.keys(ROLES) as ResourcePackageRole[]).map((role) => <label className="block space-y-1 text-sm" key={role}><span>{ROLES[role]}</span><select className={CONTROL} onChange={(event) => setSelections((current) => ({ ...current, [role]: event.target.value }))} value={selections[role] ?? ""}><option value="">请选择文件</option>{snapshot.candidates?.[role]?.map((path) => <option key={path} value={path}>{path}</option>)}</select></label>)}
      <button className={BUTTON} disabled={!Object.keys(ROLES).every((role) => selections[role as ResourcePackageRole])} onClick={() => void update({ action: "retry", selections })} type="button">使用所选文件继续解析</button>
      {Object.entries(snapshot.package?.documents ?? {}).map(([role, file]) => <a className="block text-sm underline" href={file.url} key={role}>{ROLES[role as ResourcePackageRole]}原件：{file.fileName}</a>)}
    </fieldset></details> : null}
    {draft && snapshot && ["ready", "blocked"].includes(snapshot.status) ? <fieldset className="min-w-0 space-y-5 border-t border-stone-200 pt-5" disabled={locked}>
      <legend className="sr-only">确认教学要求</legend>
      <section className="scroll-mt-4 space-y-4" id="resource-package-overview">
        <div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold text-stone-950">1. 课程概况</h2><p className="mt-1 text-sm text-stone-600">决定生成内容的对象、目标与最终方向。</p></div>{sectionIssueCounts.overview ? <span className="text-xs font-medium text-amber-800">待处理 {sectionIssueCounts.overview}</span> : <CheckCircle2 className="size-5 text-emerald-700" />}</div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div><Field invalid={!draft.courseName.trim()} label="课程名称（必填）" onChange={(value) => change({ ...draft, courseName: value })} value={draft.courseName} /><SourceEvidence sources={draft.sourceEvidence?.courseName} /></div>
          <div><Field invalid={!draft.grade.trim()} label="授课对象（专业、年级或学段，必填）" onChange={(value) => change({ ...draft, grade: value })} value={draft.grade} /><SourceEvidence sources={draft.sourceEvidence?.grade} /></div>
          <Field label="学科 / 课程领域" onChange={(value) => change({ ...draft, subject: value })} value={draft.subject} />
          {draft.learnerContext.trim() || draft.sourceEvidence?.learnerContext?.length ? <div><Field label="学情参考" multiline onChange={(value) => change({ ...draft, learnerContext: value })} value={draft.learnerContext} /><SourceEvidence sources={draft.sourceEvidence?.learnerContext} /></div> : null}
        </div>
        <div><Field invalid={!draft.drivingQuestion.trim()} label="项目学习驱动问题（必填）" multiline onChange={(value) => change({ ...draft, drivingQuestion: value })} value={draft.drivingQuestion} /><SourceEvidence sources={draft.sourceEvidence?.drivingQuestion} /></div>
        {draft.projectTask || draft.sourceEvidence?.projectTask?.length ? <div><Field label="项目任务" multiline onChange={(value) => change({ ...draft, projectTask: value })} value={draft.projectTask ?? ""} /><SourceEvidence sources={draft.sourceEvidence?.projectTask} /></div> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <div><Field invalid={!draft.learningObjectives.some((item) => item.trim())} label="课程学习目标（必填，每行一项）" multiline onChange={(value) => change({ ...draft, learningObjectives: value.split("\n") })} value={draft.learningObjectives.join("\n")} /><SourceEvidence sources={draft.sourceEvidence?.learningObjectives} /></div>
          <div><Field invalid={!draft.expectedOutcome.trim()} label="预期成果（总体要求，必填）" multiline onChange={(value) => change({ ...draft, expectedOutcome: value })} value={draft.expectedOutcome} /><SourceEvidence sources={draft.sourceEvidence?.expectedOutcome} /></div>
        </div>
        {draft.teachingHighlights?.length || draft.teachingDifficulties?.length || draft.sourceEvidence?.teachingHighlights?.length || draft.sourceEvidence?.teachingDifficulties?.length ? <div className="grid gap-4 rounded-[10px] border border-stone-200 bg-stone-50 p-4 sm:grid-cols-2">
          {draft.teachingHighlights?.length || draft.sourceEvidence?.teachingHighlights?.length ? <div><Field label="AI知识教学重点（每行一项）" multiline onChange={(value) => change({ ...draft, teachingHighlights: value.split("\n").filter(Boolean) })} value={draft.teachingHighlights?.join("\n") ?? ""} /><SourceEvidence sources={draft.sourceEvidence?.teachingHighlights} /></div> : null}
          {draft.teachingDifficulties?.length || draft.sourceEvidence?.teachingDifficulties?.length ? <div><Field label="AI知识理解难点（每行一项）" multiline onChange={(value) => change({ ...draft, teachingDifficulties: value.split("\n").filter(Boolean) })} value={draft.teachingDifficulties?.join("\n") ?? ""} /><SourceEvidence sources={draft.sourceEvidence?.teachingDifficulties} /></div> : null}
        </div> : null}
      </section>
      <section className="scroll-mt-4 space-y-4 border-t border-stone-200 pt-5" id="resource-package-schedule">
        <div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold text-stone-950">2. 课时计划</h2><p className="mt-1 text-sm text-stone-600">总时长需同时等于课次计算值和五阶段合计。</p></div>{sectionIssueCounts.schedule || sectionIssueCounts.stages ? <Clock3 className="size-5 text-amber-700" /> : <CheckCircle2 className="size-5 text-emerald-700" />}</div>
        <div className="grid gap-3 sm:grid-cols-3">
          {([['lessonCount', '课次'], ['minutesPerLesson', '每课次分钟数'], ['totalMinutes', '课程总分钟数（必填）']] as const).map(([key, label]) => <Field invalid={validationIssues.some((issue) => issue.id === ({ lessonCount: "lesson-count", minutesPerLesson: "minutes-per-lesson", totalMinutes: "total-minutes" } as const)[key])} key={key} label={label} numeric onChange={(value) => change({ ...draft, [key]: value === "" ? null : Number(value) })} value={draft[key]} />)}
        </div>
        <div className={`flex flex-wrap items-center justify-between gap-3 rounded-[10px] px-3 py-2 text-sm ${stageTotal === draft.totalMinutes ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}>
          <span>五阶段合计 <strong>{stageTotal}</strong> 分钟；当前课程总时长 <strong>{draft.totalMinutes ?? "未填写"}</strong> 分钟。</span>
          {stageTotal > 0 && stageTotal !== draft.totalMinutes ? <button className={BUTTON} onClick={() => change({ ...draft, totalMinutes: stageTotal })} type="button">采用阶段合计</button> : null}
        </div>
      </section>
      {draft.preClassPreparation?.length || draft.organizationRequirements?.length || draft.aiUsagePolicy || draft.facilitatorReference?.length || snapshot.package?.draft.preClassPreparation?.length || snapshot.package?.draft.organizationRequirements?.length || snapshot.package?.draft.aiUsagePolicy || snapshot.package?.draft.facilitatorReference?.length ? <details className="border-b border-stone-200 pb-3">
        <summary className="min-h-11 cursor-pointer py-2 font-medium text-stone-800">上游备课约束与主持参考</summary>
        <div className="space-y-3 pt-2">
          {draft.preClassPreparation?.length || snapshot.package?.draft.preClassPreparation?.length ? <div><Field label="课前准备（每行一项）" multiline onChange={(value) => change({ ...draft, preClassPreparation: value.split("\n").filter(Boolean) })} value={draft.preClassPreparation?.join("\n") ?? ""} /><SourceEvidence sources={draft.sourceEvidence?.preClassPreparation} /></div> : null}
          {draft.organizationRequirements?.length || snapshot.package?.draft.organizationRequirements?.length ? <div><Field label="组织与完成方式（每行一项）" multiline onChange={(value) => change({ ...draft, organizationRequirements: value.split("\n").filter(Boolean) })} value={draft.organizationRequirements?.join("\n") ?? ""} /><SourceEvidence sources={draft.sourceEvidence?.organizationRequirements} /></div> : null}
          {draft.aiUsagePolicy || snapshot.package?.draft.aiUsagePolicy ? <Field label="学生使用 AI 的边界" multiline onChange={(value) => change({ ...draft, aiUsagePolicy: value })} value={draft.aiUsagePolicy ?? ""} /> : null}
          {draft.facilitatorReference?.length || snapshot.package?.draft.facilitatorReference?.length ? <div><Field label="教师主持要点（每行一项）" multiline onChange={(value) => change({ ...draft, facilitatorReference: value.split("\n").filter(Boolean) })} value={draft.facilitatorReference?.join("\n") ?? ""} /><SourceEvidence sources={draft.sourceEvidence?.facilitatorReference} /></div> : null}
        </div>
      </details> : null}
      <section aria-label="五阶段教案安排" className="scroll-mt-4 space-y-3 border-t border-stone-200 pt-5" id="resource-package-stages">
        <div className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="font-semibold text-stone-950">3. 五阶段安排</h2><p className="mt-1 text-sm text-stone-600">阶段任务、产出和角色会直接进入课堂生成。</p></div><span className="text-sm text-stone-500">阶段合计 {stageTotal} / {draft.totalMinutes ?? "待填写"} 分钟</span></div>
        <p className="text-sm text-stone-600">按一个学生与 AI 虚拟伙伴协作安排活动，每位学生提交自己的作品。</p>
        {draft.stages.map((stage, index) => <details className="border-b border-stone-200 pb-3" key={stage.key}>
          <summary className="min-h-11 cursor-pointer py-2 font-medium text-stone-800"><span className="inline-flex items-center gap-2"><span className="grid size-7 place-items-center rounded-full bg-stone-100 text-xs">{index + 1}</span>{RESOURCE_PACKAGE_STAGE_LABELS[stage.key]} · {stage.durationMin ?? "待填写"} 分钟</span></summary>
          <div className="space-y-3 pt-2">
            <div className="grid gap-3 sm:grid-cols-2"><Field label={`${RESOURCE_PACKAGE_STAGE_LABELS[stage.key]}标题`} onChange={(value) => updateStage(index, { title: value })} value={stage.title} /><Field invalid={!Number.isInteger(stage.durationMin) || (stage.durationMin ?? 0) <= 0} label={`${RESOURCE_PACKAGE_STAGE_LABELS[stage.key]}分钟数`} numeric onChange={(value) => updateStage(index, { durationMin: value === "" ? null : Number(value) })} value={stage.durationMin} /></div>
            {([['requirements', '学生行动'], ['outputs', '阶段产出'], ['teacherActions', '教师行动'], ['aiActions', 'AI职责']] as const).filter(([key]) => stage[key].trim() || snapshot.package?.draft.stages[index]?.[key]?.trim()).map(([key, label]) => <Field key={key} label={`${RESOURCE_PACKAGE_STAGE_LABELS[stage.key]}：${label}`} multiline onChange={(value) => updateStage(index, { [key]: value }, true)} value={stage[key]} />)}
            {([['checkpoints', '课次检查点'], ['observationPoints', '观察与介入']] as const).filter(([key]) => stage[key]?.length || snapshot.package?.draft.stages[index]?.[key]?.length).map(([key, label]) => <Field key={key} label={`${RESOURCE_PACKAGE_STAGE_LABELS[stage.key]}：${label}（每行一项）`} multiline onChange={(value) => updateStage(index, { [key]: value.split("\n").filter(Boolean) })} value={stage[key]?.join("\n") ?? ""} />)}
            {stage.key === "showcase" && (draft.showcasePlan && Object.values(draft.showcasePlan).some((value) => value !== undefined) || snapshot.package?.draft.showcasePlan && Object.values(snapshot.package.draft.showcasePlan).some((value) => value !== undefined)) ? <div className="space-y-3 border-l-2 border-stone-200 pl-4"><div><h3 className="text-sm font-semibold text-stone-900">现场展示安排</h3><p className="mt-1 text-xs leading-5 text-stone-500">从成果展示文本自动识别，教师可以明确修正。</p></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {draft.showcasePlan?.presenterCount !== undefined || snapshot.package?.draft.showcasePlan?.presenterCount !== undefined ? <Field label="现场汇报人数" numeric onChange={(value) => change({ ...draft, showcasePlan: { ...(draft.showcasePlan ?? {}), presenterCount: optionalNumber(value) } })} value={draft.showcasePlan?.presenterCount ?? null} /> : null}
              {draft.showcasePlan?.presentationSec !== undefined || snapshot.package?.draft.showcasePlan?.presentationSec !== undefined ? <Field label="每人展示（秒）" min={0} numeric onChange={(value) => change({ ...draft, showcasePlan: { ...(draft.showcasePlan ?? {}), presentationSec: optionalNumber(value) } })} value={draft.showcasePlan?.presentationSec ?? null} /> : null}
              {draft.showcasePlan?.discussionSec !== undefined || snapshot.package?.draft.showcasePlan?.discussionSec !== undefined ? <Field label="交流讨论（秒）" min={0} numeric onChange={(value) => change({ ...draft, showcasePlan: { ...(draft.showcasePlan ?? {}), discussionSec: optionalNumber(value) } })} value={draft.showcasePlan?.discussionSec ?? null} /> : null}
              {draft.showcasePlan?.transitionSec !== undefined || snapshot.package?.draft.showcasePlan?.transitionSec !== undefined ? <Field label="换场衔接（秒）" min={0} numeric onChange={(value) => change({ ...draft, showcasePlan: { ...(draft.showcasePlan ?? {}), transitionSec: optionalNumber(value) } })} value={draft.showcasePlan?.transitionSec ?? null} /> : null}
            </div><SourceEvidence sources={draft.sourceEvidence?.showcasePlan} /></div> : null}
            <SourceEvidence sources={draft.sourceEvidence?.[`stages.${stage.key}`]} />
          </div>
        </details>)}
      </section>
      <details className="scroll-mt-4 border-b border-t border-stone-200 py-3" id="resource-package-knowledge" open={sectionIssueCounts.knowledge > 0 || undefined}>
        <summary className="min-h-11 cursor-pointer py-2 font-medium text-stone-900">4. 知识与证据 · {draft.knowledgePoints.length} 个主题 / {knowledgeItemCount} 个条目</summary>
        <div className="space-y-5 pt-2">
          {draft.knowledgeEvidenceSummary ? <p className="rounded-[10px] bg-stone-100 p-3 text-sm leading-6 text-stone-700">总体证据：{EVIDENCE_STATUS[draft.knowledgeEvidenceSummary.overallStatus]}{draft.knowledgeEvidenceSummary.gaps.length ? `；${draft.knowledgeEvidenceSummary.gaps.join("；")}` : ""}</p> : null}
          {draft.knowledgePoints.map((point, index) => <div className="space-y-3 border-b border-stone-100 pb-4" key={point.id ?? index}>
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-semibold uppercase tracking-wide text-stone-500">知识主题 {index + 1}</span>{point.evidenceStatus ? <span className={`rounded-full px-2 py-1 text-xs ${point.evidenceStatus === "SUPPORTED" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{EVIDENCE_STATUS[point.evidenceStatus]}</span> : null}</div>
            <Field label={`知识点 ${index + 1} 名称`} onChange={(value) => change({ ...draft, knowledgePoints: draft.knowledgePoints.map((item, i) => i === index ? { ...item, name: value } : item) })} value={point.name} />
            <Field label={`知识点 ${index + 1} 内容说明`} multiline onChange={(value) => change({ ...draft, knowledgePoints: draft.knowledgePoints.map((item, i) => i === index ? { ...item, description: value } : item) })} value={point.description} />
            <Field hint="修改名称与说明时，系统会保留已解析的任务关联、来源标识和原文定位。" label={`知识点 ${index + 1} 子知识点（每行一项，名称：说明）`} multiline onChange={(value) => change({ ...draft, knowledgePoints: draft.knowledgePoints.map((item, i) => i === index ? { ...item, subPoints: value.split("\n"), children: value.split("\n").filter(Boolean).map((text, childIndex) => { const separator = text.indexOf("："); const name = separator < 0 ? text : text.slice(0, separator); const existing = item.children?.find((child) => child.name === name) ?? item.children?.[childIndex]; return { ...existing, id: existing?.id ?? browserRandomUUID(), name, description: separator < 0 ? "" : text.slice(separator + 1) }; }) } : item) })} value={point.subPoints.join("\n")} />
            <details className="border-l-2 border-stone-200 pl-3"><summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-stone-700">证据状态与任务关联</summary><div className="space-y-3 pb-2">
              <label className="block space-y-1.5 text-sm font-medium text-stone-700"><span>证据状态</span><select className={CONTROL} onChange={(event) => change({ ...draft, knowledgePoints: draft.knowledgePoints.map((item, i) => i === index ? { ...item, evidenceStatus: event.target.value as "SUPPORTED" | "PARTIAL" | "UNSUPPORTED" } : item) })} value={point.evidenceStatus ?? "SUPPORTED"}>{Object.entries(EVIDENCE_STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <Field label="证据缺口" multiline onChange={(value) => change({ ...draft, knowledgePoints: draft.knowledgePoints.map((item, i) => i === index ? { ...item, evidenceGap: value } : item) })} value={point.evidenceGap ?? ""} />
              {point.taskAssociation ? <Field label="任务关联" multiline onChange={(value) => change({ ...draft, knowledgePoints: draft.knowledgePoints.map((item, i) => i === index ? { ...item, taskAssociation: value } : item) })} value={point.taskAssociation} /> : null}
              <Field label="来源标识（每行一项）" multiline onChange={(value) => change({ ...draft, knowledgePoints: draft.knowledgePoints.map((item, i) => i === index ? { ...item, sources: value.split("\n").filter(Boolean) } : item) })} value={point.sources?.join("\n") ?? ""} />
              <SourceEvidence sources={point.source ? [point.source] : undefined} />
            </div></details>
            <button aria-label={`移除知识点 ${index + 1}`} className={BUTTON} onClick={() => change({ ...draft, knowledgePoints: draft.knowledgePoints.filter((_, i) => i !== index) })} type="button"><Trash2 aria-hidden className="size-4" />移除知识点</button>
          </div>)}
          <button className={BUTTON} onClick={() => change({ ...draft, knowledgePoints: [...draft.knowledgePoints, { name: "", description: "", subPoints: [] }] })} type="button"><Plus aria-hidden className="size-4" />添加知识点</button>
        </div>
      </details>
      <section className="scroll-mt-4 space-y-3 border-t border-stone-200 pt-5" id="resource-package-assessment">
      <div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold text-stone-950">5. 交付与评价</h2><p className="mt-1 text-sm text-stone-600">结构化交付物、量规和反思题会进入正式课堂。</p></div>{sectionIssueCounts.assessment ? <span className="text-xs font-medium text-amber-800">待处理 {sectionIssueCounts.assessment}</span> : <CheckCircle2 className="size-5 text-emerald-700" />}</div>
      <details className="border-b border-stone-200 pb-3"><summary className="min-h-11 cursor-pointer py-2 font-medium">最终交付物 · {draft.finalDeliverables?.length ?? 0} 项</summary><div className="space-y-4 pt-2">{draft.finalDeliverables?.map((item, index) => <div className="space-y-2 border-l-2 border-stone-200 pl-3" key={item.id}><Field label={`交付物 ${index + 1} 名称`} onChange={(value) => change({ ...draft, finalDeliverables: draft.finalDeliverables?.map((entry, i) => i === index ? { ...entry, name: value } : entry) })} value={item.name} /><Field label={`交付物 ${index + 1} 格式`} onChange={(value) => change({ ...draft, finalDeliverables: draft.finalDeliverables?.map((entry, i) => i === index ? { ...entry, format: value } : entry) })} value={item.format} /><Field label={`交付物 ${index + 1} 要求`} multiline onChange={(value) => change({ ...draft, finalDeliverables: draft.finalDeliverables?.map((entry, i) => i === index ? { ...entry, requirements: value } : entry) })} value={item.requirements} /><label className="flex min-h-11 items-center gap-2 text-sm text-stone-700"><input checked={item.required} className="size-4" onChange={(event) => change({ ...draft, finalDeliverables: draft.finalDeliverables?.map((entry, i) => i === index ? { ...entry, required: event.target.checked } : entry) })} type="checkbox" /><span>必须提交</span></label><button className={BUTTON} onClick={() => change({ ...draft, finalDeliverables: draft.finalDeliverables?.filter((_, i) => i !== index) })} type="button">移除此交付物</button></div>)}<button className={BUTTON} onClick={() => change({ ...draft, finalDeliverables: [...(draft.finalDeliverables ?? []), { id: browserRandomUUID(), name: "", format: "document", requirements: "", required: true }] })} type="button">添加最终交付物</button></div></details>
      <details className="border-b border-stone-200 pb-3">
        <summary className="min-h-11 cursor-pointer py-2 font-medium text-stone-800">评价标准与反思要点</summary>
        <div className="space-y-3 pt-2"><Field label="课程评价标准 / 量规" multiline onChange={(value) => change({ ...draft, evaluationCriteria: value })} value={draft.evaluationCriteria} />
        {draft.originalEvaluationSources ? <p className="rounded bg-amber-50 p-3 text-sm leading-6">包内原评分安排：{draft.originalEvaluationSources}</p> : null}
        <p className="text-sm text-stone-600">正式评分采用教师与 AI 两个来源；维度及权重按资源包确认。授权适配时默认教师60%、AI40%，可在这里修改。</p>
        <div className="grid gap-3 sm:grid-cols-2">{(["teacher", "ai"] as const).map((key) => <Field key={key} max={100} min={0} numeric label={`${key === "teacher" ? "教师" : "AI"}评分来源比例（%）`} value={draft.evaluationRubric?.sourceWeights[key] ?? (key === "teacher" ? 60 : 40)} onChange={(value) => change({ ...draft, evaluationRubric: { ...(draft.evaluationRubric ?? { id: browserRandomUUID(), version: 1, dimensions: [], sourceWeights: { teacher: 60, ai: 40 } }), sourceWeights: { ...(draft.evaluationRubric?.sourceWeights ?? { teacher: 60, ai: 40 }), [key]: Number(value) } } })} />)}</div>
        {draft.evaluationRubric ? <p className="text-xs text-stone-500">评分来源合计 {draft.evaluationRubric.sourceWeights.teacher + draft.evaluationRubric.sourceWeights.ai}%；评价维度合计 {draft.evaluationRubric.dimensions.reduce((sum, item) => sum + item.weight, 0)}%。</p> : null}
        {draft.evaluationRubric?.dimensions.map((item, index) => <div className="space-y-2 border-t border-stone-200 pt-3" key={item.id}><div className="grid gap-3 sm:grid-cols-2"><Field label={`评价维度 ${index + 1} 名称`} value={item.name} onChange={(value) => change({ ...draft, evaluationRubric: { ...draft.evaluationRubric!, dimensions: draft.evaluationRubric!.dimensions.map((entry, i) => i === index ? { ...entry, name: value } : entry) } })} /><Field max={100} min={0} numeric label={`评价维度 ${index + 1} 权重（%）`} value={item.weight} onChange={(value) => change({ ...draft, evaluationRubric: { ...draft.evaluationRubric!, dimensions: draft.evaluationRubric!.dimensions.map((entry, i) => i === index ? { ...entry, weight: Number(value) } : entry) } })} /></div><Field multiline label={`评价维度 ${index + 1} 判据`} value={item.description} onChange={(value) => change({ ...draft, evaluationRubric: { ...draft.evaluationRubric!, dimensions: draft.evaluationRubric!.dimensions.map((entry, i) => i === index ? { ...entry, description: value } : entry) } })} /><button className={BUTTON} onClick={() => change({ ...draft, evaluationRubric: { ...draft.evaluationRubric!, dimensions: draft.evaluationRubric!.dimensions.filter((_, i) => i !== index) } })} type="button">移除此评价维度</button></div>)}
        <button className={BUTTON} onClick={() => change({ ...draft, evaluationRubric: { ...(draft.evaluationRubric ?? { id: browserRandomUUID(), version: 1, sourceWeights: { teacher: 60, ai: 40 }, dimensions: [] }), dimensions: [...(draft.evaluationRubric?.dimensions ?? []), { id: browserRandomUUID(), name: "", description: "", weight: 0 }] } })} type="button">添加评价维度</button>
        <Field label="学生反思问题（每行一题）" multiline onChange={(value) => { const prompts = value.split("\n").filter(Boolean); change({ ...draft, reflectionQuestions: value.split("\n"), reflectionQuestionSet: { id: draft.reflectionQuestionSet?.id ?? browserRandomUUID(), version: draft.reflectionQuestionSet?.version ?? 1, questions: prompts.map((prompt) => { const existing = draft.reflectionQuestionSet?.questions.find((question) => question.prompt === prompt); return { id: existing?.id ?? browserRandomUUID(), prompt, required: existing?.required ?? true }; }) } }); }} value={draft.reflectionQuestions.join("\n")} /></div>
      </details>
      </section>
      <div className="sticky bottom-3 z-10 flex flex-col gap-3 rounded-[14px] border border-stone-300 bg-white/95 p-3 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0"><p aria-live="polite" className="text-sm font-medium text-stone-800">{!dirty && snapshot.package?.confirmedAt ? "教学要求已确认，可开始生成课堂" : dirty ? "有修改待确认，草稿已在本机保留" : "请核对自动识别的教学要求"}</p>{validation.length ? <p className="mt-1 text-xs text-amber-800">还有 {validation.length} 项需要处理</p> : requiredPlanningIssues.length && !planningAcknowledged ? <p className="mt-1 text-xs text-amber-800">请先确认上游规划问题</p> : null}</div>
        <div className="flex flex-wrap gap-2">
        {dirty ? <button className={BUTTON} onClick={restoreParsedDraft} type="button"><RotateCcw aria-hidden className="size-4" />恢复本次解析结果</button> : null}
        <button className={`${BUTTON} border-stone-900 bg-stone-900 text-white hover:bg-stone-800`} disabled={validation.length > 0 || (requiredPlanningIssues.length > 0 && !planningAcknowledged) || (!dirty && Boolean(snapshot.package?.confirmedAt))} onClick={() => void update({ action: "confirm", revision: snapshot.package?.revision, draft,
          ...(snapshot.package?.planningIssueVersion && planningAcknowledged ? { acknowledgement: { issueVersion: snapshot.package.planningIssueVersion, issueIds: requiredPlanningIssues.map((issue) => issue.id) } } : {}) })} type="button">{busy ? <><LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />正在保存…</> : <><FileCheck2 aria-hidden className="size-4" />确认并保存教学要求</>}</button>
        {snapshot.status === "blocked" && snapshot.package?.conflictVersion ? <button className={`${BUTTON} border-amber-600 bg-amber-100`} disabled={validation.length > 0} onClick={() => void update({ action: "adapt", revision: snapshot.package?.revision, conflictVersion: snapshot.package?.conflictVersion, draft })} type="button">按系统流程适配后继续</button> : null}
        </div>
      </div>
    </fieldset> : null}
  </section>;
}
