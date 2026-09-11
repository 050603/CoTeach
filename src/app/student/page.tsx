"use client";

import Link from "next/link";
import { LearningArt } from "@/components/platform/learning-art";
import { PlatformLoading, PlatformEmpty } from "@/components/platform/platform-feedback";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ArrowRight, Plus, Search } from "lucide-react";
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
  const [keyword, setKeyword] = useState("");
  const [filter, setFilter] = useState("all");
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
  const visibleCourses = (courses ?? []).filter(course =>
    (filter === "all" || course.status === filter) &&
    [course.name, course.teacher?.displayName, course.term].some(value => value?.toLowerCase().includes(keyword.trim().toLowerCase())));
  return (
    <StudentShell>
      <div className="pbl-student-dashboard">
      <header className="pbl-page-heading pbl-student-heading">
        <LearningArt />
        <div>
          <p className="text-xs tracking-widest text-[var(--pbl-student)]">我的学习</p>
          <h1 className="mt-3 text-3xl font-semibold">我的课程</h1>
        </div>
        <button
          className="inline-flex min-h-11 items-center gap-2 rounded-[6px] border border-[var(--pbl-border)] px-4 text-sm"
          onClick={() => setShowJoin(!showJoin)}
          aria-expanded={showJoin}
        >
          <Plus size={16} />加入课程
        </button>
      </header>
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
      {courses && courses.length > 0 && <section className="pbl-student-toolbar" aria-label="课程筛选">
        <div className="pbl-student-filters">{[["all", "全部课程"], ["open", "进行中"], ["finished", "已结束"]].map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}{value === "all" && <span>{courses.length}</span>}</button>)}</div>
        <label className="pbl-student-search"><Search size={18} aria-hidden="true"/><input aria-label="搜索课程" placeholder="搜索课程、教师或学期" value={keyword} onChange={event => setKeyword(event.target.value)}/></label>
      </section>}
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
        <PlatformEmpty title="尚未加入课程" description="使用课程邀请码加入后，课程大纲、课堂与作业将在这里呈现。" />
      ) : (
        <div className="pbl-student-course-grid">
          {visibleCourses.length === 0 && <div className="col-span-full"><PlatformEmpty title="没有找到匹配的课程" description="试试其他关键词，或切换到全部课程。" /><button className="min-h-11 text-sm text-[var(--pbl-student)]" onClick={() => { setKeyword(""); setFilter("all"); }}>清除筛选</button></div>}
          {visibleCourses.map((course) => {
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
                className="pbl-course-card pbl-student-course-card group"
              >
                <div className="pbl-student-card-media">
                <CourseCover
                  url={course.coverImageUrl}
                  name={course.name}
                  className="pbl-student-cover"
                />
                <span className="pbl-student-course-status" data-status={course.status}>{course.status === "finished" ? "已结束" : course.status === "open" ? "进行中" : "待开放"}</span>
                </div>
                <div className="pbl-student-course-copy">
                  <p className="text-xs text-[var(--pbl-text-muted)]">
                    {course.term ?? "课程系列"} ·{" "}
                    {course.teacher?.displayName ?? "任课教师待定"}
                  </p>
                  <h2 title={course.name}>
                    {course.name}
                  </h2>
                  <p className="pbl-student-course-description">{course.description || "暂无课程介绍"}</p>
                  <p className="pbl-student-course-date">
                    开课时间：{courseDate(course.startsAt)}
                  </p>
                  <div className="pbl-student-progress-track" role="progressbar" aria-label={`${course.name}完成进度`} aria-valuenow={completed} aria-valuemin={0} aria-valuemax={Math.max(tasks.length, 1)}><div className="h-full rounded-full bg-[var(--pbl-student)]" style={{ width: `${tasks.length ? completed / tasks.length * 100 : 0}%` }} /></div>
                  <div className="pbl-student-course-footer">
                    <span className="text-[var(--pbl-text-muted)]">
                      {course.chapters.length} 章 · 已完成 {completed}/
                      {tasks.length} 项
                    </span>
                    <span className="pbl-student-course-enter">{course.status === "finished" ? "回顾课程" : "进入课程"}<ArrowRight size={16}/></span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
      </div>
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
