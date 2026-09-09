"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ClipboardList,
  FileText,
  LockKeyhole,
  Play,
} from "lucide-react";
import { activityTypeLabel } from "@/lib/platform/labels";
import {
  CourseCover,
  StudentShell,
  courseDate,
  studentPrimary,
} from "@/components/platform/student-shell";

type Activity = {
  id: string;
  type: string;
  title: string;
  description: string | null;
  isOpen: boolean;
  progress: { status: string };
};
type Course = {
  id: string;
  name: string;
  description: string | null;
  outline?: string | null;
  referenceMaterials?: string | null;
  coverImageUrl?: string | null;
  term: string | null;
  startsAt: string | null;
  endsAt: string | null;
  status: string;
  teacher: { displayName: string } | null;
  chapters: Array<{
    id: string;
    title: string;
    description: string | null;
    isOpen: boolean;
    opensAt: string | null;
    activities: Activity[];
  }>;
};
const tabs = [
  { id: "chapters", label: "章节目录" },
  { id: "details", label: "课程详情" },
  { id: "outline", label: "课程大纲" },
  { id: "resources", label: "参考资料" },
] as const;
type Tab = (typeof tabs)[number]["id"];
function ActivityIcon({ type }: { type: string }) {
  const Icon =
    type.toLowerCase() === "classroom"
      ? Play
      : ["form", "quiz", "assignment"].includes(type.toLowerCase())
        ? ClipboardList
        : FileText;
  return <Icon size={17} />;
}

export default function StudentCoursePage() {
  const params = useParams<{ offeringId: string }>();
  const router = useRouter();
  const [course, setCourse] = useState<Course | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("chapters");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    fetch("/api/platform/courses", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          router.replace("/student/login");
          return;
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.message ?? "无法加载课程");
        const found = data.courses.find(
          (item: Course) => item.id === params.offeringId,
        );
        if (!found) throw new Error("你尚未加入该课程，或课程尚未开放。");
        if (active) {
          setCourse(found);
          setError(null);
        }
      })
      .catch((reason) => {
        if (active)
          setError(reason instanceof Error ? reason.message : "加载失败");
      });
    return () => {
      active = false;
    };
  }, [params.offeringId, router, retry]);
  if (error)
    return (
      <StudentShell>
        <p role="alert">{error}</p>
        <button
          className="mt-4 min-h-11 underline"
          onClick={() => setRetry(retry + 1)}
        >
          重新加载
        </button>
        <Link className="ml-6 text-sm underline" href="/student?all=1">
          返回我的课程
        </Link>
      </StudentShell>
    );
  if (!course)
    return (
      <StudentShell>
        <p
          role="status"
          className="py-20 text-center text-sm text-[var(--pbl-text-muted)]"
        >
          正在加载课程…
        </p>
      </StudentShell>
    );
  const activities = course.chapters.flatMap((chapter) => chapter.activities);
  const completed = activities.filter(
    (activity) => activity.progress.status === "completed",
  ).length;
  const accessible = course.chapters
    .filter((chapter) => chapter.isOpen)
    .flatMap((chapter) =>
      chapter.activities.filter((activity) => activity.isOpen),
    );
  const next =
    accessible.find((activity) => activity.progress.status === "in_progress") ??
    accessible.find((activity) => activity.progress.status !== "completed");
  const resources = course.chapters.flatMap((chapter) =>
    chapter.activities
      .filter((activity) => activity.type.toLowerCase() === "resource")
      .map((activity) => ({ chapter, activity })),
  );
  function taskRow(activity: Activity, open: boolean, index?: string) {
    return (
      <div className="flex min-h-16 items-center gap-3 border-t border-[var(--pbl-border)] px-4 py-3 md:px-6">
        <span className="text-[var(--pbl-text-muted)]">
          <ActivityIcon type={activity.type} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {index ? (
              <span className="mr-2 text-xs text-[var(--pbl-text-muted)]">
                {index}
              </span>
            ) : null}
            {activity.title}
          </p>
          <p className="mt-1 text-xs text-[var(--pbl-text-muted)]">
            {activityTypeLabel(activity.type)}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--pbl-text-muted)]">
          {!open ? (
            <>
              <LockKeyhole size={14} />
              未解锁
            </>
          ) : activity.progress.status === "completed" ? (
            <>
              <CheckCircle2 size={15} className="text-[var(--pbl-student)]" />
              已完成
            </>
          ) : activity.progress.status === "in_progress" ? (
            "继续学习"
          ) : (
            "未开始"
          )}
        </span>
        {open ? (
          <ArrowRight size={16} className="text-[var(--pbl-student)]" />
        ) : null}
      </div>
    );
  }
  return (
    <StudentShell>
      <Link
        href="/student?all=1"
        className="inline-flex min-h-11 items-center text-sm text-[var(--pbl-text-muted)]"
      >
        ← 我的课程
      </Link>
      <section className="pbl-student-course-hero mt-5 grid overflow-hidden md:grid-cols-[0.7fr_1.3fr]">
        <CourseCover
          url={course.coverImageUrl}
          name={course.name}
          className="min-h-60 md:min-h-80"
        />
        <div className="p-6 md:p-8">
          <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--pbl-text-muted)]">
            <span>{course.term ?? "课程系列"}</span>
            <span className="rounded-[6px] border border-[var(--pbl-border)] px-2 py-1">
              {course.status === "draft"
                ? "等待开课"
                : course.status === "finished"
                  ? "已结课"
                  : "开放学习"}
            </span>
          </div>
          <h1 className="mt-4 font-serif text-3xl font-semibold leading-snug">
            {course.name}
          </h1>
          <p className="mt-4 line-clamp-2 text-sm leading-7 text-[var(--pbl-text-muted)]">
            {course.description ||
              "围绕真实问题，按章节完成课堂学习与实践任务。"}
          </p>
          <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-xs text-[var(--pbl-text-muted)]">授课教师</dt>
              <dd className="mt-1.5">
                {course.teacher?.displayName ?? "待公布"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--pbl-text-muted)]">开课时间</dt>
              <dd className="mt-1.5">{courseDate(course.startsAt)}</dd>
            </div>
          </dl>
          {next ? (
            <Link
              href={`/student/activities/${next.id}`}
              className={`${studentPrimary} mt-6`}
            >
              {completed || next.progress.status === "in_progress"
                ? "继续学习"
                : "开始学习"}
              <ArrowRight size={16} />
            </Link>
          ) : (
            <p className="mt-6 text-sm text-[var(--pbl-student)]">
              {activities.length && completed === activities.length
                ? "已完成全部学习任务"
                : "下一项学习任务尚未开放"}
            </p>
          )}
        </div>
      </section>
      <div className="pbl-progress-strip mt-6 flex flex-wrap items-center gap-4 text-sm">
        <BookOpen size={19} className="text-[var(--pbl-student)]" />
        <span>{course.chapters.length} 个章节</span>
        <span className="text-[var(--pbl-text-muted)]">
          已完成 {completed} / {activities.length} 项学习任务
        </span>
        <div
          className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-[6px] bg-[var(--pbl-border)]"
          role="progressbar"
          aria-label="课程学习进度"
          aria-valuemin={0}
          aria-valuemax={activities.length || 1}
          aria-valuenow={completed}
        >
          <div
            className="h-full bg-[var(--pbl-student)]"
            style={{
              width: `${activities.length ? (completed / activities.length) * 100 : 0}%`,
            }}
          />
        </div>
      </div>
      <nav
        aria-label="课程内容"
        className="mt-6 flex gap-5 overflow-x-auto border-b border-[var(--pbl-border)] md:gap-8"
      >
        {tabs.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            aria-pressed={tab === item.id}
            className={`min-h-12 shrink-0 border-b-2 px-1 text-sm ${tab === item.id ? "border-[var(--pbl-student)] font-semibold text-[var(--pbl-student)]" : "border-transparent text-[var(--pbl-text-muted)]"}`}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <section
        aria-label={tabs.find((item) => item.id === tab)?.label}
        className="py-7"
      >
        {tab === "chapters" ? (
          <div className="space-y-5">
            {course.chapters.length === 0 ? (
              <p className="py-8 text-sm text-[var(--pbl-text-muted)]">
                教师正在安排章节，课程内容将在发布后显示。
              </p>
            ) : (
              course.chapters.map((chapter, index) => (
                <details
                  open
                  key={chapter.id}
                  className="overflow-hidden rounded-[10px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)]"
                >
                  <summary className="cursor-pointer px-5 py-5 marker:text-[var(--pbl-text-muted)]">
                    <span className="ml-1 text-xs text-[var(--pbl-text-muted)]">
                      第 {String(index + 1).padStart(2, "0")} 章
                    </span>
                    <span className="ml-4 font-serif text-lg font-semibold">
                      {chapter.title}
                    </span>
                    <span className="ml-4 text-xs text-[var(--pbl-text-muted)]">
                      {chapter.isOpen
                        ? `${chapter.activities.length} 项任务`
                        : chapter.opensAt
                          ? `${courseDate(chapter.opensAt)} 开放`
                          : "待教师解锁"}
                    </span>
                  </summary>
                  {chapter.description ? (
                    <p className="px-6 pb-4 text-sm leading-6 text-[var(--pbl-text-muted)]">
                      {chapter.description}
                    </p>
                  ) : null}
                  {chapter.activities.length ? (
                    chapter.activities.map((activity, taskIndex) =>
                      chapter.isOpen && activity.isOpen ? (
                        <Link
                          className="block transition-colors hover:bg-[var(--pbl-bg)]"
                          key={activity.id}
                          href={`/student/activities/${activity.id}`}
                        >
                          {taskRow(
                            activity,
                            true,
                            `${index + 1}.${taskIndex + 1}`,
                          )}
                        </Link>
                      ) : (
                        <div key={activity.id} aria-disabled="true">
                          {taskRow(
                            activity,
                            false,
                            `${index + 1}.${taskIndex + 1}`,
                          )}
                        </div>
                      ),
                    )
                  ) : (
                    <p className="border-t border-[var(--pbl-border)] px-6 py-5 text-sm text-[var(--pbl-text-muted)]">
                      本章节的任务尚未发布。
                    </p>
                  )}
                </details>
              ))
            )}
          </div>
        ) : tab === "details" ? (
          <div className="max-w-3xl">
            <h2 className="font-serif text-xl font-semibold">关于这门课程</h2>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-8 text-[var(--pbl-text-muted)]">
              {course.description || "教师尚未填写课程介绍。"}
            </p>
            <dl className="mt-8 grid gap-5 border-t border-[var(--pbl-border)] pt-6 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-[var(--pbl-text-muted)]">开课时间</dt>
                <dd className="mt-2">{courseDate(course.startsAt)}</dd>
              </div>
              <div>
                <dt className="text-[var(--pbl-text-muted)]">结课时间</dt>
                <dd className="mt-2">{courseDate(course.endsAt)}</dd>
              </div>
            </dl>
          </div>
        ) : tab === "outline" ? (
          <div className="max-w-3xl">
            <h2 className="font-serif text-xl font-semibold">课程大纲</h2>
            {course.outline ? (
              <p className="mt-4 whitespace-pre-wrap text-sm leading-8 text-[var(--pbl-text-muted)]">
                {course.outline}
              </p>
            ) : null}
            <ol className="mt-6 divide-y divide-[var(--pbl-border)]">
              {course.chapters.map((chapter, index) => (
                <li key={chapter.id} className="py-5">
                  <h3 className="font-semibold">
                    {index + 1}. {chapter.title}
                  </h3>
                  {chapter.description ? (
                    <p className="mt-2 text-sm leading-7 text-[var(--pbl-text-muted)]">
                      {chapter.description}
                    </p>
                  ) : null}
                  <p className="mt-2 text-xs text-[var(--pbl-text-muted)]">
                    {chapter.activities
                      .map((activity) => activityTypeLabel(activity.type))
                      .join(" · ") || "学习任务待发布"}
                  </p>
                </li>
              ))}
            </ol>
            {!course.outline && !course.chapters.length ? (
              <p className="mt-4 text-sm text-[var(--pbl-text-muted)]">
                课程大纲将在教师发布后显示。
              </p>
            ) : null}
          </div>
        ) : (
          <div>
            <h2 className="font-serif text-xl font-semibold">参考资料</h2>
            {course.referenceMaterials ? (
              <p className="mt-4 max-w-3xl whitespace-pre-wrap text-sm leading-8 text-[var(--pbl-text-muted)]">
                {course.referenceMaterials}
              </p>
            ) : null}
            {resources.length ? (
              <div className="mt-6 overflow-hidden rounded-[10px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)]">
                {resources.map(({ chapter, activity }) =>
                  chapter.isOpen && activity.isOpen ? (
                    <Link
                      key={activity.id}
                      href={`/student/activities/${activity.id}`}
                      className="block hover:bg-[var(--pbl-bg)]"
                    >
                      {taskRow(activity, true)}
                    </Link>
                  ) : (
                    <div key={activity.id} aria-disabled="true">
                      {taskRow(activity, false)}
                    </div>
                  ),
                )}
              </div>
            ) : !course.referenceMaterials ? (
              <p className="mt-4 text-sm text-[var(--pbl-text-muted)]">
                教师尚未添加参考资料。
              </p>
            ) : null}
          </div>
        )}
      </section>
    </StudentShell>
  );
}
