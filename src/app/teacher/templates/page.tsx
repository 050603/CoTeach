"use client";

import Link from "next/link";
import { LearningArt } from "@/components/platform/learning-art";
import { PlatformLoading } from "@/components/platform/platform-feedback";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Archive, ArrowRight, BookOpen, Clock3, FileText, LoaderCircle, Plus, Search, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { readTemplateContent, templateContentSchema, type TemplateContent } from "@/lib/platform/template-content";
import { decodePblTemplate } from "@/lib/platform/pbl-template";
import { teacherPlatformFetch } from "@/lib/platform/client";
import { TeacherPlatformHeader, TeacherPlatformPage } from "@/components/platform/teacher-shell";

type Template = { id: string; title: string; description: string | null; status: string; versions: Array<{ id: string; version: number; status: string; createdAt: string; snapshot: unknown }> };
const field = "min-h-11 w-full rounded-[6px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pbl-teacher)]";
const secondary = "inline-flex min-h-11 items-center justify-center gap-2 rounded-[6px] border border-[var(--pbl-border)] px-4 text-sm font-medium hover:bg-black/5 disabled:opacity-50";
const primary = "inline-flex min-h-11 items-center justify-center gap-2 rounded-[6px] bg-[var(--pbl-teacher)] px-5 text-sm font-medium text-white disabled:opacity-50";
const emptyContent = (): TemplateContent => ({ schemaVersion: 1, title: "", subject: "", grade: "", durationMinutes: 45, summary: "", learningObjectives: [""], outline: [{ title: "", durationMinutes: 45, description: "" }], resources: [] });

export default function TeacherTemplatesPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [content, setContent] = useState<TemplateContent>(emptyContent);
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState<"generate" | "save" | "archive" | null>(null);
  const [editorError, setEditorError] = useState("");
  const [preview, setPreview] = useState<Template | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Template | null>(null);
  const [filter, setFilter] = useState<"active" | "archived">("active");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await teacherPlatformFetch("/api/platform/templates", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "无法加载课程库");
      setTemplates(data.templates ?? []);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "加载失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function createCourse() {
    if (creating) return;
    setCreating(true); setError(null); setNotice("");
    try {
      const response = await teacherPlatformFetch("/api/platform/templates/pbl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await response.json();
      if (!response.ok || !data.templateId) throw new Error(data.message ?? "无法新建课程，请重试");
      router.push(`/teacher/prepare/${data.templateId}/verify`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法新建课程，请重试");
    } finally {
      setCreating(false);
    }
  }

  function openEditor(template?: Template) {
    setEditing(template ?? null);
    setContent(template ? readTemplateContent(template.versions[0]?.snapshot) ?? { ...emptyContent(), title: template.title, summary: template.description ?? "" } : emptyContent());
    setBrief(""); setEditorError(""); setEditorOpen(true); setPreview(null);
  }
  async function generate() {
    if (busy) return;
    setBusy("generate"); setEditorError("");
    try {
      const response = await teacherPlatformFetch("/api/platform/templates/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: content.title, subject: content.subject, grade: content.grade, durationMinutes: content.durationMinutes, brief }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "生成失败，请重试");
      const result = templateContentSchema.safeParse(data.content);
      if (!result.success) throw new Error("生成内容不完整，请重试");
      setContent(result.data);
    } catch (reason) { setEditorError(reason instanceof Error ? reason.message : "生成失败"); }
    finally { setBusy(null); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    const parsed = templateContentSchema.safeParse(content);
    if (!parsed.success) { setEditorError("请补全课程名称、简介、学习目标和教学环节，并检查参考链接格式。"); return; }
    if (content.outline.reduce((sum, item) => sum + item.durationMinutes, 0) !== content.durationMinutes) { setEditorError("教学环节的时长总和需要与课程总时长一致。"); return; }
    setBusy("save"); setEditorError("");
    try {
      const response = await teacherPlatformFetch(editing ? `/api/platform/templates/${editing.id}/versions` : "/api/platform/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: content.title, description: content.summary, snapshot: parsed.data }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "保存失败");
      setEditorOpen(false); setNotice(editing ? "新版本已保存，已安排的课堂保留原版本。" : "课程已加入课程库，可以在课程系列的章节中选用。");
      setFilter("active"); await load();
    } catch (reason) { setEditorError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(null); }
  }
  async function archive() {
    if (!archiveTarget || busy) return;
    setBusy("archive"); setError(null);
    try {
      const response = await teacherPlatformFetch(`/api/platform/templates/${archiveTarget.id}/versions`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "归档失败");
      setArchiveTarget(null); setNotice("课程已归档，已安排的课堂仍保留原有内容。"); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "归档失败"); setArchiveTarget(null); }
    finally { setBusy(null); }
  }

  const active = templates.filter((item) => item.status.toLowerCase() !== "archived");
  const visible = templates.filter((item) => (item.status.toLowerCase() === "archived") === (filter === "archived") && `${item.title} ${item.description ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const previewContent = preview ? readTemplateContent(preview.versions[0]?.snapshot) : null;

  return <TeacherPlatformPage>
    <TeacherPlatformHeader active="templates" />
    <div className="pbl-workspace-content">
      <div className="pbl-page-heading"><LearningArt /><div><p className="text-xs font-semibold tracking-[0.18em] text-[var(--pbl-teacher)]">教学内容 / LIBRARY</p><h1 className="mt-3 font-serif text-4xl font-semibold">课程库</h1><p className="mt-4 max-w-2xl text-sm leading-7 text-[var(--pbl-text-muted)]">把一堂好课沉淀为可复用的教学内容。新建后通过快速生成完成备课，再到课程系列的章节中安排使用。</p></div><button className={primary} disabled={creating} onClick={() => void createCourse()} type="button">{creating ? <LoaderCircle className="animate-spin" size={17} /> : <Plus size={17} />}{creating ? "正在新建…" : "新建课程"}</button></div>
      <div className="pbl-list-toolbar"><div className="flex gap-1" role="group" aria-label="课程状态"><button className={secondary + (filter === "active" ? " bg-[var(--pbl-surface)]" : " border-transparent text-[var(--pbl-text-muted)]")} aria-pressed={filter === "active"} onClick={() => setFilter("active")}>可用课程 <span className="text-xs">{active.length}</span></button><button className={secondary + (filter === "archived" ? " bg-[var(--pbl-surface)]" : " border-transparent text-[var(--pbl-text-muted)]")} aria-pressed={filter === "archived"} onClick={() => setFilter("archived")}>已归档</button></div><label className="relative w-full sm:w-72"><Search size={17} className="absolute left-3 top-3.5 text-[var(--pbl-text-muted)]"/><input aria-label="搜索课程" className={field + " pl-10"} placeholder="搜索课程名称或内容" value={query} onChange={(event) => setQuery(event.target.value)}/></label></div>
      {error && <div role="alert" className="mt-5 flex items-center justify-between gap-3 rounded-[6px] border border-[var(--pbl-danger)] p-4 text-sm text-[var(--pbl-danger)]">{error}<button className="min-h-11 rounded-[6px] border border-[var(--pbl-border)] px-4 text-sm" onClick={() => void load()}>重试</button></div>}
      {notice && <p role="status" className="mt-5 flex items-center justify-between gap-3 rounded-[6px] border border-[var(--pbl-border)] p-4 text-sm">{notice}<button className="grid min-h-11 min-w-11 place-items-center" aria-label="关闭提示" onClick={() => setNotice("")}><X size={16}/></button></p>}
      {loading ? <PlatformLoading label="正在加载课程库…" /> : visible.length === 0 ? <div className="pbl-empty"><BookOpen size={36} strokeWidth={1.3} className="mx-auto text-[var(--pbl-teacher)]"/><h2 className="mt-5 font-serif text-2xl">{query ? "没有找到匹配课程" : filter === "archived" ? "暂无归档课程" : "从一堂课开始"}</h2><p className="mx-auto mt-3 max-w-md text-sm leading-7 text-[var(--pbl-text-muted)]">{query ? "尝试其他关键词，或清空搜索查看全部课程。" : filter === "archived" ? "暂时不再使用的课程会保留在这里。" : "填写课程主题与教学要求，生成教学方案并审阅保存；也可以直接编写课程内容。"}</p></div> : <div className="mt-7 grid gap-5 md:grid-cols-2 xl:grid-cols-3">{visible.map((template) => { const detail = readTemplateContent(template.versions[0]?.snapshot); const pbl = decodePblTemplate(template.versions[0]?.snapshot); return <article key={template.id} className="pbl-library-card flex flex-col p-6"><div className="pbl-library-art"><LearningArt /><span>{pbl ? "项目式学习" : "课程设计"}</span></div><div className="flex items-center justify-between"><span className="flex items-center gap-2 text-xs font-medium text-[var(--pbl-teacher)]"><BookOpen size={16}/>{detail?.subject || "课堂教学"}</span><span className="text-xs text-[var(--pbl-text-muted)]">第 {template.versions[0]?.version ?? 1} 版</span></div><h2 className="mt-6 font-serif text-xl leading-8 font-semibold">{template.title}</h2><p className="mt-3 line-clamp-3 text-sm leading-7 text-[var(--pbl-text-muted)]">{detail?.summary || template.description || "打开课程查看内容与版本信息。"}</p><div className="mt-5 flex flex-wrap gap-4 text-xs text-[var(--pbl-text-muted)]">{detail && <><span className="flex items-center gap-1.5"><Clock3 size={14}/>{detail.durationMinutes} 分钟</span><span>{detail.outline.length} 个教学环节</span>{detail.grade && <span>{detail.grade}</span>}</>}</div><div className="mt-6 flex items-center justify-between border-t border-[var(--pbl-border)] pt-4">{pbl ? <Link className="flex min-h-11 items-center gap-2 text-sm font-medium text-[var(--pbl-teacher)]" href={`/teacher/prepare/${template.id}/verify`}>继续备课<ArrowRight size={16}/></Link> : <button className="flex min-h-11 items-center gap-2 text-sm font-medium text-[var(--pbl-teacher)]" onClick={() => setPreview(template)}>查看课程<ArrowRight size={16}/></button>}{filter === "active" && <button className="grid min-h-11 min-w-11 place-items-center text-[var(--pbl-text-muted)] hover:text-[var(--pbl-danger)]" aria-label={`归档 ${template.title}`} onClick={() => setArchiveTarget(template)}><Archive size={16}/></button>}</div></article>; })}</div>}
    </div>
    <Dialog open={editorOpen} onOpenChange={(open) => { if (!busy) setEditorOpen(open); }}><DialogContent className="pbl-platform-theme pbl-platform-dialog bg-[var(--pbl-surface)] sm:max-w-4xl"><DialogHeader><DialogTitle className="font-serif text-2xl">{editing ? "编辑课程内容" : "新建课程"}</DialogTitle><DialogDescription>填写教学需求后生成方案，审阅并保存后即可在章节中选用。</DialogDescription></DialogHeader><form onSubmit={save} className="space-y-7"><fieldset disabled={!!busy} className="space-y-5 disabled:opacity-70"><div className="grid gap-4 sm:grid-cols-2"><label className="space-y-2 text-sm">课程名称<input className={field} value={content.title} readOnly={!!editing} required maxLength={160} onChange={(e) => setContent({ ...content, title: e.target.value })} placeholder="例如：为校园设计雨水收集系统"/></label><label className="space-y-2 text-sm">学科<input className={field} value={content.subject} maxLength={100} onChange={(e) => setContent({ ...content, subject: e.target.value })} placeholder="例如：科学 · 跨学科实践"/></label><label className="space-y-2 text-sm">适用年级<input className={field} value={content.grade} maxLength={100} onChange={(e) => setContent({ ...content, grade: e.target.value })} placeholder="例如：初中七年级"/></label><label className="space-y-2 text-sm">课程时长（分钟）<input className={field} type="number" min={5} max={600} required value={content.durationMinutes} onChange={(e) => setContent({ ...content, durationMinutes: Number(e.target.value) })}/></label></div><div className="border-y border-[var(--pbl-border)] py-5"><label className="block space-y-2 text-sm">教学要求<textarea className={field + " min-h-24"} value={brief} maxLength={12000} onChange={(e) => setBrief(e.target.value)} placeholder="描述希望学生学会什么、已有基础、教学情境及期待的学习成果。"/></label><div className="mt-3 flex flex-wrap items-center gap-3"><button type="button" className="min-h-11 rounded-[6px] border border-[var(--pbl-border)] px-4 text-sm" disabled={!content.title.trim() || !brief.trim() || !!busy} onClick={() => void generate()}>{busy === "generate" ? <LoaderCircle size={16} className="animate-spin"/> : <FileText size={16}/>} {busy === "generate" ? "正在生成教学方案…" : "根据要求生成方案"}</button><span className="text-xs leading-6 text-[var(--pbl-text-muted)]">生成会替换下方方案；保存前请确认内容。</span></div></div><label className="block space-y-2 text-sm">课程简介<textarea className={field + " min-h-24"} value={content.summary} maxLength={10000} required onChange={(e) => setContent({ ...content, summary: e.target.value })}/></label><label className="block space-y-2 text-sm">学习目标<span className="ml-2 text-xs text-[var(--pbl-text-muted)]">每行一个目标</span><textarea className={field + " min-h-24"} value={content.learningObjectives.join("\n")} required onChange={(e) => setContent({ ...content, learningObjectives: e.target.value.split("\n") })}/></label><section><div className="mb-3 flex items-center justify-between"><h3 className="font-semibold">教学环节</h3><span className="text-xs text-[var(--pbl-text-muted)]">已分配 {content.outline.reduce((sum, item) => sum + item.durationMinutes, 0)} / {content.durationMinutes} 分钟</span></div><div className="divide-y divide-[var(--pbl-border)]">{content.outline.map((section, index) => <div key={index} className="py-4"><div className="mb-3 flex items-center gap-3"><span className="font-serif text-lg text-[var(--pbl-text-muted)]">{String(index + 1).padStart(2, "0")}</span><input aria-label={`环节 ${index + 1} 名称`} className={field} required value={section.title} onChange={(e) => setContent({ ...content, outline: content.outline.map((item, i) => i === index ? { ...item, title: e.target.value } : item) })}/><input aria-label={`环节 ${index + 1} 分钟`} className={field + " max-w-20"} type="number" min={1} max={600} required value={section.durationMinutes} onChange={(e) => setContent({ ...content, outline: content.outline.map((item, i) => i === index ? { ...item, durationMinutes: Number(e.target.value) } : item) })}/><button className="grid min-h-11 min-w-11 place-items-center" type="button" aria-label={`删除环节 ${index + 1}`} disabled={content.outline.length === 1} onClick={() => setContent({ ...content, outline: content.outline.filter((_, i) => i !== index) })}><X size={16}/></button></div><textarea className={field + " min-h-24"} aria-label={`环节 ${index + 1} 教学内容`} required value={section.description} onChange={(e) => setContent({ ...content, outline: content.outline.map((item, i) => i === index ? { ...item, description: e.target.value } : item) })} placeholder="教学内容、学生任务和成果要求"/></div>)}</div><button className="min-h-11 rounded-[6px] border border-[var(--pbl-border)] px-4 text-sm" type="button" disabled={content.outline.length >= 30} onClick={() => setContent({ ...content, outline: [...content.outline, { title: "", durationMinutes: 5, description: "" }] })}><Plus size={16}/>添加教学环节</button></section><section><h3 className="mb-3 font-semibold">参考资料</h3>{content.resources.map((resource, index) => <div key={index} className="mb-3 flex flex-wrap gap-2"><input className={field + " flex-1 basis-48"} aria-label={`资料 ${index + 1} 名称`} placeholder="资料名称或准备建议" required value={resource.title} onChange={(e) => setContent({ ...content, resources: content.resources.map((item, i) => i === index ? { ...item, title: e.target.value } : item) })}/><input className={field + " flex-1 basis-48"} aria-label={`资料 ${index + 1} 链接`} placeholder="https://（可选）" type="url" value={resource.url} onChange={(e) => setContent({ ...content, resources: content.resources.map((item, i) => i === index ? { ...item, url: e.target.value } : item) })}/><button className="grid min-h-11 min-w-11 place-items-center" type="button" aria-label={`删除资料 ${index + 1}`} onClick={() => setContent({ ...content, resources: content.resources.filter((_, i) => i !== index) })}><X size={16}/></button></div>)}<button className="min-h-11 rounded-[6px] border border-[var(--pbl-border)] px-4 text-sm" type="button" disabled={content.resources.length >= 30} onClick={() => setContent({ ...content, resources: [...content.resources, { title: "", url: "" }] })}><Plus size={16}/>添加参考资料</button></section></fieldset>{editorError && <p role="alert" className="text-sm text-[var(--pbl-danger)]">{editorError}</p>}<div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--pbl-border)] pt-5"><p className="text-xs text-[var(--pbl-text-muted)]">{editing ? "保存为新版本，已安排的课堂不受影响。" : "保存后可在课程系列中添加为课堂内容。"}</p><button className={primary} type="submit" disabled={!!busy}>{busy === "save" ? "保存中…" : editing ? "保存新版本" : "保存到课程库"}</button></div></form></DialogContent></Dialog>
    <Dialog open={!!preview} onOpenChange={(open) => { if (!open) setPreview(null); }}><DialogContent className="pbl-platform-theme pbl-platform-dialog bg-[var(--pbl-surface)] sm:max-w-3xl"><DialogHeader><DialogTitle className="font-serif text-2xl">{preview?.title}</DialogTitle><DialogDescription>{previewContent ? `${previewContent.grade || "课堂教学"} · ${previewContent.durationMinutes} 分钟` : "课程内容与版本"}</DialogDescription></DialogHeader>{previewContent ? <div className="space-y-6"><p className="text-sm leading-7 text-[var(--pbl-text-muted)]">{previewContent.summary}</p><section><h3 className="mb-3 font-semibold">学习目标</h3><ul className="list-disc space-y-2 pl-5 text-sm leading-7">{previewContent.learningObjectives.map((goal, index) => <li key={index}>{goal}</li>)}</ul></section><section><h3 className="mb-3 font-semibold">教学环节</h3>{previewContent.outline.map((section, index) => <div key={index} className="border-t border-[var(--pbl-border)] py-4"><div className="flex justify-between gap-3"><h4 className="font-medium">{index + 1}. {section.title}</h4><span className="shrink-0 text-xs text-[var(--pbl-text-muted)]">{section.durationMinutes} 分钟</span></div><p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[var(--pbl-text-muted)]">{section.description}</p></div>)}</section>{previewContent.resources.length > 0 && <section><h3 className="mb-3 font-semibold">参考资料</h3><ul className="space-y-2 text-sm">{previewContent.resources.map((resource, index) => <li key={index}>{resource.url ? <a className="text-[var(--pbl-teacher)] underline" href={resource.url} target="_blank" rel="noreferrer">{resource.title}</a> : resource.title}</li>)}</ul></section>}</div> : <p className="py-6 text-sm text-[var(--pbl-text-muted)]">{preview?.description || "此课程尚未填写教学方案，可编辑并补全课程内容。"}</p>}<div className="flex flex-wrap justify-between gap-3 border-t border-[var(--pbl-border)] pt-5"><Link href="/teacher/classes" className="min-h-11 rounded-[6px] border border-[var(--pbl-border)] px-4 text-sm">到课程系列中安排<ArrowRight size={16}/></Link>{preview && preview.status.toLowerCase() !== "archived" && <button className={primary} onClick={() => openEditor(preview)}>编辑课程内容</button>}</div></DialogContent></Dialog>
    <AlertDialog open={!!archiveTarget} onOpenChange={(open) => { if (!busy && !open) setArchiveTarget(null); }}><AlertDialogContent className="pbl-platform-theme pbl-platform-dialog"><AlertDialogHeader><AlertDialogTitle>归档“{archiveTarget?.title}”？</AlertDialogTitle><AlertDialogDescription>归档后不能再添加到新章节，已安排的课堂仍保留原有内容。你仍可在“已归档”中查看课程。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><button className="min-h-11 rounded-[6px] border border-[var(--pbl-border)] px-4 text-sm" disabled={!!busy} onClick={() => setArchiveTarget(null)}>取消</button><button className={primary + " bg-[var(--pbl-danger)]"} disabled={!!busy} onClick={() => void archive()}>{busy === "archive" ? "归档中…" : "确认归档"}</button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </TeacherPlatformPage>;
}
