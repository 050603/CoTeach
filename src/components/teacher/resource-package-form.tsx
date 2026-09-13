"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileArchive, LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import { readJsonResponse } from "@/lib/http/read-json-response";
import {
  RESOURCE_PACKAGE_STAGE_LABELS,
  resourcePackageDraftErrors,
  type CourseResourcePackage,
  type ResourcePackageDraft,
  type ResourcePackageJobSnapshot,
  type ResourcePackageRole,
} from "@/lib/resource-package/types";

const ROLES: Record<ResourcePackageRole, string> = {
  knowledge: "知识点文档", lessonPlan: "完整教案", launchPresentation: "项目启动 PPT",
};
const CONTROL = "min-h-11 w-full rounded-[10px] border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 disabled:bg-stone-50";
const BUTTON = "inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-stone-300 px-3 py-2 text-sm font-medium hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500";
type PackageResponse = { job: ResourcePackageJobSnapshot | null; error?: string; message?: string; detail?: string };

function Field({ label, value, onChange, multiline = false, numeric = false }: {
  label: string; value: string | number | null; onChange: (value: string) => void; multiline?: boolean; numeric?: boolean;
}) {
  return <label className="block min-w-0 space-y-1.5 text-sm font-medium text-stone-700">
    <span>{label}</span>
    {multiline
      ? <textarea className={`${CONTROL} min-h-24 resize-y font-normal leading-6`} onChange={(event) => onChange(event.target.value)} value={value ?? ""} />
      : <input className={`${CONTROL} font-normal`} min={numeric ? 1 : undefined} onChange={(event) => onChange(event.target.value)} step={numeric ? 1 : undefined} type={numeric ? "number" : "text"} value={value ?? ""} />}
  </label>;
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
  const restoredKey = useRef("");
  const dirtyRef = useRef(false);
  const endpoint = `/api/courses/${encodeURIComponent(courseId)}/resource-package`;
  const storageKey = `openpbl:resource-package-draft:${courseId}`;
  const processing = snapshot?.status === "running" || snapshot?.status === "queued";
  const locked = disabled || busy || processing || !loaded;
  const validation = draft ? resourcePackageDraftErrors(draft) : [];

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
    onConfirmed(null);
    try { window.sessionStorage.setItem(storageKey, JSON.stringify({ key: restoredKey.current, draft: next })); } catch { /* Optional draft recovery. */ }
  }

  async function update(body: Record<string, unknown>) {
    setBusy(true);
    setError(undefined);
    onConfirmed(null);
    setDirty(true);
    dirtyRef.current = true;
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
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold text-stone-950">从教学资源包生成课堂</h1>
        <p className="max-w-xl text-sm leading-6 text-stone-600">上传知识点文档、完整教案与项目启动 PPT 所在的 ZIP。确认教学要求后，按教案时间生成五阶段课堂。</p>
      </div>
      <label className={`${BUTTON} ${locked ? "cursor-not-allowed opacity-45" : "cursor-pointer"}`}>
        {busy ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : <FileArchive aria-hidden className="size-4" />}
        {snapshot ? "更换资源包" : "上传资源包（必填）"}
        <input accept=".zip,application/zip,application/x-zip-compressed" aria-label="上传课堂资源包" className="sr-only" disabled={locked} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} type="file" />
      </label>
    </div>
    <p className="text-xs text-stone-500">支持 ZIP，最大 50 MiB。启动 PPT 自动加入第一阶段；其余文档作为教师备课资料。</p>
    {!loaded && !error ? <p aria-live="polite" className="text-sm text-stone-500">正在读取已保存的资源包…</p> : null}
    {snapshot ? <div aria-live="polite" className="space-y-2 text-sm text-stone-600">
      {snapshot.package?.source.fileName ? <p className="break-all font-medium text-stone-800">{snapshot.package.source.fileName}</p> : null}
      <p>{snapshot.message || (processing ? "正在解析资源包…" : "请确认识别结果")}</p>
      {processing ? <progress aria-label="资源包解析进度" className="h-2 w-full accent-stone-700" max={100} value={snapshot.progress} /> : null}
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
    {validation.length ? <ul aria-label="待补充或修正的信息" className="space-y-1 rounded-[10px] bg-amber-50 p-3 text-sm text-amber-800">{validation.map((item) => <li key={item}>{item}</li>)}</ul> : null}
    {snapshot?.candidates && !processing ? <details open={snapshot.status === "needs_selection"} className="border-b border-stone-200 pb-3"><summary className="min-h-11 cursor-pointer py-2 font-medium">资料对应关系与教师原件</summary><fieldset className="space-y-3 pt-2" disabled={locked}>
      <legend className="mb-2 text-sm font-semibold">请选择各类资料对应的文件</legend>
      {(Object.keys(ROLES) as ResourcePackageRole[]).map((role) => <label className="block space-y-1 text-sm" key={role}><span>{ROLES[role]}</span><select className={CONTROL} onChange={(event) => setSelections((current) => ({ ...current, [role]: event.target.value }))} value={selections[role] ?? ""}><option value="">请选择文件</option>{snapshot.candidates?.[role]?.map((path) => <option key={path} value={path}>{path}</option>)}</select></label>)}
      <button className={BUTTON} disabled={!Object.keys(ROLES).every((role) => selections[role as ResourcePackageRole])} onClick={() => void update({ action: "retry", selections })} type="button">使用所选文件继续解析</button>
      {Object.entries(snapshot.package?.documents ?? {}).map(([role, file]) => <a className="block text-sm underline" href={file.url} key={role}>{ROLES[role as ResourcePackageRole]}原件：{file.fileName}</a>)}
    </fieldset></details> : null}
    {draft && snapshot && ["ready", "blocked"].includes(snapshot.status) ? <fieldset className="min-w-0 space-y-5 border-t border-stone-200 pt-5" disabled={locked}>
      <legend className="px-1 text-base font-semibold text-stone-900">确认教学要求</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="课程名称（必填）" onChange={(value) => change({ ...draft, courseName: value })} value={draft.courseName} />
        <Field label="教学对象 / 学段（必填）" onChange={(value) => change({ ...draft, grade: value })} value={draft.grade} />
        <Field label="学科" onChange={(value) => change({ ...draft, subject: value })} value={draft.subject} />
        <Field label="学情补充（可选）" onChange={(value) => change({ ...draft, learnerContext: value })} value={draft.learnerContext} />
      </div>
      <Field label="项目学习驱动问题（必填）" multiline onChange={(value) => change({ ...draft, drivingQuestion: value })} value={draft.drivingQuestion} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="学习目标（必填，每行一项）" multiline onChange={(value) => change({ ...draft, learningObjectives: value.split("\n") })} value={draft.learningObjectives.join("\n")} />
        <Field label="项目成果要求（必填）" multiline onChange={(value) => change({ ...draft, expectedOutcome: value })} value={draft.expectedOutcome} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {([['lessonCount', '课次数'], ['minutesPerLesson', '每课次分钟数'], ['totalMinutes', '课程总分钟数（必填）']] as const).map(([key, label]) => <Field key={key} label={label} numeric onChange={(value) => change({ ...draft, [key]: value === "" ? null : Number(value) })} value={draft[key]} />)}
      </div>
      <section aria-label="五阶段教案安排" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="font-semibold text-stone-900">五阶段教案安排</h2><span className="text-sm text-stone-500">阶段合计 {draft.stages.reduce((sum, stage) => sum + (stage.durationMin || 0), 0)} / {draft.totalMinutes ?? "待填写"} 分钟</span></div>
        <p className="text-sm text-stone-600">按一个学生与 AI 虚拟伙伴协作安排活动，每位学生提交自己的作品。</p>
        {draft.stages.map((stage, index) => <details className="border-b border-stone-200 pb-3" key={stage.key}>
          <summary className="min-h-11 cursor-pointer py-2 font-medium text-stone-800">{index + 1}. {RESOURCE_PACKAGE_STAGE_LABELS[stage.key]} · {stage.durationMin ?? "待填写"} 分钟</summary>
          <div className="space-y-3 pt-2">
            <div className="grid gap-3 sm:grid-cols-2"><Field label={`${RESOURCE_PACKAGE_STAGE_LABELS[stage.key]}标题`} onChange={(value) => change({ ...draft, stages: draft.stages.map((item, i) => i === index ? { ...item, title: value } : item) })} value={stage.title} /><Field label={`${RESOURCE_PACKAGE_STAGE_LABELS[stage.key]}分钟数`} numeric onChange={(value) => change({ ...draft, stages: draft.stages.map((item, i) => i === index ? { ...item, durationMin: value === "" ? null : Number(value) } : item) })} value={stage.durationMin} /></div>
            {([['requirements', '任务与教学活动'], ['outputs', '阶段交付要求'], ['teacherActions', '教师指导'], ['aiActions', 'AI 伙伴支持']] as const).map(([key, label]) => <Field key={key} label={`${RESOURCE_PACKAGE_STAGE_LABELS[stage.key]}：${label}`} multiline onChange={(value) => change({ ...draft, stages: draft.stages.map((item, i) => i === index ? { ...item, [key]: value } : item) })} value={stage[key]} />)}
            {([['checkpoints', '课次检查点'], ['observationPoints', '观察与介入']] as const).map(([key, label]) => <Field key={key} label={`${RESOURCE_PACKAGE_STAGE_LABELS[stage.key]}：${label}（每行一项）`} multiline onChange={(value) => change({ ...draft, stages: draft.stages.map((item, i) => i === index ? { ...item, [key]: value.split("\n").filter(Boolean) } : item) })} value={stage[key]?.join("\n") ?? ""} />)}
          </div>
        </details>)}
      </section>
      <details className="border-b border-stone-200 pb-3">
        <summary className="min-h-11 cursor-pointer py-2 font-medium text-stone-800">必须覆盖的知识点 · {draft.knowledgePoints.length} 类</summary>
        <div className="space-y-5 pt-2">
          {draft.knowledgePoints.map((point, index) => <div className="space-y-3 border-b border-stone-100 pb-4" key={index}>
            <Field label={`知识点 ${index + 1} 名称`} onChange={(value) => change({ ...draft, knowledgePoints: draft.knowledgePoints.map((item, i) => i === index ? { ...item, name: value } : item) })} value={point.name} />
            <Field label={`知识点 ${index + 1} 内容说明`} multiline onChange={(value) => change({ ...draft, knowledgePoints: draft.knowledgePoints.map((item, i) => i === index ? { ...item, description: value } : item) })} value={point.description} />
            <Field label={`知识点 ${index + 1} 子知识点（每行一项，名称：说明）`} multiline onChange={(value) => change({ ...draft, knowledgePoints: draft.knowledgePoints.map((item, i) => i === index ? { ...item, subPoints: value.split("\n"), children: value.split("\n").filter(Boolean).map((text, childIndex) => { const separator = text.indexOf("："); return { id: item.children?.[childIndex]?.id ?? crypto.randomUUID(), name: separator < 0 ? text : text.slice(0, separator), description: separator < 0 ? "" : text.slice(separator + 1), source: item.children?.[childIndex]?.source }; }) } : item) })} value={point.subPoints.join("\n")} />
            <button aria-label={`移除知识点 ${index + 1}`} className={BUTTON} onClick={() => change({ ...draft, knowledgePoints: draft.knowledgePoints.filter((_, i) => i !== index) })} type="button"><Trash2 aria-hidden className="size-4" />移除知识点</button>
          </div>)}
          <button className={BUTTON} onClick={() => change({ ...draft, knowledgePoints: [...draft.knowledgePoints, { name: "", description: "", subPoints: [] }] })} type="button"><Plus aria-hidden className="size-4" />添加知识点</button>
        </div>
      </details>
      <details className="border-b border-stone-200 pb-3"><summary className="min-h-11 cursor-pointer py-2 font-medium">最终交付物 · {draft.finalDeliverables?.length ?? 0} 项</summary><div className="space-y-4 pt-2">{draft.finalDeliverables?.map((item, index) => <div className="space-y-2" key={item.id}><Field label={`交付物 ${index + 1} 名称`} onChange={(value) => change({ ...draft, finalDeliverables: draft.finalDeliverables?.map((entry, i) => i === index ? { ...entry, name: value } : entry) })} value={item.name} /><Field label={`交付物 ${index + 1} 格式`} onChange={(value) => change({ ...draft, finalDeliverables: draft.finalDeliverables?.map((entry, i) => i === index ? { ...entry, format: value } : entry) })} value={item.format} /><Field label={`交付物 ${index + 1} 要求`} multiline onChange={(value) => change({ ...draft, finalDeliverables: draft.finalDeliverables?.map((entry, i) => i === index ? { ...entry, requirements: value } : entry) })} value={item.requirements} /><button className={BUTTON} onClick={() => change({ ...draft, finalDeliverables: draft.finalDeliverables?.filter((_, i) => i !== index) })} type="button">移除此交付物</button></div>)}<button className={BUTTON} onClick={() => change({ ...draft, finalDeliverables: [...(draft.finalDeliverables ?? []), { id: crypto.randomUUID(), name: "", format: "document", requirements: "", required: true }] })} type="button">添加最终交付物</button></div></details>
      <details className="border-b border-stone-200 pb-3">
        <summary className="min-h-11 cursor-pointer py-2 font-medium text-stone-800">评价标准与反思要点</summary>
        <div className="space-y-3 pt-2"><Field label="课程评价标准 / 量规" multiline onChange={(value) => change({ ...draft, evaluationCriteria: value })} value={draft.evaluationCriteria} />
        {draft.originalEvaluationSources ? <p className="rounded bg-amber-50 p-3 text-sm leading-6">包内原评分安排：{draft.originalEvaluationSources}</p> : null}
        <p className="text-sm text-stone-600">正式评分采用教师与 AI 两个来源；维度及权重按资源包确认。授权适配时默认教师60%、AI40%，可在这里修改。</p>
        <div className="grid gap-3 sm:grid-cols-2">{(["teacher", "ai"] as const).map((key) => <Field key={key} numeric label={`${key === "teacher" ? "教师" : "AI"}评分来源比例（%）`} value={draft.evaluationRubric?.sourceWeights[key] ?? (key === "teacher" ? 60 : 40)} onChange={(value) => change({ ...draft, evaluationRubric: { ...(draft.evaluationRubric ?? { id: crypto.randomUUID(), version: 1, dimensions: [], sourceWeights: { teacher: 60, ai: 40 } }), sourceWeights: { ...(draft.evaluationRubric?.sourceWeights ?? { teacher: 60, ai: 40 }), [key]: Number(value) } } })} />)}</div>
        {draft.evaluationRubric?.dimensions.map((item, index) => <div className="space-y-2 border-t border-stone-200 pt-3" key={item.id}><div className="grid gap-3 sm:grid-cols-2"><Field label={`评价维度 ${index + 1} 名称`} value={item.name} onChange={(value) => change({ ...draft, evaluationRubric: { ...draft.evaluationRubric!, dimensions: draft.evaluationRubric!.dimensions.map((entry, i) => i === index ? { ...entry, name: value } : entry) } })} /><Field numeric label={`评价维度 ${index + 1} 权重（%）`} value={item.weight} onChange={(value) => change({ ...draft, evaluationRubric: { ...draft.evaluationRubric!, dimensions: draft.evaluationRubric!.dimensions.map((entry, i) => i === index ? { ...entry, weight: Number(value) } : entry) } })} /></div><Field multiline label={`评价维度 ${index + 1} 判据`} value={item.description} onChange={(value) => change({ ...draft, evaluationRubric: { ...draft.evaluationRubric!, dimensions: draft.evaluationRubric!.dimensions.map((entry, i) => i === index ? { ...entry, description: value } : entry) } })} /><button className={BUTTON} onClick={() => change({ ...draft, evaluationRubric: { ...draft.evaluationRubric!, dimensions: draft.evaluationRubric!.dimensions.filter((_, i) => i !== index) } })} type="button">移除此评价维度</button></div>)}
        <button className={BUTTON} onClick={() => change({ ...draft, evaluationRubric: { ...(draft.evaluationRubric ?? { id: crypto.randomUUID(), version: 1, sourceWeights: { teacher: 60, ai: 40 }, dimensions: [] }), dimensions: [...(draft.evaluationRubric?.dimensions ?? []), { id: crypto.randomUUID(), name: "", description: "", weight: 0 }] } })} type="button">添加评价维度</button>
        <Field label="反思要点（每行一项）" multiline onChange={(value) => change({ ...draft, reflectionQuestions: value.split("\n"), reflectionQuestionSet: { id: draft.reflectionQuestionSet?.id ?? crypto.randomUUID(), version: draft.reflectionQuestionSet?.version ?? 1, questions: value.split("\n").filter(Boolean).map((prompt, index) => ({ id: draft.reflectionQuestionSet?.questions[index]?.id ?? crypto.randomUUID(), prompt, required: true })) } })} value={draft.reflectionQuestions.join("\n")} /></div>
      </details>
      <div className="flex flex-wrap items-center gap-3">
        <button className={BUTTON} disabled={validation.length > 0 || (!dirty && Boolean(snapshot.package?.confirmedAt))} onClick={() => void update({ action: "confirm", revision: snapshot.package?.revision, draft })} type="button">{busy ? "正在保存…" : "确认并保存教学要求"}</button>
        <span aria-live="polite" className="text-sm text-stone-600">{!dirty && snapshot.package?.confirmedAt ? "教学要求已确认，可开始生成课堂" : dirty ? "有修改待确认，草稿已保留" : "请核对自动识别的教学要求"}</span>
        {snapshot.status === "blocked" && snapshot.package?.conflictVersion ? <button className={`${BUTTON} border-amber-600 bg-amber-100`} disabled={validation.length > 0} onClick={() => void update({ action: "adapt", revision: snapshot.package?.revision, conflictVersion: snapshot.package?.conflictVersion, draft })} type="button">按系统流程适配后继续</button> : null}
      </div>
    </fieldset> : null}
  </section>;
}
