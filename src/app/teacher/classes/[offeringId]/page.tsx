"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import Link from "next/link";
import { ResilientImage } from "@/components/resilient-image";
import { TeacherPlatformPage, TeacherPlatformHeader } from "@/components/platform/teacher-shell";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, BarChart3, BookOpen, Check, ChevronDown, ClipboardList, Copy, Download, FileText, Link2, LockKeyhole, MoreHorizontal, ArrowUpRight, PencilLine, Play, Plus, Settings2, Sparkles, Trash2, UnlockKeyhole, Upload, Users, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from "@/components/ui/overlays";
import { offeringStatusLabel, instanceStatusLabel } from "@/lib/platform/labels";
import { teacherPlatformFetch } from "@/lib/platform/client";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { publishedClassroomVersion, teacherClassroomEntry } from "@/lib/platform/classroom-entry";
import { createEmptySurveyQuestion, SurveyBuilder } from "@/components/platform/survey-builder";
import type { ExperimentConfig } from "@/lib/platform/experiment";
import type { SurveyQuestion } from "@/lib/platform/survey";
import { LearningArt } from "@/components/platform/learning-art";
import { CoTeachLogo } from "@/components/brand/coteach-logo";
import { clientUUID } from "@/lib/uuid";
import { copyTextToClipboard } from "@/lib/browser/copy-text";
import { courseReferenceCode, formatCourseTimestamp } from "@/lib/platform/course-identity";
const STUDENT_ACCESS_ADDRESS = "coteach.cn";
type Instance = {
    id: string;
    status: string;
    coverImageUrl?: string | null;
};
type Activity = {
    id: string;
    title: string;
    type: string;
    isOpen: boolean;
    description?: string;
    version?: number;
    hasResponses?: boolean;
    templateId?: string | null;
    templateVersionId?: string | null;
    config?: {
        content?: string;
        url?: string;
        resourceKind?: "link" | "file";
        fileId?: string;
        fileName?: string;
        fileSize?: string;
        questions?: SurveyQuestion[];
        experiment?: ExperimentConfig;
    };
    instances?: Instance[];
};
type Chapter = {
    id: string;
    title: string;
    isOpen: boolean;
    version?: number;
    activities: Activity[];
};
type CourseReference = {
    id: string;
    kind: "link" | "file";
    title: string;
    url: string;
    fileName?: string;
    fileSize?: string;
    file?: File;
};
type Offering = {
    id: string;
    name: string;
    term?: string | null;
    description?: string | null;
    coverImageUrl?: string | null;
    startsAt?: string | null;
    endsAt?: string | null;
    outline?: string;
    referenceMaterials?: string;
    courseReferences?: CourseReference[];
    status: string;
    version?: number;
    invitation?: {
        code: string;
    } | null;
    chapters: Chapter[];
};
type Template = {
    id: string;
    title: string;
    status?: string;
    createdAt?: string;
    versions: Array<{
        id: string;
        version: number;
        status: string;
    }>;
};
const types: Record<string, string> = { Classroom: "课堂", Form: "问卷", Assignment: "作业", Quiz: "测验", Resource: "资料" };
const typeDescriptions: Record<string, string> = {
    Classroom: "关联课程库中已发布的教案，由原授课工作台完成配置与授课。",
    Form: "收集学生反馈，提交结果将在教师数据看板中汇总。",
    Assignment: "向学生发布任务要求，供学生提交过程或成果。",
    Quiz: "创建文字回答题目，用于快速检查学习理解。",
    Resource: "发布说明、外部链接或 PDF 文档，供学生随时查阅。",
};
const field = "min-h-11 w-full rounded-[6px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-3 py-2 text-sm";
const button = "pbl-teacher-button inline-flex min-h-10 items-center justify-center gap-2 rounded-[8px] border border-[var(--pbl-border)] px-3 text-sm font-medium disabled:opacity-50";
const rowAction = `${button} pbl-row-secondary-action`;
const readyVersion = (template?: Template) => publishedClassroomVersion(template?.versions);
function TeacherActivityIcon({ type }: { type: string }) {
    const Icon = type === "Classroom" ? Play : type === "Resource" ? FileText : ClipboardList;
    return <Icon aria-hidden="true" size={17}/>;
}
function AccessToggle({
    disabled,
    isOpen,
    onToggle,
    subject,
    title,
}: {
    disabled: boolean;
    isOpen: boolean;
    onToggle: () => Promise<boolean>;
    subject: "章节" | "内容";
    title?: string;
}) {
    const [feedbackState, setFeedbackState] = useState<boolean | null>(null);
    const [expanded, setExpanded] = useState(false);
    const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const displayedIsOpen = feedbackState ?? isOpen;

    useEffect(() => () => {
        if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    }, []);

    async function toggleAccess() {
        const nextIsOpen = !isOpen;
        if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
        setFeedbackState(nextIsOpen);
        setExpanded(true);
        const succeeded = await onToggle();
        if (!succeeded) {
            setFeedbackState(null);
            setExpanded(false);
            return;
        }
        collapseTimerRef.current = setTimeout(() => {
            setFeedbackState(null);
            setExpanded(false);
            collapseTimerRef.current = null;
        }, 2000);
    }

    const stateLabel = displayedIsOpen ? "已解锁" : "已锁定";
    return (
        <button
            type="button"
            className={`pbl-access-toggle ${displayedIsOpen ? "is-open" : "is-locked"}${expanded ? " is-expanded" : ""}`}
            aria-label={`${isOpen ? "锁定" : "解锁"}${subject}`}
            aria-pressed={isOpen}
            disabled={disabled}
            title={title ?? `当前${isOpen ? "已解锁" : "已锁定"}，点击${isOpen ? "锁定" : "解锁"}${subject}`}
            onClick={() => void toggleAccess()}
        >
            <span className="pbl-access-icon" aria-hidden="true">
                {displayedIsOpen ? <UnlockKeyhole /> : <LockKeyhole />}
            </span>
            <span className="pbl-access-label" aria-hidden={!expanded}>{stateLabel}</span>
        </button>
    );
}
export default function TeacherClassEditorPage() {
    const router = useRouter();
    const { offeringId } = useParams<{
        offeringId: string;
    }>();
    const [offering, setOffering] = useState<Offering | null>(null);
    const [templates, setTemplates] = useState<Template[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);
    const [tab, setTab] = useState("chapters");
    const [dialog, setDialog] = useState<"chapter" | "activity" | "info" | null>(null);
    const [chapterId, setChapterId] = useState("");
    const [chapterTitle, setChapterTitle] = useState("");
    const [editChapter, setEditChapter] = useState<Chapter | null>(null);
    const [editActivity, setEditActivity] = useState<Activity | null>(null);
    const [activityToDelete, setActivityToDelete] = useState<Activity | null>(null);
    const [activity, setActivity] = useState<{
        title: string;
        type: string;
        templateVersionId: string;
        content: string;
        url: string;
        resourceKind: "link" | "file";
        file: File | null;
        fileId: string;
        fileName: string;
        fileSize: string;
        questions: string;
        surveyQuestions: SurveyQuestion[];
    }>({ title: "", type: "Classroom", templateVersionId: "", content: "", url: "", resourceKind: "link", file: null, fileId: "", fileName: "", fileSize: "", questions: "", surveyQuestions: [createEmptySurveyQuestion()] });
    const [preferredTemplateVersionId, setPreferredTemplateVersionId] = useState("");
    const [info, setInfo] = useState({ name: "", term: "", description: "", coverImageUrl: "", startsAt: "", endsAt: "", outline: "", referenceMaterials: "" });
    const [courseReferences, setCourseReferences] = useState<CourseReference[]>([]);
    const [removedCourseFileIds, setRemovedCourseFileIds] = useState<string[]>([]);
    const [expandedChapters, setExpandedChapters] = useState<Set<string>>(new Set());
    const [invitationOpen, setInvitationOpen] = useState(false);
    const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
    const copyButtonRef = useRef<HTMLButtonElement>(null);
    const coverInputRef = useRef<HTMLInputElement>(null);
    const load = useCallback(async () => {
        const [response, templateResponse] = await Promise.all([teacherPlatformFetch("/api/platform/offerings", { cache: "no-store" }), teacherPlatformFetch("/api/platform/templates", { cache: "no-store" })]);
        const [data, templateData] = await Promise.all([response.json(), templateResponse.json()]);
        if (!response.ok)
            throw new Error(data.message ?? "无法加载教学班");
        const found = data.offerings?.find((item: Offering) => item.id === offeringId);
        if (!found)
            throw new Error("课程不存在或您没有访问权限");
        setOffering(found);
        setExpandedChapters((current) => current.size ? current : new Set(found.chapters.map((chapter: Chapter) => chapter.id)));
        if (!templateResponse.ok)
            throw new Error(templateData.message ?? "课程库暂时无法加载");
        setTemplates(templateData.templates ?? []);
    }, [offeringId]);
    useEffect(() => {
        setPreferredTemplateVersionId(new URLSearchParams(window.location.search).get("templateVersionId") ?? "");
        void load().catch((reason) => setError(reason instanceof Error ? reason.message : "加载失败"));
    }, [load]);
    async function mutate(url: string, body?: unknown, method = "PATCH") {
        const response = await teacherPlatformFetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        const data = await response.json();
        if (!response.ok)
            throw new Error(data.message ?? "操作失败，请重试");
        return data;
    }
    async function run(action: () => Promise<void>, success = "已保存", reloadAfter = true): Promise<boolean> {
        if (busy)
            return false;
        setBusy(true);
        setError(null);
        setMessage("");
        try {
            await action();
            if (reloadAfter) await load();
            setMessage(success);
            return true;
        }
        catch (reason) {
            await load().catch(() => undefined);
            setError(reason instanceof Error ? reason.message : "操作失败，请重试");
            return false;
        }
        finally {
            setBusy(false);
        }
    }
    function uploadCover(file: File) {
        void run(async () => {
            const form = new FormData();
            form.append("file", file);
            const response = await teacherPlatformFetch(`/api/platform/offerings/${offeringId}/cover`, { method: "PUT", body: form });
            const data = await response.json().catch(() => ({})) as {
                offering?: Partial<Offering>;
                message?: string;
            };
            if (!response.ok)
                throw new Error(data.message ?? "课程封面上传失败，请重试");
            const updated = data.offering;
            if (!updated?.coverImageUrl) throw new Error("课程封面上传成功，但未返回新图片地址");
            setOffering((current) => current ? { ...current, ...updated } : current);
        }, "课程封面已上传", false);
    }
    function openActivity(chapter: Chapter, item?: Activity) {
        setChapterId(chapter.id);
        setEditActivity(item ?? null);
        setError(null);
        const preferredTemplate = !item ? templates.find((template) => template.versions.some((version) => version.id === preferredTemplateVersionId)) : undefined;
        const preferredVersion = readyVersion(preferredTemplate);
        const configuredQuestions = item?.config?.questions?.map((question) => ({ ...question, type: question.type ?? "short-text", chartType: question.chartType ?? (question.type === "multiple-choice" ? "bar" : "donut"), options: question.options ?? [] })) ?? [];
        const resourceKind = item?.config?.resourceKind ?? (item?.config?.url?.startsWith("/api/uploads/") ? "file" : "link");
        setActivity({ title: item?.title ?? preferredTemplate?.title ?? "", type: item?.type ?? "Classroom", templateVersionId: item?.templateVersionId ?? preferredVersion?.id ?? "", content: item?.config?.content ?? item?.description ?? "", url: item?.config?.url ?? "", resourceKind, file: null, fileId: item?.config?.fileId ?? "", fileName: item?.config?.fileName ?? "", fileSize: item?.config?.fileSize ?? "", questions: configuredQuestions.map((question) => question.title).join("\n"), surveyQuestions: configuredQuestions.length ? configuredQuestions : [createEmptySurveyQuestion()] });
        setDialog("activity");
    }
    function openInfo() {
        if (!offering)
            return;
        setInfo({ name: offering.name, term: offering.term ?? "", description: offering.description ?? "", coverImageUrl: offering.coverImageUrl ?? "", startsAt: offering.startsAt?.slice(0, 10) ?? "", endsAt: offering.endsAt?.slice(0, 10) ?? "", outline: offering.outline ?? "", referenceMaterials: offering.referenceMaterials ?? "" });
        setCourseReferences(offering.courseReferences ?? []);
        setRemovedCourseFileIds([]);
        setDialog("info");
        setError(null);
    }
    function save(event: FormEvent) {
        event.preventDefault();
        void run(async () => {
            if (dialog === "chapter")
                await mutate(editChapter ? `/api/platform/chapters/${editChapter.id}` : `/api/platform/offerings/${offeringId}/chapters`, { title: chapterTitle.trim(), ...(editChapter ? { version: editChapter.version } : {}) }, editChapter ? "PATCH" : "POST");
            if (dialog === "info") {
                const referenceLinks = courseReferences.filter((reference) => reference.kind === "link").map(({ id, title, url }) => ({ id, title: title.trim(), url: url.trim() }));
                await mutate(`/api/platform/offerings/${offeringId}`, { ...info, referenceLinks, coverImageUrl: info.coverImageUrl || null, startsAt: info.startsAt ? new Date(`${info.startsAt}T00:00:00+08:00`).toISOString() : null, endsAt: info.endsAt ? new Date(`${info.endsAt}T23:59:59+08:00`).toISOString() : null, version: offering?.version });
                for (const reference of courseReferences.filter((item) => item.kind === "file" && item.file)) {
                    const file = reference.file!;
                    if (file.type !== "application/pdf" || !file.name.toLowerCase().endsWith(".pdf")) throw new Error("课程参考资料仅支持 PDF 文档");
                    const form = new FormData();
                    form.append("file", file);
                    form.append("title", reference.title.trim() || file.name);
                    form.append("courseId", offeringId);
                    form.append("bindAsCourseResource", "true");
                    const response = await teacherPlatformFetch("/api/uploads", { method: "POST", body: form });
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok) throw new Error(data.message ?? "课程参考资料上传失败，请重试");
                }
                for (const fileId of removedCourseFileIds) {
                    const response = await teacherPlatformFetch(`/api/uploads/${fileId}`, { method: "DELETE" });
                    if (!response.ok) {
                        const data = await response.json().catch(() => ({}));
                        throw new Error(data.message ?? "课程参考资料删除失败，请重试");
                    }
                }
            }
            if (dialog === "activity") {
                let resource = { url: activity.url, fileId: activity.fileId, fileName: activity.fileName, fileSize: activity.fileSize };
                if (activity.type === "Resource" && activity.resourceKind === "file" && activity.file) {
                    if (activity.file.type !== "application/pdf" || !activity.file.name.toLowerCase().endsWith(".pdf")) throw new Error("请选择 PDF 文档");
                    const form = new FormData();
                    form.append("file", activity.file);
                    form.append("title", activity.title.trim() || activity.file.name);
                    form.append("courseId", offeringId);
                    form.append("bindAsCourseResource", "true");
                    const response = await teacherPlatformFetch("/api/uploads", { method: "POST", body: form });
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok || !data.id || !data.url) throw new Error(data.message ?? "PDF 上传失败，请重试");
                    resource = { url: data.url, fileId: data.id, fileName: data.fileName ?? activity.file.name, fileSize: data.size ?? "" };
                }
                const config = activity.type === "Form" && editActivity?.hasResponses
                    ? { ...editActivity.config, content: activity.content }
                    : { ...(activity.type === "Classroom" ? editActivity?.config ?? {} : {}), schemaVersion: activity.type === "Form" ? 2 : 1, content: activity.content, ...(activity.type === "Resource" ? { resourceKind: activity.resourceKind, ...(resource.url ? { url: resource.url } : {}), ...(activity.resourceKind === "file" && resource.fileId ? { fileId: resource.fileId, fileName: resource.fileName, fileSize: resource.fileSize } : {}) } : activity.url ? { url: activity.url } : {}), ...(activity.type === "Form" ? { questions: activity.surveyQuestions } : activity.type === "Quiz" ? { questions: activity.questions.split("\n").map((title) => title.trim()).filter(Boolean).map((title, index) => ({ id: editActivity?.config?.questions?.[index]?.id ?? `q${index + 1}`, title, required: true })) } : {}) };
                await mutate(editActivity ? `/api/platform/activities/${editActivity.id}/manage` : `/api/platform/offerings/${offeringId}/chapters/${chapterId}/activities`, { title: activity.title.trim(), description: activity.content, config, ...(editActivity ? { version: editActivity.version } : { type: activity.type }), ...(activity.type === "Classroom" ? { templateVersionId: activity.templateVersionId || undefined } : {}) }, editActivity ? "PATCH" : "POST");
            }
            setDialog(null);
        });
    }
    async function copyInvitation() {
        if (!offering?.invitation?.code)
            return;
        try {
            await copyTextToClipboard(offering.invitation.code);
            setCopyStatus("copied");
        }
        catch {
            setCopyStatus("failed");
        }
    }
    function toggleChapter(id: string) {
        setExpandedChapters((current) => {
            const next = new Set(current);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    }
    if (!offering)
        return <TeacherPlatformPage compactNav><TeacherPlatformHeader compact active="classes" backHref="/teacher/classes" backLabel="返回教学班"/><div className="pbl-workspace-content"><p role={error ? "alert" : "status"}>{error || "正在加载教学班…"}</p>{error ? <button className={`${button} mt-4`} onClick={() => void run(async () => { })}>重试</button> : null}</div></TeacherPlatformPage>;
    const count = offering.chapters.reduce((total, chapter) => total + chapter.activities.length, 0);
    const activeChapterTitle = offering.chapters.find((chapter) => chapter.id === chapterId)?.title ?? "当前章节";
    const dialogTitle = dialog === "info" ? "课程设置" : dialog === "chapter" ? editChapter ? "编辑章节" : "添加章节" : editActivity ? "编辑学习内容" : "添加学习内容";
    const dialogEyebrow = dialog === "info" ? "课程主页与开放周期" : dialog === "chapter" ? "组织学习路径" : editActivity ? "更新当前内容" : `添加到 · ${activeChapterTitle}`;
    const dialogDescription = dialog === "info" ? "集中维护学生在课程主页看到的信息，以及本期课程的起止时间。" : dialog === "chapter" ? "用清晰的学习阶段命名章节，帮助学生理解课程推进路径。" : typeDescriptions[activity.type];
    const dialogSubmitLabel = dialog === "info" ? "保存课程设置" : dialog === "chapter" ? editChapter ? "保存章节名称" : "添加章节" : editActivity ? "保存内容修改" : "添加到章节";
    const availableTemplates = templates.filter((template) => template.status?.toLowerCase() === "active" && readyVersion(template));
    return <TeacherPlatformPage compactNav><TeacherPlatformHeader compact active="classes" backHref="/teacher/classes" backLabel="返回教学班"/>

    <div className="pbl-workspace-content pbl-teacher-course-page">
      <div className="pbl-course-heading pbl-teacher-course-heading">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-[var(--pbl-text-muted)]">
            <span>{offering.term || "教学班"}</span>
            <span className="pbl-teacher-course-status">{offeringStatusLabel(offering.status)}</span>
          </div>
          <h1 title={offering.name}>{offering.name}</h1>
          {offering.description ? <p className="pbl-teacher-course-description">{offering.description}</p> : null}
          <dl className="pbl-teacher-course-metrics">
            <div><dt>章节</dt><dd>{offering.chapters.length}</dd></div>
            <div><dt>学习内容</dt><dd>{count}</dd></div>
            <div><dt>开课日期</dt><dd>{offering.startsAt ? new Date(offering.startsAt).toLocaleDateString("zh-CN") : "待设置"}</dd></div>
          </dl>
        </div>
        <div className="pbl-teacher-course-tools" aria-label="课程快捷管理">
          <p>课程管理</p>
          <div className="pbl-teacher-course-actions">
            <Link className="pbl-course-quick-action" href={`/teacher/classes/${offeringId}/students`}>
              <span><Users size={17}/></span><span><strong>学生管理</strong><small>成员与学习记录</small></span>
            </Link>
            {offering.invitation ? (
              <button className="pbl-course-quick-action" onClick={() => { setCopyStatus("idle"); setInvitationOpen(true); }}>
                <span><Copy size={17}/></span><span><strong>学生邀请码</strong><small className="is-active">已激活 · 点击展示</small></span>
              </button>
            ) : (
              <button disabled={busy} className="pbl-course-quick-action" onClick={() => void run(async () => { await mutate(`/api/platform/offerings/${offeringId}/invitation`, {}, "POST"); }, "学生邀请码已激活，可用于注册")}>
                <span><Copy size={17}/></span><span><strong>学生邀请码</strong><small>点击激活</small></span>
              </button>
            )}
            <button className="pbl-course-quick-action" onClick={openInfo}>
              <span><Settings2 size={17}/></span><span><strong>课程设置</strong><small>主页与开课信息</small></span>
            </button>
          </div>
          {offering.status.toLowerCase() === "draft" ? <button disabled={busy} className="pbl-course-open-action" onClick={() => void run(async () => { await mutate(`/api/platform/offerings/${offeringId}`, { status: "open", version: offering.version }); }, "课程已开放，学生现在可以进入已解锁内容")}><UnlockKeyhole size={15}/>开放课程给学生</button> : null}
        </div>
      </div>
      <div className="pbl-teacher-course-tabs">
        <div role="tablist" aria-label="课程管理" className="flex gap-7">{[["chapters", "章节目录"], ["overview", "课程主页"]].map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? "is-active" : undefined} onClick={() => setTab(value)}>{label}</button>)}</div>
        <div className="pbl-teacher-course-tab-actions">
          <p role="status" className="text-xs text-[var(--pbl-text-muted)]">{busy ? "正在保存…" : message}</p>
          {tab === "chapters" ? (
            <button
              className={button + " border-transparent bg-[var(--pbl-teacher)] text-white"}
              onClick={() => {
                setEditChapter(null);
                setChapterTitle("");
                setError(null);
                setDialog("chapter");
              }}
            >
              <Plus size={15} />
              添加章节
            </button>
          ) : null}
        </div>
      </div>
      {error && !dialog ? <p role="alert" className="mt-4 text-sm text-[var(--pbl-danger)]">{error}</p> : null}
      {tab === "chapters" ? (
        <>
          <div className="pbl-teacher-chapter-list" role="list" aria-label="课程章节">
            {offering.chapters.map((chapter, index) => {
              const isExpanded = expandedChapters.has(chapter.id);
              return (
                <article key={chapter.id} role="listitem" className={"pbl-teacher-chapter" + (isExpanded ? " is-expanded" : "")}>
                  <header className="pbl-teacher-chapter-heading">
                    <button
                      type="button"
                      className="pbl-teacher-chapter-toggle"
                      onClick={() => toggleChapter(chapter.id)}
                      aria-expanded={isExpanded}
                      aria-controls={"teacher-chapter-" + chapter.id}
                    >
                      <span className="pbl-teacher-chapter-index" aria-hidden="true"><small>CHAPTER</small>{String(index + 1).padStart(2, "0")}</span>
                      <span className="min-w-0 flex-1 text-left">
                        <strong title={chapter.title}>{chapter.title}</strong>
                        <small>{chapter.activities.length} 项学习内容</small>
                      </span>
                      <ChevronDown size={17} className="pbl-teacher-chapter-chevron" />
                    </button>
                    <div className="pbl-teacher-chapter-actions">
                      <AccessToggle
                        disabled={busy}
                        isOpen={chapter.isOpen}
                        subject="章节"
                        title={chapter.isOpen ? "当前学生可见，点击锁定章节" : "当前学生不可见，点击解锁章节"}
                        onToggle={() => run(async () => {
                          await mutate("/api/platform/chapters/" + chapter.id, {
                            isOpen: !chapter.isOpen,
                            version: chapter.version,
                          });
                        }, chapter.isOpen ? "章节及其内容已锁定" : "章节已解锁")}
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="pbl-row-more-button" aria-label={chapter.title + "更多操作"}>
                            <MoreHorizontal size={18} />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="pbl-platform-theme pbl-platform-dialog">
                          <DropdownMenuItem onSelect={() => {
                            setEditChapter(chapter);
                            setChapterTitle(chapter.title);
                            setError(null);
                            setDialog("chapter");
                          }}>
                            编辑章节名称
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </header>
                  {isExpanded ? (
                    <div id={"teacher-chapter-" + chapter.id} className="pbl-teacher-chapter-content">
                      <div className="pbl-teacher-activity-list" role="list" aria-label={`${chapter.title}学习内容`}>
                      {chapter.activities.map((item, itemIndex) => {
                        const instance = item.instances?.[0];
                        const template = templates.find((entry) => entry.id === item.templateId);
                        const entry = instance ? teacherClassroomEntry(instance) : null;
                        const version = readyVersion(template);
                        const primaryLabel = item.type === "Classroom"
                          ? entry?.label ?? (version ? "进入课堂" : "前往课程库")
                          : item.type === "Form" ? "数据看板" : "编辑内容";
                        const primaryHref = item.type === "Classroom"
                          ? entry?.href ?? (version ? null : "/teacher/templates")
                          : item.type === "Form" ? "/teacher/surveys/" + item.id : null;
                        const openDefaultActivity = () => {
                          if (item.type !== "Classroom" || !version) {
                            openActivity(chapter, item);
                            return;
                          }
                          void run(async () => {
                            const data = await mutate("/api/platform/activities/" + item.id + "/instance", { templateVersionId: version.id }, "POST");
                            if (!data.instance?.id) throw new Error("课堂创建失败，请重试");
                            router.push(teacherClassroomEntry(data.instance).href);
                          });
                        };
                        const activitySummary = <>
                          <span className="pbl-teacher-activity-visual">
                            {item.type === "Classroom" && instance?.coverImageUrl ? (
                              <ResilientImage width={96} height={54} unoptimized src={instance.coverImageUrl} alt="" className="pbl-teacher-activity-cover" />
                            ) : <TeacherActivityIcon type={item.type}/>}
                          </span>
                          <span className="pbl-teacher-activity-copy">
                            <span className="pbl-teacher-activity-meta">
                              <span>{index + 1}.{itemIndex + 1}</span>
                              <span>{types[item.type] || item.type}</span>
                            </span>
                            <span className="pbl-teacher-activity-title" title={item.title}>{item.title}</span>
                            {item.type === "Classroom" ? (
                              <small>
                                {template?.title || "待选择课程库课堂"}
                                {instance ? " · " + instanceStatusLabel(instance.status) : ""}
                                {!instance && !version ? " · 请先在课程库发布教案" : ""}
                              </small>
                            ) : null}
                          </span>
                        </>;
                        return (
                          <div key={item.id} role="listitem" className="pbl-activity-row pbl-teacher-activity-row">
                            {primaryHref ? (
                              <Link
                                className="pbl-teacher-activity-main"
                                href={primaryHref}
                                aria-label={`打开“${item.title}”：${primaryLabel}`}
                              >
                                {activitySummary}
                              </Link>
                            ) : (
                              <button
                                type="button"
                                className="pbl-teacher-activity-main"
                                aria-label={`打开“${item.title}”：${primaryLabel}`}
                                disabled={busy && item.type === "Classroom"}
                                onClick={openDefaultActivity}
                              >
                                {activitySummary}
                              </button>
                            )}
                            <div className="pbl-teacher-activity-actions">
                            {item.type === "Classroom" ? <Link className={rowAction} href={`/teacher/classes/${offeringId}/activities/${item.id}/experiment`}><ClipboardList size={14} />{item.config?.experiment?.enabled ? "编辑实验" : "实验配置"}</Link> : null}
                            {item.type === "Classroom" ? (
                              entry ? (
                                <Link className={rowAction} href={entry.href}>
                                  <ArrowUpRight size={14} />{entry.label}
                                </Link>
                              ) : version ? (
                                <button
                                  className={rowAction}
                                  disabled={busy}
                                  onClick={openDefaultActivity}
                                >
                                  <ArrowUpRight size={14} />进入课堂
                                </button>
                              ) : (
                                <Link className={rowAction} href="/teacher/templates"><BookOpen size={14}/>前往课程库</Link>
                              )
                            ) : item.type === "Form" ? (
                              <Link className={rowAction} href={"/teacher/surveys/" + item.id}>
                                <BarChart3 size={14} />数据看板
                              </Link>
                            ) : (
                              <button className={rowAction} onClick={openDefaultActivity}><PencilLine size={14}/>编辑内容</button>
                            )}
                            <AccessToggle
                              disabled={busy}
                              isOpen={item.isOpen}
                              subject="内容"
                              title={item.isOpen
                                ? chapter.isOpen ? "当前学生可见，点击锁定内容" : "内容已解锁，将在章节解锁后对学生可见；点击锁定内容"
                                : "当前学生不可见，点击解锁内容"}
                              onToggle={() => run(async () => {
                                await mutate("/api/platform/activities/" + item.id + "/manage", {
                                  isOpen: !item.isOpen,
                                  version: item.version,
                                });
                              }, item.isOpen ? "内容已锁定" : chapter.isOpen ? "内容已解锁" : "内容与章节已解锁")}
                            />
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button className="pbl-row-more-button" aria-label={item.title + "更多操作"} disabled={busy}>
                                  <MoreHorizontal size={18} />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="pbl-platform-theme pbl-platform-dialog">
                                <DropdownMenuItem onSelect={() => openActivity(chapter, item)}>{item.type === "Classroom" ? "编辑课堂设置" : "编辑名称与内容关联"}</DropdownMenuItem>
                                {item.type === "Classroom" ? <DropdownMenuItem asChild><Link href={`/teacher/classes/${offeringId}/activities/${item.id}/experiment`}>设置实验前后测</Link></DropdownMenuItem> : null}
                                {item.type === "Form" ? (
                                  <DropdownMenuItem asChild>
                                    <a href={`/api/platform/activities/${item.id}/survey-export`}>
                                      <Download size={15} />导出问卷数据（CSV）
                                    </a>
                                  </DropdownMenuItem>
                                ) : null}
                                {instance && instance.status !== "finished" ? (
                                  <DropdownMenuItem asChild>
                                    <Link href={"/teacher/classrooms/" + instance.id}>课堂学习记录</Link>
                                  </DropdownMenuItem>
                                ) : null}
                                <DropdownMenuItem variant="destructive" onSelect={() => setActivityToDelete(item)}>
                                  <Trash2 size={15} />删除内容
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            </div>
                          </div>
                        );
                      })}
                      {chapter.activities.length === 0 ? (
                        <p className="pbl-teacher-chapter-empty">本章还没有内容。可以从课程库选择课堂，或添加其他学习任务。</p>
                      ) : null}
                      </div>
                      <button className="pbl-teacher-add-activity" onClick={() => openActivity(chapter)}>
                        <Plus size={15} />添加学习内容
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
          {offering.chapters.length === 0 ? (
            <div className="pbl-teacher-course-empty">
              <BookOpen size={30} strokeWidth={1.2} />
              <h2>暂无章节</h2>
              <p>添加章节后，可继续加入课堂、问卷、作业和资料。</p>
            </div>
          ) : null}
        </>
      ) : (
        <div className="pbl-teacher-overview">
          <div className="pbl-teacher-overview-main">
            <section>
              <div className="pbl-teacher-overview-cover">
                {offering.coverImageUrl ? (
                  <ResilientImage fill unoptimized fallback={<LearningArt />} src={offering.coverImageUrl} alt={offering.name + "课程封面"} className="h-full w-full object-cover" />
                ) : (
                  <LearningArt className="h-full w-full max-w-xl" />
                )}
                <input
                  ref={coverInputRef}
                  accept="image/png,image/jpeg,image/webp"
                  aria-label="选择课程封面图片"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) uploadCover(file);
                    event.target.value = "";
                  }}
                  tabIndex={-1}
                  type="file"
                />
                <div>
                  <p>{offering.coverImageUrl ? "自定义课程封面 · 16:9" : "当前使用默认课程封面"}</p>
                  <span className="flex items-center gap-2">
                    <button
                      disabled={busy}
                      onClick={() => void run(async () => {
                        const data = await mutate(
                          "/api/platform/offerings/" + offeringId + "/cover",
                          undefined,
                          "POST",
                        ) as { offering?: Partial<Offering> };
                        const updated = data.offering;
                        if (!updated?.coverImageUrl) throw new Error("课程封面生成成功，但未返回新图片地址");
                        setOffering((current) => current ? { ...current, ...updated } : current);
                      }, offering.coverImageUrl ? "课程封面已重新生成" : "课程封面已生成", false)}
                      type="button"
                    >
                      <Sparkles size={15} />
                      {busy ? "处理中…" : offering.coverImageUrl ? "AI 重绘" : "AI 生成"}
                    </button>
                    <button disabled={busy} onClick={() => coverInputRef.current?.click()} type="button">
                      <Upload size={15} />上传图片
                    </button>
                  </span>
                </div>
              </div>
              <p className="mt-3 text-xs leading-6 text-[var(--pbl-text-muted)]">
                AI 会先理解课程简介与大纲，再设计画面、绘制封面，并检查主题与无文字要求；也可上传 PNG、JPG 或 WebP 图片。图片将自动优化为 16:9，最大 10 MB。
              </p>
            </section>
            {[
              ["课程详情", offering.description],
              ["课程大纲", offering.outline],
            ].map(([title, content]) => (
              <section key={title} className="pbl-teacher-overview-copy">
                <h2>{title}</h2>
                <p>{content || "尚未填写，可在课程设置中完善。"}</p>
              </section>
            ))}
            <section className="pbl-teacher-overview-copy">
              <h2>参考资料</h2>
              {offering.referenceMaterials ? <p>{offering.referenceMaterials}</p> : null}
              {offering.courseReferences?.length ? <div className="mt-3 flex flex-col gap-2">{offering.courseReferences.map((reference) => <a key={reference.id} href={reference.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-[8px] border border-[var(--pbl-border)] px-3 py-2 text-sm"><span className="text-[var(--pbl-teacher)]">{reference.kind === "link" ? <Link2 size={16}/> : <FileText size={16}/>}</span><span className="min-w-0 flex-1 truncate">{reference.title}</span><small className="text-[var(--pbl-text-muted)]">{reference.kind === "file" ? reference.fileSize || "PDF" : "打开链接"}</small><ArrowUpRight size={14}/></a>)}</div> : !offering.referenceMaterials ? <p>尚未添加，可在课程设置中完善。</p> : null}
            </section>
          </div>
          <aside className="pbl-teacher-overview-aside">
            <h2>课程开放</h2>
            <p>开放课程后，已加入的学生可学习已解锁章节中的内容。</p>
            <strong>当前：{offeringStatusLabel(offering.status)}</strong>
            <button
              disabled={busy}
              className={button + " mt-5 w-full"}
              onClick={() => void run(async () => {
                await mutate("/api/platform/offerings/" + offeringId, {
                  status: offering.status.toLowerCase() === "open" ? "finished" : "open",
                  version: offering.version,
                });
              })}
            >
              {offering.status.toLowerCase() === "open" ? "结束本期课程" : "开放课程"}
            </button>
            <button className={button + " mt-3 w-full"} onClick={openInfo}>编辑课程主页</button>
          </aside>
        </div>
      )}
    </div>
    <Dialog open={dialog !== null} onOpenChange={(value) => { if (!value && !busy) setDialog(null); }}>
      <DialogContent className={`pbl-platform-theme pbl-platform-dialog pbl-course-editor-dialog bg-[var(--pbl-surface)] ${dialog === "activity" && activity.type === "Form" ? "sm:max-w-4xl" : "sm:max-w-3xl"}`}>
        <DialogHeader className="pbl-course-dialog-header">
          <span className="pbl-dialog-header-icon">
            {dialog === "info" ? <Settings2 size={21}/> : dialog === "chapter" ? <BookOpen size={21}/> : editActivity ? <PencilLine size={21}/> : <Plus size={21}/>}
          </span>
          <div>
            <p className="pbl-dialog-eyebrow">{dialogEyebrow}</p>
            <DialogTitle className="font-serif text-2xl">{dialogTitle}</DialogTitle>
            <DialogDescription>{dialogDescription}</DialogDescription>
          </div>
        </DialogHeader>
        <form className="pbl-course-dialog-form" onSubmit={save}>
          <div className="pbl-course-dialog-body">
            {dialog === "chapter" ? (
              <section className="pbl-course-dialog-section">
                <div className="pbl-dialog-section-heading"><div><h3>章节名称</h3><p>建议使用能够表达学习阶段或核心问题的名称。</p></div><span>01</span></div>
                <label className="pbl-dialog-field"><span>名称 <small>必填</small></span><input aria-label="章节名称" autoFocus required maxLength={160} className={field} value={chapterTitle} onChange={(event) => setChapterTitle(event.target.value)} placeholder="例如：发现问题与实地调研"/></label>
              </section>
            ) : null}
            {dialog === "activity" ? (
              <>
                <section className="pbl-course-dialog-section">
                  <div className="pbl-dialog-section-heading"><div><h3>内容身份</h3><p>先确定学习内容类型与学生看到的名称。</p></div><span>01</span></div>
                  <div className="pbl-activity-identity-grid">
                    <label className="pbl-dialog-field"><span>内容类型 <small>{editActivity ? "编辑时不可更改" : "必填"}</small></span><select aria-label="内容类型" disabled={Boolean(editActivity)} className={field} value={activity.type} onChange={(event) => setActivity({ ...activity, type: event.target.value })}>{Object.entries(types).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small>{typeDescriptions[activity.type]}</small></label>
                    <label className="pbl-dialog-field"><span>内容标题 <small>必填</small></span><input aria-label="标题" autoFocus={!editActivity} required maxLength={160} className={field} value={activity.title} onChange={(event) => setActivity({ ...activity, title: event.target.value })} placeholder={activity.type === "Form" ? "例如：课堂即时反馈" : "输入学生将在目录中看到的名称"}/></label>
                  </div>
                </section>
                <section className="pbl-course-dialog-section">
                  <div className="pbl-dialog-section-heading"><div><h3>{activity.type === "Classroom" ? "关联课堂" : "学习要求"}</h3><p>{activity.type === "Classroom" ? "选择备课阶段已发布的教案，进入课堂后仍由原工作台完成配置。" : "填写学生进入内容后需要理解和完成的信息。"}</p></div><span>02</span></div>
                  {activity.type === "Classroom" ? (
                    <>
                      <label className="pbl-dialog-field" htmlFor="template"><span>课程库教案 <small>必填</small></span><select id="template" required disabled={Boolean(editActivity?.instances?.[0] && editActivity.instances[0].status !== "finished")} className={field} value={activity.templateVersionId} onChange={(event) => { const template = availableTemplates.find((item) => readyVersion(item)?.id === event.target.value); setActivity({ ...activity, templateVersionId: event.target.value, title: template?.title || activity.title }); }}><option value="">选择已发布的课堂教案</option>{availableTemplates.map((template) => { const version = readyVersion(template)!; return <option key={version.id} value={version.id}>{template.title} · 编号 {courseReferenceCode(template.id)} · 首次生成 {formatCourseTimestamp(template.createdAt)} · v{version.version}</option>; })}</select></label>
                      {availableTemplates.length ? <p className="pbl-dialog-inline-note"><Check size={15}/>只显示未归档且已有发布版本的教案。关联后不会自动开始课堂。</p> : <div className="pbl-dialog-empty-notice"><BookOpen size={19}/><div><strong>课程库暂无可用教案</strong><p>请先完成备课并发布教案，再返回当前章节进行关联。</p><Link href="/teacher/templates">前往课程库 <ArrowUpRight size={14}/></Link></div></div>}
                    </>
                  ) : (
                    <>
                      <label className="pbl-dialog-field"><span>{activity.type === "Assignment" ? "作业要求" : activity.type === "Form" ? "问卷说明（可选）" : "内容说明"}</span><textarea className={`${field} min-h-24`} value={activity.content} onChange={(event) => setActivity({ ...activity, content: event.target.value })} placeholder={activity.type === "Form" ? "向学生说明本次问卷的目的，鼓励真实表达。" : "说明学习目标、完成要求或使用方式"}/></label>
                      {activity.type === "Resource" ? <div className="pbl-dialog-field">
                        <span>资料来源 <small>必填</small></span>
                        <div className="flex gap-2" role="group" aria-label="资料来源">
                          <button type="button" aria-pressed={activity.resourceKind === "link"} className={`${button} flex-1 ${activity.resourceKind === "link" ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]" : ""}`} onClick={() => setActivity({ ...activity, resourceKind: "link", url: activity.resourceKind === "file" ? "" : activity.url, file: null, fileId: "", fileName: "", fileSize: "" })}>链接</button>
                          <button type="button" aria-pressed={activity.resourceKind === "file"} className={`${button} flex-1 ${activity.resourceKind === "file" ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]" : ""}`} onClick={() => setActivity({ ...activity, resourceKind: "file", url: activity.fileId ? activity.url : "" })}>PDF 文件</button>
                        </div>
                        {activity.resourceKind === "link" ? <input aria-label="资料链接" required type="url" pattern="https?://.*" placeholder="https://" className={field} value={activity.url} onChange={(event) => setActivity({ ...activity, url: event.target.value, file: null, fileId: "", fileName: "", fileSize: "" })}/> : <label className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-[8px] border border-dashed border-[var(--pbl-border)] bg-[var(--pbl-bg)] px-4 py-5 text-center text-sm">
                          <Upload size={20} className="text-[var(--pbl-teacher)]"/>
                          <span>{activity.file?.name || activity.fileName || "选择 PDF 文档"}</span>
                          <small className="text-[var(--pbl-text-muted)]">仅支持 PDF，单个文件不超过 50 MiB</small>
                          <input aria-label="上传 PDF 文档" required={!activity.fileId} className="sr-only" type="file" accept="application/pdf,.pdf" onChange={(event) => { const file = event.target.files?.[0] ?? null; setActivity({ ...activity, file, fileId: file ? "" : activity.fileId, fileName: file?.name ?? activity.fileName, fileSize: file ? "" : activity.fileSize, url: file ? "" : activity.url }); }}/>
                        </label>}
                      </div> : null}
                      {activity.type === "Form" ? <fieldset disabled={Boolean(editActivity?.hasResponses)}>{editActivity?.hasResponses ? <p className="mb-3 text-sm text-[var(--pbl-text-muted)]">已有学生提交此问卷，题目和选项已锁定；可以修改标题、说明或开放状态。新题目请创建新问卷。</p> : null}<SurveyBuilder questions={activity.surveyQuestions} onChange={(surveyQuestions) => setActivity({ ...activity, surveyQuestions })}/></fieldset> : activity.type === "Quiz" ? <label className="pbl-dialog-field"><span>测验题目 <small>每行一题</small></span><textarea required className={`${field} min-h-32`} value={activity.questions} onChange={(event) => setActivity({ ...activity, questions: event.target.value })} placeholder="请写出本节课的核心概念。"/></label> : null}
                    </>
                  )}
                </section>
              </>
            ) : null}
            {dialog === "info" ? (
              <>
                <section className="pbl-course-dialog-section">
                  <div className="pbl-dialog-section-heading"><div><h3>基本信息与周期</h3><p>课程名称和学期用于识别本期课程，日期用于学生主页展示。</p></div><span>01</span></div>
                  <div className="pbl-dialog-field-grid">{[["name", "课程名称"], ["term", "学期"], ["startsAt", "开课日期"], ["endsAt", "结课日期"]].map(([key, label]) => <label key={key} className="pbl-dialog-field"><span>{label}{key === "name" ? <small>必填</small> : null}</span><input required={key === "name"} type={key.endsWith("At") ? "date" : "text"} className={field} value={info[key as keyof typeof info]} onChange={(event) => setInfo({ ...info, [key]: event.target.value })}/></label>)}</div>
                </section>
                <section className="pbl-course-dialog-section">
                  <div className="pbl-dialog-section-heading"><div><h3>学生课程主页</h3><p>这些内容会分别进入学生端的课程介绍和课程资料区域。</p></div><span>02</span></div>
                  <div className="pbl-dialog-field-stack">
                    {[["description", "课程简介"], ["outline", "整体课程大纲"]].map(([key, label]) => <label key={key} className="pbl-dialog-field"><span>{label}</span><textarea className={`${field} min-h-24`} value={info[key as keyof typeof info]} onChange={(event) => setInfo({ ...info, [key]: event.target.value })} placeholder={key === "description" ? "简要介绍课程主题、学习方式与预期成果" : "概述课程的主要阶段与学习路径"}/></label>)}
                    <div className="pbl-dialog-field">
                      <span>课程参考资料 <small>链接或 PDF</small></span>
                      <div className="flex flex-col gap-2">
                        {courseReferences.map((reference) => (
                          <div key={reference.id} className="flex items-start gap-2 rounded-[8px] border border-[var(--pbl-border)] bg-[var(--pbl-bg)] p-3">
                            <span className="mt-3 text-[var(--pbl-teacher)]">{reference.kind === "link" ? <Link2 size={17}/> : <FileText size={17}/>}</span>
                            <div className="min-w-0 flex-1 space-y-2">
                              <input aria-label={`${reference.kind === "link" ? "链接" : "文件"}标题`} required readOnly={reference.kind === "file" && !reference.file} className={field} value={reference.title} onChange={(event) => setCourseReferences((items) => items.map((item) => item.id === reference.id ? { ...item, title: event.target.value } : item))}/>
                              {reference.kind === "link" ? <input aria-label="参考资料链接" required type="url" pattern="https?://.*" className={field} value={reference.url} placeholder="https://" onChange={(event) => setCourseReferences((items) => items.map((item) => item.id === reference.id ? { ...item, url: event.target.value } : item))}/> : <p className="truncate text-xs text-[var(--pbl-text-muted)]">{reference.fileName}{reference.fileSize ? ` · ${reference.fileSize}` : ""}</p>}
                            </div>
                            <button type="button" aria-label={`移除 ${reference.title || "参考资料"}`} className={`${button} min-h-11 px-3 text-[var(--pbl-danger)]`} onClick={() => { if (reference.kind === "file" && !reference.file) setRemovedCourseFileIds((ids) => [...ids, reference.id]); setCourseReferences((items) => items.filter((item) => item.id !== reference.id)); }}><Trash2 size={16}/></button>
                          </div>
                        ))}
                        {!courseReferences.length ? <p className="rounded-[8px] border border-dashed border-[var(--pbl-border)] px-4 py-5 text-center text-sm text-[var(--pbl-text-muted)]">尚未添加课程参考资料</p> : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" className={button} onClick={() => setCourseReferences((items) => [...items, { id: `link-${clientUUID()}`, kind: "link", title: "", url: "" }])}><Link2 size={16}/>添加链接</button>
                        <label className={`${button} cursor-pointer`}><Upload size={16}/>上传 PDF<input aria-label="上传课程参考资料 PDF" className="sr-only" type="file" accept="application/pdf,.pdf" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); const invalid = files.find((file) => file.type !== "application/pdf" || !file.name.toLowerCase().endsWith(".pdf")); if (invalid) { setError("课程参考资料仅支持 PDF 文档"); event.target.value = ""; return; } setCourseReferences((items) => [...items, ...files.map((file) => ({ id: `pending-${clientUUID()}`, kind: "file" as const, title: file.name.replace(/\.pdf$/i, ""), url: "", fileName: file.name, fileSize: `${(file.size / (1024 * 1024)).toFixed(1)} MB`, file }))]); event.target.value = ""; }}/></label>
                      </div>
                    </div>
                    <label className="pbl-dialog-field"><span>补充说明 <small>兼容原有内容，可选</small></span><textarea className={`${field} min-h-20`} value={info.referenceMaterials} onChange={(event) => setInfo({ ...info, referenceMaterials: event.target.value })} placeholder="可填写无法归类为链接或文件的书目说明"/></label>
                  </div>
                </section>
              </>
            ) : null}
            {error ? <p role="alert" className="pbl-dialog-error">{error}</p> : null}
          </div>
          <div className="pbl-course-dialog-footer">
            <p>{dialog === "info" ? "保存后，学生课程主页将同步更新。" : dialog === "chapter" ? "章节默认加入当前课程目录，开放状态可在目录中调整。" : editActivity ? "修改仅作用于当前课程中的这项学习内容。" : "添加后可在章节目录中继续调整开放状态。"}</p>
            <div><button type="button" disabled={busy} className="pbl-dialog-secondary" onClick={() => setDialog(null)}>取消</button><button disabled={busy} className="pbl-dialog-primary">{busy ? "保存中…" : dialogSubmitLabel}</button></div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
    <AlertDialog open={activityToDelete !== null} onOpenChange={(open) => { if (!open && !busy) setActivityToDelete(null); }}>
      <AlertDialogContent className="pbl-platform-theme">
        <div className="space-y-2">
          <AlertDialogTitle>删除“{activityToDelete?.title}”？</AlertDialogTitle>
          <AlertDialogDescription>
            删除后，这项{activityToDelete ? types[activityToDelete.type] || "学习内容" : "学习内容"}将从章节目录和学生端移除。已有课堂、提交及学习记录会继续保留。
          </AlertDialogDescription>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              const selected = activityToDelete;
              if (!selected) return;
              void run(async () => {
                await mutate(`/api/platform/activities/${selected.id}`, undefined, "DELETE");
              }, `${types[selected.type] || "学习内容"}已从章节目录删除`).then((succeeded) => {
                if (succeeded) setActivityToDelete(null);
              });
            }}
          >
            确认删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <Dialog open={invitationOpen} onOpenChange={(open) => { setInvitationOpen(open); if (!open) setCopyStatus("idle"); }}>
      <DialogContent
        className="pbl-platform-theme pbl-platform-dialog pbl-invitation-dialog"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          copyButtonRef.current?.focus();
        }}
      >
        <header className="pbl-invitation-topbar">
          <CoTeachLogo className="pbl-invitation-brand" variant="horizontalSolid" height={58} priority />
          <div><span>学生课堂入口</span><strong>{offering.name}</strong></div>
          <DialogClose asChild>
            <button type="button" aria-label="关闭邀请码投屏"><X size={21} /></button>
          </DialogClose>
        </header>
        <DialogHeader className="sr-only">
          <DialogTitle>学生加入课程</DialogTitle>
          <DialogDescription>按照屏幕上的三步说明打开学生端并加入课程。</DialogDescription>
        </DialogHeader>
        <section className="pbl-invitation-board" aria-label="加入课程步骤">
          <article className="pbl-invitation-step pbl-invitation-step-access">
            <div className="pbl-invitation-step-heading"><b>01</b><span>第一步</span></div>
            <div className="pbl-invitation-step-content">
              <h2>打开电脑浏览器</h2>
              <p>在地址栏输入</p>
              <output aria-label="学生端访问地址">{STUDENT_ACCESS_ADDRESS}</output>
              <small>输入完成后，按 Enter 键打开学生端</small>
            </div>
          </article>
          <div className="pbl-invitation-connector" aria-hidden="true"><ArrowRight /></div>
          <article className="pbl-invitation-step pbl-invitation-step-account">
            <div className="pbl-invitation-step-heading"><b>02</b><span>第二步</span></div>
            <div className="pbl-invitation-step-content">
              <h2>注册 / 登录</h2>
              <strong>首次使用<br />注册学生账号</strong>
              <small>已有账号的同学直接登录</small>
            </div>
          </article>
          <div className="pbl-invitation-connector" aria-hidden="true"><ArrowRight /></div>
          <article className="pbl-invitation-step pbl-invitation-step-code">
            <div className="pbl-invitation-step-heading"><b>03</b><span>第三步</span></div>
            <div className="pbl-invitation-step-content">
              <h2>输入课程邀请码</h2>
              <output aria-label="学生邀请码">
                {(offering.invitation?.code ?? "").slice(0, 3)} <b>{(offering.invitation?.code ?? "").slice(3, 6)}</b>
              </output>
              <small>注册或加入课程时，输入这组邀请码</small>
            </div>
          </article>
        </section>
        <footer className="pbl-invitation-actions">
          <p role="status">
            {copyStatus === "copied" ? "邀请码已复制" : copyStatus === "failed" ? "复制失败，请手动记录邀请码" : "完成以上三步，即可进入课程"}
          </p>
          <button ref={copyButtonRef} type="button" onClick={() => void copyInvitation()}>
            {copyStatus === "copied" ? <Check size={17} /> : <Copy size={17} />}
            {copyStatus === "copied" ? "已复制" : "复制邀请码"}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  </TeacherPlatformPage>;
}
