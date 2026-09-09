"use client";

import Link from "next/link";
import { LearningArt } from "@/components/platform/learning-art";
import { PlatformLoading, PlatformEmpty } from "@/components/platform/platform-feedback";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ArrowRight, Plus } from "lucide-react";
import {
  CourseCover,
  StudentShell,
  courseDate,
  studentInput,
  studentPrimary,
} from "@/components/platform/student-shell";

type PlatformCourse = {
  id: string;
  name: string;
  description: string | null;
  coverImageUrl: string | null;
  startsAt: string | null;
  term: string | null;
  status?: string;
  teacher: { displayName: string } | null;
  chapters: Array<{ isOpen?: boolean; activities: Array<{ id?: string; title?: string; isOpen?: boolean; progress: { status: string; lastAccessedAt?: string | null } }> }>;
};

function StudentEntryPageContent() {
  const router = useRouter();
  const search = useSearchParams();
  const showAll = search.get("all") === "1";
  const [courses, setCourses] = useState<PlatformCourse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [invite, setInvite] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [showJoin, setShowJoin] = useState(false);
  useEffect(() => {
    let active = true;
    fetch("/api/platform/courses", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) {
          router.replace("/student/login");
          return;
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.message ?? "课程加载失败");
        if (!active) return;
        if (data.courses.length === 1 && !showAll) {
          router.replace(`/student/courses/${data.courses[0].id}`);
          return;
        }
        setCourses(data.courses);
        setError(null);
      })
      .catch(() => {
        if (active) setError("暂时无法加载课程，请重试。");
      });
    return () => {
      active = false;
    };
  }, [router, showAll, retry]);
  async function join(event: React.FormEvent) {
    event.preventDefault();
    if (joining) return;
    setJoining(true);
    setJoinError(null);
    try {
      const response = await fetch("/api/platform/auth/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationCode: invite }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "加入失败");
      router.push(
        `/student/courses/${data.offeringId ?? data.enrollment?.offeringId}`,
      );
    } catch (reason) {
      setJoinError(
        reason instanceof Error ? reason.message : "网络错误，请重试",
      );
    } finally {
      setJoining(false);
    }
  }
  const availableTasks = (courses ?? []).filter(course => course.status === "open").flatMap(course =>
    course.chapters.filter(chapter => chapter.isOpen).flatMap(chapter => chapter.activities
      .filter(task => task.id && task.isOpen && !["completed", "submitted"].includes(task.progress.status))
      .map(task => ({ ...task, courseName: course.name }))));
  const continuing = availableTasks.filter(task => task.progress.status === "in_progress")
    .sort((a, b) => (Date.parse(b.progress.lastAccessedAt ?? "") || 0) - (Date.parse(a.progress.lastAccessedAt ?? "") || 0))[0] ?? availableTasks[0];
  return (
    <StudentShell>
      <header className="pbl-page-heading"><LearningArt />
        <div>
          <p className="text-xs tracking-widest text-[var(--pbl-student)]">
            我的学习
          </p>
          <h1 className="mt-3 font-serif text-3xl font-semibold">我的课程</h1>
          <p className="mt-3 text-sm text-[var(--pbl-text-muted)]">
            选择课程，查看章节安排并继续学习。
          </p>
        </div>
        <button
          className="inline-flex min-h-11 items-center gap-2 rounded-[6px] border border-[var(--pbl-border)] px-4 text-sm"
          onClick={() => setShowJoin(!showJoin)}
          aria-expanded={showJoin}
        >
          <Plus size={16} />
          加入课程
        </button>
      </header>
      {courses && courses.length > 0 && <section className="pbl-learning-overview" aria-label="学习概况"><div><p className="text-xs font-semibold text-[var(--pbl-student)]">每一步，都在积累</p><h2 className="mt-2 text-xl font-semibold">{continuing?.title ?? "今天，也向前一步"}</h2><p className="mt-3 text-sm leading-7 text-[var(--pbl-text-muted)]">{continuing ? `${continuing.courseName} · 接续你的学习任务` : "从课程目录找到下一项任务，继续你的探索。"}</p>{continuing && <Link className={`${studentPrimary} mt-4`} href={`/student/activities/${continuing.id}`}>{continuing.progress.status === "in_progress" ? "继续学习" : "开始下一项任务"}<ArrowRight size={16}/></Link>}</div><dl className="flex gap-8"><div><dt className="text-xs text-[var(--pbl-text-muted)]">已加入课程</dt><dd className="mt-3 text-3xl font-semibold tabular-nums">{courses.length}</dd></div><div><dt className="text-xs text-[var(--pbl-text-muted)]">已完成任务</dt><dd className="mt-3 text-3xl font-semibold tabular-nums">{courses.reduce((sum, course) => sum + course.chapters.flatMap(chapter => chapter.activities).filter(task => task.progress.status === "completed").length, 0)}</dd></div></dl></section>}
      {showJoin || courses?.length === 0 ? (
        <form
          onSubmit={join}
          className="mt-7 rounded-[10px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-5"
        >
          <h2 className="font-semibold">使用邀请码加入课程</h2>
          <div className="mt-3 flex flex-col items-start gap-3 sm:flex-row sm:items-end">
            <label className="w-full max-w-sm text-sm">
              课程邀请码
              <input
                required
                value={invite}
                onChange={(event) =>
                  setInvite(event.target.value.toUpperCase())
                }
                className={studentInput}
                placeholder="输入教师提供的邀请码"
              />
            </label>
            <button
              disabled={joining || !invite.trim()}
              className={studentPrimary}
            >
              {joining ? "加入中…" : "加入并查看课程"}
            </button>
          </div>
          {joinError ? (
            <p role="alert" className="mt-3 text-sm text-[var(--pbl-danger)]">
              {joinError}
            </p>
          ) : null}
        </form>
      ) : null}
      {error ? (
        <div role="alert" className="mt-10">
          <p>{error}</p>
          <button
            className="mt-3 min-h-11 underline"
            onClick={() => setRetry(retry + 1)}
          >
            重新加载
          </button>
        </div>
      ) : courses === null ? (
        <PlatformLoading label="正在打开学习空间…" />
      ) : courses.length === 0 ? (
        <PlatformEmpty title="学习旅程，即将开始" description="你还没有加入课程。加入后，课程大纲、课堂与作业将在这里呈现。" />
      ) : (
        <div className="mt-9 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {courses.map((course) => {
            const tasks = course.chapters.flatMap(
              (chapter) => chapter.activities,
            );
            const completed = tasks.filter(
              (task) => task.progress.status === "completed",
            ).length;
            return (
              <Link
                key={course.id}
                href={`/student/courses/${course.id}`}
                className="pbl-course-card group transition-colors hover:border-[var(--pbl-student)]"
              >
                <CourseCover
                  url={course.coverImageUrl}
                  name={course.name}
                  className="h-48"
                />
                <div className="p-5">
                  <p className="text-xs text-[var(--pbl-text-muted)]">
                    {course.term ?? "课程系列"} ·{" "}
                    {course.teacher?.displayName ?? "任课教师待定"}
                  </p>
                  <h2 className="mt-3 font-serif text-xl font-semibold">
                    {course.name}
                  </h2>
                  <p className="mt-3 text-xs text-[var(--pbl-text-muted)]">
                    开课时间：{courseDate(course.startsAt)}
                  </p>
                  <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-[var(--pbl-student-soft)]" role="progressbar" aria-label={`${course.name}完成进度`} aria-valuenow={completed} aria-valuemin={0} aria-valuemax={Math.max(tasks.length, 1)}><div className="h-full rounded-full bg-[var(--pbl-student)]" style={{ width: `${tasks.length ? completed / tasks.length * 100 : 0}%` }} /></div>
                  <div className="mt-5 flex items-center justify-between border-t border-[var(--pbl-border)] pt-4 text-sm">
                    <span className="text-[var(--pbl-text-muted)]">
                      {course.chapters.length} 章 · 已完成 {completed}/
                      {tasks.length} 项
                    </span>
                    <ArrowRight
                      size={18}
                      className="text-[var(--pbl-student)]"
                    />
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </StudentShell>
  );
}

export default function StudentEntryPage() {
  return (
    <Suspense
      fallback={
        <main className="grid min-h-screen place-items-center bg-[var(--pbl-bg)] text-sm text-[var(--pbl-text-muted)]">
          <p role="status">正在打开学习空间…</p>
        </main>
      }
    >
      <StudentEntryPageContent />
    </Suspense>
  );
}
