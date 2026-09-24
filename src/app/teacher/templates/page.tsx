"use client";

import Link from "next/link";
import { ResilientImage } from "@/components/resilient-image";
import { LearningArt } from "@/components/platform/learning-art";
import { PlatformLoading } from "@/components/platform/platform-feedback";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Archive, ArrowRight, BookOpen, Clock3, FileText, LoaderCircle, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { readTemplateContent, templateContentSchema, type TemplateContent } from "@/lib/platform/template-content";
import { decodePblTemplate, type PblTemplateDesign } from "@/lib/platform/pbl-template";
import { teacherPlatformFetch } from "@/lib/platform/client";
import { TeacherPlatformHeader, TeacherPlatformPage } from "@/components/platform/teacher-shell";
import { courseLibraryStatus, coursePreparationHref, type CourseLibraryStatus } from "@/lib/courses/preparation-navigation";
import { courseReferenceCode, formatCourseTimestamp } from "@/lib/platform/course-identity";

type Template = { id: string; title: string; description: string | null; status: string; createdAt?: string; updatedAt?: string; generationStatus?: string | null; versions: Array<{ id: string; version: number; status: string; createdAt?: string; snapshot: unknown }> };
const COURSE_LIBRARY_STATUS: Record<CourseLibraryStatus, { label: string; action: string }> = {
  published: { label: "已发布", action: "查看课程" },
  "completed-unpublished": { label: "已完成未发布", action: "查看并发布" },
  incomplete: { label: "未完成", action: "继续生成" },
  generating: { label: "生成中", action: "查看生成进度" },
  archived: { label: "已归档", action: "查看课程" },
};
const field = "min-h-11 w-full rounded-[6px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pbl-teacher)]";
const primary = "inline-flex min-h-11 items-center justify-center gap-2 rounded-[6px] bg-[var(--pbl-teacher)] px-5 text-sm font-medium text-white disabled:opacity-50";
const emptyContent = (): TemplateContent => ({ schemaVersion: 1, title: "", subject: "", grade: "", durationMinutes: 45, summary: "", learningObjectives: [""], outline: [{ title: "", durationMinutes: 45, description: "" }], resources: [] });

function ArchivedPblPreview({ course }: { course: PblTemplateDesign }) {
  const sections = course.content.teachingOutline ?? [];
  const stagePlan = course.content.stagePlan?.stages ?? [];
  const pages = (course.content._openmaicSceneOutlines ?? []).filter((page) => page.audience !== "teacher");
  return <div className="max-h-[65vh] space-y-6 overflow-y-auto pr-2 text-sm leading-7">
    {course.summary && <p className="whitespace-pre-wrap text-[var(--pbl-text-muted)]">{course.summary}</p>}
    {course.drivingQuestion && <section><h3 className="font-semibold">驱动性问题</h3><p className="mt-2 whitespace-pre-wrap text-[var(--pbl-text-muted)]">{course.drivingQuestion}</p></section>}
    {!!course.learningObjectives?.length && <section><h3 className="font-semibold">学习目标</h3><ul className="mt-2 list-disc pl-5 text-[var(--pbl-text-muted)]">{course.learningObjectives.map((goal, index) => <li key={index}>{goal}</li>)}</ul></section>}
    {course.expectedOutcome && <section><h3 className="font-semibold">预期成果</h3><p className="mt-2 whitespace-pre-wrap text-[var(--pbl-text-muted)]">{course.expectedOutcome}</p></section>}
    {sections.length > 0 ? <section><h3 className="font-semibold">教学安排</h3><ol className="mt-2 divide-y divide-[var(--pbl-border)] border-y border-[var(--pbl-border)]">{sections.map((section, index) => <li className="py-3" key={section.id}><div className="flex justify-between gap-3"><h4 className="font-medium">{index + 1}. {section.title}</h4><span className="shrink-0 text-xs text-[var(--pbl-text-muted)]">{section.durationMin} 分钟</span></div>{section.teachingGoal && <p className="mt-1 text-[var(--pbl-text-muted)]">{section.teachingGoal}</p>}{section.studentActivity && <p className="mt-1 text-[var(--pbl-text-muted)]">学生活动：{section.studentActivity}</p>}</li>)}</ol></section>
      : stagePlan.length > 0 && <section><h3 className="font-semibold">五阶段课堂安排</h3><ol className="mt-2 divide-y divide-[var(--pbl-border)] border-y border-[var(--pbl-border)]">{stagePlan.map((stage, index) => <li className="flex justify-between gap-3 py-2" key={stage.key}><span>{index + 1}. {stage.title}</span><span className="shrink-0 text-xs text-[var(--pbl-text-muted)]">{stage.durationMin ?? 0} 分钟</span></li>)}</ol></section>}
    {!sections.length && !stagePlan.length && course.content.pblOutline && <section><h3 className="font-semibold">课程大纲</h3><p className="mt-2 whitespace-pre-wrap text-[var(--pbl-text-muted)]">{course.content.pblOutline}</p></section>}
    {pages.length > 0 && <section><h3 className="font-semibold">学生课堂页面（{pages.length}）</h3><ol className="mt-2 list-decimal pl-5 text-[var(--pbl-text-muted)]">{pages.map((page) => <li key={page.id}>{page.title}</li>)}</ol></section>}
    {!!course.resources?.length && <section><h3 className="font-semibold">课程资料</h3><ul className="mt-2 list-disc pl-5 text-[var(--pbl-text-muted)]">{course.resources.map((resource) => <li key={resource.id}>{resource.title}</li>)}</ul></section>}
    {!course.summary && !course.drivingQuestion && !course.learningObjectives?.length && !sections.length && !stagePlan.length && !course.content.pblOutline && !pages.length && <p className="py-4 text-[var(--pbl-text-muted)]">这门课程尚未填写或生成详细内容。</p>}
  </div>;
}

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
  const [busy, setBusy] = useState<"generate" | "save" | "archive" | "restore" | "delete" | null>(null);
  const [editorError, setEditorError] = useState("");
  const [preview, setPreview] = useState<Template | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Template | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null);
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
      setEditorOpen(false); setNotice(editing ? "新版本已保存，已安排的课堂保留原版本。" : "课程已加入课程库，可以在教学班的章节中选用。");
      setFilter("active"); await load();
    } catch (reason) { setEditorError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(null); }
  }
  async function archive() {
    if (!archiveTarget || busy) return;
    const target = archiveTarget;
    setBusy("archive"); setError(null);
    try {
      const response = await teacherPlatformFetch(`/api/platform/templates/${target.id}/versions`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "归档失败");
      setArchiveTarget(null); setNotice(`“${target.title}”（编号 ${courseReferenceCode(target.id)}）已归档，已安排的课堂仍保留原有内容。`); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "归档失败"); setArchiveTarget(null); }
    finally { setBusy(null); }
  }

  async function restore(template: Template) {
    if (busy) return;
    setBusy("restore"); setError(null); setNotice("");
    try {
      const response = await teacherPlatformFetch(`/api/platform/templates/${template.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restore" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "恢复失败");
      setNotice(`“${template.title}”（编号 ${courseReferenceCode(template.id)}）已恢复，可重新添加到教学班。`); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "恢复失败"); }
    finally { setBusy(null); }
  }

  async function removeArchived() {
    if (!deleteTarget || busy) return;
    const target = deleteTarget;
    setBusy("delete"); setError(null); setNotice("");
    try {
      const response = await teacherPlatformFetch(`/api/platform/templates/${target.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "删除失败");
      setDeleteTarget(null); setNotice(`“${target.title}”（编号 ${courseReferenceCode(target.id)}）已从课程库删除；已产生的课堂记录仍会保留。`); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败"); setDeleteTarget(null); }
    finally { setBusy(null); }
  }

  const active = templates.filter((item) => item.status.toLowerCase() === "active");
  const archivedCount = templates.filter((item) => item.status.toLowerCase() === "archived").length;
  const versionCount = templates.reduce((sum, item) => sum + item.versions.length, 0);
  const visible = templates.filter((item) => (item.status.toLowerCase() === "archived") === (filter === "archived") && `${item.title} ${item.description ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const previewContent = preview ? readTemplateContent(preview.versions[0]?.snapshot) : null;
  const previewPbl = preview ? decodePblTemplate(preview.versions[0]?.snapshot) : null;

  return <TeacherPlatformPage>
    <TeacherPlatformHeader active="templates" />
    <div className="pbl-workspace-content pbl-teacher-dashboard pbl-teacher-library-page">
      <div className="pbl-page-heading pbl-library-heading pbl-teacher-dashboard-heading"><LearningArt /><div><p className="text-xs font-semibold tracking-[0.18em] text-[var(--pbl-teacher)]">备课资源</p><h1 className="mt-3 text-4xl font-semibold">课程库</h1></div><div className="pbl-classes-heading-actions"><dl className="pbl-heading-metrics" aria-label="课程库概况"><div><dt>可用课程</dt><dd>{loading ? "—" : active.length}</dd></div><div><dt>已归档</dt><dd>{loading ? "—" : archivedCount}</dd></div><div><dt>累计版本</dt><dd>{loading ? "—" : versionCount}</dd></div></dl><button className="pbl-teacher-create-button" disabled={creating} onClick={() => void createCourse()} type="button">{creating ? <LoaderCircle className="animate-spin" size={17} /> : <Plus size={17} />}{creating ? "正在新建…" : "新建课程"}</button></div></div>
      <div className="pbl-list-toolbar pbl-teacher-list-toolbar"><div className="pbl-teacher-segmented" role="group" aria-label="课程状态"><button aria-label="可用课程" aria-pressed={filter === "active"} onClick={() => setFilter("active")}>可用课程 <span>{active.length}</span></button><button aria-label="已归档" aria-pressed={filter === "archived"} onClick={() => setFilter("archived")}>已归档 <span>{archivedCount}</span></button></div><label className="pbl-teacher-search"><Search size={17}/><input aria-label="搜索课程" placeholder="搜索课程名称或内容" value={query} onChange={(event) => setQuery(event.target.value)}/></label></div>
      {error && <div role="alert" className="mt-5 flex items-center justify-between gap-3 rounded-[6px] border border-[var(--pbl-danger)] p-4 text-sm text-[var(--pbl-danger)]">{error}<button className="min-h-11 rounded-[6px] border border-[var(--pbl-border)] px-4 text-sm" onClick={() => void load()}>重试</button></div>}
      {notice && <p role="status" className="mt-5 flex items-center justify-between gap-3 rounded-[6px] border border-[var(--pbl-border)] p-4 text-sm">{notice}<button className="grid min-h-11 min-w-11 place-items-center" aria-label="关闭提示" onClick={() => setNotice("")}><X size={16}/></button></p>}
      {loading ? <PlatformLoading label="正在加载课程库…" /> : visible.length === 0 ? <div className="pbl-empty"><BookOpen size={36} strokeWidth={1.3} className="mx-auto text-[var(--pbl-teacher)]"/><h2 className="mt-5 font-serif text-2xl">{query ? "没有找到匹配课程" : filter === "archived" ? "暂无归档课程" : "课程库为空"}</h2><p className="mx-auto mt-3 max-w-md text-sm leading-7 text-[var(--pbl-text-muted)]">{query ? "尝试其他关键词，或清空搜索查看全部课程。" : filter === "archived" ? "归档课程可以恢复；确认不再需要后也可以删除。" : "填写课程主题与教学要求，生成教学方案并审阅保存；也可以直接编写课程内容。"}</p></div> : <div className="pbl-teacher-card-grid pbl-template-grid">{visible.map((template) => {
        const detail = readTemplateContent(template.versions[0]?.snapshot);
        const pbl = decodePblTemplate(template.versions[0]?.snapshot);
        const archived = template.status.toLowerCase() === "archived";
        const libraryStatus = courseLibraryStatus({
          archived,
          generationStatus: template.generationStatus,
          latestVersionStatus: template.versions[0]?.status,
          generationRun: pbl?.content.classroomGenerationRun,
        });
        const statusCopy = COURSE_LIBRARY_STATUS[libraryStatus];
        const courseHref = coursePreparationHref(template.id, libraryStatus);
        const referenceCode = courseReferenceCode(template.id);
        const accessibleCourseName = `${template.title}（课程编号 ${referenceCode}）`;
        const cardBody = <>
          <div className={"pbl-library-art" + (pbl?.coverImageUrl ? " pbl-library-art-cover" : "")}>
            {pbl?.coverImageUrl
              ? <ResilientImage fallback={<LearningArt />} src={pbl.coverImageUrl} alt={`${template.title}课程封面`} fill unoptimized sizes="(min-width: 1280px) 33vw, 50vw" className="object-cover" />
              : <LearningArt />}
            <span className="pbl-template-kind-label">{pbl ? "项目式学习" : "课程设计"}</span>
            <span className="pbl-template-status-badge" data-status={libraryStatus}>{statusCopy.label}</span>
          </div>
          <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-xs font-medium text-[var(--pbl-teacher)]"><BookOpen size={16}/>{detail?.subject || "课堂教学"}</span><span className="text-xs text-[var(--pbl-text-muted)]">第 {template.versions[0]?.version ?? 1} 版</span></div>
          <h2 className="pbl-template-card-title" title={template.title}>{template.title}</h2>
          <p className="pbl-template-card-description">{detail?.summary || template.description || "打开课程查看内容与版本信息。"}</p>
          <div className="pbl-template-card-meta">{detail && <><span><Clock3 size={14}/>{detail.durationMinutes} 分钟</span><span>{detail.outline.length} 个教学环节</span>{detail.grade && <span>{detail.grade}</span>}</>}</div>
          <dl className="mt-4 grid gap-1.5 border-t border-[var(--pbl-border)] pt-3 text-xs leading-5 text-[var(--pbl-text-muted)]">
            <div className="flex items-baseline justify-between gap-3"><dt>课程编号</dt><dd className="font-mono font-medium tracking-[0.08em] text-[var(--pbl-text-strong)]" title={template.id}>{referenceCode}</dd></div>
            <div className="flex items-baseline justify-between gap-3"><dt>首次生成时间</dt><dd className="tabular-nums"><time dateTime={template.createdAt}>{formatCourseTimestamp(template.createdAt)}</time></dd></div>
            <div className="flex items-baseline justify-between gap-3"><dt>最近修改时间</dt><dd className="tabular-nums"><time dateTime={template.updatedAt}>{formatCourseTimestamp(template.updatedAt)}</time></dd></div>
          </dl>
        </>;
        return <article key={template.id} className="pbl-library-card pbl-template-card">
          {!archived && pbl ? (
            <Link aria-label={`打开课程 ${accessibleCourseName}`} className="pbl-template-card-main" href={courseHref}>{cardBody}</Link>
          ) : (
            <button aria-label={`打开课程 ${accessibleCourseName}`} className="pbl-template-card-main text-left" onClick={() => setPreview(template)} type="button">{cardBody}</button>
          )}
          <div className="pbl-template-card-footer">
            {!archived && pbl ? <Link className="flex min-h-11 items-center gap-2 text-sm font-medium text-[var(--pbl-teacher)]" href={courseHref}>{statusCopy.action}<ArrowRight size={16}/></Link> : <button className="flex min-h-11 items-center gap-2 text-sm font-medium text-[var(--pbl-teacher)]" onClick={() => setPreview(template)}>查看课程<ArrowRight size={16}/></button>}
            {archived ? <span className="flex items-center gap-1">
              <button className="grid min-h-11 min-w-11 place-items-center text-[var(--pbl-teacher)]" aria-label={`恢复 ${accessibleCourseName}`} disabled={Boolean(busy)} onClick={() => void restore(template)}><RotateCcw size={16}/></button>
              <button className="grid min-h-11 min-w-11 place-items-center text-[var(--pbl-danger)]" aria-label={`删除 ${accessibleCourseName}`} disabled={Boolean(busy)} onClick={() => setDeleteTarget(template)}><Trash2 size={16}/></button>
            </span> : <button className="grid min-h-11 min-w-11 place-items-center text-[var(--pbl-text-muted)] hover:text-[var(--pbl-danger)]" aria-label={`归档 ${accessibleCourseName}`} onClick={() => setArchiveTarget(template)}><Archive size={16}/></button>}
          </div>
        </article>;
      })}</div>}
    </div>
    <Dialog open={editorOpen} onOpenChange={(open) => { if (!busy) setEditorOpen(open); }}><DialogContent className="pbl-platform-theme pbl-platform-dialog bg-[var(--pbl-surface)] sm:max-w-4xl"><DialogHeader><DialogTitle className="font-serif text-2xl">{editing ? "编辑课程内容" : "新建课程"}</DialogTitle><DialogDescription>填写教学需求后生成方案，审阅并保存后即可在章节中选用。</DialogDescription></DialogHeader><form onSubmit={save} className="space-y-7"><fieldset disabled={!!busy} className="space-y-5 disabled:opacity-70"><div className="grid gap-4 sm:grid-cols-2"><label className="space-y-2 text-sm">课程名称<input className={field} value={content.title} readOnly={!!editing} required maxLength={160} onChange={(e) => setContent({ ...content, title: e.target.value })} placeholder="例如：为校园设计雨水收集系统"/></label><label className="space-y-2 text-sm">学科<input className={field} value={content.subject} maxLength={100} onChange={(e) => setContent({ ...content, subject: e.target.value })} placeholder="例如：科学 · 跨学科实践"/></label><label className="space-y-2 text-sm">适用年级<input className={field} value={content.grade} maxLength={100} onChange={(e) => setContent({ ...content, grade: e.target.value })} placeholder="例如：初中七年级"/></label><label className="space-y-2 text-sm">课程时长（分钟）<input className={field} type="number" min={5} max={600} required value={content.durationMinutes} onChange={(e) => setContent({ ...content, durationMinutes: Number(e.target.value) })}/></label></div><div className="border-y border-[var(--pbl-border)] py-5"><label className="block space-y-2 text-sm">教学要求<textarea className={field + " min-h-24"} value={brief} maxLength={12000} onChange={(e) => setBrief(e.target.value)} placeholder="描述希望学生学会什么、已有基础、教学情境及期待的学习成果。"/></label><div className="mt-3 flex flex-wrap items-center gap-3"><button type="button" className="min-h-11 rounded-[6px] border border-[var(--pbl-border)] px-4 text-sm" disabled={!content.title.trim() || !brief.trim() || !!busy} onClick={() => void generate()}>{busy === "generate" ? <LoaderCircle size={16} className="animate-spin"/> : <FileText size={16}/>} {busy === "generate" ? "正在生成教学方案…" : "根据要求生成方案"}</button><span className="text-xs leading-6 text-[var(--pbl-text-muted)]">生成会替换下方方案；保存前请确认内容。</span></div></div><label className="block space-y-2 text-sm">课程简介<textarea className={field + " min-h-24"} value={content.summary} maxLength={10000} required onChange={(e) => setContent({ ...content, summary: e.target.value })}/></label><label className="block space-y-2 text-sm">学习目标<span className="ml-2 text-xs text-[var(--pbl-text-muted)]">每行一个目标</span><textarea className={field + " min-h-24"} value={content.learningObjectives.join("\n")} required onChange={(e) => setContent({ ...content, learningObjectives: e.target.value.split("\n") })}/></label><section><div className="mb-3 flex items-center justify-between"><h3 className="font-semibold">教学环节</h3><span className="text-xs text-[var(--pbl-text-muted)]">已分配 {content.outline.reduce((sum, item) => sum + item.durationMinutes, 0)} / {content.durationMinutes} 分钟</span></div><div className="divide-y divide-[var(--pbl-border)]">{content.outline.map((section, index) => <div key={index} className="py-4"><div className="mb-3 flex items-center gap-3"><span className="font-serif text-lg text-[var(--pbl-text-muted)]">{String(index + 1).padStart(2, "0")}</span><input aria-label={`环节 ${index + 1} 名称`} className={field} required value={section.title} onChange={(e) => setContent({ ...content, outline: content.outline.map((item, i) => i === index ? { ...item, title: e.target.value } : item) })}/><input aria-label={`环节 ${index + 1} 分钟`} className={field + " max-w-20"} type="number" min={1} max={600} required value={section.durationMinutes} onChange={(e) => setContent({ ...content, outline: content.outline.map((item, i) => i === index ? { ...item, durationMinutes: Number(e.target.value) } : item) })}/><button className="grid min-h-11 min-w-11 place-items-center" type="button" aria-label={`删除环节 ${index + 1}`} disabled={content.outline.length === 1} onClick={() => setContent({ ...content, outline: content.outline.filter((_, i) => i !== index) })}><X size={16}/></button></div><textarea className={field + " min-h-24"} aria-label={`环节 ${index + 1} 教学内容`} required value={section.description} onChange={(e) => setContent({ ...content, outline: content.outline.map((item, i) => i === index ? { ...item, description: e.target.value } : item) })} placeholder="教学内容、学生任务和成果要求"/></div>)}</div><button className="min-h-11 rounded-[6px] border border-[var(--pbl-border)] px-4 text-sm" type="button" disabled={content.outline.length >= 30} onClick={() => setContent({ ...content, outline: [...content.outline, { title: "", durationMinutes: 5, description: "" }] })}><Plus size={16}/>添加教学环节</button></section><section><h3 className="mb-3 font-semibold">参考资料</h3>{content.resources.map((resource, index) => <div key={index} className="mb-3 flex flex-wrap gap-2"><input className={field + " flex-1 basis-48"} aria-label={`资料 ${index + 1} 名称`} placeholder="资料名称或准备建议" required value={resource.title} onChange={(e) => setContent({ ...content, resources: content.resources.map((item, i) => i === index ? { ...item, title: e.target.value } : item) })}/><input className={field + " flex-1 basis-48"} aria-label={`资料 ${index + 1} 链接`} placeholder="https://（可选）" type="url" value={resource.url} onChange={(e) => setContent({ ...content, resources: content.resources.map((item, i) => i === index ? { ...item, url: e.target.value } : item) })}/><button className="grid min-h-11 min-w-11 place-items-center" type="button" aria-label={`删除资料 ${index + 1}`} onClick={() => setContent({ ...content, resources: content.resources.filter((_, i) => i !== index) })}><X size={16}/></button></div>)}<button className="min-h-11 rounded-[6px] border border-[var(--pbl-border)] px-4 text-sm" type="button" disabled={content.resources.length >= 30} onClick={() => setContent({ ...content, resources: [...content.resources, { title: "", url: "" }] })}><Plus size={16}/>添加参考资料</button></section></fieldset>{editorError && <p role="alert" className="text-sm text-[var(--pbl-danger)]">{editorError}</p>}<div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--pbl-border)] pt-5"><p className="text-xs text-[var(--pbl-text-muted)]">{editing ? "保存为新版本，已安排的课堂不受影响。" : "保存后可在教学班中添加为课堂内容。"}</p><button className={primary} type="submit" disabled={!!busy}>{busy === "save" ? "保存中…" : editing ? "保存新版本" : "保存到课程库"}</button></div></form></DialogContent></Dialog>
    <Dialog open={!!preview} onOpenChange={(open) => { if (!open) setPreview(null); }}><DialogContent className="pbl-platform-theme pbl-platform-dialog bg-[var(--pbl-surface)] sm:max-w-3xl"><DialogHeader><DialogTitle className="font-serif text-2xl">{preview?.title}</DialogTitle><DialogDescription>{preview ? `${previewContent ? `${previewContent.grade || "课堂教学"} · ${previewContent.durationMinutes} 分钟 · ` : previewPbl ? `${previewPbl.grade || "项目式学习"} · ` : ""}课程编号 ${courseReferenceCode(preview.id)} · 首次生成 ${formatCourseTimestamp(preview.createdAt)}` : "课程内容与版本"}</DialogDescription></DialogHeader>{previewContent ? <div className="space-y-6"><p className="text-sm leading-7 text-[var(--pbl-text-muted)]">{previewContent.summary}</p><section><h3 className="mb-3 font-semibold">学习目标</h3><ul className="list-disc space-y-2 pl-5 text-sm leading-7">{previewContent.learningObjectives.map((goal, index) => <li key={index}>{goal}</li>)}</ul></section><section><h3 className="mb-3 font-semibold">教学环节</h3>{previewContent.outline.map((section, index) => <div key={index} className="border-t border-[var(--pbl-border)] py-4"><div className="flex justify-between gap-3"><h4 className="font-medium">{index + 1}. {section.title}</h4><span className="shrink-0 text-xs text-[var(--pbl-text-muted)]">{section.durationMinutes} 分钟</span></div><p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[var(--pbl-text-muted)]">{section.description}</p></div>)}</section>{previewContent.resources.length > 0 && <section><h3 className="mb-3 font-semibold">参考资料</h3><ul className="space-y-2 text-sm">{previewContent.resources.map((resource, index) => <li key={index}>{resource.url ? <a className="text-[var(--pbl-teacher)] underline" href={resource.url} target="_blank" rel="noreferrer">{resource.title}</a> : resource.title}</li>)}</ul></section>}</div> : previewPbl ? <ArchivedPblPreview course={previewPbl} /> : <p className="py-6 text-sm text-[var(--pbl-text-muted)]">{preview?.description || "此课程尚未填写教学方案，可编辑并补全课程内容。"}</p>}<div className="flex flex-wrap justify-between gap-3 border-t border-[var(--pbl-border)] pt-5">{preview?.status.toLowerCase() === "archived" ? <p className="text-xs text-[var(--pbl-text-muted)]">已归档，仅供查看。恢复后可继续备课或安排到教学班。</p> : <><Link href="/teacher/classes" className="min-h-11 rounded-[6px] border border-[var(--pbl-border)] px-4 text-sm">到教学班中安排<ArrowRight size={16}/></Link>{preview && <button className={primary} onClick={() => openEditor(preview)}>编辑课程内容</button>}</>}</div></DialogContent></Dialog>
    <AlertDialog open={!!archiveTarget} onOpenChange={(open) => { if (!busy && !open) setArchiveTarget(null); }}><AlertDialogContent className="pbl-platform-theme pbl-platform-dialog"><AlertDialogHeader><AlertDialogTitle>归档“{archiveTarget?.title}”？</AlertDialogTitle><AlertDialogDescription>归档后不能再添加到新章节，已安排的课堂仍保留原有内容。你仍可在“已归档”中查看课程。{archiveTarget && <span className="mt-2 block">课程编号 {courseReferenceCode(archiveTarget.id)} · 首次生成 {formatCourseTimestamp(archiveTarget.createdAt)}</span>}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><button className="min-h-11 rounded-[6px] border border-[var(--pbl-border)] px-4 text-sm" disabled={!!busy} onClick={() => setArchiveTarget(null)}>取消</button><button className={primary + " bg-[var(--pbl-danger)]"} disabled={!!busy} onClick={() => void archive()}>{busy === "archive" ? "归档中…" : "确认归档"}</button></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!busy && !open) setDeleteTarget(null); }}><AlertDialogContent className="pbl-platform-theme pbl-platform-dialog"><AlertDialogHeader><AlertDialogTitle>删除“{deleteTarget?.title}”？</AlertDialogTitle><AlertDialogDescription>删除后无法从课程库恢复，但已安排的课堂和学习记录会继续保留。{deleteTarget && <span className="mt-2 block">课程编号 {courseReferenceCode(deleteTarget.id)} · 首次生成 {formatCourseTimestamp(deleteTarget.createdAt)}</span>}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><button className="min-h-11 rounded-[6px] border border-[var(--pbl-border)] px-4 text-sm" disabled={!!busy} onClick={() => setDeleteTarget(null)}>取消</button><button className={primary + " bg-[var(--pbl-danger)]"} disabled={!!busy} onClick={() => void removeArchived()}>{busy === "delete" ? "删除中…" : "确认删除"}</button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </TeacherPlatformPage>;
}
