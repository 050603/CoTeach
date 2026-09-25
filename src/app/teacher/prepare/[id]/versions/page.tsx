"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, BookOpenCheck, Clock3, GitBranch, History, RotateCcw } from "lucide-react";
import { DashboardShell } from "@/components/dashboard-shell";
import { StudentStageHost } from "@/components/openmaic-bridge/student-stage-host";
import { Button, toast } from "@/components/ui";
import { buttonVariants } from "@/components/ui/button";
import { courseDetailedEditHref } from "@/lib/courses/preparation-navigation";
import { useCourse, useSession } from "@/lib/session/store";
import type { PblTemplateVersionDetail, PblTemplateVersionSummary } from "@/lib/platform/pbl-template-repository";

type HistoryPayload = {
  courseVersion: number;
  latestVersion: number | null;
  versions: PblTemplateVersionSummary[];
  selected: PblTemplateVersionDetail;
};

function versionStatus(status: string, current: boolean): string {
  if (current) return status.toUpperCase() === "PUBLISHED" ? "当前发布" : "当前草稿";
  if (status.toUpperCase() === "PUBLISHED") return "已发布";
  return "历史草稿";
}

function duration(seconds: number | null): string {
  if (seconds === null) return "尚无实测音频";
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return `${minutes} 分 ${rest} 秒`;
}

function dateLabel(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function CourseVersionsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const session = useSession();
  const course = useCourse(params?.id);
  const [selectedVersion, setSelectedVersion] = useState<number>();
  const [history, setHistory] = useState<HistoryPayload>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [restorePending, setRestorePending] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [showPlayback, setShowPlayback] = useState(false);

  useEffect(() => {
    if (!params?.id) return;
    const controller = new AbortController();
    const query = selectedVersion ? `?version=${selectedVersion}` : "";
    void fetch(`/api/courses/${encodeURIComponent(params.id)}/versions${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "无法读取版本记录");
        return payload as HistoryPayload;
      })
      .then((payload) => { if (!controller.signal.aborted) { setHistory(payload); setError(""); } })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取版本记录"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [params?.id, selectedVersion]);

  function selectVersion(version: number) {
    if (version === history?.selected.version) return;
    setSelectedVersion(version);
    setLoading(true);
    setRestorePending(false);
    setShowPlayback(false);
  }

  async function restoreVersion() {
    if (!history || !params?.id) return;
    setRestoring(true);
    try {
      const response = await fetch(`/api/courses/${encodeURIComponent(params.id)}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceVersion: history.selected.version, expectedCourseVersion: history.courseVersion }),
      });
      const payload = await response.json() as { version?: number; error?: string };
      if (!response.ok) throw new Error(payload.error || "恢复失败");
      await session.refresh("teacher");
      toast.success(`已从 v${history.selected.version} 创建草稿 v${payload.version}`, { description: "请检查课程和音频，并按发布中心提示完成终审。" });
      router.push(courseDetailedEditHref(params.id));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "恢复失败";
      setError(message);
      toast.error("无法恢复版本", { description: message });
      setRestorePending(false);
    } finally { setRestoring(false); }
  }

  const selected = history && history.selected.version === (selectedVersion ?? history.latestVersion) ? history.selected : undefined;
  const current = history?.versions[0];
  const isCurrent = Boolean(selected && selected.version === history?.latestVersion);
  const backHref = `/teacher/prepare/${encodeURIComponent(params.id)}/preview`;

  return <DashboardShell backHref={backHref} backLabel="返回发布中心" role="teacher" userName={session.user.name} variant="bare" currentCourse={course ? { id: course.id, name: course.name, status: course.status } : undefined} wide>
    <main className="mx-auto w-full max-w-[1480px] pb-16">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-stone-200 pb-5">
        <div>
          <p className="flex items-center gap-2 text-xs font-bold text-[var(--pbl-teacher)]"><History size={16} />课程版本记录</p>
          <h1 className="mt-2 font-editorial text-2xl font-semibold text-stone-950 sm:text-3xl">{course?.name || selected?.name || "课程版本"}</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">查看已发布版本和保留的历史草稿。恢复会建立一个新草稿，现有发布版本和课堂记录会继续保留。</p>
        </div>
        <Link className={buttonVariants({ variant: "outline", className: "min-h-11" })} href={backHref}><ArrowLeft size={16} />返回发布中心</Link>
      </header>

      {error ? <div className="mt-5 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert"><AlertTriangle size={17} className="mt-0.5 shrink-0" />{error}</div> : null}
      {!history && loading ? <div className="grid min-h-72 place-items-center text-sm text-stone-500">正在读取课程版本…</div> : null}

      {history ? <div className="mt-5 grid items-start gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="overflow-hidden rounded-xl border border-stone-200 bg-white">
          <div className="border-b border-stone-200 px-4 py-3"><h2 className="text-sm font-bold text-stone-900">版本时间线</h2><p className="mt-1 text-xs text-stone-500">共 {history.versions.length} 个版本</p></div>
          <ol className="max-h-[70vh] overflow-y-auto p-2">
            {history.versions.map((version) => <li key={version.version}>
              <button aria-current={selected?.version === version.version ? "true" : undefined} className={`mb-1 w-full rounded-lg border px-3 py-3 text-left transition ${selected?.version === version.version ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)]" : "border-transparent hover:border-stone-200 hover:bg-stone-50"}`} onClick={() => selectVersion(version.version)} type="button">
                <span className="flex items-center justify-between gap-2"><strong className="text-sm text-stone-900">v{version.version}</strong><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${version.status.toUpperCase() === "PUBLISHED" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{versionStatus(version.status, version.version === history.latestVersion)}</span></span>
                <span className="mt-1 block truncate text-xs text-stone-700">{version.name}</span>
                <span className="mt-1 block text-[11px] text-stone-500">创建于 {dateLabel(version.createdAt)} · {version.pageCount} 页</span>
              </button>
            </li>)}
          </ol>
        </aside>

        <div className="min-w-0 space-y-5">
          {loading ? <div className="grid min-h-40 place-items-center rounded-xl border border-stone-200 bg-white text-sm text-stone-500">正在读取所选版本…</div> : selected ? <>
            <section className="rounded-xl border border-stone-200 bg-white p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div><p className="text-xs font-bold text-[var(--pbl-teacher)]">{versionStatus(selected.status, isCurrent)} · v{selected.version}</p><h2 className="mt-1 text-xl font-bold text-stone-950">{selected.name}</h2><p className="mt-1 text-sm text-stone-500">{[selected.subject, selected.grade].filter(Boolean).join(" · ")} · 创建于 {dateLabel(selected.createdAt)}</p></div>
                {!isCurrent ? <Button className="min-h-11" disabled={!selected.restorable || !selected.classroomAvailable || restoring} onClick={() => setRestorePending(true)} type="button"><RotateCcw size={16} />恢复为新草稿</Button> : <Link className={buttonVariants({ variant: "outline", className: "min-h-11" })} href={courseDetailedEditHref(params.id)}>编辑当前版本</Link>}
              </div>
              {!selected.restorable ? <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">此版本使用旧数据格式，暂时无法恢复。</p> : null}
              {!selected.classroomAvailable ? <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">此版本引用的课堂文件已缺失，无法完整恢复或预览。</p> : null}
              {restorePending ? <div className="mt-5 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950" role="group" aria-label="确认恢复历史版本">
                <p className="font-bold">从 v{selected.version} 创建新草稿？</p>
                <p className="mt-1 leading-6">当前{current?.status.toUpperCase() === "DRAFT" ? `草稿 v${current.version} 将保留在历史记录中；` : ""}新草稿需重新检查，并按发布中心提示完成终审。浏览器里尚未保存的编辑不会进入历史记录。</p>
                <div className="mt-3 flex flex-wrap gap-2"><Button disabled={restoring} loading={restoring} onClick={() => void restoreVersion()} type="button">确认恢复</Button><Button disabled={restoring} onClick={() => setRestorePending(false)} type="button" variant="outline">取消</Button></div>
              </div> : null}
            </section>

            <section className="rounded-xl border border-stone-200 bg-white p-5 sm:p-6">
              <h2 className="flex items-center gap-2 text-base font-bold text-stone-950"><GitBranch size={17} />与当前版本对照</h2>
              <div className="mt-4 grid gap-px overflow-hidden rounded-lg border border-stone-200 bg-stone-200 sm:grid-cols-4">
                <VersionMetric icon={<BookOpenCheck size={17} />} label="学生页面" before={`${selected.pageCount} 页`} after={`${current?.pageCount ?? 0} 页`} />
                <VersionMetric icon={<Clock3 size={17} />} label="课程规划" before={selected.stageMinutes === null ? "未规划" : `${selected.stageMinutes} 分钟`} after={current?.stageMinutes === null ? "未规划" : `${current?.stageMinutes ?? 0} 分钟`} />
                <VersionMetric icon={<Clock3 size={17} />} label="实测朗读音频" before={duration(selected.measuredSpeechSeconds)} after={duration(current?.measuredSpeechSeconds ?? null)} />
                <VersionMetric icon={<BookOpenCheck size={17} />} label="课程资料" before={`${selected.resourceCount} 项`} after={`${current?.resourceCount ?? 0} 项`} />
              </div>
              <p className="mt-3 text-xs text-stone-500">每项依次显示所选 v{selected.version} 和当前 v{current?.version}。时长取版本快照中保存的核查结果。</p>
            </section>

            <section className="rounded-xl border border-stone-200 bg-white p-5 sm:p-6">
              <h2 className="text-base font-bold text-stone-950">课程设计</h2>
              {selected.summary ? <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-stone-700">{selected.summary}</p> : null}
              {selected.drivingQuestion ? <p className="mt-3 rounded-lg bg-stone-50 p-3 text-sm text-stone-800"><strong>驱动问题：</strong>{selected.drivingQuestion}</p> : null}
              {selected.learningObjectives.length ? <div className="mt-4"><h3 className="text-sm font-bold text-stone-900">学习目标</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-stone-700">{selected.learningObjectives.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
              {selected.stagePlan.length ? <div className="mt-4"><h3 className="text-sm font-bold text-stone-900">五阶段时间安排</h3><ol className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">{selected.stagePlan.map((stage) => <li className="rounded-lg border border-stone-200 bg-stone-50 p-3" key={stage.key}><span className="block text-xs font-bold text-stone-900">{stage.title}</span><span className="mt-1 block text-sm text-stone-600">{stage.minutes} 分钟</span></li>)}</ol></div> : null}
            </section>

            <section className="rounded-xl border border-stone-200 bg-white p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-bold text-stone-950">学生课堂页面 · {selected.pages.length} 页</h2>{selected.classroomId && selected.classroomAvailable ? <Button onClick={() => setShowPlayback((value) => !value)} type="button" variant="outline">{showPlayback ? "收起历史课堂" : "预览历史课堂"}</Button> : null}</div>
              {selected.timingAudit ? <p className="mt-3 text-sm text-stone-600">音频核查：{selected.timingAudit.source === "actual-audio" ? "实测" : "估算"} · {selected.timingAudit.measuredSegmentCount}/{selected.timingAudit.narrationSegmentCount} 段 · 知识讲授预算 {Math.round(selected.timingAudit.budgetSeconds / 60)} 分钟{selected.timingAudit.complete ? " · 已完成" : " · 未完成"}</p> : <p className="mt-3 text-sm text-stone-500">此版本尚未保存音频时长核查结果。</p>}
              {showPlayback && selected.classroomId ? <div className="mt-4 overflow-hidden rounded-lg border border-stone-200"><StudentStageHost backHref={backHref} classroomId={selected.classroomId} className="h-[min(820px,calc(100dvh-190px))] min-h-[520px]" mode="teacher-preview" variant="embedded" /></div> : null}
              {selected.pages.length ? <ol className="mt-4 max-h-80 divide-y divide-stone-100 overflow-y-auto rounded-lg border border-stone-200">{selected.pages.map((page, index) => <li className="flex items-start gap-3 px-3 py-2.5 text-sm" key={page.id}><span className="w-7 shrink-0 text-xs font-bold text-stone-400">{index + 1}</span><span className="min-w-0 flex-1 text-stone-800">{page.title}</span><span className="shrink-0 text-xs text-stone-500">{page.stageLabel}{page.seconds ? ` · ${duration(page.seconds)}` : ""}</span></li>)}</ol> : <p className="mt-4 text-sm text-stone-500">此版本尚未生成课堂页面。</p>}
            </section>
          </> : null}
        </div>
      </div> : null}
    </main>
  </DashboardShell>;
}

function VersionMetric({ icon, label, before, after }: { icon: React.ReactNode; label: string; before: string; after: string }) {
  return <div className="bg-white p-3"><p className="flex items-center gap-1.5 text-xs font-bold text-stone-600">{icon}{label}</p><p className="mt-2 text-sm font-bold text-stone-950">所选：{before}</p><p className="mt-1 text-xs text-stone-500">当前：{after}</p></div>;
}
