"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  History,
  PlayCircle,
  RefreshCw,
  Users,
} from "lucide-react";
import { DashboardShell } from "@/components/dashboard-shell";
import { InviteCodeCard } from "@/components/invite-code-card";
import { Card, Pill, PrimaryButton, SaveStatus } from "@/components/ui";
import { useSession, useCourse, useHydrated } from "@/lib/session/store";
import { useCoursePresence } from "@/hooks/use-course-presence";
import { getNewSystemCourseReadiness } from "@/lib/classroom/new-system-course";
import { MakeArtifactModeSetting } from "@/components/teacher/make-artifact-mode-setting";

export default function TeachSetupWorkspace({ activityId, offeringId, templateVersionId, templateId }: { activityId: string; offeringId: string; templateVersionId: string; templateId: string }) {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user, startTeaching, updateCourse, flushSaves, retrySave, saveState, lastSavedAt } = useSession();
  const course = useCourse(params?.id);
  const hydrated = useHydrated();
  const presence = useCoursePresence({
    courseId: course?.id,
    role: "teacher",
    enabled: course?.status === "teaching",
  });

  const existing = course?.classConfig;
  const [totalStudents, setTotalStudents] = useState<number>(existing?.totalStudents ?? 32);
  const [starting, setStarting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [startError, setStartError] = useState<string>();

  // Sync local state if course changes
  useEffect(() => {
    if (!course?.classConfig) return;
    setTotalStudents(course.classConfig.totalStudents);
  }, [course?.classConfig]);

  const inviteCode = course?.inviteCode;
  const isTeaching = course?.status === "teaching";
  const readinessChecks = course ? getNewSystemCourseReadiness(course) : [];
  const readinessBlockers = readinessChecks.filter((check) => !check.ok);

  if (!hydrated) {
    return (
      <DashboardShell role="teacher" userName={user.name} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">加载中…</div>
      </DashboardShell>
    );
  }

  if (!course) {
    return (
      <DashboardShell role="teacher" userName={user.name} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">
          未找到课程。
          <Link className="mt-4 text-blue-700 hover:underline" href={`/teacher/classes/${offeringId}`}>
            返回课程列表
          </Link>
        </div>
      </DashboardShell>
    );
  }

  async function start() {
    if (!course) return;
    setStartError(undefined);
    setStarting(true);
    try {
      if (saveState === "error") await retrySave();
      if (!await flushSaves()) throw new Error("配置尚未保存，请重试");
      const code = startTeaching(course.id, {
        groupMode: "solo",
        totalStudents: Math.max(1, Number(totalStudents) || 1),
        perGroup: 1,
        crossClass: false,
      });
      if (!await flushSaves()) throw new Error("开始课堂未保存，请重试");
      router.push(`/teacher/teach/${course.id}/classroom`);
      return code;
    } catch (error) {
      setStartError(error instanceof Error ? error.message : "课程尚未准备完成");
    } finally { setStarting(false); }
  }

  async function handleRestart() {
    if (!course || restarting) return;
    setRestarting(true);
    setStartError(undefined);
    try {
      const response = await fetch(`/api/platform/activities/${activityId}/instance`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateVersionId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "无法创建新场次");
      window.location.assign(`/teacher/teach/${data.instance.id}/setup`);
    } catch (error) { setStartError(error instanceof Error ? error.message : "无法创建新场次"); }
    finally { setRestarting(false); }
  }

  async function saveConfiguration() {
    if (!course) return;
    updateCourse(course.id, { classConfig: { groupMode: "solo", totalStudents: Math.max(1, totalStudents), perGroup: 1, crossClass: false } });
    setStartError(await flushSaves() ? undefined : "配置保存失败，请重试");
  }

  return (
    <DashboardShell
      role="teacher"
      userName={user.name}
      variant="bare"
      currentCourse={{ id: course.id, name: course.name, status: course.status }}
    >
      <div className="mb-5 flex items-center gap-3">
        <Link
          className="grid h-9 w-9 place-items-center rounded-[6px] border border-stone-200 bg-white text-stone-500 hover:bg-stone-50"
          href={`/teacher/classes/${offeringId}`}
        >
          <ArrowLeft size={17} />
        </Link>
        <div>
          <h1 className="text-[28px] font-bold">班级配置</h1>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-5">
        <div className="space-y-5">
          {readinessBlockers.length > 0 ? (
            <Card className="border-amber-200 bg-amber-50/70">
              <h2 className="text-lg font-bold text-amber-950">开课前还需完成 {readinessBlockers.length} 项</h2>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-amber-900">
                {readinessBlockers.map((check) => (
                  <li key={check.id}>• {check.label}：{check.message}</li>
                ))}
              </ul>
              <Link
                className="mt-4 inline-flex h-10 items-center rounded-[7px] bg-amber-900 px-4 text-sm font-bold text-white hover:bg-amber-800"
                href={`/teacher/prepare/${templateId}/verify`}
              >
                返回备课生成
              </Link>
            </Card>
          ) : null}
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h2 className="text-xl font-bold">五阶段课堂</h2>
              {course.status !== "finished" ? <MakeArtifactModeSetting course={course} /> : null}
            </div>
            <div className="mt-4 space-y-3">
              <p className="text-sm leading-6 text-stone-600">项目启动、成果汇报与评价、学习反思采用轻量资源授课；知识讲授采用分节学习、小测与助教讲解；项目实践的成果形式由教师在右上角统一设置。</p>
              <div className="grid gap-2 sm:grid-cols-5">
                {course.stages.map((stage, index) => <div className="rounded-[8px] border border-blue-100 bg-blue-50/70 p-3" key={stage.key}><span className="text-xs font-black text-blue-700">阶段 {index + 1}</span><p className="mt-1 text-sm font-bold text-stone-900">{stage.label}</p></div>)}
              </div>
            </div>
          </Card>

          <Card>
            <h2 className="text-xl font-bold">人数与配置</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-stone-700">
                  班级总人数
                </span>
                <input
                  className="h-11 w-full rounded-[6px] border border-stone-300 px-4 outline-none focus:border-blue-500"
                  disabled={course.status === "finished"}
                  min={1}
                  onChange={(e) => setTotalStudents(Number(e.target.value) || 1)}
                  type="number"
                  value={totalStudents}
                />
              </label>
              <div>
                <span className="mb-2 block text-sm font-semibold text-stone-700">
                  预计个人项目数
                </span>
                <div className="flex h-11 items-center rounded-[6px] border border-stone-200 bg-stone-50 px-4 text-base font-bold text-stone-700">
                  <Users className="mr-2 text-stone-400" size={18} /> {totalStudents} 个
                </div>
              </div>
            </div>
            {course.status !== "finished" ? <PrimaryButton className="mt-4" onClick={saveConfiguration} disabled={saveState === "saving"}>保存配置</PrimaryButton> : null}
            <p className="mt-4 text-sm leading-6 text-stone-500">每位加入课堂的学生都会自动获得一个私有项目空间。</p>
          </Card>

          <Card>
            <h2 className="text-xl font-bold">课程信息确认</h2>
            <dl className="mt-3 grid grid-cols-2 gap-y-3 text-sm">
              <div>
                <dt className="text-stone-500">课程</dt>
                <dd className="mt-0.5 font-semibold">{course.name}</dd>
              </div>
              <div>
                <dt className="text-stone-500">学科 / 年级</dt>
                <dd className="mt-0.5 font-semibold">
                  {course.subject} · {course.grade}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">课时</dt>
                <dd className="mt-0.5 font-semibold">{course.hours}</dd>
              </div>
              <div>
                <dt className="text-stone-500">阶段数</dt>
                <dd className="mt-0.5 font-semibold">{course.stages.length}</dd>
              </div>
            </dl>
          </Card>
        </div>

        <aside className="space-y-5">
          {inviteCode ? (
            <InviteCodeCard
              code={inviteCode}
              hint={
                isTeaching
                  ? "教学班邀请码，学生加入课程后进入本课堂"
                  : "教学班邀请码；课堂开始后学生可进入本场次"
              }
              
            />
          ) : (
            <Card>
              <h2 className="text-lg font-bold">邀请码</h2>
              <p className="mt-3 text-sm leading-7 text-stone-600">
                学生通过教学班加入课程。请在课程的邀请与访问页面设置邀请码。
              </p>
            </Card>
          )}

          <Card>
            <h2 className="text-lg font-bold">在线学生</h2>
            <div className="mt-3 flex items-center gap-2 text-sm text-stone-500">
              <Users className="text-stone-400" size={16} />
              {isTeaching
                ? `当前 ${course.students.filter((student) => presence.onlineStudentIds.has(student.id)).length} 人在线（共 ${course.students.length} 人加入）`
                : "课堂尚未开始"}
            </div>
            {isTeaching && course.students.length > 0 ? (
              <ul className="mt-3 max-h-56 space-y-2 overflow-auto">
                {course.students.map((s) => {
                  const online = presence.onlineStudentIds.has(s.id);
                  return (
                    <li
                      className="flex items-center gap-2 rounded-[6px] border border-stone-200 bg-white px-3 py-2"
                      key={s.id}
                    >
                      <span className="relative">
                        <span className="grid h-7 w-7 place-items-center rounded-full bg-blue-50 text-xs font-bold text-blue-700">
                          {s.name.slice(0, 1)}
                        </span>
                        <span
                          className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white ${online ? "bg-green-500" : "bg-stone-300"}`}
                          aria-hidden="true"
                        />
                      </span>
                      <span className="flex-1 text-sm font-semibold">
                        {s.name}
                      </span>
                      {online ? (
                        <Pill tone="green">在线</Pill>
                      ) : (
                        <Pill tone="gray">离线</Pill>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </Card>

          <Card>
            {isTeaching ? (
              <PrimaryButton
                className="h-12 w-full text-base"
                onClick={async () => { if (saveState === "error") await retrySave(); if (await flushSaves()) router.push(`/teacher/teach/${course.id}/classroom`); else setStartError("课堂尚未保存，请重试"); }}
                type="button"
              >
                <PlayCircle size={18} /> 进入教室
              </PrimaryButton>
            ) : (
              <PrimaryButton
                className="h-12 w-full text-base"
                disabled={starting || course.status === "finished" || readinessBlockers.length > 0}
                onClick={start}
                type="button"
              >
                <PlayCircle size={18} /> {starting ? "正在开始…" : course.status === "finished" ? "本场课堂已结束" : "开始上课"}
              </PrimaryButton>
            )}
            <p className="mt-3 text-center text-xs text-stone-500">
              {isTeaching
                ? "课堂已开启，可随时进入教室推进阶段"
                : "开始上课后学生可进入本场课堂；教学班邀请码继续有效"}
            </p>
            <SaveStatus state={saveState} lastSavedAt={lastSavedAt} onRetry={() => void retrySave()} />
            {startError ? <p className="mt-2 text-center text-xs font-semibold text-red-700">{startError}</p> : null}
          </Card>

          {(course.status === "finished") && (
            <Card>
              <h2 className="text-lg font-bold">再次授课与学习记录</h2>
              <p className="mt-2 text-sm leading-6 text-stone-600">
                再次授课会使用同一已发布教案创建新的待授课场次，当前课堂及学生学习记录完整保留。教学班邀请码继续有效。
              </p>
              <button
                className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-[6px] border border-amber-300 bg-amber-50 text-sm font-semibold text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={restarting}
                onClick={handleRestart}
                type="button"
              >
                <RefreshCw size={16} className={restarting ? "animate-spin" : ""} />
                {restarting ? "正在创建…" : "再次授课"}
              </button>
              <Link
                className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-[6px] border border-stone-200 bg-white text-sm font-semibold text-stone-700 transition hover:bg-stone-50"
                href={`/teacher/classrooms/${course.id}`}
              >
                <History size={16} />
                查看课堂学习记录
              </Link>
            </Card>
          )}
        </aside>
      </div>
    </DashboardShell>
  );
}
