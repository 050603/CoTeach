"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Bell,
  ArrowLeft,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  Database,
  FileText,
  GraduationCap,
  LogOut,
  Settings,
  Star,
  UserRound,
  X,
} from "lucide-react";
import { CoTeachLogoMark } from "@/components/brand/coteach-logo";
import { cn } from "@/lib/utils";
import { teacherSettingsHref } from "@/lib/navigation/teacher-return";
import { COURSE_STATUS_LABEL } from "@/lib/session/types";
import type { CourseStatus } from "@/lib/session/types";
import { useSession } from "@/lib/session/store";
import { loadJSON, saveJSON } from "@/lib/session/storage";
import { PrimaryButton, SaveStatus, TextInput } from "@/components/ui";
import styles from "./dashboard-shell.module.css";

type Role = "student" | "teacher";

export type DashboardStageOption = { index: number; label: string };

export type DashboardShellProps = {
  role: Role;
  active?: string;
  phase?: string;
  title?: string;
  subtitle?: string;
  course?: string;
  children: ReactNode;
  wide?: boolean;
  immersive?: boolean;
  viewportLocked?: boolean;
  variant?: "default" | "bare";
  headerSlot?: ReactNode;
  classroomBar?: ReactNode;
  hideCourseSwitcher?: boolean;
  currentCourse?: { id: string; name: string; status: CourseStatus };
  currentStage?: { index: number; total: number; label: string };
  /** Optional stage jump entries shown from the top classroom stage menu. */
  stageOptions?: DashboardStageOption[];
  onSelectStage?: (index: number) => void;
  userName?: string;
  currentTask?: string;
  leadRole?: "AI" | "教师" | "学生";
  backHref?: string;
  backLabel?: string;
};

export type DashboardTopBarProps = Pick<
  DashboardShellProps,
  | "role"
  | "phase"
  | "title"
  | "course"
  | "headerSlot"
  | "classroomBar"
  | "hideCourseSwitcher"
  | "currentCourse"
  | "currentStage"
  | "stageOptions"
  | "onSelectStage"
  | "userName"
  | "currentTask"
  | "leadRole"
  | "backHref"
  | "backLabel"
>;

type OpenPanel = "courses" | "notifications" | "profile" | null;

type NotificationReadState = {
  storageKey: string;
  byCourse: Record<string, string>;
};

const NOTIFICATION_READ_STORAGE_PREFIX = "openpbl.notifications.read-through.v1";

function notificationReadStorageKey(role: Role, studentId?: string): string {
  return role === "student" && studentId
    ? `${NOTIFICATION_READ_STORAGE_PREFIX}:student:${studentId}`
    : `${NOTIFICATION_READ_STORAGE_PREFIX}:${role}`;
}

function loadNotificationReads(storageKey: string): Record<string, string> {
  const stored = loadJSON<unknown>(storageKey, {});
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  return Object.fromEntries(
    Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export function DashboardTopBar({
  role,
  phase = "",
  title = "与 AI 一起实践的项目课堂",
  course,
  headerSlot,
  classroomBar,
  hideCourseSwitcher = false,
  currentCourse,
  currentStage,
  stageOptions,
  onSelectStage,
  userName,
  currentTask,
  leadRole,
  backHref,
  backLabel,
}: DashboardTopBarProps) {
  const pathname = usePathname();
  const session = useSession();
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null);
  const readStorageKey = notificationReadStorageKey(role, session.studentId);
  const [notificationReads, setNotificationReads] = useState<NotificationReadState>({
    storageKey: "",
    byCourse: {},
  });
  const isTeacher = role === "teacher";
  const [nameDraft, setNameDraft] = useState(() => {
    const name = userName ?? session.user.name;
    if (!isTeacher && name === "教师") return "";
    return name;
  });
  const displayName = isTeacher
    ? (userName ?? session.user.name ?? "教师")
    : (session.studentName || (userName && userName !== "教师" ? userName : ""));
  const homeHref = backHref ?? (isTeacher ? "/teacher" : "/student");
  const homeLabel = backLabel ?? "返回课程空间";
  const courseName = currentCourse?.name ?? course;
  const stageLabel = currentStage
    ? `阶段 ${currentStage.index + 1}/${currentStage.total} · ${currentStage.label}`
    : phase;
  const current = useMemo(() => {
    if (currentCourse) return session.courses.find((item) => item.id === currentCourse.id);
    return session.courses[0];
  }, [currentCourse, session.courses]);
  const notifications = (current?.activityLog ?? []).slice(0, 8);
  const notificationReadsReady = notificationReads.storageKey === readStorageKey;
  const readThroughId = current && notificationReadsReady
    ? notificationReads.byCourse[current.id]
    : undefined;
  const readThroughIndex = readThroughId
    ? notifications.findIndex((item) => item.id === readThroughId)
    : -1;
  const unreadCount = notificationReadsReady
    ? readThroughId
      ? (readThroughIndex >= 0 ? readThroughIndex : notifications.length)
      : notifications.length
    : 0;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Read receipts hydrate from browser storage after SSR.
    setNotificationReads({
      storageKey: readStorageKey,
      byCourse: loadNotificationReads(readStorageKey),
    });

    function syncNotificationReads(event: StorageEvent) {
      if (event.key !== readStorageKey) return;
      setNotificationReads({
        storageKey: readStorageKey,
        byCourse: loadNotificationReads(readStorageKey),
      });
    }

    window.addEventListener("storage", syncNotificationReads);
    return () => window.removeEventListener("storage", syncNotificationReads);
  }, [readStorageKey]);

  function toggle(panel: OpenPanel) {
    if (panel === "notifications" && openPanel !== panel && current && notifications[0]) {
      const persisted = notificationReads.storageKey === readStorageKey
        ? notificationReads.byCourse
        : loadNotificationReads(readStorageKey);
      const byCourse = { ...persisted, [current.id]: notifications[0].id };
      setNotificationReads({ storageKey: readStorageKey, byCourse });
      saveJSON(readStorageKey, byCourse);
    }
    setOpenPanel((currentPanel) => (currentPanel === panel ? null : panel));
  }

  function saveProfile() {
    const name = nameDraft.trim() || displayName;
    session.setUser({ role, name });
    setOpenPanel(null);
  }

  async function logout() {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "X-OpenPBL-Role": role },
    });
    if (!response.ok) return;
    window.location.assign(isTeacher ? "/teacher/login" : "/student");
  }

  return (
    <header className="fixed inset-x-0 top-0 z-[70] border-b border-[var(--pbl-border)] bg-[color-mix(in_srgb,var(--pbl-surface)_96%,transparent)] backdrop-blur-sm">
      <div className="pbl-wide-container flex min-h-16 items-center px-3 py-2 md:px-5">
        <Link aria-label={homeLabel} className="flex min-h-11 min-w-0 shrink-0 items-center gap-2.5" href={homeHref} title={homeLabel}>
          {backHref ? <ArrowLeft aria-hidden="true" className="shrink-0 text-[var(--pbl-text-muted)]" size={18} /> : null}
          <LogoMark role={role} />
          <div className="hidden min-w-0 lg:block">
            <div className="flex items-baseline gap-1"><span className="truncate text-sm font-bold tracking-tight text-[var(--pbl-text-strong)]">CoTeach</span></div>
            <div className="mt-0.5 max-w-44 truncate text-xs font-medium text-[var(--pbl-text-muted)]">{courseName ?? (isTeacher ? "教师课程空间" : title)}</div>
          </div>
        </Link>
        <div className="ml-2 flex min-w-0 flex-1 items-center gap-2 md:ml-4">
          <div className={cn("min-w-0 flex-1", hideCourseSwitcher ? "lg:hidden" : "md:hidden")}>
            <p className="truncate text-xs font-semibold" title={courseName ?? title}>{courseName ?? title}</p>
            {stageLabel ? <p className="mt-0.5 truncate text-[11px] text-[var(--pbl-text-muted)]" title={stageLabel}>{stageLabel}</p> : null}
          </div>
          {(courseName || stageLabel) && !hideCourseSwitcher ? (
            <div className="relative hidden min-w-0 md:block">
              <button className="inline-flex min-h-11 w-full max-w-[620px] min-w-0 items-center gap-2 border-l border-[var(--pbl-border)] px-2 text-left text-sm font-semibold text-[var(--pbl-text)] transition-colors hover:bg-[var(--pbl-surface-soft)] lg:gap-3 lg:px-4" onClick={() => toggle("courses")} type="button">
                <span className={cn("hidden h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-xs)] lg:grid", isTeacher ? "bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]" : "bg-[var(--pbl-student-soft)] text-[var(--pbl-student)]")}><GraduationCap size={16} /></span>
                <span className="min-w-0"><span className="block truncate">{stageLabel || courseName}</span><span className="block truncate text-xs font-normal text-[var(--pbl-text-muted)]">{[leadRole ? `${leadRole}主导` : null, currentTask ?? courseName].filter(Boolean).join(" · ")}</span></span>
                {currentCourse ? <span className="hidden shrink-0 xl:inline-flex"><StatusPill status={currentCourse.status} /></span> : null}
                <ChevronDown size={14} className={cn("shrink-0 text-[var(--pbl-text-subtle)] transition", openPanel === "courses" && "rotate-180")} />
              </button>
              {openPanel === "courses" ? <TopPopover align="left" onClose={() => setOpenPanel(null)}><CourseMenu currentId={currentCourse?.id} isTeacher={isTeacher} onClose={() => setOpenPanel(null)} onSelectStage={onSelectStage} stageOptions={stageOptions} /></TopPopover> : null}
            </div>
          ) : null}
          {headerSlot}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 md:gap-2">
          <div className="hidden lg:block"><SaveStatus lastSavedAt={session.lastSavedAt} onRetry={() => void session.retrySave()} state={session.saveState} /></div>
          {isTeacher ? <Link className="hidden h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--pbl-border)] bg-white/80 px-3 text-[13px] font-semibold text-[var(--pbl-text-muted)] transition hover:border-[var(--pbl-teacher-border)] hover:text-[var(--pbl-teacher)] md:inline-flex" href={teacherSettingsHref(pathname)}><Settings size={14} /> AI 设置</Link> : null}
          <div className="relative">
            <button aria-label="通知中心" className="relative grid h-11 w-11 place-items-center rounded-[var(--radius-sm)] border border-transparent text-[var(--pbl-text-muted)] transition hover:border-[var(--pbl-border)] hover:bg-[var(--pbl-surface)]" onClick={() => toggle("notifications")} type="button">
              <Bell size={18} strokeWidth={1.8} />
              {unreadCount ? <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--pbl-danger)] px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white">{unreadCount}</span> : null}
            </button>
            {openPanel === "notifications" ? <TopPopover align="right" onClose={() => setOpenPanel(null)}><NotificationMenu items={notifications} /></TopPopover> : null}
          </div>
          <div className="relative">
            <button aria-label="个人信息" className="flex min-h-11 items-center gap-2 rounded-[var(--radius-sm)] px-1.5 transition hover:bg-white" onClick={() => toggle("profile")} type="button">
              <Avatar name={displayName || (isTeacher ? "教师" : "学生")} />
              <span className="hidden max-w-[100px] truncate text-[13px] font-semibold md:inline">{displayName || "未加入课堂"}</span>
              <ChevronDown size={14} className={cn("hidden text-[var(--pbl-text-subtle)] transition sm:block", openPanel === "profile" && "rotate-180")} />
            </button>
            {openPanel === "profile" ? (
              <TopPopover align="right" onClose={() => setOpenPanel(null)}>
                <div className="space-y-3.5">
                  <div><div className="text-base font-bold text-[var(--pbl-text-strong)]">个人信息</div><p className="mt-0.5 text-[13px] text-[var(--pbl-text-muted)]">当前身份：{isTeacher ? "教师端" : "学生端"}</p></div>
                  <label className="block text-[13px] font-semibold text-[var(--pbl-text)]">显示姓名<TextInput className="mt-1.5 h-10" value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} /></label>
                  <div className="grid grid-cols-2 gap-2"><PrimaryButton className="h-10 text-sm" onClick={saveProfile}>保存</PrimaryButton><Link className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] text-[13px] font-semibold text-[var(--pbl-text-muted)] transition hover:bg-[var(--pbl-surface-soft)]" href={isTeacher ? teacherSettingsHref(pathname) : "/student"} onClick={() => setOpenPanel(null)}><UserRound size={15} /> 个人中心</Link></div>
                  {isTeacher ? <Link className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] text-[13px] font-semibold text-[var(--pbl-teacher)] transition hover:bg-white" href="/teacher/register" onClick={() => setOpenPanel(null)}><UserPlusIcon /> 创建其他教师</Link> : null}
                  <button className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--pbl-danger-border)] bg-[var(--pbl-danger-soft)] text-[13px] font-semibold text-[var(--pbl-danger)] transition hover:bg-[var(--pbl-danger-soft)]" onClick={() => void logout()} type="button"><LogOut size={15} /> 退出登录</button>
                </div>
              </TopPopover>
            ) : null}
          </div>
        </div>
      </div>
      {classroomBar ? <div className="mt-2 px-2 sm:px-3 lg:px-4">{classroomBar}</div> : null}
    </header>
  );
}

export function DashboardShell({
  role,
  phase = "",
  title = "与 AI 一起实践的项目课堂",
  subtitle,
  course,
  children,
  wide = false,
  immersive = false,
  viewportLocked = false,
  headerSlot,
  classroomBar,
  hideCourseSwitcher = false,
  currentCourse,
  currentStage,
  stageOptions,
  onSelectStage,
  userName,
  currentTask,
  leadRole,
  backHref,
  backLabel,
}: DashboardShellProps) {
  const isTeacher = role === "teacher";
  return (
    <div
      className={cn(
        immersive || viewportLocked
          ? "h-dvh min-h-0 overflow-hidden"
          : "min-h-screen",
        viewportLocked && "fixed inset-0",
        "text-[var(--pbl-text)]",
        styles.shell,
        isTeacher ? "pbl-app-bg-role-teacher" : "pbl-app-bg-role-student",
      )}
    >
      {!immersive ? <DashboardTopBar backHref={backHref} backLabel={backLabel} classroomBar={classroomBar} course={course} currentCourse={currentCourse} currentStage={currentStage} currentTask={currentTask} headerSlot={headerSlot} hideCourseSwitcher={hideCourseSwitcher} leadRole={leadRole} onSelectStage={onSelectStage} phase={phase} role={role} stageOptions={stageOptions} title={title} userName={userName} /> : null}

      <main className={immersive
        ? "h-full min-h-0 overflow-hidden p-0"
        : viewportLocked
          ? classroomBar
            ? "h-full min-h-0 overflow-hidden pt-[8.5rem] md:pt-[8.875rem]"
            : "h-full min-h-0 overflow-hidden pt-[4.5rem]"
          : classroomBar ? "pt-[8.5rem] md:pt-[8.875rem]" : "pt-[4.5rem]"}>
        <div
          className={immersive
            ? "h-full min-h-0 w-full overflow-hidden"
            : viewportLocked
              ? cn(
                  "mx-auto h-full min-h-0 w-full overflow-hidden px-4 md:px-5",
                  wide ? "pbl-wide-container" : "pbl-dashboard-container",
                  wide && styles.learningViewport,
                )
              : cn(
                  "mx-auto w-full px-4 pb-10 md:px-5",
                  wide ? "pbl-wide-container" : "pbl-dashboard-container",
                )}
          style={viewportLocked && wide
            ? {
                // Keep the actual learning surface at no more than 16:9. The
                // rem offsets track the scaled classroom header and padding.
                maxWidth: "calc(177.7778dvh - 8rem + 2.5rem)",
              }
            : undefined}
        >
          {subtitle ? <p className="mb-2 text-sm font-medium text-[var(--pbl-text-muted)]">{subtitle}</p> : null}
          {children}
        </div>
      </main>
    </div>
  );
}

function UserPlusIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="15"
      viewBox="0 0 24 24"
      width="15"
    >
      <path
        d="M15 19c0-2.21-2.69-4-6-4s-6 1.79-6 4m6-7a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm10-5v6m3-3h-6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function StatusPill({ status }: { status: CourseStatus }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-semibold ring-1",
        status === "ready" && "bg-[var(--pbl-success-soft)] text-[var(--pbl-success)] ring-[var(--pbl-success)]/30",
        status === "teaching" && "bg-[var(--pbl-ai-soft)] text-[var(--pbl-ai)] ring-[var(--pbl-ai-border)]",
        status === "preparing" && "bg-[var(--pbl-warning-soft)] text-[var(--pbl-warning)] ring-[var(--pbl-accent-border)]",
        status === "draft" && "bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-muted)] ring-[var(--pbl-border)]",
        status === "finished" && "bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-subtle)] ring-[var(--pbl-border)]",
      )}
    >
      {COURSE_STATUS_LABEL[status]}
    </span>
  );
}

function TopPopover({ children, onClose, align }: { children: ReactNode; onClose: () => void; align: "left" | "right" }) {
  return (
    <div className={cn("pbl-glass absolute top-[calc(100%+10px)] z-40 w-[min(380px,calc(100vw-24px))] rounded-[var(--radius-md)] p-4", styles.popover, align === "left" ? "left-0" : "right-0")}>
      <button
        className="absolute right-1 top-1 grid h-11 w-11 place-items-center rounded-[var(--radius-xs)] text-[var(--pbl-text-subtle)] transition hover:bg-[var(--pbl-surface)] hover:text-[var(--pbl-text-muted)]"
        onClick={onClose}
        type="button"
        aria-label="关闭"
      >
        <X size={15} />
      </button>
      {children}
    </div>
  );
}

function CourseMenu({ currentId, isTeacher, onClose, stageOptions, onSelectStage }: { currentId?: string; isTeacher: boolean; onClose: () => void; stageOptions?: DashboardStageOption[]; onSelectStage?: (index: number) => void }) {
  const { courses } = useSession();
  return (
    <div>
      <div className="mb-3 pr-8">
        <div className="text-base font-bold text-[var(--pbl-text-strong)]">课堂切换</div>
      </div>
      <div className="max-h-[360px] space-y-1.5 overflow-auto pr-1">
        {courses.map((item) => {
          const href = isTeacher
            ? item.status === "teaching"
              ? `/teacher/teach/${item.id}/classroom`
              : `/teacher/prepare/${item.id}/preview`
            : item.status === "teaching"
              ? `/student/classroom/${item.id}`
              : "/student";
          return (
            <Link
              className={cn(
                "block rounded-[var(--radius-sm)] border px-3 py-2.5 transition hover:border-[var(--pbl-teacher-border)] hover:bg-[var(--pbl-teacher-soft)]",
                item.id === currentId ? "border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)]" : "border-[var(--pbl-border)] bg-white/80",
              )}
              href={href}
              key={item.id}
              onClick={onClose}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[13px] font-bold text-[var(--pbl-text-strong)]">{item.name}</span>
                <StatusPill status={item.status} />
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--pbl-text-muted)]">
                {item.subject} · {item.grade} · 阶段 {item.currentStageIndex + 1}/{item.stages.length}
              </div>
            </Link>
          );
        })}
      </div>
      {stageOptions?.length && onSelectStage ? (
        <div className="mt-4 border-t border-[var(--pbl-border)] pt-3">
          <div className="mb-2 text-xs font-bold text-[var(--pbl-text-muted)]">阶段入口</div>
          <div className="grid gap-1">
            {stageOptions.map((stage) => (
              <button
                className="flex items-center gap-2 rounded-[var(--radius-xs)] px-2.5 py-2 text-left text-xs font-semibold text-[var(--pbl-text)] transition hover:bg-[var(--pbl-teacher-soft)] hover:text-[var(--pbl-teacher)]"
                key={stage.index}
                onClick={() => { onSelectStage(stage.index); onClose(); }}
                type="button"
              >
                <span className="grid size-5 place-items-center rounded-full bg-[var(--pbl-surface-soft)] text-[10px] tabular-nums text-[var(--pbl-text-muted)]">{stage.index + 1}</span>
                <span className="truncate">{stage.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NotificationMenu({ items }: { items: { id: string; actor: string; action: string; detail?: string; createdAt: string }[] }) {
  return (
    <div>
      <div className="mb-3 pr-8">
        <div className="text-base font-bold text-[var(--pbl-text-strong)]">通知中心</div>
      </div>
      {items.length ? (
        <div className="space-y-1.5">
          {items.map((item) => (
            <div className="rounded-[var(--radius-sm)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)]/80 p-2.5" key={item.id}>
              <div className="text-[13px] font-semibold text-[var(--pbl-text-strong)]">
                {item.actor} · {item.action}
              </div>
              {item.detail ? <div className="mt-0.5 text-[13px] text-[var(--pbl-text-muted)]">{item.detail}</div> : null}
              <div className="mt-1.5 text-[11px] text-[var(--pbl-text-subtle)]">{new Date(item.createdAt).toLocaleString("zh-CN")}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="pbl-dot-grid rounded-[var(--radius-sm)] border border-dashed border-[var(--pbl-border-strong)] bg-[var(--pbl-surface-soft)]/40 py-8 text-center text-[13px] text-[var(--pbl-text-muted)]">
          暂无通知
        </div>
      )}
    </div>
  );
}

export function LogoMark({ role = "teacher" }: { role?: Role }) {
  // 使用统一品牌 Logo 图标（不再按 role 切换颜色，保持品牌一致性）
  return (
    <span className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center">
      <CoTeachLogoMark size={36} />
      {/* 角色 dot 标识 */}
      <span
        className={cn(
          "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white",
          role === "teacher" ? "bg-[var(--pbl-teacher)]" : "bg-[var(--pbl-student)]"
        )}
      />
    </span>
  );
}

export function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  const initials = name.slice(0, 1);
  return (
    <div
      className="grid shrink-0 place-items-center rounded-full bg-stone-800 text-sm font-bold text-white"
      style={{ height: size, width: size }}
      title={name}
    >
      {initials}
    </div>
  );
}

export function AvatarStack({ names }: { names: string[] }) {
  return (
    <div className="flex items-center">
      {names.slice(0, 4).map((name, index) => (
        <div className="-ml-2 first:ml-0" key={name}>
          <Avatar name={name} size={34 - index} />
        </div>
      ))}
      {names.length > 4 ? (
        <div className="-ml-1 grid h-8 w-8 place-items-center rounded-full bg-[var(--pbl-surface-soft)] text-xs font-bold text-[var(--pbl-text-muted)]">
          +{names.length - 4}
        </div>
      ) : null}
    </div>
  );
}

export function Toolbar() {
  const icons = [ClipboardList, FileText, CalendarDays, Database, Star];
  const formatButtons: Array<{ label: string; name: string }> = [
    { label: "B", name: "加粗" },
    { label: "I", name: "斜体" },
    { label: "U", name: "下划线" },
    { label: "S", name: "删除线" },
  ];
  return (
    <div className={cn("flex h-11 items-center gap-1 border-b border-[var(--pbl-border)] bg-[var(--pbl-surface-soft)] px-3", styles.toolbar)}>
      <select className="h-8 rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-3 text-sm text-[var(--pbl-text-muted)]">
        <option>正文</option>
      </select>
      <select className="h-8 rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-3 text-sm text-[var(--pbl-text-muted)]">
        <option>系统字体</option>
      </select>
      <select className="h-8 rounded-[var(--radius-xs)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-3 text-sm text-[var(--pbl-text-muted)]">
        <option>14</option>
      </select>
      <span className="mx-2 h-6 w-px bg-[var(--pbl-border)]" />
      {formatButtons.map((item) => (
        <button
          aria-label={item.name}
          className="grid h-8 w-8 place-items-center rounded-[var(--radius-xs)] text-base font-bold text-[var(--pbl-text)] transition hover:bg-[var(--pbl-surface)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--pbl-teacher)]"
          key={item.label}
          type="button"
        >
          {item.label}
        </button>
      ))}
      <span className="mx-2 h-6 w-px bg-[var(--pbl-border)]" />
      {icons.map((Icon, index) => (
        <button
          aria-label="格式按钮"
          className="grid h-8 w-8 place-items-center rounded-[var(--radius-xs)] text-[var(--pbl-text)] transition hover:bg-[var(--pbl-surface)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--pbl-teacher)]"
          key={index}
          type="button"
        >
          <Icon size={17} />
        </button>
      ))}
      <span className="ml-auto text-[var(--pbl-text-subtle)]">撤销</span>
      <span className="text-[var(--pbl-text-subtle)]">重做</span>
    </div>
  );
}
