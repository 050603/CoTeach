"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  Clock3,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { DashboardShell } from "@/components/dashboard-shell";
import { CourseCard } from "@/components/course-card";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  PageState,
} from "@/components/ui";
import { useHydrated, useSession } from "@/lib/session/store";
import type { Course } from "@/lib/session/types";

type Filter = "all" | "preparing" | "ready" | "teaching" | "finished";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "preparing", label: "备课中" },
  { key: "ready", label: "待开课" },
  { key: "teaching", label: "授课中" },
  { key: "finished", label: "已结束" },
];

function isPreparing(course: Course) {
  return course.status === "draft" || course.status === "preparing";
}
function matches(course: Course, filter: Filter) {
  if (filter === "all") return true;
  if (filter === "preparing") return isPreparing(course);
  return course.status === filter;
}

export default function TeacherHomePage() {
  const session = useSession();
  const hydrated = useHydrated();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [nameOpen, setNameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(session.user.name);
  const [creating, setCreating] = useState(false);

  function createAndOpenProject() {
    if (creating) return;
    setCreating(true);
    try {
      const course = session.createCourse({});
      router.push(`/teacher/prepare/${course.id}/verify`);
    } finally {
      // 创建失败时也要重置，避免按钮卡住
      setTimeout(() => setCreating(false), 500);
    }
  }

  const sorted = useMemo(
    () => [...session.courses].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [session.courses],
  );
  const courses = useMemo(
    () =>
      sorted.filter(
        (course) =>
          matches(course, filter) &&
          (!query.trim() ||
            `${course.name}${course.subject}${course.grade}`
              .toLowerCase()
              .includes(query.trim().toLowerCase())),
      ),
    [sorted, filter, query],
  );

  const active = sorted.filter((course) => course.status === "teaching");
  const unfinished = sorted.filter(isPreparing);
  const finished = sorted.filter((course) => course.status === "finished");

  return (
    <DashboardShell
      currentTask="处理当前课堂与备课任务"
      leadRole="教师"
      role="teacher"
      userName={session.user.name}
      variant="bare"
    >
      <div className="pbl-dashboard-container px-4 pb-12 pt-6 md:px-6">
        {/* ===== Hero 区 ===== */}
        <section className="pbl-aurora-light relative mb-6 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)]">
          <div className="pbl-aurora" />
          <div className="pbl-grid-light" />

          <div className="relative z-10 grid gap-6 p-6 md:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)] lg:gap-8">
            {/* 左：欢迎语 + 主操作 */}
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-[var(--pbl-border-strong)] bg-white/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--pbl-text-muted)] backdrop-blur-sm">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--pbl-teacher)] opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--pbl-teacher)]" />
                </span>
                教师工作台
              </div>
              <h1 className="mt-4 text-[length:clamp(1.75rem,3.6vw,2.5rem)] font-extrabold leading-[1.1] tracking-tight text-[var(--pbl-text-strong)]">
                欢迎回来，<span className="pbl-display-gradient">{session.user.name}</span>
              </h1>

              {/* 主操作按钮组 */}
              <div className="mt-5 flex flex-wrap items-center gap-2.5">
                <button
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-xs)] bg-[var(--pbl-teacher)] px-5 text-sm font-semibold text-white shadow-[0_4px_14px_rgba(29,78,216,0.25)] transition hover:-translate-y-0.5 hover:bg-[var(--pbl-teacher-hover)] hover:shadow-[0_8px_22px_rgba(29,78,216,0.35)] disabled:opacity-60"
                  disabled={creating}
                  onClick={createAndOpenProject}
                  type="button"
                >
                  <Plus size={17} /> 创建项目课程
                </button>
                <Link
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-xs)] border border-[var(--pbl-border-strong)] bg-white px-4 text-sm font-semibold text-[var(--pbl-text)] transition hover:-translate-y-0.5 hover:border-[var(--pbl-teacher-border)] hover:text-[var(--pbl-teacher)] hover:shadow-md"
                  href="/teacher/settings"
                >
                  <Sparkles size={15} /> AI 设置
                </Link>
                <Link
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-xs)] border border-indigo-200 bg-indigo-50 px-4 text-sm font-semibold text-indigo-700 transition hover:-translate-y-0.5 hover:bg-indigo-100"
                  href="/teacher/classes"
                >
                  教学班编排
                </Link>
              </div>
            </div>

            {/* 右：3 个指标卡片（移除介入提醒，仅保留状态统计） */}
            <div className="grid grid-cols-3 gap-2.5 self-center">
              <StatCard
                icon={<BookOpen size={15} />}
                label="授课中"
                value={active.length}
                tone="teacher"
              />
              <StatCard
                icon={<Clock3 size={15} />}
                label="备课中"
                value={unfinished.length}
                tone="warning"
              />
              <StatCard
                icon={<CheckCircle2 size={15} />}
                label="已结束"
                value={finished.length}
                tone="muted"
              />
            </div>
          </div>
        </section>

        {/* ===== 课程区 ===== */}
        <section>
          {/* 工具条 */}
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-editorial text-xl font-semibold text-[var(--pbl-text-strong)]">
                我的课程
              </h2>
              <p className="mt-0.5 text-[12px] text-[var(--pbl-text-muted)]">
                共 {sorted.length} 个课程
              </p>
            </div>
            <label className="relative">
              <Search
                aria-hidden="true"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--pbl-text-muted)]"
                size={15}
              />
              <Input
                aria-label="搜索课程"
                className="h-10 pl-9 sm:w-64"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索课程 / 学科 / 年级"
                value={query}
              />
            </label>
          </div>

          {/* Inline 筛选 chips */}
          <nav
            aria-label="课程筛选"
            className="mb-5 flex flex-wrap gap-1.5"
          >
            {FILTERS.map((item) => {
              const count =
                item.key === "all"
                  ? sorted.length
                  : item.key === "preparing"
                    ? unfinished.length
                    : sorted.filter((c) => c.status === item.key).length;
              const isActive = filter === item.key;
              return (
                <button
                  aria-current={isActive ? "page" : undefined}
                  className={`inline-flex min-h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition ${
                    isActive
                      ? "bg-[var(--pbl-teacher)] text-white shadow-[0_2px_8px_rgba(29,78,216,0.2)]"
                      : "border border-[var(--pbl-border)] bg-[var(--pbl-surface)] text-[var(--pbl-text-muted)] hover:border-[var(--pbl-teacher-border)] hover:text-[var(--pbl-teacher)]"
                  }`}
                  key={item.key}
                  onClick={() => setFilter(item.key)}
                  type="button"
                >
                  {item.label}
                  <span
                    className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold ${
                      isActive ? "bg-white/25 text-white" : "bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-subtle)]"
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </nav>

          {/* 课程列表 */}
          {!hydrated ? (
            <PageState description="正在读取课程档案。" title="加载课程" />
          ) : courses.length ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {courses.map((course) => (
                <CourseCard course={course} key={course.id} />
              ))}
            </div>
          ) : (
            <PageState
              action={
                <button
                  className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-xs)] bg-[var(--pbl-teacher)] px-5 text-sm font-semibold text-white transition hover:bg-[var(--pbl-teacher-hover)] disabled:opacity-60"
                  disabled={creating}
                  onClick={createAndOpenProject}
                  type="button"
                >
                  <Plus size={16} /> 创建第一个项目
                </button>
              }
              description="可以调整筛选条件，或从一个真实问题开始创建课程。"
              title="这里还没有匹配的课程"
            />
          )}
        </section>
      </div>
      <Dialog onOpenChange={setNameOpen} open={nameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>修改教师姓名</DialogTitle>
            <DialogDescription>姓名将显示在导学、介入和评价确认记录中。</DialogDescription>
          </DialogHeader>
          <FormField label="显示姓名">
            {({ id }) => (
              <Input autoFocus id={id} onChange={(event) => setNameDraft(event.target.value)} value={nameDraft} />
            )}
          </FormField>
          <DialogFooter>
            <Button onClick={() => setNameOpen(false)} variant="secondary">取消</Button>
            <Button
              disabled={!nameDraft.trim()}
              onClick={() => {
                session.setUser({ role: "teacher", name: nameDraft.trim() });
                setNameOpen(false);
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardShell>
  );
}

/* ===== 子组件 ===== */

function StatCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: "teacher" | "warning" | "muted";
}) {
  const toneMap = {
    teacher: {
      bg: "bg-[var(--pbl-teacher-soft)]",
      text: "text-[var(--pbl-teacher)]",
      ring: "ring-[var(--pbl-teacher-border)]",
    },
    warning: {
      bg: "bg-[var(--pbl-warning-soft)]",
      text: "text-[var(--pbl-warning)]",
      ring: "ring-[var(--pbl-warning-border)]",
    },
    muted: {
      bg: "bg-[var(--pbl-surface-soft)]",
      text: "text-[var(--pbl-text-muted)]",
      ring: "ring-[var(--pbl-border)]",
    },
  }[tone];

  return (
    <div className="group relative overflow-hidden rounded-[var(--radius-sm)] border border-[var(--pbl-border)] bg-white/80 p-3 backdrop-blur-sm transition hover:-translate-y-0.5 hover:border-[var(--pbl-border-strong)] hover:shadow-md">
      <div className="flex items-center gap-1.5">
        <span className={`grid h-6 w-6 place-items-center rounded-[var(--radius-xs)] ring-1 ${toneMap.bg} ${toneMap.text} ${toneMap.ring}`}>
          {icon}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--pbl-text-muted)]">
          {label}
        </span>
      </div>
      <div className="mt-2">
        <span className={`text-[22px] font-extrabold leading-none ${toneMap.text}`}>{value}</span>
      </div>
    </div>
  );
}
