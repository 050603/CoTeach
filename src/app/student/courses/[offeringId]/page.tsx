"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  FileText,
  LockKeyhole,
  LoaderCircle,
  Play,
  Sparkles,
} from "lucide-react";
import { PraixisLogo } from "@/components/brand/praixis-logo";
import {
  CourseCover,
  courseDate,
  studentPrimary,
} from "@/components/platform/student-shell";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { activityTypeLabel } from "@/lib/platform/labels";
import { loadJSON, saveJSON } from "@/lib/session/storage";

type ActivityProgress = {
  status: string;
  startedAt?: string | null;
  completedAt?: string | null;
  lastAccessedAt?: string | null;
};

type Activity = {
  id: string;
  type: string;
  title: string;
  description: string | null;
  isOpen: boolean;
  progress: ActivityProgress;
};

type Chapter = {
  id: string;
  title: string;
  description: string | null;
  isOpen: boolean;
  opensAt: string | null;
  activities: Activity[];
};

type Course = {
  id: string;
  name: string;
  description: string | null;
  outline?: string | null;
  referenceMaterials?: string | null;
  courseReferences?: Array<{
    id: string;
    kind: "link" | "file";
    title: string;
    url: string;
    fileName?: string;
    fileSize?: string;
  }>;
  coverImageUrl?: string | null;
  term: string | null;
  startsAt: string | null;
  endsAt: string | null;
  status: string;
  teacher: { displayName: string } | null;
  chapters: Chapter[];
};

type CourseTask = {
  chapter: Chapter;
  chapterIndex: number;
  activity: Activity;
  taskIndex: number;
};

type Tab = "learning" | "intro" | "resources";

type ReminderReadState = {
  storageKey: string;
  reminders: string[];
};

const REMINDER_READ_STORAGE_PREFIX = "openpbl.course-reminders.read.v1";

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "learning", label: "课程学习" },
  { id: "intro", label: "课程介绍" },
  { id: "resources", label: "课程资料" },
];

function normalized(value?: string | null) {
  return value?.toLowerCase() ?? "";
}

function isCompleted(activity: Activity) {
  return normalized(activity.progress.status) === "completed";
}

function isInProgress(activity: Activity) {
  return normalized(activity.progress.status) === "in_progress";
}

function flattenTasks(course: Course): CourseTask[] {
  return course.chapters.flatMap((chapter, chapterIndex) =>
    chapter.activities.map((activity, taskIndex) => ({
      chapter,
      chapterIndex,
      activity,
      taskIndex,
    })),
  );
}

function findNextTask(course: Course) {
  const accessible = flattenTasks(course).filter(
    ({ chapter, activity }) => chapter.isOpen && activity.isOpen,
  );
  return (
    accessible.find(({ activity }) => isInProgress(activity)) ??
    accessible.find(({ activity }) => !isCompleted(activity))
  );
}

function reminderReadStorageKey(studentId: string, courseId: string): string {
  return `${REMINDER_READ_STORAGE_PREFIX}:${studentId}:${courseId}`;
}

function loadReadReminders(storageKey: string): string[] {
  const stored = loadJSON<unknown>(storageKey, []);
  return Array.isArray(stored)
    ? stored.filter((item): item is string => typeof item === "string")
    : [];
}

function ActivityIcon({ type }: { type: string }) {
  const value = normalized(type);
  const Icon =
    value === "classroom"
      ? Play
      : ["form", "quiz", "assignment"].includes(value)
        ? ClipboardList
        : FileText;
  return <Icon aria-hidden="true" size={16} />;
}

function CourseTopbar({
  courseId,
  studentId,
  viewerName,
  reminders,
}: {
  courseId: string;
  studentId: string;
  viewerName: string;
  reminders: string[];
}) {
  const initial = viewerName.trim().charAt(0) || "同";
  const storageKey = reminderReadStorageKey(studentId, courseId);
  const [readState, setReadState] = useState<ReminderReadState>({
    storageKey: "",
    reminders: [],
  });
  const readReminders = readState.storageKey === storageKey
    ? new Set(readState.reminders)
    : new Set<string>();
  const unreadCount = readState.storageKey === storageKey
    ? reminders.filter((reminder) => !readReminders.has(reminder)).length
    : 0;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Read receipts hydrate from browser storage after SSR.
    setReadState({ storageKey, reminders: loadReadReminders(storageKey) });

    function syncReadReminders(event: StorageEvent) {
      if (event.key !== storageKey) return;
      setReadState({ storageKey, reminders: loadReadReminders(storageKey) });
    }

    window.addEventListener("storage", syncReadReminders);
    return () => window.removeEventListener("storage", syncReadReminders);
  }, [storageKey]);

  function markRemindersRead(open: boolean) {
    if (!open || !reminders.length) return;
    const persisted = readState.storageKey === storageKey
      ? readState.reminders
      : loadReadReminders(storageKey);
    const next = Array.from(new Set([...persisted, ...reminders])).slice(-50);
    setReadState({ storageKey, reminders: next });
    saveJSON(storageKey, next);
  }

  return (
    <header className="pbl-student-course-topbar">
      <div className="pbl-student-course-topbar-inner">
        <div className="flex min-w-0 items-center gap-5">
          <Link href="/student" aria-label="PrAIxis 学生首页">
            <PraixisLogo variant="horizontalSolid" height={38} priority />
          </Link>
          <span className="h-5 w-px bg-[var(--pbl-border)]" aria-hidden="true" />
          <Link
            href="/student?all=1"
            className="inline-flex min-h-10 items-center gap-2 rounded-[10px] px-2 text-sm font-medium text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-surface-soft)] hover:text-[var(--pbl-text-strong)]"
          >
            <ArrowLeft size={17} />
            返回我的课程
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <Popover onOpenChange={markRemindersRead}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="pbl-course-reminder-trigger"
                aria-label={`课程提醒，共 ${unreadCount} 条`}
              >
                <Bell size={18} />
                {unreadCount ? (
                  <span aria-hidden="true">{unreadCount}</span>
                ) : null}
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={10}
              className="pbl-platform-theme pbl-course-reminder-popover"
            >
              <div className="flex items-center gap-2">
                <Sparkles size={16} className="text-[var(--pbl-student)]" />
                <h2 className="font-semibold text-[var(--pbl-text-strong)]">
                  课程提醒
                </h2>
              </div>
              <p className="mt-1.5 text-xs leading-5 text-[var(--pbl-text-muted)]">
                根据当前课程进度实时生成
              </p>
              {reminders.length ? (
                <ul className="mt-3 grid gap-2">
                  {reminders.map((reminder) => (
                    <li key={reminder} className="pbl-course-reminder-item">
                      {reminder}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 rounded-[10px] bg-[var(--pbl-student-soft)] p-3 text-sm text-[var(--pbl-student)]">
                  当前没有待处理的课程任务。
                </p>
              )}
            </PopoverContent>
          </Popover>
          <div className="pbl-student-viewer" aria-label={`当前学生：${viewerName}`}>
            <span aria-hidden="true">{initial}</span>
            <strong>{viewerName}</strong>
          </div>
        </div>
      </div>
    </header>
  );
}

function WorkspaceFrame({
  courseId = "pending",
  studentId = "pending",
  viewerName,
  reminders = [],
  children,
}: {
  courseId?: string;
  studentId?: string;
  viewerName: string;
  reminders?: string[];
  children: ReactNode;
}) {
  return (
    <main className="pbl-platform-theme pbl-platform-page-student pbl-student-course-workspace min-h-screen">
      <CourseTopbar courseId={courseId} studentId={studentId} viewerName={viewerName} reminders={reminders} />
      {children}
    </main>
  );
}

function CourseProgress({ completed, total }: { completed: number; total: number }) {
  const percentage = total ? Math.round((completed / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <span className="text-[13px] text-[var(--pbl-text-muted)]">学习进度</span>
          <p className="mt-1 text-[15px] font-medium text-[var(--pbl-text-strong)]">
            已完成 {completed} / {total} 项任务
          </p>
        </div>
        <strong className="text-xl text-[var(--pbl-student)]">{percentage}%</strong>
      </div>
      <div
        className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--pbl-border)]"
        role="progressbar"
        aria-label="课程学习进度"
        aria-valuemin={0}
        aria-valuemax={total || 1}
        aria-valuenow={completed}
      >
        <div
          className="h-full rounded-full bg-[var(--pbl-student)] transition-[width]"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

export default function StudentCoursePage() {
  const params = useParams<{ offeringId: string }>();
  const router = useRouter();
  const [course, setCourse] = useState<Course | null>(null);
  const [viewerId, setViewerId] = useState("pending");
  const [viewerName, setViewerName] = useState("同学");
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("learning");
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
        ) as Course | undefined;
        if (!found) throw new Error("你尚未加入该课程，或课程尚未开放。");
        if (!active) return;

        const next = findNextTask(found);
        const initiallyOpen =
          next?.chapter.id ??
          found.chapters.find((chapter) => chapter.isOpen)?.id ??
          found.chapters[0]?.id;
        setCourse(found);
        setViewerId(typeof data.viewer?.id === "string" ? data.viewer.id : "student");
        setViewerName(data.viewer?.displayName?.trim() || "同学");
        setExpanded(initiallyOpen ? new Set([initiallyOpen]) : new Set());
        setError(null);
      })
      .catch((reason) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "加载失败");
        }
      });
    return () => {
      active = false;
    };
  }, [params.offeringId, router, retry]);

  const tasks = useMemo(() => (course ? flattenTasks(course) : []), [course]);
  const completed = tasks.filter(({ activity }) => isCompleted(activity)).length;
  const nextTask = course ? findNextTask(course) : undefined;
  const courseFinished = course
    ? ["finished", "archived"].includes(normalized(course.status))
    : false;
  const allCompleted = tasks.length > 0 && completed === tasks.length;
  const lockedChapters = course?.chapters.filter((chapter) => !chapter.isOpen).length ?? 0;
  const reminders = useMemo(() => {
    if (!course) return [];
    if (allCompleted) return ["你已完成全部学习任务，可以查看学习记录。"];
    const items: string[] = [];
    if (nextTask) {
      items.push(
        `${isInProgress(nextTask.activity) ? "继续" : "下一项"}：${nextTask.activity.title}`,
      );
    } else if (courseFinished) {
      items.push("课程已经结束，当前可以查看已完成的学习记录。");
    } else {
      items.push("当前没有已开放且未完成的任务。");
    }
    if (lockedChapters) {
      items.push(`${lockedChapters} 个章节尚待教师解锁。`);
    }
    return items;
  }, [allCompleted, course, courseFinished, lockedChapters, nextTask]);

  if (error) {
    return (
      <WorkspaceFrame viewerName={viewerName}>
        <div className="pbl-student-course-state" role="alert">
          <div className="pbl-student-course-state-icon">
            <BookOpen size={24} />
          </div>
          <h1>课程加载失败</h1>
          <p>{error}</p>
          <button
            type="button"
            className={`${studentPrimary} mt-5`}
            onClick={() => setRetry((value) => value + 1)}
          >
            重新加载
          </button>
        </div>
      </WorkspaceFrame>
    );
  }

  if (!course) {
    return (
      <WorkspaceFrame viewerName={viewerName}>
        <div className="pbl-student-course-loading" role="status" aria-label="正在加载课程">
          <div className="pbl-student-course-summary-skeleton" />
          <div className="pbl-student-course-content-skeleton">
            <span />
            <span />
            <div />
            <div />
            <div />
          </div>
        </div>
      </WorkspaceFrame>
    );
  }

  function toggleChapter(chapterId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(chapterId)) next.delete(chapterId);
      else next.add(chapterId);
      return next;
    });
  }

  return (
    <WorkspaceFrame courseId={course.id} studentId={viewerId} viewerName={viewerName} reminders={reminders}>
      <div className="pbl-student-course-layout">
        <aside className="pbl-student-course-summary-wrap" aria-label="课程概览">
          <div className="pbl-student-course-summary">
            <CourseCover
              url={course.coverImageUrl}
              name={course.name}
              className="pbl-student-course-cover"
            />
            <div className="pbl-student-course-summary-body">
              <div className="flex items-center gap-2 text-[13px] text-[var(--pbl-text-muted)]">
                <span>{course.term || "当前学期"}</span>
                <span aria-hidden="true">·</span>
                <span>{course.teacher?.displayName || "教师待公布"}</span>
              </div>
              <h1>{course.name}</h1>
              <p className="pbl-student-course-summary-description">
                {course.description || "围绕真实问题，按章节完成课堂学习与实践任务。"}
              </p>
              <CourseProgress completed={completed} total={tasks.length} />

              {allCompleted ? (
                <div className="pbl-course-complete-state">
                  <CheckCircle2 size={20} />
                  <div>
                    <strong>课程学习已完成</strong>
                    <p>所有任务均已完成，可继续查看学习记录。</p>
                  </div>
                </div>
              ) : nextTask ? (
                <Link
                  href={`/student/activities/${nextTask.activity.id}`}
                  className={`${studentPrimary} mt-5 w-full`}
                >
                  {courseFinished
                    ? "查看学习记录"
                    : completed || isInProgress(nextTask.activity)
                      ? "继续学习"
                      : "开始学习"}
                  <ArrowRight size={16} />
                </Link>
              ) : (
                <div className="pbl-course-waiting-state">
                  <LockKeyhole size={17} />
                  {courseFinished ? "课程已结束" : "下一项学习任务尚未开放"}
                </div>
              )}

              {nextTask ? (
                <div className="pbl-student-next-task">
                  <span>{courseFinished ? "最近学习任务" : "下一项学习任务"}</span>
                  <strong title={nextTask.activity.title}>{nextTask.activity.title}</strong>
                  <p>
                    {activityTypeLabel(nextTask.activity.type)} · 第 {nextTask.chapterIndex + 1} 章 {nextTask.chapter.title}
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        </aside>

        <section className="pbl-student-course-main" aria-label="课程内容">
          <nav className="pbl-student-course-tabs" aria-label="课程内容导航">
            {tabs.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => setTab(item.id)}
                aria-pressed={tab === item.id}
                className={tab === item.id ? "is-active" : undefined}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {tab === "learning" ? (
            <div className="pbl-student-learning-panel">
              <header className="pbl-student-learning-heading">
                <div>
                  <h2>课程学习</h2>
                </div>
                <p>{course.chapters.length} 个章节 · {tasks.length} 项学习任务</p>
              </header>

              {course.chapters.length ? (
                <div className="pbl-student-chapter-list" role="list" aria-label="课程章节">
                  {course.chapters.map((chapter, chapterIndex) => {
                    const chapterCompleted = chapter.activities.filter(isCompleted).length;
                    const chapterPercentage = chapter.activities.length
                      ? Math.round((chapterCompleted / chapter.activities.length) * 100)
                      : 0;
                    const isExpanded = expanded.has(chapter.id);
                    return (
                      <article
                        key={chapter.id}
                        role="listitem"
                        className={`pbl-student-chapter${isExpanded ? " is-expanded" : ""}`}
                      >
                        <button
                          type="button"
                          className="pbl-student-chapter-heading"
                          onClick={() => toggleChapter(chapter.id)}
                          aria-expanded={isExpanded}
                          aria-controls={`chapter-${chapter.id}`}
                        >
                          <span className="pbl-student-chapter-index" aria-hidden="true">
                            <small>CHAPTER</small>
                            {String(chapterIndex + 1).padStart(2, "0")}
                          </span>
                          <span className="pbl-student-chapter-copy">
                            <strong title={chapter.title}>{chapter.title}</strong>
                            <small>{chapter.description || `${chapter.activities.length} 项学习任务`}</small>
                          </span>
                          <span className="pbl-student-chapter-overview">
                            <span className={chapter.isOpen ? "is-open" : "is-locked"}>
                              {!chapter.isOpen ? <LockKeyhole size={12} /> : null}
                              {chapter.isOpen ? "开放学习" : "尚未开放"}
                            </span>
                            <span className="pbl-student-chapter-progress-row">
                              <span>{chapterCompleted} / {chapter.activities.length}</span>
                              <span className="pbl-student-mini-progress" aria-hidden="true">
                                <i style={{ width: `${chapterPercentage}%` }} />
                              </span>
                              <span>{chapterPercentage}%</span>
                            </span>
                          </span>
                          <ChevronDown className="pbl-student-chapter-chevron" size={18} />
                        </button>

                        {isExpanded ? (
                          <div id={`chapter-${chapter.id}`} className="pbl-student-chapter-content">
                            {chapter.activities.length ? (
                              <div className="pbl-student-task-list" role="list" aria-label={`${chapter.title}学习任务`}>
                                {chapter.activities.map((activity, taskIndex) => {
                                  const isOpen = chapter.isOpen && activity.isOpen;
                                  const current = nextTask?.activity.id === activity.id;
                                  const row = (
                                    <div
                                      role="listitem"
                                      className={`pbl-student-task-row${current ? " is-current" : ""}${!isOpen ? " is-locked" : ""}`}
                                    >
                                      <span className="pbl-student-task-icon">
                                        <ActivityIcon type={activity.type} />
                                      </span>
                                      <span className="pbl-student-task-copy">
                                        <span>
                                          {chapterIndex + 1}.{taskIndex + 1} · {activityTypeLabel(activity.type)}
                                        </span>
                                        <strong title={activity.title}>{activity.title}</strong>
                                      </span>
                                      <span className={`pbl-student-task-state${isOpen && isInProgress(activity) ? " is-progress" : ""}`}>
                                        {!isOpen ? (
                                          <><LockKeyhole size={14} /> 未解锁</>
                                        ) : isCompleted(activity) ? (
                                          <><Check size={15} /> 已完成</>
                                        ) : isInProgress(activity) ? (
                                          <><LoaderCircle size={15} /> 进行中</>
                                        ) : (
                                          "未开始"
                                        )}
                                      </span>
                                      {isOpen ? <ArrowRight size={15} aria-hidden="true" /> : null}
                                    </div>
                                  );
                                  return isOpen ? (
                                    <Link key={activity.id} href={`/student/activities/${activity.id}`}>
                                      {row}
                                    </Link>
                                  ) : (
                                    <div key={activity.id} aria-disabled="true">{row}</div>
                                  );
                                })}
                              </div>
                            ) : (
                              <p className="pbl-student-chapter-empty">本章节的任务尚未发布。</p>
                            )}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="pbl-student-course-empty">
                  <BookOpen size={25} />
                  <h3>课程章节正在准备中</h3>
                  <p>教师发布章节后，完整学习路径会显示在这里。</p>
                </div>
              )}
            </div>
          ) : tab === "intro" ? (
            <div className="pbl-student-secondary-panel">
              <div className="pbl-student-secondary-copy">
                <span>ABOUT THE COURSE</span>
                <h2>课程介绍</h2>
                <p>{course.description || "教师尚未填写课程介绍。"}</p>
              </div>
              <dl className="pbl-student-course-meta">
                <div><dt>授课教师</dt><dd>{course.teacher?.displayName || "待公布"}</dd></div>
                <div><dt>课程学期</dt><dd>{course.term || "待公布"}</dd></div>
                <div><dt>开课时间</dt><dd>{courseDate(course.startsAt)}</dd></div>
                <div><dt>结课时间</dt><dd>{courseDate(course.endsAt)}</dd></div>
              </dl>
              <div className="pbl-student-outline">
                <h3>课程大纲</h3>
                {course.outline ? <p>{course.outline}</p> : null}
                <ol>
                  {course.chapters.map((chapter, index) => (
                    <li key={chapter.id}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <div>
                        <strong>{chapter.title}</strong>
                        {chapter.description ? <p>{chapter.description}</p> : null}
                      </div>
                    </li>
                  ))}
                </ol>
                {!course.outline && !course.chapters.length ? (
                  <p className="text-sm text-[var(--pbl-text-muted)]">课程大纲将在教师发布后显示。</p>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="pbl-student-secondary-panel">
              <div className="pbl-student-secondary-copy">
                <span>COURSE MATERIALS</span>
                <h2>课程资料</h2>
                <p>{course.referenceMaterials || "教师单独上传的课程参考资料会展示在这里。"}</p>
              </div>
              {course.courseReferences?.length ? (
                <div className="pbl-student-resource-list">
                  {course.courseReferences?.map((reference) => (
                    <a key={reference.id} href={reference.url} target="_blank" rel="noreferrer">
                      <div className="pbl-student-resource-row">
                        <span className="pbl-student-task-icon"><FileText size={16} /></span>
                        <div className="min-w-0 flex-1">
                          <strong title={reference.title}>{reference.title}</strong>
                          <p>{reference.kind === "file" ? `${reference.fileName || "PDF 文档"}${reference.fileSize ? ` · ${reference.fileSize}` : ""}` : "课程参考链接"}</p>
                        </div>
                        <span>{reference.kind === "file" ? "查看 PDF" : "打开链接"}</span>
                        <ArrowRight size={15} />
                      </div>
                    </a>
                  ))}
                </div>
              ) : (
                <div className="pbl-student-course-empty pbl-student-course-empty-compact">
                  <FileText size={23} />
                  <h3>暂无课程资料</h3>
                  <p>教师单独上传课程参考资料后会显示在这里。</p>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </WorkspaceFrame>
  );
}
