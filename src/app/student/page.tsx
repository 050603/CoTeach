"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  KeyRound,
  Play,
  RotateCcw,
} from "lucide-react";
import { DashboardShell } from "@/components/dashboard-shell";
import { JoinClassForm } from "@/components/join-class-form";
import { useSession, useHydrated } from "@/lib/session/store";
import { clientUUID } from "@/lib/uuid";

type PlatformCourse = {
  id: string;
  name: string;
  term: string | null;
  status: string;
  teacher: { displayName: string };
  chapters: Array<{ activities: Array<{ type: string; progress: { status: string } }> }>;
};

export default function StudentEntryPage() {
  const router = useRouter();
  const { joinClass, rejoinClass, user, studentName, joinedCourseId, courses, getLeftClassHistory, refresh } = useSession();
  const hydrated = useHydrated();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [platformCourses, setPlatformCourses] = useState<PlatformCourse[]>([]);
  const [platformReady, setPlatformReady] = useState(false);
  const [platformInvite, setPlatformInvite] = useState("");
  const [platformInviteError, setPlatformInviteError] = useState<string | null>(null);
  const [platformInviteBusy, setPlatformInviteBusy] = useState(false);

  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    fetch("/api/platform/courses", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as { courses?: PlatformCourse[] };
        if (active) {
          setPlatformCourses(data.courses ?? []);
          // An authenticated account with zero enrollments still belongs on
          // the long-lived "我的课程" page so it can join another class. The
          // legacy join form is only the fallback when this platform API is
          // unavailable or the visitor is not signed in.
          setPlatformReady(true);
        }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [hydrated]);

  const joinedCourse = joinedCourseId
    ? courses.find((c) => c.id === joinedCourseId)
    : undefined;

  const leftHistory = hydrated ? getLeftClassHistory() : [];

  async function handleJoin(code: string, name: string) {
    setError(undefined);
    setBusy(true);
    try {
      const response = await fetch("/api/auth/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: clientUUID(),
          inviteCode: code,
          studentName: name,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        user?: { courseId?: string };
      };
      if (response.ok && data.user?.courseId) {
        await refresh("student");
        router.replace(`/student/classroom/${data.user.courseId}`);
        return;
      }
      if (data.error !== "AUTH_NOT_CONFIGURED") {
        setError(
          data.error === "INVITE_CODE_INVALID"
            ? "邀请码无效，或教师尚未开始授课"
            : data.message ?? "加入失败，请稍后重试",
        );
        return;
      }

      const result = joinClass(code, name);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      router.replace(`/student/classroom/${result.course.id}`);
    } catch (error) {
      console.error("[student] join failed:", error);
      setError("网络异常，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  function handleRejoin(record: { courseId: string; courseName: string; studentId: string; studentName: string; leftAt: string }) {
    setError(undefined);
    setBusy(true);
    const result = rejoinClass(record);
    setBusy(false);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    router.replace(`/student/classroom/${result.course.id}`);
  }

  async function joinPlatformCourse() {
    if (!platformInvite.trim() || platformInviteBusy) return;
    setPlatformInviteBusy(true); setPlatformInviteError(null);
    try {
      const response = await fetch("/api/platform/auth/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invitationCode: platformInvite }) });
      const data = await response.json();
      if (!response.ok) { setPlatformInviteError(data.message ?? "邀请码无效"); return; }
      const refreshed = await fetch("/api/platform/courses", { cache: "no-store" });
      if (refreshed.ok) setPlatformCourses((await refreshed.json()).courses ?? []);
      setPlatformInvite("");
    } catch { setPlatformInviteError("网络错误，请稍后重试"); } finally { setPlatformInviteBusy(false); }
  }

  if (hydrated && platformReady) {
    return <PlatformCourseHome courses={platformCourses} inviteCode={platformInvite} inviteError={platformInviteError} inviteBusy={platformInviteBusy} onInviteCodeChange={setPlatformInvite} onJoin={() => void joinPlatformCourse()} />;
  }

  return (
    <DashboardShell
      role="student"
      userName={joinedCourse ? (studentName ?? user.name) : undefined}
      variant="bare"
    >
      <div className="pbl-content-container px-4 pb-12 pt-6 md:px-6 md:pt-10">
        {/* 页面标题 */}
        <header className="mb-6 text-center">
          <h1 className="text-[length:clamp(1.625rem,3.4vw,2.25rem)] font-extrabold leading-tight tracking-tight text-[var(--pbl-text-strong)]">
            <span className="pbl-display-gradient">加入项目式课堂</span>
          </h1>
          <p className="mt-2 text-[14px] text-[var(--pbl-text-muted)]">
            输入教师提供的邀请码，开始你的项目学习
          </p>
          <div className="mt-3 flex justify-center gap-3 text-xs">
            <Link className="font-semibold text-indigo-600 hover:underline" href="/student/login">学生登录</Link>
            <span className="text-[var(--pbl-border-strong)]">·</span>
            <Link className="font-semibold text-indigo-600 hover:underline" href="/student/register">注册长期账号</Link>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,27.5rem)_minmax(0,1fr)] lg:gap-8">
            {/* 左：邀请码加入卡片 */}
            <section className="space-y-4">
              {joinedCourse?.status === "teaching" ? (
                <AvailableClassCard
                  course={joinedCourse}
                  onReturn={() => router.replace(`/student/classroom/${joinedCourse.id}`)}
                  studentName={studentName ?? user.name}
                />
              ) : null}

              {/* 快速重新加入 */}
              {leftHistory.length > 0 ? (
                <div className="rounded-[var(--radius-lg)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-4 shadow-[var(--shadow-soft)]">
                  <div className="mb-3 flex items-center gap-2">
                    <span className="grid h-6 w-6 place-items-center rounded-[var(--radius-xs)] bg-[var(--pbl-student-soft)] text-[var(--pbl-student)]">
                      <RotateCcw size={12} />
                    </span>
                    <span className="text-[13px] font-bold text-[var(--pbl-text-strong)]">快速重新加入</span>
                  </div>
                  <div className="space-y-1.5">
                    {leftHistory.map((record) => (
                      <button
                        key={record.courseId}
                        className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--pbl-border)] bg-white p-3 text-left transition hover:-translate-y-0.5 hover:border-[var(--pbl-student-border)] hover:bg-[var(--pbl-student-soft)]/40 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={busy}
                        onClick={() => handleRejoin(record)}
                        type="button"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-bold text-[var(--pbl-text-strong)]">{record.courseName}</div>
                          <div className="mt-0.5 truncate text-[11px] text-[var(--pbl-text-muted)]">
                            以 <span className="font-semibold text-[var(--pbl-text)]">{record.studentName}</span> 身份重新加入
                          </div>
                        </div>
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--pbl-student)] text-white">
                          <ArrowRight size={13} />
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="mt-3 border-t border-[var(--pbl-border)] pt-2.5 text-center text-[11px] text-[var(--pbl-text-subtle)]">
                    或使用邀请码加入新课堂 ↓
                  </div>
                </div>
              ) : null}

              {/* 邀请码表单 */}
              <div className="relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] shadow-[var(--shadow-floating)]">
                {/* 顶部装饰条 */}
                <div className="h-1 w-full bg-gradient-to-r from-[var(--pbl-teacher)] via-[var(--pbl-ai)] to-[var(--pbl-student)]" />
                <div className="p-5 md:p-7">
                  <JoinClassForm
                    busy={busy}
                    errorMessage={error}
                    onSubmit={handleJoin}
                    variant="bare"
                  />
                </div>
              </div>

              {/* 底部辅助链接 */}
              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-[11px] text-[var(--pbl-text-muted)]">
                <Link
                  className="inline-flex items-center gap-1 transition hover:text-[var(--pbl-student)]"
                  href="/"
                >
                  <ArrowLeft size={12} /> 返回首页
                </Link>
                <span className="text-[var(--pbl-border-strong)]">|</span>
                <span className="inline-flex items-center gap-1">
                  <KeyRound size={12} /> 没有邀请码？请向任课教师索取
                </span>
              </div>
            </section>

            {/* 右：使用说明（粉色信息条） */}
            <aside>
              <div className="rounded-[var(--radius-lg)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-5 shadow-[var(--shadow-soft)] md:p-6">
                <div className="mb-4 flex items-center gap-2">
                  <span className="h-3 w-0.5 rounded-full bg-[var(--pbl-student)]" />
                  <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--pbl-text-strong)]">
                    使用说明
                  </h2>
                </div>
                <p className="mb-4 text-[12px] leading-5 text-[var(--pbl-text-muted)]">
                  第一次使用本系统？按下面 4 步即可开始你的项目学习之旅。
                </p>

                <ol className="space-y-2.5 2xl:grid 2xl:grid-cols-2 2xl:gap-3 2xl:space-y-0">
                  <InstructionStep
                    step={1}
                    title="向教师索取邀请码"
                    desc="任课教师会提供 6 位字母数字组合的邀请码，例如 A2K9QP。"
                  />
                  <InstructionStep
                    step={2}
                    title="填写邀请码和姓名"
                    desc="在左侧表单中输入邀请码（不区分大小写）和你自己的姓名。"
                  />
                  <InstructionStep
                    step={3}
                    title="点击进入课堂"
                    desc="提交后即加入教师正在授课的项目课堂，开始本轮学习。"
                  />
                  <InstructionStep
                    step={4}
                    title="跟随 AI 老师完成项目"
                    desc="跟随教师完成五阶段课堂，在知识讲授中分节学习、完成小测，并在项目实践工作台完成自己的文档或代码成果。"
                  />
                </ol>

                <div className="mt-5 rounded-[var(--radius-sm)] border border-dashed border-[var(--pbl-border-strong)] bg-[var(--pbl-surface-soft)]/60 p-3.5">
                  <p className="text-[11px] font-semibold text-[var(--pbl-text-strong)]">提示</p>
                  <p className="mt-1 text-[11px] leading-5 text-[var(--pbl-text-muted)]">
                    课堂进行中如意外退出，可使用“快速重新加入”功能回到上次离开的课堂，无需重新输入邀请码。
                  </p>
                </div>
              </div>
            </aside>
        </div>
      </div>
    </DashboardShell>
  );
}

function PlatformCourseHome({ courses, inviteCode, inviteError, inviteBusy, onInviteCodeChange, onJoin }: { courses: PlatformCourse[]; inviteCode: string; inviteError: string | null; inviteBusy: boolean; onInviteCodeChange: (value: string) => void; onJoin: () => void }) {
  return <main className="min-h-screen bg-[var(--pbl-bg)] px-5 py-10 text-[var(--pbl-text)]"><div className="mx-auto max-w-4xl"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">学生学习空间</p><h1 className="mt-2 text-3xl font-bold">我的课程</h1><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">登录后继续跨章节、跨课堂的学习进度。</p></div><Link className="text-sm text-[var(--pbl-text-muted)]" href="/student">返回学生入口</Link></div>{courses.length ? <div className="mt-8 grid gap-4 md:grid-cols-2">{courses.map((course) => { const activities = course.chapters.flatMap((chapter) => chapter.activities).filter((activity) => activity.type === "Classroom"); const completed = activities.filter((activity) => activity.progress.status === "completed").length; return <Link className="rounded-xl border border-[var(--pbl-border)] bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-300" href={`/student/courses/${course.id}`} key={course.id}><div className="flex items-start justify-between gap-3"><h2 className="font-bold">{course.name}</h2><span className="text-xs font-semibold text-emerald-600">{course.status === "finished" ? "已结课" : "进行中"}</span></div><p className="mt-2 text-xs text-[var(--pbl-text-muted)]">{course.term ?? "教学班"} · {course.teacher.displayName}</p><div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-500" style={{ width: `${activities.length ? completed / activities.length * 100 : 0}%` }} /></div><p className="mt-2 text-xs text-[var(--pbl-text-muted)]">{activities.length ? `${completed}/${activities.length} 个课堂活动已完成` : "暂无可统计课堂活动"}</p></Link>; })}</div> : <p className="mt-8 rounded-xl border border-dashed border-[var(--pbl-border)] bg-white p-8 text-sm text-[var(--pbl-text-muted)]">你还没有加入教学班，请输入教师提供的邀请码。</p>}<section className="mt-8 rounded-xl border border-dashed border-indigo-200 bg-indigo-50/60 p-5"><h2 className="font-bold">加入另一个教学班</h2><div className="mt-3 flex flex-wrap gap-2"><input className="min-h-10 min-w-60 flex-1 rounded-lg border border-indigo-200 bg-white px-3 text-sm uppercase" value={inviteCode} onChange={(event) => onInviteCodeChange(event.target.value.toUpperCase())} placeholder="输入课程邀请码" /><button className="min-h-10 rounded-lg bg-indigo-600 px-4 text-sm font-bold text-white disabled:opacity-50" disabled={inviteBusy} onClick={onJoin} type="button">{inviteBusy ? "加入中…" : "加入课程"}</button></div>{inviteError ? <p className="mt-2 text-sm text-rose-700">{inviteError}</p> : null}</section></div></main>;
}

/* ===== 子组件 ===== */

function InstructionStep({
  step,
  title,
  desc,
}: {
  step: number;
  title: string;
  desc: string;
}) {
  return (
    <li
      className="flex items-start gap-3 rounded-[var(--radius-sm)] border border-[#fce7f3] bg-[#fdf2f8] p-3 transition hover:border-[#f9a8d4] hover:bg-[#fce7f3]"
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#ec4899] text-[12px] font-extrabold text-white">
        {step}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-bold text-[var(--pbl-text-strong)]">{title}</p>
        <p className="mt-0.5 text-[11px] leading-5 text-[var(--pbl-text-muted)]">{desc}</p>
      </div>
    </li>
  );
}

function AvailableClassCard({
  course,
  studentName,
  onReturn,
}: {
  course: {
    id: string;
    name: string;
    subject?: string;
    grade?: string;
    currentStageIndex?: number;
    stages?: Array<{ label: string }>;
  };
  studentName: string;
  onReturn: () => void;
}) {
  const stage = course.stages?.[course.currentStageIndex ?? 0]?.label;
  return (
    <article className="relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--pbl-student-border)] bg-[linear-gradient(135deg,var(--pbl-student-soft),var(--pbl-surface)_62%)] p-4 shadow-[var(--shadow-soft)]">
      <div className="absolute right-0 top-0 h-24 w-24 translate-x-8 -translate-y-8 rounded-full bg-[var(--pbl-student)]/10" />
      <div className="relative">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[var(--pbl-student)] text-white shadow-sm">
            <BookOpen size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--pbl-student)]">
                可返回的课堂
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-semibold text-[var(--pbl-success)] ring-1 ring-[var(--pbl-success-border)]">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--pbl-success)]" />
                授课中
              </span>
            </div>
            <h2 className="mt-1 truncate text-[17px] font-bold text-[var(--pbl-text-strong)]">
              {course.name}
            </h2>
            <p className="mt-1 text-[11px] text-[var(--pbl-text-muted)]">
              {[
                course.subject,
                course.grade,
                stage ? `当前：${stage}` : undefined,
              ].filter(Boolean).join(" · ") || "项目式学习课堂"}
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--pbl-student-border)]/70 pt-3">
          <p className="min-w-0 truncate text-[11px] text-[var(--pbl-text-muted)]">
            以 <strong className="text-[var(--pbl-text)]">{studentName}</strong> 身份继续学习
          </p>
          <button
          className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-xs)] bg-[var(--pbl-student)] px-3.5 text-[12px] font-bold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-[var(--pbl-student-hover)] hover:shadow-md focus:outline-none focus:ring-2 focus:ring-[var(--pbl-student-border)] focus:ring-offset-2"
          onClick={onReturn}
          type="button"
        >
            <Play size={13} fill="currentColor" /> 返回课堂
          </button>
        </div>
      </div>
    </article>
  );
}
