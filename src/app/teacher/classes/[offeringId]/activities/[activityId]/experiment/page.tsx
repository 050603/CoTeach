"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ClipboardCopy, Download, Eye, FileUp, ListPlus, Save } from "lucide-react";
import { TeacherPlatformHeader, TeacherPlatformPage } from "@/components/platform/teacher-shell";
import { ExperimentQuestionBuilder, prepareExperiment, validateExperiment } from "@/components/platform/experiment-question-builder";
import { ExperimentPreview } from "@/components/platform/experiment-preview";
import { teacherPlatformFetch } from "@/lib/platform/client";
import { EXPERIMENT_BULK_EXAMPLE, exportExperimentConfigJson, importExperimentConfigJson, parseExperimentQuestionRows } from "@/lib/platform/experiment-bulk";
import { ExperimentConfigSchema, groupExperimentQuestions, type ExperimentConfig, type ExperimentQuestion } from "@/lib/platform/experiment";
import { clientUUID } from "@/lib/uuid";

type ClassroomActivity = { id: string; title: string; type: string; version: number; config?: Record<string, unknown> & { experiment?: ExperimentConfig } };
type Offering = { id: string; name: string; chapters: Array<{ id: string; title: string; activities: ClassroomActivity[] }> };
type QuestionBank = "sharedQuestions" | "pretest" | "posttest";
type SourceQuestion = { bank: string; question: ExperimentQuestion };

const emptyExperiment: ExperimentConfig = { enabled: false, sharedQuestions: [], pretest: [], posttest: [], randomizeQuestionOrder: true, randomizeOptionOrder: true };
const bankLabels: Record<QuestionBank, string> = { sharedQuestions: "前后测共用", pretest: "前测专属", posttest: "后测专属" };
const field = "min-h-11 w-full rounded-lg border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-3 py-2 text-sm";
const secondary = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-4 text-sm font-medium disabled:opacity-50";
const primary = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[var(--pbl-teacher)] px-5 text-sm font-semibold text-white disabled:opacity-50";

function cloneQuestion(question: ExperimentQuestion): ExperimentQuestion {
  return { ...question, id: clientUUID(), ...(question.options ? { options: [...question.options] } : {}), ...(Array.isArray(question.correctAnswer) ? { correctAnswer: [...question.correctAnswer] } : {}), ...(question.scale ? { scale: { ...question.scale } } : {}), ...(question.group ? { group: { ...question.group, id: clientUUID() } } : {}) };
}

function sourceQuestionGroups(config: ExperimentConfig) {
  return (["sharedQuestions", "pretest", "posttest"] as const).flatMap((sourceBank) =>
    groupExperimentQuestions(config[sourceBank]).flatMap((section) => section.group ? [{ sourceBank, group: section.group, questions: section.questions }] : []));
}

function sourceQuestions(config: ExperimentConfig): SourceQuestion[] {
  return [
    ...config.sharedQuestions.map((question) => ({ bank: "共用题", question })),
    ...config.pretest.map((question) => ({ bank: "前测题", question })),
    ...config.posttest.map((question) => ({ bank: "后测题", question })),
  ];
}

export default function TeacherClassroomExperimentPage() {
  const { offeringId, activityId } = useParams<{ offeringId: string; activityId: string }>();
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [draft, setDraft] = useState<ExperimentConfig>(emptyExperiment);
  const [tab, setTab] = useState<"edit" | "reuse" | "preview">("edit");
  const [sourceId, setSourceId] = useState("");
  const [bank, setBank] = useState<QuestionBank>("sharedQuestions");
  const [bulkText, setBulkText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await teacherPlatformFetch("/api/platform/offerings", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "无法加载实验配置");
      const rows = (data.offerings ?? []) as Offering[];
      const target = rows.find((row) => row.id === offeringId)?.chapters.flatMap((chapter) => chapter.activities).find((activity) => activity.id === activityId && activity.type === "Classroom");
      if (!target) throw new Error("课堂不存在，或您没有编辑权限");
      const saved = ExperimentConfigSchema.safeParse(target.config?.experiment);
      setOfferings(rows);
      setDraft(saved.success ? saved.data : emptyExperiment);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法加载实验配置");
    } finally {
      setLoading(false);
    }
  }, [activityId, offeringId]);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const offering = offerings.find((row) => row.id === offeringId);
  const targetChapter = offering?.chapters.find((chapter) => chapter.activities.some((activity) => activity.id === activityId));
  const target = targetChapter?.activities.find((activity) => activity.id === activityId);
  const sources = offerings.flatMap((row) => row.chapters.flatMap((chapter) => chapter.activities.flatMap((activity) => {
    if (activity.id === activityId || activity.type !== "Classroom") return [];
    const parsed = ExperimentConfigSchema.safeParse(activity.config?.experiment);
    if (!parsed.success || !sourceQuestions(parsed.data).length && !parsed.data.scenarioPair) return [];
    return [{ id: activity.id, title: activity.title, course: row.name, chapter: chapter.title, config: parsed.data }];
  })));
  const selectedSource = sources.find((source) => source.id === sourceId);
  const selectedSourceGroups = selectedSource ? sourceQuestionGroups(selectedSource.config) : [];
  const totalPre = draft.sharedQuestions.length + draft.pretest.length + (draft.scenarioPair ? 1 : 0);
  const totalPost = draft.sharedQuestions.length + draft.posttest.length + (draft.scenarioPair ? 1 : 0);

  function applyConfig(config: ExperimentConfig, message: string) {
    setDraft({ ...config, enabled: true });
    setError("");
    setNotice(message);
    setTab("edit");
  }

  function appendQuestions(questions: ExperimentQuestion[], message: string) {
    if (draft[bank].length + questions.length > 30) {
      setError(`${bankLabels[bank]}最多设置 30 道题目，请减少导入数量`);
      return;
    }
    setDraft((current) => ({ ...current, enabled: true, [bank]: [...current[bank], ...questions] }));
    setError("");
    setNotice(message);
    setTab("edit");
  }

  function importRows() {
    const result = parseExperimentQuestionRows(bulkText);
    if (!result.ok) { setError(result.errors.join("；")); return; }
    appendQuestions(result.questions, `已添加 ${result.questions.length} 道${bankLabels[bank]}题目，请检查后保存`);
    if (draft[bank].length + result.questions.length <= 30) setBulkText("");
  }

  function copyEntireSource() {
    if (!selectedSource) return;
    const copied = importExperimentConfigJson(exportExperimentConfigJson(selectedSource.config));
    if (!copied.ok) { setError(copied.errors.join("；")); return; }
    applyConfig(copied.config, `已复制“${selectedSource.title}”的整套实验配置，保存后应用到本课堂`);
  }

  function copyScenarioPair() {
    if (!selectedSource?.config.scenarioPair) return;
    const pair = selectedSource.config.scenarioPair;
    setDraft((current) => ({ ...current, enabled: true, scenarioPair: { a: cloneQuestion(pair.a), b: cloneQuestion(pair.b) } }));
    setError(""); setNotice("已复制 A/B 情境题，请检查后保存"); setTab("edit");
  }

  function copyQuestionGroup(questions: ExperimentQuestion[], title: string) {
    const groupId = clientUUID();
    appendQuestions(questions.map((question) => ({ ...cloneQuestion(question), group: question.group ? { ...question.group, id: groupId } : undefined })), `已复制“${title}”题组到${bankLabels[bank]}，请检查后保存`);
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    try {
      const result = importExperimentConfigJson(await file.text());
      if (!result.ok) { setError(result.errors.join("；")); return; }
      applyConfig(result.config, `已导入“${file.name}”，保存后应用到本课堂`);
    } catch { setError("无法读取配置文件，请使用本页面导出的 JSON 文件"); }
  }

  function downloadConfig() {
    const prepared = prepareExperiment(draft);
    const result = ExperimentConfigSchema.safeParse(prepared);
    if (!result.success) { setError(validateExperiment(draft) ?? "请先完善题目再导出"); return; }
    const blob = new Blob([exportExperimentConfigJson(result.data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `experiment-${activityId}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setNotice("实验配置文件已导出");
  }

  async function save() {
    if (!target || busy) return;
    const validation = validateExperiment(draft);
    if (validation) { setError(validation); setTab("edit"); return; }
    const prepared = prepareExperiment(draft);
    const parsed = ExperimentConfigSchema.safeParse(prepared);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "实验配置有误"); setTab("edit"); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await teacherPlatformFetch(`/api/platform/activities/${activityId}/manage`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { ...(target.config ?? {}), schemaVersion: 1, experiment: parsed.data }, version: target.version }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "无法保存实验配置");
      await load();
      setNotice("实验配置已保存到本课堂");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法保存实验配置"); }
    finally { setBusy(false); }
  }

  return <TeacherPlatformPage>
    <TeacherPlatformHeader active="classes" compact backHref={`/teacher/classes/${offeringId}`} backLabel="返回教学班" />
    <div className="pbl-workspace-content mx-auto max-w-6xl space-y-6 pb-20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-[0.18em] text-[var(--pbl-teacher)]">课堂实验模式</p>
          <h1 className="mt-2 text-2xl font-semibold text-[var(--pbl-text-strong)] md:text-3xl">前后测配置</h1>
          <p className="mt-2 text-sm text-[var(--pbl-text-muted)]">{offering?.name ?? "正在加载教学班"}{targetChapter ? ` · ${targetChapter.title}` : ""}{target ? ` · ${target.title}` : ""}</p>
        </div>
        <div className="flex flex-wrap gap-2"><Link className={secondary} href={`/teacher/classes/${offeringId}`}><ArrowLeft size={16} />返回课程</Link><button type="button" className={primary} disabled={loading || busy || !target} onClick={() => void save()}><Save size={16} />{busy ? "保存中…" : "保存实验配置"}</button></div>
      </div>
      {loading ? <p role="status" className="rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-6 text-sm">正在加载实验配置…</p> : null}
      {error ? <p role="alert" className="rounded-lg border border-[var(--pbl-danger)] bg-[var(--pbl-surface)] p-3 text-sm text-[var(--pbl-danger)]">{error}</p> : null}
      {notice ? <p role="status" className="rounded-lg border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-3 text-sm text-[var(--pbl-teacher)]">{notice}</p> : null}
      {!loading && target ? <>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-4"><small className="text-[var(--pbl-text-muted)]">实验模式</small><strong className="mt-1 block text-lg">{draft.enabled ? "已开启" : "未开启"}</strong></div>
          <div className="rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-4"><small className="text-[var(--pbl-text-muted)]">前测题数</small><strong className="mt-1 block text-lg">{totalPre}</strong></div>
          <div className="rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-4"><small className="text-[var(--pbl-text-muted)]">后测题数</small><strong className="mt-1 block text-lg">{totalPost}</strong></div>
        </div>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="实验配置步骤">
          {([["edit", "编辑题目", ListPlus], ["reuse", "批量添加与复用", ClipboardCopy], ["preview", "学生视角预览", Eye]] as const).map(([key, label, Icon]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={`${secondary} ${tab === key ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]" : ""}`} onClick={() => { setTab(key); setError(""); }}><Icon size={16} />{label}</button>)}
        </div>
        {tab === "edit" ? <div role="tabpanel" className="rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-4 md:p-6"><ExperimentQuestionBuilder value={draft} onChange={(next) => { setDraft(next); setNotice(""); }} /></div> : null}
        {tab === "reuse" ? <div role="tabpanel" className="space-y-6">
          <section className="rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-4 md:p-6">
            <h2 className="text-lg font-semibold">从已有课堂复制</h2><p className="mt-1 text-sm text-[var(--pbl-text-muted)]">选择您名下任一教学班的课堂。整套复制会替换当前草稿；单题复制会追加到所选题组。保存后才会应用到学生测验。</p>
            <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]"><select className={field} aria-label="选择已有课堂" value={sourceId} onChange={(event) => setSourceId(event.target.value)}><option value="">选择已有实验课堂</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.course} · {source.chapter} · {source.title}</option>)}</select><button type="button" className={primary} disabled={!selectedSource} onClick={copyEntireSource}><ClipboardCopy size={16} />复制整套配置</button></div>
            {sources.length === 0 ? <p className="mt-3 text-sm text-[var(--pbl-text-muted)]">目前没有可复用的实验课堂，可先批量录入题目。</p> : null}
            {selectedSource ? <div className="mt-5 space-y-3"><div className="flex flex-wrap items-center gap-3"><label className="text-sm">题目复制到 <select className={`${field} ml-2 w-auto`} aria-label="复制题目到" value={bank} onChange={(event) => setBank(event.target.value as QuestionBank)}>{Object.entries(bankLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{selectedSource.config.scenarioPair ? <button type="button" className={secondary} onClick={copyScenarioPair}>复制 A/B 情境题</button> : null}</div>{selectedSourceGroups.length ? <div className="space-y-2">{selectedSourceGroups.map(({ sourceBank, group, questions }) => <div key={`${sourceBank}-${group.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--pbl-border)] bg-[var(--pbl-teacher-soft)] p-3"><p className="text-sm"><strong>{group.title}</strong><span className="ml-2 text-xs text-[var(--pbl-text-muted)]">{bankLabels[sourceBank]} · {questions.length} 题</span></p><button type="button" className={secondary} onClick={() => copyQuestionGroup(questions, group.title)}>复制整个题组</button></div>)}</div> : null}<div className="max-h-80 space-y-2 overflow-y-auto">{sourceQuestions(selectedSource.config).map(({ bank: sourceBank, question }) => <div key={question.id} className="flex items-start justify-between gap-3 rounded-lg border border-[var(--pbl-border)] p-3"><div className="min-w-0"><small className="text-[var(--pbl-text-muted)]">{sourceBank}{question.group ? ` · ${question.group.title}` : ""}</small><p className="mt-1 whitespace-pre-wrap text-sm">{question.prompt}</p></div><button type="button" className={`${secondary} shrink-0`} onClick={() => appendQuestions([cloneQuestion(question)], `已复制题目到${bankLabels[bank]}，请检查后保存`)}>复制此题</button></div>)}</div></div> : null}
          </section>
          <section className="rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-4 md:p-6">
            <h2 className="text-lg font-semibold">从表格批量添加</h2><p className="mt-1 text-sm text-[var(--pbl-text-muted)]">在 Excel 中按列整理后直接粘贴。参考答案可以留空；同一题组标题的题目会归在一起，作答说明只需在首行填写。</p>
            <p className="mt-3 overflow-x-auto rounded-lg bg-[var(--pbl-bg)] p-3 font-mono text-xs whitespace-pre">{EXPERIMENT_BULK_EXAMPLE}</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]"><label className="text-sm">添加到 <select className={`${field} mt-1`} aria-label="批量添加到" value={bank} onChange={(event) => setBank(event.target.value as QuestionBank)}>{Object.entries(bankLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button type="button" className={`${primary} self-end`} onClick={importRows} disabled={!bulkText.trim()}><ListPlus size={16} />批量添加题目</button></div>
            <textarea className={`${field} mt-3 min-h-40 font-mono`} aria-label="粘贴题目表格" value={bulkText} onChange={(event) => setBulkText(event.target.value)} placeholder="在这里粘贴 Excel 表格行" />
          </section>
          <section className="rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-4 md:p-6"><h2 className="text-lg font-semibold">配置文件</h2><p className="mt-1 text-sm text-[var(--pbl-text-muted)]">下载整套题目与参考答案以备份，或在另一课堂导入并应用；导入后会生成新的题目编号。</p><div className="mt-4 flex flex-wrap gap-3"><button type="button" className={secondary} onClick={downloadConfig}><Download size={16} />下载配置 JSON</button><label className={`${secondary} cursor-pointer`}><FileUp size={16} />导入配置 JSON<input className="sr-only" type="file" accept=".json,application/json" aria-label="导入配置 JSON" onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ""; }} /></label></div></section>
        </div> : null}
        {tab === "preview" ? <div role="tabpanel" className="rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-4 md:p-6"><ExperimentPreview config={prepareExperiment(draft)} /></div> : null}
        <div className="flex justify-end"><button type="button" className={primary} disabled={busy} onClick={() => void save()}><Save size={16} />{busy ? "保存中…" : "保存实验配置"}</button></div>
      </> : null}
    </div>
  </TeacherPlatformPage>;
}
