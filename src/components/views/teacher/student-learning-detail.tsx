"use client";

import { useState } from "react";
import { BookOpenCheck, CheckCircle2, CircleAlert, CircleX, Route } from "lucide-react";
import { Avatar } from "@/components/dashboard-shell";
import { DialogDescription, DialogTitle, Drawer, DrawerContent } from "@/components/ui";
import { firstKnowledgeLectureAttempts } from "@/lib/knowledge-lecture";
import { formatLearningContentReference } from "@/lib/learning-analytics/content-reference";
import type { Course, LearningEventType } from "@/lib/session/types";
import { cn } from "@/lib/utils";

export type StudentLearningDetailTab = "trajectory" | "answers";

const TABS: Array<{ id: StudentLearningDetailTab; label: string; icon: React.ReactNode }> = [
  { id: "trajectory", label: "学习轨迹", icon: <Route size={14} /> },
  { id: "answers", label: "答题详情", icon: <BookOpenCheck size={14} /> },
];

const EVENT_TYPE_LABELS: Record<LearningEventType, string> = {
  "scene-enter": "进入学习页面",
  "scene-leave": "离开学习页面",
  "scene-complete": "完成学习页面",
  heartbeat: "持续学习",
  "scene-replay": "重新播放讲解",
  "knowledge_explanation_view": "查看题目统一讲解",
  "interaction-result": "完成互动操作",
  "artifact-change": "更新学习内容",
  "stage-enter": "进入学习阶段",
  "stage-goal-complete": "完成阶段目标",
  "resource-open": "打开学习资料",
  "resource-progress": "推进资料浏览",
  "resource-complete": "完成资料浏览",
};

export function formatLearningEventType(type: LearningEventType): string {
  return EVENT_TYPE_LABELS[type];
}

export function StudentLearningDetail({
  course,
  studentId,
  open,
  onOpenChange,
  initialTab = "trajectory",
}: {
  course: Course;
  studentId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: StudentLearningDetailTab;
}) {
  const [tab, setTab] = useState<StudentLearningDetailTab>(initialTab);
  const student = course.students.find((item) => item.id === studentId);
  const events = (course.learningEvents ?? [])
    .filter((event) => event.studentId === studentId && event.stageKey === "ai-learning")
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const meaningfulEvents = events.filter((event) => event.type !== "heartbeat");
  const trajectoryEvents = (meaningfulEvents.length ? meaningfulEvents : events).slice(0, 100);
  const attempts = firstKnowledgeLectureAttempts(course.aiLearningProgress?.[studentId ?? ""])
    .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
  const answeredQuestions = attempts.reduce((sum, attempt) => sum + attempt.questions.length, 0);
  const earned = attempts.reduce((sum, attempt) => sum + attempt.score, 0);
  const maxScore = attempts.reduce((sum, attempt) => sum + attempt.maxScore, 0);
  const accuracy = maxScore > 0 ? Math.round(earned / maxScore * 100) : undefined;
  const signals = (course.learningSignals ?? []).filter((signal) =>
    signal.studentId === studentId
    && signal.stageKey === "ai-learning"
    && signal.status === "open",
  );

  return (
    <Drawer onOpenChange={onOpenChange} open={open}>
      <DrawerContent className="w-[min(920px,100vw)]">
        <DialogTitle className="flex items-center gap-3">
          {student ? <Avatar name={student.name} size={38} /> : null}
          <span>{student?.name ?? "学生详情"}</span>
        </DialogTitle>
        <DialogDescription>查看该学生的知识讲授学习轨迹与每道题的真实作答记录。</DialogDescription>

        {signals.length ? (
          <section className="mt-4 rounded-xl border border-rose-200 bg-rose-50/65 p-3" aria-label="待处理学习信号">
            <h3 className="flex items-center gap-2 text-sm font-bold text-rose-950"><CircleAlert size={16} />待处理学习信号 · {signals.length} 条</h3>
            <ul className="mt-2 divide-y divide-rose-100">
              {signals.map((signal) => (
                <li className="py-2 first:pt-0 last:pb-0" key={signal.id}>
                  <p className="text-xs font-bold text-rose-900">{signal.title}</p>
                  <p className="mt-0.5 text-xs leading-5 text-rose-800/80">{signal.summary}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <nav aria-label="学生详情内容" className="mt-5 flex gap-1 border-b border-stone-200">
          {TABS.map((item) => (
            <button
              aria-selected={tab === item.id}
              className={cn(
                "inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-semibold",
                tab === item.id ? "border-blue-700 text-blue-700" : "border-transparent text-stone-500 hover:text-stone-800",
              )}
              key={item.id}
              onClick={() => setTab(item.id)}
              role="tab"
              type="button"
            >
              {item.icon}{item.label}
            </button>
          ))}
        </nav>

        {tab === "trajectory" ? (
          <section aria-label="学习轨迹" className="mt-4">
            {trajectoryEvents.length ? (
              <ol className="overflow-hidden rounded-lg border border-stone-200">
                <li className="grid grid-cols-[150px_130px_minmax(0,1fr)] gap-3 bg-stone-50 px-3 py-2 text-xs font-bold text-stone-500"><span>时间</span><span>学习动作</span><span>学习位置</span></li>
                {trajectoryEvents.map((event) => (
                  <li className="grid grid-cols-[150px_130px_minmax(0,1fr)] gap-3 border-t border-stone-100 px-3 py-3 text-sm" key={event.id}>
                    <time className="text-xs text-stone-400">{new Date(event.occurredAt).toLocaleString("zh-CN")}</time>
                    <span className="font-semibold text-stone-700">{formatLearningEventType(event.type)}</span>
                    <span className="text-stone-500">{formatLearningContentReference(event.content, event.metadata?.sceneTitle?.toString() ?? "当前学习内容")}</span>
                  </li>
                ))}
              </ol>
            ) : <Empty text="暂无学习轨迹" />}
          </section>
        ) : (
          <section aria-label="答题详情" className="mt-4 space-y-4">
            <div className="grid grid-cols-3 gap-2 rounded-xl border border-blue-100 bg-blue-50/55 p-3 text-center">
              <SummaryMetric label="累计作答" value={`${answeredQuestions} 题`} />
              <SummaryMetric label="答题准确率" value={accuracy === undefined ? "—" : `${accuracy}%`} />
              <SummaryMetric label="累计得分" value={maxScore > 0 ? `${earned}/${maxScore}` : "—"} />
            </div>

            {attempts.length ? attempts.map((attempt) => {
              const section = course.content.knowledgeLectureSections?.find((item) => item.id === attempt.sectionId);
              return (
                <article className="overflow-hidden rounded-xl border border-stone-200" key={attempt.id}>
                  <header className="flex flex-wrap items-center justify-between gap-2 bg-stone-50 px-4 py-3">
                    <div><h3 className="text-sm font-bold text-stone-900">{section?.title ?? "知识讲授小测"}</h3><p className="mt-0.5 text-[10px] text-stone-400">提交于 {new Date(attempt.submittedAt).toLocaleString("zh-CN")}</p></div>
                    <strong className="text-sm tabular-nums text-blue-800">{attempt.score}/{attempt.maxScore} 分</strong>
                  </header>
                  <ol className="divide-y divide-stone-100">
                    {attempt.questions.map((question, index) => {
                      const passed = question.correct === true || (question.points > 0 && question.earned / question.points >= 0.8);
                      const knowledgePointNames = question.knowledgePointIds.map((id) => course.content.knowledgePoints.find((point) => point.id === id)?.name ?? id);
                      return (
                        <li className="p-4" key={question.questionId}>
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0"><p className="text-[10px] font-bold text-stone-400">第 {index + 1} 题</p><p className="mt-1 text-sm font-bold leading-6 text-stone-900">{question.prompt}</p></div>
                            <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold", passed ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700")}>{passed ? <CheckCircle2 size={12} /> : <CircleX size={12} />}{question.earned}/{question.points} 分</span>
                          </div>
                          <div className="mt-3 grid gap-2 sm:grid-cols-2">
                            <AnswerBlock label="学生答案" text={question.answer || "未作答"} tone={passed ? "neutral" : "danger"} />
                            <AnswerBlock label="参考答案" text={question.referenceAnswer || "暂无参考答案"} tone="success" />
                          </div>
                          {question.feedback ? <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800"><strong>评阅反馈：</strong>{question.feedback}</p> : null}
                          <p className="mt-2 text-[10px] text-stone-400">对应知识点：{knowledgePointNames.join(" · ") || "未关联"}</p>
                        </li>
                      );
                    })}
                  </ol>
                </article>
              );
            }) : <Empty text="该学生暂未提交知识讲授小测" />}
          </section>
        )}
      </DrawerContent>
    </Drawer>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[10px] font-semibold text-stone-500">{label}</p><p className="mt-1 text-base font-bold text-stone-900">{value}</p></div>;
}

function AnswerBlock({ label, text, tone }: { label: string; text: string; tone: "neutral" | "danger" | "success" }) {
  return <div className={cn("rounded-lg border px-3 py-2", tone === "danger" ? "border-rose-100 bg-rose-50/60" : tone === "success" ? "border-emerald-100 bg-emerald-50/60" : "border-stone-200 bg-stone-50")}><p className="text-[10px] font-bold text-stone-400">{label}</p><p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-stone-700">{text}</p></div>;
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-stone-200 py-8 text-center text-sm text-stone-500">{text}</div>;
}
