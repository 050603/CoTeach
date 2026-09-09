import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import Link from "next/link";
import { ArrowLeft, History, Users, FileText } from "lucide-react";
import { DashboardShell } from "@/components/dashboard-shell";
import { Card } from "@/components/ui";
import { isDatabaseConfigured } from "@/lib/db/client";
import {
  listCourseSessions,
  getCourseSession,
} from "@/lib/db/session-repository";
import { getCourse } from "@/lib/session/server-store";
import {
  feedbackKindLabel,
  submissionTypeLabel,
  userFacingName,
  userFacingStageLabel,
} from "@/lib/user-facing-labels";
import { KnowledgeLectureHistory } from "@/components/views/teacher/knowledge-lecture-history";
import type {
  KnowledgeLectureSection,
  KnowledgePoint,
  OpenMaicSceneOutlineSnapshot,
  StudentAiProgress,
} from "@/lib/session/types";

// History page — Server Component. Lists all archived classroom sessions for
// the course and (when ?session=ID is present) shows the detail of one
// archived session read-only.

type ArchivedData = {
  students?: Array<{ id: string; name: string; joinedAt?: string }>;
  submissions?: Array<{
    id: string;
    studentName?: string;
    stageKey?: string;
    title?: string;
    type?: string;
    createdAt?: string;
  }>;
  feedback?: Array<{
    id: string;
    stageKey?: string;
    kind?: string;
    content?: string;
    sourceName?: string;
    createdAt?: string;
  }>;
  evaluations?: Array<{
    id: string;
    stageKey?: string;
    targetType?: string;
    targetId?: string;
    score?: number;
    comment?: string;
    createdAt?: string;
  }>;
  groups?: Array<{ id: string; name: string; topic?: string }>;
  aiLearningProgress?: Record<string, StudentAiProgress>;
  knowledgeLecture?: {
    classroomId?: string;
    knowledgePoints?: KnowledgePoint[];
    sections?: KnowledgeLectureSection[];
    sceneOutlines?: OpenMaicSceneOutlineSnapshot[];
  };
};

function formatDateTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function archivedTargetLabel(data: ArchivedData, targetType?: string, targetId?: string): string {
  if (targetType === "student") {
    return data.students?.find((student) => student.id === targetId)?.name ?? "未识别学生";
  }
  if (targetType === "group") {
    return data.groups?.find((group) => group.id === targetId)?.name ?? "未识别项目小组";
  }
  return "课程整体";
}

export default async function CourseHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ session?: string }>;
}) {
  const { id: courseId } = await params;
  const { session: selectedSessionId } = await searchParams;

  const auth = await authenticateRequest(new Request("http://localhost/teacher/history", { headers: await headers() }), "teacher");
  if ("response" in auth || !await canAccessLegacyCourse(auth.claims, courseId)) notFound();
  const teacherName = auth.claims.role === "teacher" ? auth.claims.displayName : "教师";
  const course = await getCourse(courseId);

  if (!course) {
    return (
      <DashboardShell role="teacher" userName={teacherName} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">
          未找到课程。
          <Link
            className="mt-4 text-blue-700 hover:underline"
            href="/teacher"
          >
            返回课程列表
          </Link>
        </div>
      </DashboardShell>
    );
  }

  // Demo mode — history requires PostgreSQL.
  if (!isDatabaseConfigured()) {
    return (
      <DashboardShell
        role="teacher"
        userName={teacherName}
        variant="bare"
        currentCourse={{ id: course.id, name: course.name, status: course.status }}
      >
        <HistoryHeader courseId={courseId} />
        <KnowledgeLectureHistory initialCourse={course} />
        <Card>
          <div className="py-12 text-center">
            <History className="mx-auto text-stone-300" size={48} />
            <p className="mt-4 text-stone-600">
              历史开课记录功能仅在配置 PostgreSQL 数据库后可用。
            </p>
            <p className="mt-2 text-xs text-stone-400">
              请在生产环境配置 DATABASE_URL 并执行数据库迁移后使用。
            </p>
          </div>
        </Card>
      </DashboardShell>
    );
  }

  const sessions = await listCourseSessions(courseId);

  let selectedSession: Awaited<ReturnType<typeof getCourseSession>> = null;
  let selectedArchived: ArchivedData | null = null;
  if (selectedSessionId) {
    selectedSession = await getCourseSession(selectedSessionId, courseId);
    if (selectedSession && selectedSession.courseId === courseId) {
      selectedArchived = (selectedSession.archivedData as unknown as ArchivedData) ?? null;
    } else {
      selectedSession = null;
    }
  }

  return (
    <DashboardShell
      role="teacher"
      userName={teacherName}
      variant="bare"
      currentCourse={{ id: course.id, name: course.name, status: course.status }}
    >
      <HistoryHeader courseId={courseId} />

      {!selectedSessionId ? <KnowledgeLectureHistory initialCourse={course} /> : null}

      {sessions.length === 0 ? (
        <Card>
          <div className="py-12 text-center">
            <History className="mx-auto text-stone-300" size={48} />
            <p className="mt-4 text-stone-600">该课程暂无历史开课记录。</p>
            <p className="mt-2 text-xs text-stone-400">
              每次结束课堂都会保留独立场次；再次开课请在教学班创建新场次。
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-[360px_1fr] gap-5">
          {/* Session list */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-stone-700">
              共 {sessions.length} 次开课记录
            </h2>
            <ul className="space-y-3">
              {sessions.map((s) => {
                const active = s.id === selectedSessionId;
                return (
                  <li key={s.id}>
                    <Link
                      href={`/teacher/teach/${courseId}/history?session=${s.id}`}
                      className={`block rounded-[var(--radius-sm)] border p-4 transition ${
                        active
                          ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher)]/5 shadow-sm"
                          : "border-stone-200 bg-white hover:border-stone-300 hover:bg-stone-50"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-sm font-bold tracking-wider text-stone-800">
                          {s.inviteCode || "(无邀请码)"}
                        </span>
                        <span className="text-xs text-stone-500">
                          {formatDateTime(s.startedAt)}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-4 text-xs text-stone-500">
                        <span className="flex items-center gap-1">
                          <Users size={12} />
                          {s.studentCount} 名学生
                        </span>
                        <span className="flex items-center gap-1">
                          <FileText size={12} />
                          {s.submissionCount} 份提交
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-stone-400">
                        结束于 {formatDateTime(s.endedAt)}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Session detail */}
          <div>
            {!selectedSession || !selectedArchived ? (
              <Card>
                <div className="py-16 text-center text-stone-500">
                  <History className="mx-auto text-stone-300" size={48} />
                  <p className="mt-4">从左侧选择一次开课记录查看详情</p>
                </div>
              </Card>
            ) : (
              <div className="space-y-5">
                <KnowledgeLectureHistory
                  archivedLecture={selectedArchived.knowledgeLecture}
                  archivedProgress={selectedArchived.aiLearningProgress}
                  archivedStudentCount={selectedArchived.students?.length ?? selectedSession.studentCount}
                  initialCourse={course}
                />
                <Card>
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-xl font-bold">开课详情</h2>
                      <p className="mt-1 text-sm text-stone-500">
                        邀请码{" "}
                        <span className="font-mono font-bold text-stone-800">
                          {selectedSession.inviteCode}
                        </span>
                        　·　{formatDateTime(selectedSession.startedAt)} 至{" "}
                        {formatDateTime(selectedSession.endedAt)}
                      </p>
                    </div>
                    <div className="text-right text-sm text-stone-500">
                      <div>{selectedSession.studentCount} 名学生</div>
                      <div>{selectedSession.submissionCount} 份提交</div>
                    </div>
                  </div>
                </Card>

                {/* Students */}
                <Card>
                  <h3 className="text-lg font-bold">学生名单</h3>
                  {selectedArchived.students && selectedArchived.students.length > 0 ? (
                    <ul className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                      {selectedArchived.students.map((stu) => (
                        <li
                          key={stu.id}
                          className="rounded-[6px] border border-stone-200 bg-stone-50 px-3 py-2"
                        >
                          <div className="font-semibold text-stone-800">{stu.name}</div>
                          {stu.joinedAt && (
                            <div className="text-xs text-stone-500">
                              加入于 {formatDateTime(stu.joinedAt)}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-sm text-stone-500">本次开课无学生加入记录。</p>
                  )}
                </Card>

                {/* Submissions */}
                <Card>
                  <h3 className="text-lg font-bold">学生提交</h3>
                  {selectedArchived.submissions && selectedArchived.submissions.length > 0 ? (
                    <ul className="mt-3 space-y-2 text-sm">
                      {selectedArchived.submissions.map((sub) => (
                        <li
                          key={sub.id}
                          className="rounded-[6px] border border-stone-200 bg-white px-3 py-2"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-stone-800">
                              {userFacingName(sub.title, "无标题学习成果")}
                            </span>
                            {sub.type && (
                              <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">
                                {submissionTypeLabel(sub.type)}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-xs text-stone-500">
                            {sub.studentName || "未知学生"}　·　
                            {userFacingStageLabel(sub.stageKey)}
                            {sub.createdAt && `　·　${formatDateTime(sub.createdAt)}`}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-sm text-stone-500">本次开课无学生提交记录。</p>
                  )}
                </Card>

                {/* Teacher feedback */}
                <Card>
                  <h3 className="text-lg font-bold">教师反馈</h3>
                  {selectedArchived.feedback && selectedArchived.feedback.length > 0 ? (
                    <ul className="mt-3 space-y-2 text-sm">
                      {selectedArchived.feedback.map((fb) => (
                        <li
                          key={fb.id}
                          className="rounded-[6px] border border-stone-200 bg-white px-3 py-2"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-stone-500">
                              {fb.sourceName || "教师"}　·　{feedbackKindLabel(fb.kind)}
                            </span>
                            {fb.stageKey && (
                              <span className="text-xs text-stone-400">{userFacingStageLabel(fb.stageKey)}</span>
                            )}
                          </div>
                          {fb.content && (
                            <p className="mt-1 text-stone-700">{fb.content}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-sm text-stone-500">本次开课无教师反馈记录。</p>
                  )}
                </Card>

                {/* Evaluations */}
                <Card>
                  <h3 className="text-lg font-bold">评价记录</h3>
                  {selectedArchived.evaluations && selectedArchived.evaluations.length > 0 ? (
                    <ul className="mt-3 space-y-2 text-sm">
                      {selectedArchived.evaluations.map((ev) => (
                        <li
                          key={ev.id}
                          className="rounded-[6px] border border-stone-200 bg-white px-3 py-2"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-stone-500">
                              评价对象：{archivedTargetLabel(selectedArchived, ev.targetType, ev.targetId)}
                              {ev.stageKey ? `　·　${userFacingStageLabel(ev.stageKey)}` : ""}
                            </span>
                            {typeof ev.score === "number" && (
                              <span className="font-bold text-stone-800">{ev.score} 分</span>
                            )}
                          </div>
                          {ev.comment && (
                            <p className="mt-1 text-stone-700">{ev.comment}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-sm text-stone-500">本次开课无评价记录。</p>
                  )}
                </Card>
              </div>
            )}
          </div>
        </div>
      )}
    </DashboardShell>
  );
}

function HistoryHeader({ courseId }: { courseId: string }) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <Link
        className="grid h-9 w-9 place-items-center rounded-[6px] border border-stone-200 bg-white text-stone-500 hover:bg-stone-50"
        href={`/teacher/teach/${courseId}/setup`}
      >
        <ArrowLeft size={17} />
      </Link>
      <div>
        <h1 className="text-[28px] font-bold">历史开课记录</h1>
      </div>
    </div>
  );
}
