"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  Check,
  ChevronRight,
  CircleDashed,
  Clock3,
  Edit3,
  ExternalLink,
  FileStack,
  GitBranch,
  History,
  Layers3,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { DashboardShell } from "@/components/dashboard-shell";
import { CourseCoverSettings } from "@/components/teacher/course-cover-settings";
import { LaunchPresentationReplacement } from "@/components/teacher/launch-presentation-replacement";
import { toast } from "@/components/ui";
import { useSession } from "@/lib/session/store";
import type {
  Course,
  CourseDesignWorkspaceArtifactStatus,
  CourseDesignWorkspacePendingUpdate,
  CourseDesignWorkspaceSectionKey,
  KnowledgePoint,
  TeachingBlueprintPage,
  TeachingBlueprintSection,
  TeachingBlueprintUnit,
} from "@/lib/session/types";
import type { CourseStagePlan, ResourcePackageStage } from "@/lib/resource-package/types";
import { COURSE_DESIGN_WORKSPACE_SECTIONS } from "@/lib/course-design/workspace";
import { cn } from "@/lib/utils";

type WorkspaceJob = { status: string; step: string; message: string; progress: number; error: string | null } | null;
type WorkspacePayload = {
  course: Course;
  statuses: Record<CourseDesignWorkspaceSectionKey, CourseDesignWorkspaceArtifactStatus>;
  pendingUpdates: CourseDesignWorkspacePendingUpdate[];
  publication: { latestVersion: number | null; publishedVersion: number | null; draftVersion: number | null };
  jobs: { design: WorkspaceJob; classroom: WorkspaceJob };
};

const INPUT = "mt-1.5 min-h-11 w-full rounded-[8px] border border-stone-300 bg-white px-3 text-sm text-stone-900 outline-none transition focus:border-[var(--pbl-teacher)] focus:ring-2 focus:ring-[var(--pbl-teacher-soft)]";
const TEXTAREA = `${INPUT} min-h-24 py-2.5 leading-6`;
const STATUS_LABEL: Record<CourseDesignWorkspaceArtifactStatus, string> = {
  missing: "未生成",
  ready: "已就绪",
  stale: "已修改待更新",
  generating: "生成中",
  failed: "生成失败",
};
const STATUS_STYLE: Record<CourseDesignWorkspaceArtifactStatus, string> = {
  missing: "border-stone-300 bg-stone-50 text-stone-600",
  ready: "border-emerald-200 bg-emerald-50 text-emerald-700",
  stale: "border-amber-300 bg-amber-50 text-amber-800",
  generating: "border-blue-200 bg-blue-50 text-blue-700",
  failed: "border-red-200 bg-red-50 text-red-700",
};

function cloneCourse(course: Course): Course {
  return structuredClone(course);
}

function lines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block text-sm font-semibold text-stone-800">
      {label}
      {children}
      {hint ? <span className="mt-1 block text-xs font-normal leading-5 text-stone-500">{hint}</span> : null}
    </label>
  );
}

function SectionHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <header className="border-b border-stone-200 px-5 py-5 sm:px-7">
      <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--pbl-teacher)]">{eyebrow}</p>
      <h2 className="mt-1 font-editorial text-2xl font-semibold text-stone-950">{title}</h2>
      <p className="mt-2 max-w-4xl text-sm leading-6 text-stone-600">{description}</p>
    </header>
  );
}

function MissingArtifact({ courseId, label }: { courseId: string; label: string }) {
  return (
    <div className="grid min-h-72 place-items-center px-6 py-12 text-center">
      <div className="max-w-md">
        <CircleDashed className="mx-auto text-stone-400" size={34} />
        <h3 className="mt-4 text-lg font-bold text-stone-900">{label}尚未生成</h3>
        <p className="mt-2 text-sm leading-6 text-stone-600">当前课程没有这一环节的正式数据。重新生成课程后会在这里显示，也可以回到一键生成页补齐。</p>
        <Link className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-[8px] bg-[var(--pbl-teacher)] px-4 text-sm font-bold text-white" href={`/teacher/prepare/${courseId}/verify`}>
          <RefreshCw size={16} /> 返回一键生成
        </Link>
      </div>
    </div>
  );
}

export function CourseDesignWorkspace() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, refresh } = useSession();
  const requestedSection = searchParams.get("section") as CourseDesignWorkspaceSectionKey | null;
  const initialSection = COURSE_DESIGN_WORKSPACE_SECTIONS.some((item) => item.key === requestedSection)
    ? requestedSection!
    : "materials";
  const [payload, setPayload] = useState<WorkspacePayload | null>(null);
  const [draft, setDraft] = useState<Course | null>(null);
  const [active, setActive] = useState<CourseDesignWorkspaceSectionKey>(initialSection);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [pendingNavigation, setPendingNavigation] = useState<CourseDesignWorkspaceSectionKey | null>(null);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [selectedCandidateSections, setSelectedCandidateSections] = useState<string[]>(() => {
    const lectureSectionId = searchParams.get("lectureSectionId");
    return lectureSectionId ? [lectureSectionId] : [];
  });

  async function loadWorkspace(quiet = false) {
    if (!params?.id) return;
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(`/api/courses/${encodeURIComponent(params.id)}/design-workspace`, { cache: "no-store" });
      const body = await response.json() as WorkspacePayload & { message?: string };
      if (!response.ok) throw new Error(body.message || "无法读取课程设计");
      setPayload(body);
      if (!dirty) setDraft(cloneCourse(body.course));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取课程设计");
    } finally {
      if (!quiet) setLoading(false);
    }
  }

  async function onLaunchUpdated() {
    await Promise.all([loadWorkspace(true), refresh("teacher")]);
  }

  useEffect(() => { void loadWorkspace(); }, [params?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const classroomJobActive = payload?.jobs.classroom
    && ["queued", "running", "cancelling"].includes(payload.jobs.classroom.status);
  useEffect(() => {
    if (!classroomJobActive) return;
    const timer = window.setInterval(() => void loadWorkspace(true), 2_500);
    return () => window.clearInterval(timer);
  }, [classroomJobActive, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const statuses = useMemo(() => {
    if (!payload) return null;
    const next = { ...payload.statuses };
    if (payload.jobs.classroom && ["queued", "running", "cancelling"].includes(payload.jobs.classroom.status)) next.classroom = "generating";
    if (payload.jobs.classroom?.status === "failed" && payload.statuses.classroom !== "ready") next.classroom = "failed";
    return next;
  }, [payload]);

  function edit(mutator: (course: Course) => void) {
    setDraft((current) => {
      if (!current) return current;
      const next = cloneCourse(current);
      mutator(next);
      return next;
    });
    setDirty(true);
    setError(undefined);
  }

  function dataForSection(course: Course, section: CourseDesignWorkspaceSectionKey): unknown {
    if (section === "materials") return {
      name: course.name,
      subject: course.subject,
      grade: course.grade,
      hours: course.hours,
      summary: course.summary,
      drivingQuestion: course.drivingQuestion,
      expectedOutcome: course.expectedOutcome ?? "",
      learningObjectives: course.learningObjectives ?? [],
      learnerProfile: course.learnerProfile,
    };
    if (section === "stage-plan") return course.content.stagePlan;
    if (section === "knowledge") return {
      knowledgePoints: course.content.knowledgePoints,
      knowledgeGraph: course.content.knowledgeGraph,
      knowledgeScopePlan: course.content.knowledgeScopePlan,
    };
    if (section === "timing") return course.content.moduleTimingPlan;
    if (section === "blueprint") return course.content.teachingBlueprint;
    return null;
  }

  async function request(body: Record<string, unknown>): Promise<WorkspacePayload> {
    const response = await fetch(`/api/courses/${encodeURIComponent(params.id)}/design-workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as WorkspacePayload & { message?: string };
    if (!response.ok) throw new Error(result.message || "操作失败，请重试");
    setPayload(result);
    setDraft(cloneCourse(result.course));
    return result;
  }

  async function save(section = active): Promise<boolean> {
    if (!draft || section === "classroom") return true;
    setSaving(true);
    try {
      const result = await request({ action: "save", section, expectedVersion: payload?.course.version, data: dataForSection(draft, section) });
      setDirty(false);
      toast.success("课程设计已保存", { description: `${COURSE_DESIGN_WORKSPACE_SECTIONS.find((item) => item.key === section)?.label}已写入课程草稿。` });
      setPayload(result);
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "保存失败";
      setError(message);
      toast.error("保存失败", { description: message });
      return false;
    } finally {
      setSaving(false);
    }
  }

  function selectSection(key: CourseDesignWorkspaceSectionKey) {
    if (key === active) return;
    if (dirty) {
      setPendingNavigation(key);
      return;
    }
    setActive(key);
    router.replace(`/teacher/prepare/${params.id}/verify/edit?section=${key}`, { scroll: false });
  }

  function navigateToHref(href: string) {
    if (dirty) {
      setPendingHref(href);
      return;
    }
    router.push(href);
  }

  async function saveThenNavigate() {
    const target = pendingNavigation;
    const href = pendingHref;
    if ((!target && !href) || !(await save())) return;
    setPendingNavigation(null);
    setPendingHref(null);
    if (target) {
      setActive(target);
      router.replace(`/teacher/prepare/${params.id}/verify/edit?section=${target}`, { scroll: false });
    } else if (href) router.push(href);
  }

  function discardThenNavigate() {
    if (!payload || (!pendingNavigation && !pendingHref)) return;
    const target = pendingNavigation;
    const href = pendingHref;
    setDraft(cloneCourse(payload.course));
    setDirty(false);
    setPendingNavigation(null);
    setPendingHref(null);
    if (target) {
      setActive(target);
      router.replace(`/teacher/prepare/${params.id}/verify/edit?section=${target}`, { scroll: false });
    } else if (href) router.push(href);
  }

  async function confirmCurrent(target: CourseDesignWorkspaceSectionKey) {
    setWorking(true);
    try {
      await request({ action: "confirm-current", target, expectedVersion: payload?.course.version });
      toast.success("已保留当前内容", { description: "该环节已经核对，待更新标记已清除。" });
    } catch (cause) {
      toast.error("操作失败", { description: cause instanceof Error ? cause.message : "请稍后重试" });
    } finally {
      setWorking(false);
    }
  }

  async function generateCandidate() {
    if (!selectedCandidateSections.length) return;
    setWorking(true);
    try {
      await request({ action: "generate-classroom-candidate", sectionIds: selectedCandidateSections, expectedVersion: payload?.course.version });
      toast.success("局部更新已进入生成队列", { description: "原课堂会一直保留，候选完成后由你决定是否采用。" });
    } catch (cause) {
      toast.error("无法开始局部更新", { description: cause instanceof Error ? cause.message : "请稍后重试" });
    } finally {
      setWorking(false);
    }
  }

  async function decideCandidate(candidateId: string, adopt: boolean) {
    setWorking(true);
    try {
      await request({ action: adopt ? "adopt-classroom-candidate" : "discard-classroom-candidate", candidateId, expectedVersion: payload?.course.version });
      toast.success(adopt ? "局部更新已采用" : "候选已丢弃", { description: adopt ? "目标小节已替换，其他课堂页面和手工内容保持不变。" : "原课堂没有发生变化。" });
    } catch (cause) {
      toast.error("候选处理失败", { description: cause instanceof Error ? cause.message : "请稍后重试" });
    } finally {
      setWorking(false);
    }
  }

  if (loading) return <DashboardShell backHref="/teacher/templates" backLabel="返回课程库" role="teacher" userName={user.name} variant="bare"><div className="grid min-h-[60vh] place-items-center text-sm text-stone-500"><LoaderCircle className="mr-2 animate-spin" size={18} />正在打开课程设计工作台…</div></DashboardShell>;
  if (!draft || !payload || !statuses) return <DashboardShell backHref="/teacher/templates" backLabel="返回课程库" role="teacher" userName={user.name} variant="bare"><div className="grid min-h-[60vh] place-items-center px-6 text-center text-sm text-red-700">{error || "课程设计无法打开"}</div></DashboardShell>;

  const current = COURSE_DESIGN_WORKSPACE_SECTIONS.find((item) => item.key === active)!;
  const currentPending = payload.pendingUpdates.filter((item) => item.target === active);

  return (
    <DashboardShell backHref="/teacher/templates" backLabel="返回课程库" role="teacher" userName={user.name} variant="bare" currentCourse={{ id: draft.id, name: draft.name, status: draft.status }}>
      <main className="mx-auto w-full max-w-[1500px] pb-28">
        <header className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-stone-200 pb-5">
          <div className="flex min-w-0 items-start gap-3">
            <button aria-label="返回课程列表" className="grid size-11 shrink-0 place-items-center rounded-full border border-stone-300 bg-white text-stone-600 hover:border-[var(--pbl-teacher)] hover:text-[var(--pbl-teacher)]" onClick={() => navigateToHref("/teacher/templates")} type="button"><ArrowLeft size={18} /></button>
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--pbl-teacher)]">课程设计工作台</p>
              <h1 className="mt-1 truncate font-editorial text-2xl font-semibold text-stone-950 sm:text-3xl">{draft.name}</h1>
              <p className="mt-1 text-sm text-stone-600">生成后的正式课程数据，可按环节回看、修改并更新受影响内容。</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded-full border px-3 py-1.5 text-xs font-bold", draft.status === "ready" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-800")}>
              {payload.publication.draftVersion && payload.publication.publishedVersion
                ? `当前发布 v${payload.publication.publishedVersion} · 草稿 v${payload.publication.draftVersion}`
                : draft.status === "ready"
                  ? `当前发布版本${payload.publication.publishedVersion ? ` v${payload.publication.publishedVersion}` : ""}`
                  : payload.pendingUpdates.length
                    ? `草稿 · ${payload.pendingUpdates.length} 项待更新`
                    : "未发布草稿"}
            </span>
            <Link className="inline-flex min-h-11 items-center gap-2 rounded-[8px] border border-stone-300 bg-white px-4 text-sm font-bold text-stone-800 hover:border-[var(--pbl-teacher)]" href={`/teacher/prepare/${encodeURIComponent(draft.id)}/versions`}><History size={16} />版本记录</Link>
            <button className="inline-flex min-h-11 items-center gap-2 rounded-[8px] border border-stone-300 bg-white px-4 text-sm font-bold text-stone-800 hover:border-[var(--pbl-teacher)]" onClick={() => navigateToHref(`/teacher/prepare/${draft.id}/preview`)} type="button"><ShieldCheck size={16} />课程发布中心</button>
          </div>
        </header>

        <section aria-label="课程设计环节" className="mb-5 overflow-hidden rounded-[14px] border border-stone-200 bg-white">
          <label className="block p-4 text-sm font-semibold text-stone-700 lg:hidden">
            当前设计环节
            <select className={INPUT} onChange={(event) => selectSection(event.target.value as CourseDesignWorkspaceSectionKey)} value={active}>
              {COURSE_DESIGN_WORKSPACE_SECTIONS.map((section) => <option key={section.key} value={section.key}>{section.phase}. {section.label} · {STATUS_LABEL[statuses[section.key]]}</option>)}
            </select>
          </label>
          <ol className="hidden grid-cols-6 lg:grid">
            {COURSE_DESIGN_WORKSPACE_SECTIONS.map((section) => {
              const status = statuses[section.key];
              const selected = section.key === active;
              return (
                <li className="min-w-0 border-r border-stone-200 last:border-r-0" key={section.key}>
                  <button aria-current={selected ? "step" : undefined} className={cn("flex min-h-[116px] w-full flex-col items-start p-4 text-left transition hover:bg-stone-50", selected && "bg-[var(--pbl-teacher-soft)]")} onClick={() => selectSection(section.key)} type="button">
                    <span className="text-[10px] font-bold tracking-[0.16em] text-stone-400">{section.phase}</span>
                    <span className="mt-1 text-sm font-bold text-stone-900">{section.shortLabel}</span>
                    <span className={cn("mt-auto rounded-full border px-2 py-0.5 text-[10px] font-bold", STATUS_STYLE[status])}>{STATUS_LABEL[status]}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>

        {error ? <div className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">{error}</div> : null}
        {currentPending.length ? <ImpactNotice pending={currentPending} onConfirm={() => void confirmCurrent(active)} onOpen={(target) => selectSection(target)} working={working} /> : null}

        <section className="overflow-hidden rounded-[14px] border border-stone-200 bg-white">
          <SectionHeader eyebrow={`${current.phase} · ${STATUS_LABEL[statuses[active]]}`} title={current.label} description={current.description} />
          {active === "materials" ? <MaterialsEditor course={draft} edit={edit} onCoverUpdated={() => loadWorkspace(true)} onLaunchUpdated={onLaunchUpdated} replaceDisabled={dirty || saving || working} /> : null}
          {active === "stage-plan" ? <StagePlanEditor course={draft} edit={edit} /> : null}
          {active === "knowledge" ? <KnowledgeEditor course={draft} edit={edit} /> : null}
          {active === "timing" ? <TimingEditor course={draft} edit={edit} /> : null}
          {active === "blueprint" ? <BlueprintEditor course={draft} edit={edit} /> : null}
          {active === "classroom" ? (
            <ClassroomEditorPanel
              course={draft}
              job={payload.jobs.classroom}
              onDecideCandidate={(id, adopt) => void decideCandidate(id, adopt)}
              onGenerate={() => void generateCandidate()}
              selectedSections={selectedCandidateSections}
              setSelectedSections={setSelectedCandidateSections}
              working={working}
            />
          ) : null}
        </section>
      </main>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-stone-200 bg-white/95 px-4 py-3 shadow-[0_-10px_30px_rgba(28,25,23,0.08)] backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-stone-600">{dirty ? "有尚未保存的修改" : saving ? "正在保存" : "当前内容已与服务器同步"}</div>
          <div className="flex items-center gap-2">
            {active !== "classroom" ? <button className="inline-flex min-h-11 items-center gap-2 rounded-[8px] bg-[var(--pbl-teacher)] px-5 text-sm font-bold text-white disabled:opacity-50" disabled={!dirty || saving} onClick={() => void save()} type="button">{saving ? <LoaderCircle className="animate-spin" size={16} /> : <Save size={16} />}保存{current.shortLabel}</button> : null}
            <Link className="inline-flex min-h-11 items-center gap-2 rounded-[8px] border border-stone-300 bg-white px-4 text-sm font-bold text-stone-800" href={`/teacher/prepare/${draft.id}/preview`}>前往发布中心<ArrowRight size={16} /></Link>
          </div>
        </div>
      </div>

      {pendingNavigation || pendingHref ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/35 p-4" role="presentation">
          <div aria-labelledby="unsaved-title" aria-modal="true" className="w-full max-w-md rounded-[14px] bg-white p-6 shadow-2xl" role="dialog">
            <h2 className="text-lg font-bold text-stone-950" id="unsaved-title">保存当前修改后再离开？</h2>
            <p className="mt-2 text-sm leading-6 text-stone-600">当前环节有未保存内容。保存后会计算受影响范围；放弃则恢复服务器中的版本。</p>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <button className="min-h-11 rounded-[8px] px-4 text-sm font-bold text-stone-600" onClick={() => { setPendingNavigation(null); setPendingHref(null); }} type="button">取消</button>
              <button className="min-h-11 rounded-[8px] border border-stone-300 px-4 text-sm font-bold text-stone-800" onClick={discardThenNavigate} type="button">放弃修改</button>
              <button className="min-h-11 rounded-[8px] bg-[var(--pbl-teacher)] px-4 text-sm font-bold text-white" disabled={saving} onClick={() => void saveThenNavigate()} type="button">保存并继续</button>
            </div>
          </div>
        </div>
      ) : null}
    </DashboardShell>
  );
}

function ImpactNotice({ pending, onConfirm, onOpen, working }: { pending: CourseDesignWorkspacePendingUpdate[]; onConfirm: () => void; onOpen: (key: CourseDesignWorkspaceSectionKey) => void; working: boolean }) {
  const sourceLabels = [...new Set(pending.map((item) => COURSE_DESIGN_WORKSPACE_SECTIONS.find((section) => section.key === item.source)?.label ?? item.source))];
  const manual = pending.some((item) => item.includesManualEdits);
  return (
    <aside className="mb-4 rounded-[12px] border border-amber-300 bg-amber-50 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex gap-3">
          <AlertTriangle className="mt-0.5 shrink-0 text-amber-700" size={20} />
          <div>
            <h2 className="text-sm font-black text-amber-950">此环节受到上游修改影响</h2>
            <p className="mt-1 text-sm leading-6 text-amber-900">来源：{sourceLabels.join("、")}。{manual ? "目标内容包含教师手工修改，更新前请先核对。" : "可以打开本环节调整，或确认继续沿用当前内容。"}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button className="min-h-10 rounded-[8px] border border-amber-400 bg-white px-3 text-xs font-bold text-amber-900" onClick={() => onOpen(pending[0]!.target)} type="button">核对本环节</button>
          <button className="min-h-10 rounded-[8px] bg-amber-800 px-3 text-xs font-bold text-white disabled:opacity-50" disabled={working} onClick={onConfirm} type="button">确认沿用当前内容</button>
        </div>
      </div>
    </aside>
  );
}

function MaterialsEditor({ course, edit, onCoverUpdated, onLaunchUpdated, replaceDisabled }: { course: Course; edit: (fn: (course: Course) => void) => void; onCoverUpdated: () => Promise<void>; onLaunchUpdated: () => Promise<void>; replaceDisabled: boolean }) {
  const pack = course.content.resourcePackage;
  return (
    <div className="grid gap-7 p-5 sm:p-7 xl:grid-cols-[minmax(0,1.4fr)_minmax(300px,0.6fr)]">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="课程名称"><input className={INPUT} value={course.name} onChange={(event) => edit((next) => { next.name = event.target.value; })} /></Field>
        <Field label="学科"><input className={INPUT} value={course.subject} onChange={(event) => edit((next) => { next.subject = event.target.value; })} /></Field>
        <Field label="教学对象 / 年级"><input className={INPUT} value={course.grade} onChange={(event) => edit((next) => { next.grade = event.target.value; })} /></Field>
        <Field label="课程总时长（小时）"><input className={INPUT} min="0.25" step="0.25" type="number" value={course.hours} onChange={(event) => edit((next) => { next.hours = Number(event.target.value); })} /></Field>
        <div className="sm:col-span-2"><Field label="课程简介"><textarea className={TEXTAREA} value={course.summary} onChange={(event) => edit((next) => { next.summary = event.target.value; })} /></Field></div>
        <div className="sm:col-span-2"><Field label="驱动问题"><textarea className={TEXTAREA} value={course.drivingQuestion} onChange={(event) => edit((next) => { next.drivingQuestion = event.target.value; })} /></Field></div>
        <div className="sm:col-span-2"><Field label="学习目标" hint="每行一个目标。"><textarea className={TEXTAREA} value={(course.learningObjectives ?? []).join("\n")} onChange={(event) => edit((next) => { next.learningObjectives = lines(event.target.value); })} /></Field></div>
        <div className="sm:col-span-2"><Field label="预期成果"><textarea className={TEXTAREA} value={course.expectedOutcome ?? ""} onChange={(event) => edit((next) => { next.expectedOutcome = event.target.value; })} /></Field></div>
        <Field label="已有知识"><textarea className={TEXTAREA} value={course.learnerProfile?.priorKnowledge ?? ""} onChange={(event) => edit((next) => { next.learnerProfile = { ...next.learnerProfile, priorKnowledge: event.target.value }; })} /></Field>
        <Field label="学习需要"><textarea className={TEXTAREA} value={course.learnerProfile?.learningNeeds ?? ""} onChange={(event) => edit((next) => { next.learnerProfile = { ...next.learnerProfile, learningNeeds: event.target.value }; })} /></Field>
        <div className="sm:col-span-2"><Field label="熟悉情境"><textarea className={TEXTAREA} value={course.learnerProfile?.familiarContexts ?? ""} onChange={(event) => edit((next) => { next.learnerProfile = { ...next.learnerProfile, familiarContexts: event.target.value }; })} /></Field></div>
      </div>
      <aside className="space-y-4">
        <div className="rounded-[10px] border border-stone-200 bg-stone-50 p-4">
          <div className="flex items-center gap-2 text-sm font-bold text-stone-900"><FileStack size={17} />资源包来源</div>
          {pack ? <div className="mt-3 space-y-2 text-sm text-stone-600"><p className="font-semibold text-stone-900">{pack.source.fileName}</p><p>资源包修订 v{pack.revision}</p><p>{Object.keys(pack.documents).length} 份已解析文档</p><p className="text-xs leading-5">保存课程定位时会同步资源包中的正式课程字段，原始上传文件和来源记录保持不变。</p></div> : <p className="mt-3 text-sm leading-6 text-stone-500">本课程没有资源包。仍可直接维护课程定位，不强制补传文件。</p>}
          <LaunchPresentationReplacement course={course} disabled={replaceDisabled} onUpdated={onLaunchUpdated} />
        </div>
        <div className="rounded-[10px] border border-stone-200 p-4">
          <div className="flex items-center gap-2 text-sm font-bold text-stone-900"><BookOpenCheck size={17} />教材与依据</div>
          <p className="mt-3 text-sm text-stone-600">已选择 {course.content.textbookSelections?.length ?? 0} 个教材版本</p>
          <p className="mt-1 text-sm text-stone-600">{course.content.courseEvidence?.mappings?.length ?? 0} 条知识依据映射</p>
        </div>
        <CourseCoverSettings
          key={course.id}
          courseId={course.id}
          courseName={course.name}
          coverImageUrl={course.coverImageUrl}
          onUpdated={onCoverUpdated}
        />
        {course.content.teachingRequirements?.items.length ? <div className="rounded-[10px] border border-violet-200 bg-violet-50 p-4"><div className="flex items-center gap-2 text-sm font-bold text-violet-950"><ShieldCheck size={17} />统一教学要求</div><ul className="mt-3 space-y-2 text-xs leading-5 text-violet-900">{course.content.teachingRequirements.items.map((item) => <li key={item.id}>• {item.text}</li>)}</ul>{course.content.teachingRequirements.conflicts.length ? <p className="mt-3 border-t border-violet-200 pt-3 text-xs font-bold text-amber-800">还有 {course.content.teachingRequirements.conflicts.length} 项来源冲突需要在资源包中处理。</p> : null}</div> : null}
      </aside>
    </div>
  );
}

function StagePlanEditor({ course, edit }: { course: Course; edit: (fn: (course: Course) => void) => void }) {
  const plan = course.content.stagePlan;
  if (!plan) return <MissingArtifact courseId={course.id} label="五阶段教学安排" />;
  const updatePlan = (mutator: (plan: CourseStagePlan) => void) => edit((next) => { if (next.content.stagePlan) mutator(next.content.stagePlan); });
  return (
    <div className="space-y-6 p-5 sm:p-7">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="课程总分钟数"><input className={INPUT} type="number" value={plan.totalMinutes} onChange={(event) => updatePlan((next) => { next.totalMinutes = Number(event.target.value); })} /></Field>
        <Field label="课次数"><input className={INPUT} type="number" value={plan.lessonCount ?? ""} onChange={(event) => updatePlan((next) => { next.lessonCount = event.target.value ? Number(event.target.value) : null; })} /></Field>
        <Field label="每课次分钟数"><input className={INPUT} type="number" value={plan.minutesPerLesson ?? ""} onChange={(event) => updatePlan((next) => { next.minutesPerLesson = event.target.value ? Number(event.target.value) : null; })} /></Field>
      </div>
      <div className="space-y-4">
        {plan.stages.map((stage, index) => <StageCard key={stage.key} index={index} stage={stage} update={(mutator) => updatePlan((next) => mutator(next.stages[index]!))} />)}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Field label="评价标准"><textarea className={TEXTAREA} value={plan.evaluationCriteria} onChange={(event) => updatePlan((next) => { next.evaluationCriteria = event.target.value; })} /></Field>
        <Field label="反思问题" hint="每行一个问题。结构化反思题也会同步更新。"><textarea className={TEXTAREA} value={plan.reflectionQuestions.join("\n")} onChange={(event) => updatePlan((next) => { const questions = lines(event.target.value); next.reflectionQuestions = questions; if (next.reflectionQuestionSet) next.reflectionQuestionSet.questions = questions.map((prompt, index) => ({ id: next.reflectionQuestionSet!.questions[index]?.id ?? `reflection-${index + 1}`, prompt, required: next.reflectionQuestionSet!.questions[index]?.required ?? true })); })} /></Field>
      </div>
      {plan.evaluationRubric ? <div className="rounded-[10px] border border-stone-200 p-4 sm:p-5"><div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="text-sm font-black text-stone-900">评价量规</h3><p className="mt-1 text-xs text-stone-500">维度权重、教师评价与 AI 评价权重都必须分别守恒。</p></div><div className="flex gap-3"><Field label="教师权重"><input className={`${INPUT} w-28`} type="number" value={plan.evaluationRubric.sourceWeights.teacher} onChange={(event) => updatePlan((next) => { if (next.evaluationRubric) next.evaluationRubric.sourceWeights.teacher = Number(event.target.value); })} /></Field><Field label="AI 权重"><input className={`${INPUT} w-28`} type="number" value={plan.evaluationRubric.sourceWeights.ai} onChange={(event) => updatePlan((next) => { if (next.evaluationRubric) next.evaluationRubric.sourceWeights.ai = Number(event.target.value); })} /></Field></div></div><div className="mt-4 space-y-3">{plan.evaluationRubric.dimensions.map((dimension, index) => <div className="grid gap-3 rounded-[8px] bg-stone-50 p-3 md:grid-cols-[minmax(160px,0.7fr)_110px_minmax(240px,1.3fr)]" key={dimension.id}><Field label={`维度 ${index + 1}`}><input className={INPUT} value={dimension.name} onChange={(event) => updatePlan((next) => { if (next.evaluationRubric) next.evaluationRubric.dimensions[index]!.name = event.target.value; })} /></Field><Field label="权重 %"><input className={INPUT} type="number" value={dimension.weight} onChange={(event) => updatePlan((next) => { if (next.evaluationRubric) next.evaluationRubric.dimensions[index]!.weight = Number(event.target.value); })} /></Field><Field label="表现说明"><input className={INPUT} value={dimension.description} onChange={(event) => updatePlan((next) => { if (next.evaluationRubric) next.evaluationRubric.dimensions[index]!.description = event.target.value; })} /></Field></div>)}</div></div> : null}
      {plan.reflectionQuestionSet ? <div className="rounded-[10px] border border-stone-200 p-4 sm:p-5"><h3 className="text-sm font-black text-stone-900">结构化反思题</h3><div className="mt-3 space-y-3">{plan.reflectionQuestionSet.questions.map((question, index) => <label className="flex gap-3 rounded-[8px] bg-stone-50 p-3" key={question.id}><input checked={question.required} className="mt-4 size-4" onChange={(event) => updatePlan((next) => { if (next.reflectionQuestionSet) next.reflectionQuestionSet.questions[index]!.required = event.target.checked; })} type="checkbox" /><span className="min-w-0 flex-1 text-xs font-semibold text-stone-600">题目 {index + 1}<input className={INPUT} value={question.prompt} onChange={(event) => updatePlan((next) => { if (!next.reflectionQuestionSet) return; next.reflectionQuestionSet.questions[index]!.prompt = event.target.value; next.reflectionQuestions = next.reflectionQuestionSet.questions.map((item) => item.prompt); })} /></span></label>)}</div></div> : null}
    </div>
  );
}

function StageCard({ stage, index, update }: { stage: ResourcePackageStage; index: number; update: (fn: (stage: ResourcePackageStage) => void) => void }) {
  return (
    <article className="rounded-[10px] border border-stone-200 p-4 sm:p-5">
      <div className="grid gap-4 md:grid-cols-[80px_minmax(0,1fr)_130px]">
        <div><span className="grid size-10 place-items-center rounded-full bg-[var(--pbl-teacher-soft)] text-sm font-black text-[var(--pbl-teacher)]">{index + 1}</span></div>
        <Field label="阶段名称"><input className={INPUT} value={stage.title} onChange={(event) => update((next) => { next.title = event.target.value; })} /></Field>
        <Field label="时长（分钟）"><input className={INPUT} type="number" value={stage.durationMin ?? ""} onChange={(event) => update((next) => { next.durationMin = Number(event.target.value); })} /></Field>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Field label="学习任务与要求"><textarea className={TEXTAREA} value={stage.requirements} onChange={(event) => update((next) => { next.requirements = event.target.value; })} /></Field>
        <Field label="阶段成果"><textarea className={TEXTAREA} value={stage.outputs} onChange={(event) => update((next) => { next.outputs = event.target.value; })} /></Field>
        <Field label="教师行动"><textarea className={TEXTAREA} value={stage.teacherActions} onChange={(event) => update((next) => { next.teacherActions = event.target.value; })} /></Field>
        <Field label="AI 行动"><textarea className={TEXTAREA} value={stage.aiActions} onChange={(event) => update((next) => { next.aiActions = event.target.value; })} /></Field>
      </div>
    </article>
  );
}

function RequirementTracePanel({ course }: { course: Course }) {
  const requirements = course.content.teachingRequirements;
  if (!requirements?.items.length && !requirements?.conflicts.length) return null;
  const blueprintSections = course.content.teachingBlueprint?.sections ?? [];
  return (
    <div className="rounded-[10px] border border-violet-200 bg-violet-50 p-4">
      <div className="flex items-center gap-2 text-sm font-black text-violet-950"><ShieldCheck size={17} />教学要求落实位置</div>
      <div className="mt-3 space-y-3">
        {requirements.items.map((requirement) => {
          const mappedPoints = course.content.knowledgePoints.filter((point) => {
            const sourceIds = new Set([point.id, ...(point.sourceKnowledgePointIds ?? [])]);
            return requirement.sourceKnowledgePointIds.some((id) => sourceIds.has(id));
          });
          const matchedUnits = blueprintSections.flatMap((section) => section.units
            .filter((unit) => unit.requirementIds?.includes(requirement.id))
            .map((unit) => ({ section, unit })));
          const pageNames = [...new Set(matchedUnits.flatMap(({ section, unit }) => section.pages
            .filter((page) => page.unitIds.includes(unit.id)).map((page) => page.title)))];
          return (
            <article className="rounded-[8px] border border-violet-200 bg-white p-3 text-xs leading-5" key={requirement.id}>
              <div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-violet-100 px-2 py-0.5 font-bold text-violet-800">{requirement.kind === "highlight" ? "教学重点" : requirement.kind === "difficulty" ? "教学难点" : requirement.kind === "teacher-directive" ? "教师补充" : "阶段要求"}</span><b className="text-stone-900">{requirement.text}</b></div>
              <p className="mt-1 text-stone-600">知识：{mappedPoints.map((point) => point.name).join("、") || "全局要求"}</p>
              <p className={matchedUnits.length || requirement.appliesTo === "other-stage" ? "text-emerald-700" : "font-bold text-amber-800"}>小节 / 单元：{matchedUnits.map(({ section, unit }) => `${section.title} / ${unit.title}`).join("、") || (requirement.appliesTo === "other-stage" ? "适用于项目实践、展示或反思阶段" : "尚未落实")}</p>
              <p className="text-stone-600">页面：{pageNames.join("、") || (requirement.appliesTo === "other-stage" ? "不进入 AI 知识讲授页面" : "尚未定位")}</p>
            </article>
          );
        })}
        {requirements.conflicts.map((conflict) => <article className="rounded-[8px] border border-amber-300 bg-amber-50 p-3 text-xs leading-5 text-amber-950" key={conflict.id}><b>未解决冲突：{conflict.summary}</b><p>{conflict.detail}</p></article>)}
      </div>
    </div>
  );
}

function KnowledgeEditor({ course, edit }: { course: Course; edit: (fn: (course: Course) => void) => void }) {
  const points = course.content.knowledgePoints;
  if (!points.length) return <MissingArtifact courseId={course.id} label="知识结构" />;
  const graph = course.content.knowledgeGraph;
  function updatePoint(index: number, mutator: (point: KnowledgePoint) => void) {
    edit((next) => {
      const point = next.content.knowledgePoints[index]!;
      mutator(point);
      const node = next.content.knowledgeGraph?.nodes.find((item) => item.id === point.id);
      if (node) {
        node.label = point.name;
        node.description = point.description;
        node.level = point.level;
        node.masteryBoundary = point.masteryBoundary;
        node.groupId = point.groupId;
        node.groupName = point.groupName;
      }
    });
  }
  function addPoint() {
    const id = `knowledge-${crypto.randomUUID()}`;
    edit((next) => {
      next.content.knowledgePoints.push({ id, name: "新知识点", description: "请补充讲授说明", level: "core" });
      next.content.knowledgeGraph ??= { nodes: [], edges: [] };
      next.content.knowledgeGraph.nodes.push({ id, label: "新知识点", description: "请补充讲授说明", level: "core", instructionalRole: "lesson" });
    });
  }
  function removePoint(id: string) {
    edit((next) => {
      next.content.knowledgePoints = next.content.knowledgePoints
        .filter((point) => point.id !== id)
        .map((point) => ({ ...point, relatedIds: point.relatedIds?.filter((relatedId) => relatedId !== id) }));
      if (next.content.knowledgeGraph) {
        next.content.knowledgeGraph.nodes = next.content.knowledgeGraph.nodes.filter((node) => node.id !== id);
        next.content.knowledgeGraph.edges = next.content.knowledgeGraph.edges.filter((edge) => edge.source !== id && edge.target !== id);
      }
    });
  }
  function addEdge() {
    if (points.length < 2) return;
    edit((next) => {
      next.content.knowledgeGraph ??= { nodes: [], edges: [] };
      next.content.knowledgeGraph.edges.push({
        id: `knowledge-edge-${crypto.randomUUID()}`,
        source: next.content.knowledgePoints[0]!.id,
        target: next.content.knowledgePoints[1]!.id,
        label: "支持理解",
        type: "supports",
        strength: "helpful",
      });
    });
  }
  return (
    <div className="space-y-6 p-5 sm:p-7">
      <RequirementTracePanel course={course} />
      {course.content.knowledgeScopePlan ? <div className="grid gap-3 rounded-[10px] border border-blue-200 bg-blue-50 p-4 text-sm sm:grid-cols-4"><div><b>{course.content.knowledgeScopePlan.planningDurationMin}</b><span className="block text-xs text-blue-700">规划分钟</span></div><div><b>{course.content.knowledgeScopePlan.sourcePointCount}</b><span className="block text-xs text-blue-700">来源知识点</span></div><div><b>{course.content.knowledgeScopePlan.targetPointCount}</b><span className="block text-xs text-blue-700">课程知识点</span></div><p className="leading-5 text-blue-900 sm:col-span-1">{course.content.knowledgeScopePlan.rationale}</p></div> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="text-sm font-black text-stone-900">知识点与分组</h3><p className="mt-1 text-xs text-stone-500">来源映射保留原始资料记录；修改分组或范围后会计算实际受影响的小节。</p></div>
        <button className="inline-flex min-h-10 items-center gap-2 rounded-[8px] border border-stone-300 bg-white px-3 text-xs font-bold text-stone-800" onClick={addPoint} type="button"><Plus size={14} />添加知识点</button>
      </div>
      <div className="space-y-3">
        {points.map((point, index) => (
          <article className="grid gap-4 rounded-[10px] border border-stone-200 p-4 lg:grid-cols-[minmax(180px,0.7fr)_minmax(260px,1.3fr)_150px]" key={point.id}>
            <Field label={`知识点 ${index + 1}`}><input className={INPUT} value={point.name} onChange={(event) => updatePoint(index, (next) => { next.name = event.target.value; })} /></Field>
            <Field label="讲授说明"><textarea className={TEXTAREA} value={point.description} onChange={(event) => updatePoint(index, (next) => { next.description = event.target.value; })} /></Field>
            <Field label="层级"><select className={INPUT} value={point.level ?? "core"} onChange={(event) => updatePoint(index, (next) => { next.level = event.target.value as KnowledgePoint["level"]; })}><option value="foundation">基础</option><option value="core">核心</option><option value="application">应用</option><option value="extension">拓展</option></select></Field>
            <Field label="知识分组名称"><input className={INPUT} value={point.groupName ?? ""} onChange={(event) => updatePoint(index, (next) => { next.groupName = event.target.value; })} /></Field>
            <Field label="分组标识"><input className={INPUT} value={point.groupId ?? ""} onChange={(event) => updatePoint(index, (next) => { next.groupId = event.target.value; })} /></Field>
            <Field label="来源映射"><input className={`${INPUT} bg-stone-50`} readOnly value={(point.sourceKnowledgePointNames ?? []).join("、") || point.sourceId || "未记录来源映射"} /></Field>
            <Field label="教学责任"><input className={`${INPUT} bg-stone-50`} readOnly value={point.teachingRole === "core-concept" ? "需先正式建立的核心概念" : point.teachingRole === "detail-concept" ? "下位机制、原则或应用" : "常规知识点"} /></Field>
            <Field label="上位概念"><input className={`${INPUT} bg-stone-50`} readOnly value={(point.parentKnowledgePointIds ?? []).map((id) => points.find((item) => item.id === id)?.name ?? id).join("、") || "无"} /></Field>
            <div className="lg:col-span-2"><Field label="掌握边界"><input className={INPUT} value={point.masteryBoundary ?? ""} onChange={(event) => updatePoint(index, (next) => { next.masteryBoundary = event.target.value; })} /></Field></div>
            <div className="flex items-end justify-end"><button className="inline-flex min-h-11 items-center gap-2 rounded-[8px] px-3 text-xs font-bold text-red-700 disabled:opacity-40" disabled={points.length === 1} onClick={() => removePoint(point.id)} type="button"><Trash2 size={14} />删除知识点</button></div>
          </article>
        ))}
      </div>
      <div className="rounded-[10px] border border-stone-200 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2 text-sm font-bold text-stone-900"><GitBranch size={17} />知识依赖与关联</div><button className="inline-flex min-h-10 items-center gap-2 rounded-[8px] border border-stone-300 px-3 text-xs font-bold text-stone-800 disabled:opacity-40" disabled={points.length < 2} onClick={addEdge} type="button"><Plus size={14} />添加关系</button></div>
        {graph?.edges.length ? <div className="mt-3 space-y-3">{graph.edges.map((edge, edgeIndex) => <div className="grid gap-3 rounded-[8px] bg-stone-50 p-3 sm:grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)_minmax(150px,0.8fr)_40px]" key={edge.id}><select aria-label={`关系 ${edgeIndex + 1} 起点`} className={INPUT} value={edge.source} onChange={(event) => edit((next) => { if (next.content.knowledgeGraph) next.content.knowledgeGraph.edges[edgeIndex]!.source = event.target.value; })}>{points.map((point) => <option key={point.id} value={point.id}>{point.name}</option>)}</select><ChevronRight className="mt-4 self-center text-stone-400" size={16} /><select aria-label={`关系 ${edgeIndex + 1} 终点`} className={INPUT} value={edge.target} onChange={(event) => edit((next) => { if (next.content.knowledgeGraph) next.content.knowledgeGraph.edges[edgeIndex]!.target = event.target.value; })}>{points.map((point) => <option key={point.id} value={point.id}>{point.name}</option>)}</select><input aria-label={`关系 ${edgeIndex + 1} 说明`} className={INPUT} value={edge.label} onChange={(event) => edit((next) => { if (next.content.knowledgeGraph) next.content.knowledgeGraph.edges[edgeIndex]!.label = event.target.value; })} /><button aria-label={`删除关系 ${edgeIndex + 1}`} className="mt-1 grid size-11 place-items-center self-end rounded-[8px] text-red-700" onClick={() => edit((next) => { if (next.content.knowledgeGraph) next.content.knowledgeGraph.edges.splice(edgeIndex, 1); })} type="button"><Trash2 size={15} /></button></div>)}</div> : <p className="mt-3 text-sm text-stone-500">当前没有知识关系。</p>}
      </div>
    </div>
  );
}

function TimingEditor({ course, edit }: { course: Course; edit: (fn: (course: Course) => void) => void }) {
  const plan = course.content.moduleTimingPlan;
  if (!plan) return <MissingArtifact courseId={course.id} label="讲授时间规划" />;
  const allocated = plan.allocations.reduce((sum, item) => sum + item.durationMin, 0);
  return (
    <div className="space-y-6 p-5 sm:p-7">
      <div className="grid gap-4 rounded-[10px] border border-stone-200 bg-stone-50 p-4 sm:grid-cols-3">
        <Field label="知识讲授总时长（分钟）"><input className={INPUT} type="number" value={plan.totalMinutes} onChange={(event) => edit((next) => { if (next.content.moduleTimingPlan) next.content.moduleTimingPlan.totalMinutes = Number(event.target.value); })} /></Field>
        <div><p className="text-sm font-semibold text-stone-800">已分配</p><p className={cn("mt-3 text-2xl font-black", Math.abs(allocated - plan.totalMinutes) < 0.001 ? "text-emerald-700" : "text-red-700")}>{allocated} 分钟</p></div>
        <div><p className="text-sm font-semibold text-stone-800">规划来源</p><p className="mt-3 text-sm text-stone-700">{plan.recommendationSource === "teacher" ? "教师调整" : plan.recommendationSource === "llm" ? "AI 建议" : "确定性规划"}</p></div>
      </div>
      <div className="space-y-3">
        {plan.allocations.map((allocation, index) => (
          <article className="grid gap-4 rounded-[10px] border border-stone-200 p-4 md:grid-cols-[minmax(0,1fr)_150px]" key={allocation.id}>
            <div><p className="text-sm font-bold text-stone-900">{allocation.title || `知识簇 ${index + 1}`}</p><p className="mt-1 text-xs leading-5 text-stone-500">{(allocation.knowledgePointIds ?? []).map((id) => course.content.knowledgePoints.find((point) => point.id === id)?.name ?? id).join("、")}</p>{allocation.notes ? <p className="mt-2 whitespace-pre-line text-xs leading-5 text-violet-800">{allocation.notes}</p> : null}</div>
            <Field label="时长（分钟）"><input className={INPUT} min="1" type="number" value={allocation.durationMin} onChange={(event) => edit((next) => { if (next.content.moduleTimingPlan) next.content.moduleTimingPlan.allocations[index]!.durationMin = Number(event.target.value); })} /></Field>
          </article>
        ))}
      </div>
      {plan.rationaleByStage?.["ai-learning"] ? <div className="rounded-[10px] border border-violet-200 bg-violet-50 p-4 text-sm leading-6 text-violet-900"><b>规划依据：</b>{plan.rationaleByStage["ai-learning"]}</div> : null}
    </div>
  );
}

function BlueprintEditor({ course, edit }: { course: Course; edit: (fn: (course: Course) => void) => void }) {
  const blueprint = course.content.teachingBlueprint;
  if (!blueprint) return <MissingArtifact courseId={course.id} label="教学蓝图与大纲" />;
  const updateSection = (sectionIndex: number, mutator: (section: TeachingBlueprintSection) => void) => edit((next) => { const section = next.content.teachingBlueprint?.sections[sectionIndex]; if (section) mutator(section); });
  const addPage = (sectionIndex: number) => updateSection(sectionIndex, (section) => {
    const unit = section.units[0];
    section.pages.push({
      id: `blueprint-page-${crypto.randomUUID()}`,
      title: "新课堂页面",
      type: "slide",
      unitIds: unit ? [unit.id] : [],
      knowledgePointIds: unit?.knowledgePointIds.length ? [...unit.knowledgePointIds] : [...section.knowledgePointIds],
      description: "请说明本页要解释、演示或组织的内容。",
      keyPoints: ["请补充页面要点"],
      teachingObjective: section.learningObjective,
    });
  });
  return (
    <div className="space-y-5 p-5 sm:p-7">
      <div className="flex flex-wrap gap-2 text-xs"><span className="rounded-full border border-stone-200 px-3 py-1.5">{blueprint.sections.length} 个知识小节</span><span className="rounded-full border border-stone-200 px-3 py-1.5">{blueprint.sections.reduce((sum, section) => sum + section.pages.length, 0)} 个讲授页面</span><span className="rounded-full border border-stone-200 px-3 py-1.5">检测模式：{blueprint.assessmentMode === "adaptive" ? "普通检测" : "综合简答"}</span></div>
      {blueprint.sections.map((section, sectionIndex) => (
        <article className="overflow-hidden rounded-[10px] border border-stone-200" key={section.id}>
          <div className="grid gap-4 border-b border-stone-200 bg-stone-50 p-4 md:grid-cols-[minmax(0,1fr)_150px_150px_150px]">
            <Field label={`小节 ${sectionIndex + 1}`}><input className={INPUT} value={section.title} onChange={(event) => updateSection(sectionIndex, (next) => { next.title = event.target.value; })} /></Field>
            <Field label="讲授秒数"><input className={INPUT} type="number" value={section.teachingDurationSec} onChange={(event) => updateSection(sectionIndex, (next) => { next.teachingDurationSec = Number(event.target.value); })} /></Field>
            <Field label="活动秒数"><input className={INPUT} type="number" value={section.learnerActivityDurationSec} onChange={(event) => updateSection(sectionIndex, (next) => { next.learnerActivityDurationSec = Number(event.target.value); })} /></Field>
            <Field label="检测秒数"><input className={INPUT} type="number" value={section.assessmentDurationSec} onChange={(event) => updateSection(sectionIndex, (next) => { next.assessmentDurationSec = Number(event.target.value); })} /></Field>
            <div className="md:col-span-4"><Field label="小节学习目标"><input className={INPUT} value={section.learningObjective} onChange={(event) => updateSection(sectionIndex, (next) => { next.learningObjective = event.target.value; })} /></Field></div>
          </div>
          <div className="space-y-5 p-4">
            <div><h3 className="text-sm font-black text-stone-900">讲授单元</h3><div className="mt-3 space-y-3">{section.units.map((unit, unitIndex) => <UnitEditor key={unit.id} unit={unit} update={(mutator) => updateSection(sectionIndex, (next) => mutator(next.units[unitIndex]!))} />)}</div></div>
            <div><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-black text-stone-900">页面安排</h3><p className="mt-1 text-xs text-stone-500">增删页面与知识关联会在保存时通过蓝图预算和引用校验。</p></div><button className="inline-flex min-h-10 items-center gap-2 rounded-[8px] border border-stone-300 px-3 text-xs font-bold text-stone-800" onClick={() => addPage(sectionIndex)} type="button"><Plus size={14} />添加页面</button></div><div className="mt-3 space-y-3">{section.pages.map((page, pageIndex) => <PageEditor key={page.id} knowledgePoints={course.content.knowledgePoints.filter((point) => section.knowledgePointIds.includes(point.id))} onDelete={() => updateSection(sectionIndex, (next) => { next.pages.splice(pageIndex, 1); })} page={page} units={section.units} update={(mutator) => updateSection(sectionIndex, (next) => mutator(next.pages[pageIndex]!))} />)}</div></div>
            <Field label="检测重点" hint="每行一项。"><textarea className={TEXTAREA} value={section.assessmentFocus.join("\n")} onChange={(event) => updateSection(sectionIndex, (next) => { next.assessmentFocus = lines(event.target.value); })} /></Field>
          </div>
        </article>
      ))}
    </div>
  );
}

function UnitEditor({ unit, update }: { unit: TeachingBlueprintUnit; update: (fn: (unit: TeachingBlueprintUnit) => void) => void }) {
  return <div className="grid gap-4 rounded-[8px] bg-stone-50 p-4 lg:grid-cols-2"><Field label="单元标题"><input className={INPUT} value={unit.title} onChange={(event) => update((next) => { next.title = event.target.value; })} /></Field><Field label="学习结果"><input className={INPUT} value={unit.learningOutcome} onChange={(event) => update((next) => { next.learningOutcome = event.target.value; })} /></Field><Field label="核心解释"><textarea className={TEXTAREA} value={unit.explanation} onChange={(event) => update((next) => { next.explanation = event.target.value; })} /></Field><Field label="原理与推理"><textarea className={TEXTAREA} value={unit.mechanism} onChange={(event) => update((next) => { next.mechanism = event.target.value; })} /></Field><Field label="例证"><textarea className={TEXTAREA} value={unit.workedExample} onChange={(event) => update((next) => { next.workedExample = event.target.value; })} /></Field><Field label="常见误解" hint="每行一项。"><textarea className={TEXTAREA} value={unit.misconceptions.join("\n")} onChange={(event) => update((next) => { next.misconceptions = lines(event.target.value); })} /></Field></div>;
}

function PageEditor({ page, update, onDelete, units, knowledgePoints }: { page: TeachingBlueprintPage; update: (fn: (page: TeachingBlueprintPage) => void) => void; onDelete: () => void; units: TeachingBlueprintUnit[]; knowledgePoints: KnowledgePoint[] }) {
  return <div className="grid gap-4 rounded-[8px] border border-stone-200 p-4 lg:grid-cols-[180px_minmax(0,1fr)_44px]"><Field label="页面类型"><select className={INPUT} value={page.type} onChange={(event) => update((next) => { next.type = event.target.value as TeachingBlueprintPage["type"]; })}><option value="slide">讲授页</option><option value="interactive">互动页</option></select></Field><Field label="页面标题"><input className={INPUT} value={page.title} onChange={(event) => update((next) => { next.title = event.target.value; })} /></Field><button aria-label={`删除页面：${page.title}`} className="mt-6 grid size-11 place-items-center rounded-[8px] text-red-700" onClick={onDelete} type="button"><Trash2 size={15} /></button><div className="lg:col-span-3"><Field label="页面说明"><textarea className={TEXTAREA} value={page.description} onChange={(event) => update((next) => { next.description = event.target.value; })} /></Field></div><div className="lg:col-span-3"><p className="text-sm font-semibold text-stone-800">知识与讲授单元关联</p><div className="mt-2 flex flex-wrap gap-2">{knowledgePoints.map((point) => <label className="inline-flex min-h-9 items-center gap-2 rounded-full border border-stone-200 px-3 text-xs text-stone-700" key={point.id}><input checked={page.knowledgePointIds.includes(point.id)} onChange={() => update((next) => { next.knowledgePointIds = next.knowledgePointIds.includes(point.id) ? next.knowledgePointIds.filter((id) => id !== point.id) : [...next.knowledgePointIds, point.id]; })} type="checkbox" />{point.name}</label>)}{units.map((unit) => <label className="inline-flex min-h-9 items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 text-xs text-blue-800" key={unit.id}><input checked={page.unitIds.includes(unit.id)} onChange={() => update((next) => { next.unitIds = next.unitIds.includes(unit.id) ? next.unitIds.filter((id) => id !== unit.id) : [...next.unitIds, unit.id]; })} type="checkbox" />单元：{unit.title}</label>)}</div></div><Field label="教学目标"><input className={INPUT} value={page.teachingObjective} onChange={(event) => update((next) => { next.teachingObjective = event.target.value; })} /></Field><div className="lg:col-span-2"><Field label="页面要点" hint="每行一项。"><textarea className={TEXTAREA} value={page.keyPoints.join("\n")} onChange={(event) => update((next) => { next.keyPoints = lines(event.target.value); })} /></Field></div></div>;
}

function ClassroomEditorPanel({ course, job, selectedSections, setSelectedSections, onGenerate, onDecideCandidate, working }: { course: Course; job: WorkspaceJob; selectedSections: string[]; setSelectedSections: (ids: string[]) => void; onGenerate: () => void; onDecideCandidate: (id: string, adopt: boolean) => void; working: boolean }) {
  const outlines = course.content._openmaicSceneOutlines ?? [];
  const sections = course.content.knowledgeLectureSections ?? [];
  const candidates = course.content.designWorkspaceRevision?.candidateUpdates ?? [];
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  if (!outlines.length || !classroomId) return <MissingArtifact courseId={course.id} label="课堂内容与资源" />;
  const active = job && ["queued", "running", "cancelling"].includes(job.status);
  const timingAudit = course.content.teachingTimingAudit;
  const audioSeconds = timingAudit
    ? timingAudit.substantiveTeachingDurationSec + timingAudit.assessmentAudioDurationSec
    : 0;
  const audioStatus = timingAudit
    ? `${Math.round(audioSeconds / 60)} 分钟 · ${timingAudit.narrationDurationSource === "actual-audio" ? "实测" : "讲稿估算"}`
    : "尚未核验";
  return (
    <div className="space-y-6 p-5 sm:p-7">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric icon={<Layers3 size={17} />} label="知识小节" value={`${sections.length}`} /><Metric icon={<FileStack size={17} />} label="课堂页面" value={`${course.content._openmaicScenesCount ?? outlines.length} / ${outlines.length}`} /><Metric icon={<Clock3 size={17} />} label="规划时长" value={`${Math.round(outlines.reduce((sum, item) => sum + (item.targetDurationSec ?? item.estimatedDuration ?? 0), 0) / 60)} 分钟`} /><Metric icon={<BookOpenCheck size={17} />} label="音频与讲稿" value={audioStatus} /></div>
      <div className="grid gap-px overflow-hidden rounded-[10px] border border-stone-200 bg-stone-200 sm:grid-cols-2 lg:grid-cols-4"><ResourceStatus label="课件 / 讲授页" value={`${outlines.filter((item) => item.type === "slide").length} 页`} ready /><ResourceStatus label="互动资源" value={`${outlines.filter((item) => item.type === "interactive").length} 页`} ready /><ResourceStatus label="小测" value={`${outlines.filter((item) => item.type === "quiz").length} 页`} ready /><ResourceStatus label="资源核验" value={timingAudit?.complete ? "已完成" : "待处理"} ready={timingAudit?.complete === true} /></div>
      {job ? <div className={cn("rounded-[10px] border p-4", job.status === "failed" ? "border-red-200 bg-red-50" : active ? "border-blue-200 bg-blue-50" : "border-stone-200 bg-stone-50")}><div className="flex items-center justify-between gap-3"><div><p className="text-sm font-bold text-stone-900">{job.message}</p><p className="mt-1 text-xs text-stone-600">{job.step} · {job.progress}%</p></div>{active ? <LoaderCircle className="animate-spin text-blue-700" size={20} /> : null}</div>{active ? <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-blue-100"><div className="h-full bg-blue-600 transition-all" style={{ width: `${job.progress}%` }} /></div> : null}</div> : null}
      {candidates.map((candidate) => <div className="rounded-[10px] border border-emerald-300 bg-emerald-50 p-4" key={candidate.id}><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm font-black text-emerald-950">局部更新候选已就绪</p><p className="mt-1 text-sm text-emerald-900">覆盖 {candidate.affectedSectionIds.length} 个小节、{candidate.affectedOutlineIds.length} 个页面。原课堂尚未改变。</p></div><div className="flex gap-2"><button className="min-h-10 rounded-[8px] border border-emerald-400 bg-white px-3 text-xs font-bold text-emerald-900" disabled={working} onClick={() => onDecideCandidate(candidate.id, false)} type="button"><Trash2 className="mr-1 inline" size={14} />丢弃</button><button className="min-h-10 rounded-[8px] bg-emerald-700 px-3 text-xs font-bold text-white" disabled={working} onClick={() => onDecideCandidate(candidate.id, true)} type="button"><Check className="mr-1 inline" size={14} />确认采用</button></div></div></div>)}
      <div>
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="text-sm font-black text-stone-900">按知识小节更新课堂</h3><p className="mt-1 text-xs text-stone-500">只生成选中小节的候选；未选中的页面和教师手工修改保持原样。</p></div><button className="inline-flex min-h-11 items-center gap-2 rounded-[8px] bg-[var(--pbl-teacher)] px-4 text-sm font-bold text-white disabled:opacity-50" disabled={!selectedSections.length || Boolean(active) || working} onClick={onGenerate} type="button"><RefreshCw size={16} />生成局部候选</button></div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">{sections.map((section) => { const checked = selectedSections.includes(section.id); return <label className={cn("flex cursor-pointer gap-3 rounded-[10px] border p-4", checked ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)]" : "border-stone-200")} key={section.id}><input checked={checked} className="mt-1 size-4" onChange={() => setSelectedSections(checked ? selectedSections.filter((id) => id !== section.id) : [...selectedSections, section.id])} type="checkbox" /><span><b className="block text-sm text-stone-900">{section.title}</b><span className="mt-1 block text-xs text-stone-500">{section.sceneOutlineIds.length + 1} 个页面 · 约 {section.estimatedMinutes} 分钟</span></span></label>; })}</div>
      </div>
      <div className="flex flex-wrap gap-2"><Link className="inline-flex min-h-11 items-center gap-2 rounded-[8px] border border-stone-300 bg-white px-4 text-sm font-bold text-stone-800" href={`/teacher/prepare/${course.id}/classroom-editor`}><Edit3 size={16} />打开课堂编辑器<ExternalLink size={14} /></Link><Link className="inline-flex min-h-11 items-center gap-2 rounded-[8px] border border-stone-300 bg-white px-4 text-sm font-bold text-stone-800" href={`/teacher/prepare/${course.id}/preview?view=student`}><BookOpenCheck size={16} />预览学生课堂</Link></div>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div className="rounded-[10px] border border-stone-200 p-4"><div className="flex items-center gap-2 text-xs font-semibold text-stone-500">{icon}{label}</div><p className="mt-2 text-lg font-black text-stone-900">{value}</p></div>;
}

function ResourceStatus({ label, value, ready }: { label: string; value: string; ready: boolean }) {
  return <div className="bg-white p-4"><p className="text-xs font-semibold text-stone-500">{label}</p><p className={cn("mt-2 text-sm font-black", ready ? "text-emerald-700" : "text-amber-700")}>{value}</p></div>;
}
