import { AlertTriangle, BarChart3 } from "lucide-react";
import type { Course } from "@/lib/session/types";
import type { ShowcaseData } from "@/lib/showcase/types";
import {
  deriveKnowledgeDashboardMetrics,
  deriveLaunchDashboardMetrics,
  deriveMakeDashboardMetrics,
  deriveShowcaseDashboardMetrics,
  type TeacherDashboardMetric,
  type TeacherDashboardTone,
} from "@/lib/classroom/teacher-dashboard-metrics";
import { cn } from "@/lib/utils";

type PulseSegment = {
  label: string;
  count: number;
  className: string;
};

type ClassroomPulse = {
  chartLabel: string;
  metrics: TeacherDashboardMetric[];
  segments: PulseSegment[];
  total: number;
};

const METRIC_TONE: Record<TeacherDashboardTone, string> = {
  neutral: "text-[var(--pbl-text-strong)]",
  info: "text-[var(--pbl-teacher)]",
  success: "text-[var(--pbl-success)]",
  warning: "text-[var(--pbl-warning)]",
  danger: "text-[var(--pbl-danger)]",
};

function metricTone(metric: TeacherDashboardMetric): string {
  return METRIC_TONE[metric.tone ?? "neutral"];
}

export function deriveTeacherClassroomPulse(
  course: Course,
  stageKey: string,
  showcaseData?: ShowcaseData,
): ClassroomPulse {
  if (stageKey === "launch") {
    const data = deriveLaunchDashboardMetrics(course);
    const completed = data.states.filter((item) => item.status === "completed").length;
    const reading = data.states.filter((item) => item.status === "opened" || item.status === "in-progress").length;
    return {
      chartLabel: "资料阅读分布",
      metrics: data.headlines,
      segments: [
        { label: "已完成", count: completed, className: "bg-emerald-600" },
        { label: "阅读中", count: reading, className: "bg-blue-600" },
        { label: "未打开", count: data.states.length - completed - reading, className: "bg-stone-300" },
      ],
      total: data.states.length,
    };
  }

  if (stageKey === "ai-learning") {
    const data = deriveKnowledgeDashboardMetrics(course);
    return {
      chartLabel: "全班学习状态",
      metrics: data.headlines,
      segments: [
        { label: "已完成", count: data.stateCounts.completed, className: "bg-emerald-600" },
        { label: "学习中", count: data.stateCounts.learning, className: "bg-blue-600" },
        { label: "未开始", count: data.stateCounts.notStarted, className: "bg-stone-300" },
        { label: "待核验", count: data.stateCounts.unverified, className: "bg-amber-500" },
      ],
      total: course.students.length,
    };
  }

  if (stageKey === "make") {
    const data = deriveMakeDashboardMetrics(course);
    const submitted = data.submittedStudentIds.size;
    const drafting = [...data.draftStudentIds].filter((studentId) => !data.submittedStudentIds.has(studentId)).length;
    return {
      chartLabel: "成果推进状态",
      metrics: data.headlines,
      segments: [
        { label: "已提交", count: submitted, className: "bg-emerald-600" },
        { label: "编制中", count: drafting, className: "bg-blue-600" },
        { label: "待形成", count: Math.max(0, course.students.length - submitted - drafting), className: "bg-stone-300" },
      ],
      total: course.students.length,
    };
  }

  if (stageKey === "showcase") {
    const data = deriveShowcaseDashboardMetrics(course, showcaseData);
    const active = data.queue.filter((item) => ["called", "pending-approval", "presenting", "evaluating", "rejected"].includes(item.status)).length;
    return {
      chartLabel: data.pendingApprovals.length ? `汇报队列 · ${data.pendingApprovals.length} 人待投屏` : "汇报队列",
      metrics: data.headlines,
      segments: [
        { label: "已评价", count: data.statusCounts.completed, className: "bg-emerald-600" },
        { label: "进行中", count: active, className: "bg-blue-600" },
        { label: "等待中", count: data.statusCounts.waiting, className: "bg-amber-500" },
        { label: "未就绪", count: data.statusCounts["not-ready"], className: "bg-stone-300" },
      ],
      total: data.queue.length,
    };
  }

  if (stageKey !== "reflection") {
    return { chartLabel: "当前阶段暂无可用统计", metrics: [], segments: [], total: 0 };
  }

  const data = course.experimentPosttestSummary;
  if (!data?.enabled) {
    return {
      chartLabel: "本课堂未开启后测",
      metrics: [{ metricId: "posttest-disabled", label: "后测状态", value: "未开启", helper: "请在实验配置中设置后测题目", tone: "neutral" }],
      segments: [],
      total: 0,
    };
  }

  const total = data.notStartedCount + data.inProgressCount + data.submittedCount;
  return {
    chartLabel: "后测作答状态",
    metrics: [
      { metricId: "posttest-not-started", label: "未开始", value: String(data.notStartedCount), helper: "尚未开始后测", tone: "neutral" },
      { metricId: "posttest-in-progress", label: "作答中", value: String(data.inProgressCount), helper: "已保存答题草稿", tone: "info" },
      { metricId: "posttest-submitted", label: "已提交", value: String(data.submittedCount), helper: "已正式提交后测", tone: "success" },
    ],
    segments: [
      { label: "已提交", count: data.submittedCount, className: "bg-emerald-600" },
      { label: "作答中", count: data.inProgressCount, className: "bg-teal-600" },
      { label: "未开始", count: data.notStartedCount, className: "bg-stone-300" },
    ],
    total,
  };
}

function PulseChart({ label, segments, total }: { label: string; segments: PulseSegment[]; total: number }) {
  const accessibleLabel = segments.map((segment) => `${segment.label}${segment.count}`).join("、");
  return (
    <div className="border-t border-[var(--pbl-border)] px-4 py-3 lg:border-l lg:border-t-0">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate font-semibold text-[var(--pbl-text-muted)]" title={label}>{label}</span>
        <span className="shrink-0 tabular-nums text-[var(--pbl-text-muted)]">{total ? `${total} 项` : "待产生数据"}</span>
      </div>
      <div aria-label={accessibleLabel} className="mt-2 flex h-2 overflow-hidden rounded-full bg-[var(--pbl-surface-soft)]" role="img">
        {segments.map((segment) => (
          <span
            className={segment.className}
            key={segment.label}
            style={{ width: `${segment.count / Math.max(1, total) * 100}%` }}
          />
        ))}
      </div>
      <div className={cn("mt-2 grid gap-x-3 gap-y-1", segments.length === 2 ? "grid-cols-2" : segments.length === 3 ? "grid-cols-3" : "grid-cols-2")}>
        {segments.map((segment) => (
          <span className="flex min-w-0 items-center gap-1 text-[10px] text-[var(--pbl-text-muted)]" key={segment.label}>
            <i aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", segment.className)} />
            <span className="truncate">{segment.label}</span>
            <strong className="ml-auto tabular-nums text-[var(--pbl-text-strong)]">{segment.count}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

export function TeacherClassroomPulse({
  course,
  stageKey,
  showcaseData,
  degraded = false,
}: {
  course: Course;
  stageKey: string;
  showcaseData?: ShowcaseData;
  degraded?: boolean;
}) {
  const pulse = deriveTeacherClassroomPulse(course, stageKey, showcaseData);
  const stageLabel = stageKey === "reflection" ? "后测" : course.stages.find((stage) => stage.key === stageKey)?.label ?? "当前阶段";
  return (
    <section
      aria-label={`${stageLabel}课堂数据速览`}
      className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)]"
    >
      <div className="grid lg:grid-cols-[11rem_minmax(0,1fr)_16rem]">
        <header className="flex items-center gap-3 px-4 py-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]">
            <BarChart3 size={18} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h2 className="truncate text-sm font-semibold text-[var(--pbl-text-strong)]">课堂数据速览</h2>
              {degraded ? <AlertTriangle aria-label="数据同步延迟" className="shrink-0 text-[var(--pbl-warning)]" size={13} /> : null}
            </div>
            <p className="mt-0.5 truncate text-[10px] text-[var(--pbl-text-muted)]">{stageLabel} · 实时课堂记录</p>
          </div>
        </header>

        <dl className="grid grid-cols-3 border-t border-[var(--pbl-border)] lg:border-l lg:border-t-0">
          {pulse.metrics.slice(0, 3).map((metric, index) => (
            <div className={cn("min-w-0 px-3 py-3", index > 0 && "border-l border-[var(--pbl-border)]")} key={metric.metricId} title={metric.helper}>
              <dt className="truncate text-[10px] font-medium text-[var(--pbl-text-muted)]">{metric.label}</dt>
              <dd className={cn("mt-1 truncate text-lg font-semibold leading-none tabular-nums", metricTone(metric))}>{metric.value}</dd>
              <p className="mt-1 truncate text-[9px] text-[var(--pbl-text-muted)]">{metric.helper ?? "实时课堂数据"}</p>
            </div>
          ))}
        </dl>

        <PulseChart label={pulse.chartLabel} segments={pulse.segments} total={pulse.total} />
      </div>
    </section>
  );
}
