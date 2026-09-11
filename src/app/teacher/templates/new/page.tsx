"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Clock3,
  FileText,
  LoaderCircle,
  Plus,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import { teacherPlatformFetch } from "@/lib/platform/client";
import { templateContentSchema, type TemplateContent } from "@/lib/platform/template-content";
import { TeacherPlatformHeader, TeacherPlatformPage } from "@/components/platform/teacher-shell";

type Step = 0 | 1 | 2;
type Draft = { content: TemplateContent; brief: string; step: Step };

const STORAGE_KEY = "openpbl:teacher:new-template-draft:v1";
const field = "min-h-11 w-full rounded-[6px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pbl-teacher)]";
const secondary = "inline-flex min-h-11 items-center justify-center gap-2 rounded-[6px] border border-[var(--pbl-border)] px-4 text-sm font-medium transition hover:bg-black/5 disabled:opacity-50";
const primary = "inline-flex min-h-11 items-center justify-center gap-2 rounded-[6px] bg-[var(--pbl-teacher)] px-5 text-sm font-semibold text-white transition hover:brightness-95 disabled:opacity-50";

function emptyContent(): TemplateContent {
  return {
    schemaVersion: 1,
    title: "",
    subject: "",
    grade: "",
    durationMinutes: 45,
    summary: "",
    learningObjectives: [""],
    outline: [{ title: "", durationMinutes: 45, description: "" }],
    resources: [],
  };
}

const STEPS = [
  { title: "备课阶段", description: "明确课程目标与教学要求" },
  { title: "生成课程", description: "审阅并调整课程方案" },
  { title: "预览发布", description: "确认后保存到课程库" },
] as const;

export default function NewTeacherTemplatePage() {
  const router = useRouter();
  const [content, setContent] = useState<TemplateContent>(emptyContent);
  const [brief, setBrief] = useState("");
  const [step, setStep] = useState<Step>(0);
  const [busy, setBusy] = useState<"generate" | "save" | null>(null);
  const [error, setError] = useState("");
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const draft = JSON.parse(raw) as Draft;
        if (draft?.content?.schemaVersion === 1) {
          setContent(draft.content);
          setBrief(typeof draft.brief === "string" ? draft.brief : "");
          setStep(draft.step === 1 || draft.step === 2 ? draft.step : 0);
        }
      }
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    } finally {
      setRestored(true);
    }
  }, []);

  useEffect(() => {
    if (!restored) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ content, brief, step } satisfies Draft));
  }, [brief, content, restored, step]);

  const allocatedMinutes = useMemo(
    () => content.outline.reduce((sum, item) => sum + (Number(item.durationMinutes) || 0), 0),
    [content.outline],
  );

  function validateBasics() {
    if (!content.title.trim()) return "请填写课程名称。";
    if (!brief.trim()) return "请填写教学要求，说明学习目标、学生基础或期望成果。";
    if (content.durationMinutes < 5 || content.durationMinutes > 600) return "课程时长应在 5 至 600 分钟之间。";
    return "";
  }

  async function generate() {
    const message = validateBasics();
    if (message || busy) { setError(message); return; }
    setBusy("generate"); setError("");
    try {
      const response = await teacherPlatformFetch("/api/platform/templates/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: content.title,
          subject: content.subject,
          grade: content.grade,
          durationMinutes: content.durationMinutes,
          brief,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "生成失败，请稍后重试");
      const parsed = templateContentSchema.safeParse(data.content);
      if (!parsed.success) throw new Error("生成结果不完整，请重新生成");
      setContent(parsed.data);
      setStep(1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "生成失败，请稍后重试");
    } finally {
      setBusy(null);
    }
  }

  function startManualPreparation() {
    const message = validateBasics();
    if (message) { setError(message); return; }
    setContent((current) => ({
      ...current,
      summary: current.summary || brief.trim(),
      learningObjectives: current.learningObjectives.some((item) => item.trim()) ? current.learningObjectives : [""],
    }));
    setError("");
    setStep(1);
  }

  function review() {
    const parsed = templateContentSchema.safeParse(content);
    if (!parsed.success) {
      setError("请补全课程简介、学习目标和每个教学环节，参考链接需以 http 或 https 开头。");
      return;
    }
    if (allocatedMinutes !== content.durationMinutes) {
      setError(`教学环节共 ${allocatedMinutes} 分钟，需要与课程总时长 ${content.durationMinutes} 分钟一致。`);
      return;
    }
    setContent(parsed.data); setError(""); setStep(2); window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function publish() {
    if (busy) return;
    const parsed = templateContentSchema.safeParse(content);
    if (!parsed.success || allocatedMinutes !== content.durationMinutes) { setStep(1); setError("课程内容校验未通过，请返回检查。" ); return; }
    setBusy("save"); setError("");
    try {
      const response = await teacherPlatformFetch("/api/platform/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: parsed.data.title, description: parsed.data.summary, snapshot: parsed.data }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "课程保存失败");
      window.localStorage.removeItem(STORAGE_KEY);
      router.push("/teacher/templates?created=1");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "课程保存失败");
    } finally {
      setBusy(null);
    }
  }

  return <TeacherPlatformPage>
    <TeacherPlatformHeader active="templates" backHref="/teacher/templates" backLabel="返回课程库" />

    <div className="pbl-workspace-content">
      <div className="grid gap-8 lg:grid-cols-[250px_minmax(0,1fr)]">
        <aside className="pbl-create-intro">
          <p className="text-xs font-semibold tracking-[0.18em] text-[var(--pbl-teacher)]">课程库 / 新建课程</p>
          <h1 className="mt-3 font-serif text-3xl font-semibold">创建课程</h1>
          <ol className="mt-8 space-y-1" aria-label="创建进度">
            {STEPS.map((item, index) => <li key={item.title} className={`relative flex gap-4 rounded-[8px] px-3 py-4 ${step === index ? "bg-[var(--pbl-surface)] shadow-sm" : ""}`} aria-current={step === index ? "step" : undefined}>
              <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border text-xs font-semibold ${index < step ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher)] text-white" : step === index ? "border-[var(--pbl-teacher)] text-[var(--pbl-teacher)]" : "border-[var(--pbl-border)] text-[var(--pbl-text-muted)]"}`}>{index < step ? <Check size={14}/> : index + 1}</span>
              <span><strong className="block text-sm">{item.title}</strong><span className="mt-1 block text-xs leading-5 text-[var(--pbl-text-muted)]">{item.description}</span></span>
            </li>)}
          </ol>
          <p className="mt-6 border-t border-[var(--pbl-border)] pt-5 text-xs leading-6 text-[var(--pbl-text-muted)]">草稿会保存在当前浏览器。发布后课程进入课程库，可在教学班的章节中选用。</p>
        </aside>

        <section className="pbl-platform-panel overflow-hidden rounded-[var(--radius-xl)] border-t-4 border-t-[var(--pbl-teacher)] shadow-[var(--shadow-raised)]">
          {step === 0 ? <div className="p-6 sm:p-9">
            <div className="border-b border-[var(--pbl-border)] pb-7"><p className="text-xs font-semibold text-[var(--pbl-teacher)]">01 / 课程基础</p><h2 className="mt-2 font-serif text-3xl font-semibold">从教学意图开始</h2><p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--pbl-text-muted)]">填写课程主题与真实教学要求。系统会生成可继续调整的完整课程方案。</p></div>
            <div className="mt-7 grid gap-5 sm:grid-cols-2">
              <label className="space-y-2 text-sm"><span>课程名称</span><input autoFocus className={field} maxLength={160} value={content.title} onChange={(event) => setContent({ ...content, title: event.target.value })} placeholder="例如：为校园设计雨水收集系统"/></label>
              <label className="space-y-2 text-sm"><span>学科领域</span><input className={field} maxLength={100} value={content.subject} onChange={(event) => setContent({ ...content, subject: event.target.value })} placeholder="例如：科学 · 跨学科实践"/></label>
              <label className="space-y-2 text-sm"><span>适用年级</span><input className={field} maxLength={100} value={content.grade} onChange={(event) => setContent({ ...content, grade: event.target.value })} placeholder="例如：初中七年级"/></label>
              <label className="space-y-2 text-sm"><span>课程时长（分钟）</span><input className={field} type="number" min={5} max={600} value={content.durationMinutes} onChange={(event) => setContent({ ...content, durationMinutes: Number(event.target.value) })}/></label>
            </div>
            <label className="mt-5 block space-y-2 text-sm"><span>教学要求</span><textarea className={field + " min-h-44 resize-y"} maxLength={12000} value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="描述希望学生学会什么、已有基础、真实问题情境、课堂组织方式和期待的学习成果。"/></label>
            {error && <p role="alert" className="mt-5 text-sm text-[var(--pbl-danger)]">{error}</p>}
            <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--pbl-border)] pt-6"><button className={secondary} type="button" onClick={startManualPreparation}><FileText size={16}/>进入详细备课</button><button className={primary} disabled={!!busy} type="button" onClick={() => void generate()}>{busy === "generate" ? <LoaderCircle className="animate-spin" size={17}/> : <Sparkles size={17}/>} {busy === "generate" ? "正在生成课程方案…" : "生成课程方案"}<ArrowRight size={16}/></button></div>
          </div> : null}

          {step === 1 ? <div className="p-6 sm:p-9">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--pbl-border)] pb-7"><div><p className="text-xs font-semibold text-[var(--pbl-teacher)]">02 / 方案审阅</p><h2 className="mt-2 font-serif text-3xl font-semibold">完善课程内容</h2><p className="mt-3 text-sm leading-7 text-[var(--pbl-text-muted)]">逐项确认学习目标、教学环节与参考资料，所有内容仍可修改。</p></div><button className={secondary} disabled={!!busy} onClick={() => void generate()}><Sparkles size={16}/>重新生成</button></div>
            <div className="mt-7 space-y-7">
              <label className="block space-y-2 text-sm"><span>课程简介</span><textarea className={field + " min-h-28"} value={content.summary} onChange={(event) => setContent({ ...content, summary: event.target.value })}/></label>
              <section><div className="mb-3 flex items-center justify-between"><h3 className="font-semibold">学习目标</h3><button type="button" className="text-sm text-[var(--pbl-teacher)]" onClick={() => setContent({ ...content, learningObjectives: [...content.learningObjectives, ""] })}><Plus size={15}/>添加目标</button></div><div className="space-y-3">{content.learningObjectives.map((goal, index) => <div className="flex gap-2" key={index}><span className="grid h-11 w-9 shrink-0 place-items-center font-serif text-sm text-[var(--pbl-text-muted)]">{String(index + 1).padStart(2, "0")}</span><input className={field} value={goal} onChange={(event) => setContent({ ...content, learningObjectives: content.learningObjectives.map((item, itemIndex) => itemIndex === index ? event.target.value : item) })}/><button type="button" className="grid h-11 w-11 shrink-0 place-items-center text-[var(--pbl-text-muted)]" aria-label={`删除目标 ${index + 1}`} disabled={content.learningObjectives.length === 1} onClick={() => setContent({ ...content, learningObjectives: content.learningObjectives.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={16}/></button></div>)}</div></section>
              <section><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">教学环节</h3><span className={`text-xs ${allocatedMinutes === content.durationMinutes ? "text-[var(--pbl-text-muted)]" : "text-[var(--pbl-danger)]"}`}>已分配 {allocatedMinutes} / {content.durationMinutes} 分钟</span></div><div className="divide-y divide-[var(--pbl-border)] border-y border-[var(--pbl-border)]">{content.outline.map((item, index) => <div className="py-5" key={index}><div className="flex gap-2"><span className="grid h-11 w-9 shrink-0 place-items-center font-serif text-sm text-[var(--pbl-text-muted)]">{String(index + 1).padStart(2, "0")}</span><input aria-label={`环节 ${index + 1} 名称`} className={field} value={item.title} onChange={(event) => setContent({ ...content, outline: content.outline.map((entry, itemIndex) => itemIndex === index ? { ...entry, title: event.target.value } : entry) })}/><input aria-label={`环节 ${index + 1} 分钟`} className={field + " max-w-24"} type="number" min={1} max={600} value={item.durationMinutes} onChange={(event) => setContent({ ...content, outline: content.outline.map((entry, itemIndex) => itemIndex === index ? { ...entry, durationMinutes: Number(event.target.value) } : entry) })}/><button type="button" className="grid h-11 w-11 shrink-0 place-items-center text-[var(--pbl-text-muted)]" aria-label={`删除环节 ${index + 1}`} disabled={content.outline.length === 1} onClick={() => setContent({ ...content, outline: content.outline.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={16}/></button></div><textarea aria-label={`环节 ${index + 1} 教学内容`} className={field + " mt-3 min-h-24"} value={item.description} onChange={(event) => setContent({ ...content, outline: content.outline.map((entry, itemIndex) => itemIndex === index ? { ...entry, description: event.target.value } : entry) })}/></div>)}</div><button type="button" className={secondary + " mt-4"} onClick={() => setContent({ ...content, outline: [...content.outline, { title: "", durationMinutes: 5, description: "" }] })}><Plus size={16}/>添加教学环节</button></section>
              <section><div className="mb-3 flex items-center justify-between"><h3 className="font-semibold">参考资料</h3><button type="button" className="text-sm text-[var(--pbl-teacher)]" onClick={() => setContent({ ...content, resources: [...content.resources, { title: "", url: "" }] })}><Plus size={15}/>添加资料</button></div>{content.resources.length === 0 ? <p className="border-y border-[var(--pbl-border)] py-5 text-sm text-[var(--pbl-text-muted)]">暂无参考资料，可按需要添加。</p> : <div className="space-y-3">{content.resources.map((resource, index) => <div className="flex flex-wrap gap-2 sm:flex-nowrap" key={index}><input aria-label={`资料 ${index + 1} 名称`} className={field} value={resource.title} placeholder="资料名称" onChange={(event) => setContent({ ...content, resources: content.resources.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item) })}/><input aria-label={`资料 ${index + 1} 链接`} className={field} value={resource.url} placeholder="https://（可选）" onChange={(event) => setContent({ ...content, resources: content.resources.map((item, itemIndex) => itemIndex === index ? { ...item, url: event.target.value } : item) })}/><button type="button" className="grid h-11 w-11 shrink-0 place-items-center text-[var(--pbl-text-muted)]" aria-label={`删除资料 ${index + 1}`} onClick={() => setContent({ ...content, resources: content.resources.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={16}/></button></div>)}</div>}</section>
            </div>
            {error && <p role="alert" className="mt-5 text-sm text-[var(--pbl-danger)]">{error}</p>}
            <div className="mt-8 flex items-center justify-between border-t border-[var(--pbl-border)] pt-6"><button className={secondary} onClick={() => { setError(""); setStep(0); }}><ArrowLeft size={16}/>上一步</button><button className={primary} onClick={review}>预览课程<ArrowRight size={16}/></button></div>
          </div> : null}

          {step === 2 ? <div className="p-6 sm:p-9">
            <div className="border-b border-[var(--pbl-border)] pb-7"><p className="text-xs font-semibold text-[var(--pbl-teacher)]">03 / 发布确认</p><h2 className="mt-2 font-serif text-3xl font-semibold">{content.title}</h2><div className="mt-4 flex flex-wrap gap-4 text-xs text-[var(--pbl-text-muted)]"><span className="flex items-center gap-1.5"><BookOpen size={15}/>{content.subject || "课堂教学"}</span>{content.grade && <span>{content.grade}</span>}<span className="flex items-center gap-1.5"><Clock3 size={15}/>{content.durationMinutes} 分钟</span></div></div>
            <div className="mt-7 space-y-8"><section><h3 className="font-semibold">课程简介</h3><p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-[var(--pbl-text-muted)]">{content.summary}</p></section><section><h3 className="font-semibold">学习目标</h3><ol className="mt-3 space-y-2">{content.learningObjectives.map((goal, index) => <li key={index} className="flex gap-3 text-sm leading-7"><span className="font-serif text-[var(--pbl-teacher)]">{String(index + 1).padStart(2, "0")}</span>{goal}</li>)}</ol></section><section><h3 className="font-semibold">课程环节</h3><div className="mt-3 border-y border-[var(--pbl-border)]">{content.outline.map((item, index) => <article className="grid gap-2 border-b border-[var(--pbl-border)] py-5 last:border-0 sm:grid-cols-[42px_minmax(0,1fr)_70px]" key={index}><span className="font-serif text-[var(--pbl-text-muted)]">{String(index + 1).padStart(2, "0")}</span><div><h4 className="font-medium">{item.title}</h4><p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[var(--pbl-text-muted)]">{item.description}</p></div><span className="text-xs text-[var(--pbl-text-muted)] sm:text-right">{item.durationMinutes} 分钟</span></article>)}</div></section>{content.resources.length > 0 && <section><h3 className="font-semibold">参考资料</h3><ul className="mt-3 space-y-2 text-sm">{content.resources.map((resource, index) => <li key={index}>{resource.url ? <a className="text-[var(--pbl-teacher)] underline" href={resource.url} target="_blank" rel="noreferrer">{resource.title}</a> : resource.title}</li>)}</ul></section>}</div>
            {error && <p role="alert" className="mt-5 text-sm text-[var(--pbl-danger)]">{error}</p>}
            <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--pbl-border)] pt-6"><button className={secondary} disabled={!!busy} onClick={() => { setError(""); setStep(1); }}><ArrowLeft size={16}/>返回修改</button><button className={primary} disabled={!!busy} onClick={() => void publish()}>{busy === "save" ? <LoaderCircle className="animate-spin" size={17}/> : <Save size={17}/>} {busy === "save" ? "正在保存到课程库…" : "发布到课程库"}</button></div>
          </div> : null}
        </section>
      </div>
    </div>
  </TeacherPlatformPage>;
}
