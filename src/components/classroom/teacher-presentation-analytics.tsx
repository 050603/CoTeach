"use client";

import type { Course } from "@/lib/session/types";
import type { ShowcaseData } from "@/lib/showcase/types";
import {
  deriveKnowledgeDashboardMetrics,
  deriveLaunchDashboardMetrics,
  deriveMakeDashboardMetrics,
  deriveShowcaseDashboardMetrics,
  type TeacherDashboardMetric,
} from "@/lib/classroom/teacher-dashboard-metrics";
import { latestReflectionByStudent, normalizeReflectionSurvey, reflectionSurveyDistribution } from "@/lib/reflection-survey";
import { deriveTeacherClassroomPulse } from "./teacher-classroom-pulse";
import styles from "./teacher-presentation-analytics.module.css";

type AggregateRow = { label: string; value: string; detail?: string; percent?: number };
type StageSummary = { title: string; rows: AggregateRow[]; empty: string; headlines?: TeacherDashboardMetric[] };

function stageSummary(course: Course, stageKey: string, showcaseData?: ShowcaseData): StageSummary {
  if (stageKey === "launch") {
    const data = deriveLaunchDashboardMetrics(course);
    return {
      title: "资料阅读覆盖", empty: "尚未发布启动资料",
      rows: data.resourceCoverage.map(({ resource, openedCount, completedCount }) => ({
        label: resource.title,
        value: course.students.length ? `${openedCount}/${course.students.length} 人已打开` : "暂无学生",
        detail: `${completedCount} 人已完成`,
        percent: course.students.length ? openedCount / course.students.length * 100 : undefined,
      })),
      headlines: [
        ...data.headlines.slice(0, 2),
        { metricId: "launch-reading-coverage", label: "资料阅读覆盖率", value: data.states.some((state) => state.status !== "not-opened") ? `${Math.round(data.states.filter((state) => state.status !== "not-opened").length / data.states.length * 100)}%` : "—", helper: "已打开的学生与资料组合占全部组合的比例" },
      ],
    };
  }
  if (stageKey === "ai-learning") {
    const data = deriveKnowledgeDashboardMetrics(course);
    return {
      title: "知识掌握汇总", empty: "尚未配置知识点",
      rows: data.masteryRows.map((row) => ({
        label: row.name,
        value: row.maxScore > 0 ? `${Math.round(row.earned / row.maxScore * 100)}%` : "待产生作答记录",
        detail: `${row.answeredStudents}/${course.students.length} 人已作答 · 首次作答得分率`,
        percent: row.maxScore > 0 ? row.earned / row.maxScore * 100 : undefined,
      })),
      headlines: [...data.headlines.slice(0, 2), { metricId: "knowledge-completed", label: "已完成学习", value: course.students.length ? `${data.stateCounts.completed}/${course.students.length}` : "—", helper: "学习进度达到完成边界" }],
    };
  }
  if (stageKey === "make") {
    const data = deriveMakeDashboardMetrics(course);
    const hasDecisions = data.decisionCounts.adopted + data.decisionCounts.rejected > 0;
    return {
      title: "AI 协作汇总", empty: "等待有效协作记录",
      rows: [
        { label: "参与 AI 协作", value: data.collaborationStudentIds.size ? `${data.collaborationStudentIds.size} 人` : "待产生协作记录", detail: "主动请求协作或记录判断的学生" },
        { label: "采纳或修改建议", value: hasDecisions ? `${data.decisionCounts.adopted} 次` : "待产生判断记录" },
        { label: "未采纳建议", value: hasDecisions ? `${data.decisionCounts.rejected} 次` : "待产生判断记录" },
      ],
      headlines: [...data.headlines.slice(0, 2), { metricId: "make-collaboration", label: "AI 协作覆盖", value: course.students.length && data.collaborationStudentIds.size ? `${data.collaborationStudentIds.size}/${course.students.length}` : "—", helper: "按学生主动协作记录计算" }],
    };
  }
  if (stageKey === "showcase") {
    const data = deriveShowcaseDashboardMetrics(course, showcaseData);
    return { title: "汇报安排", empty: "暂无可汇报队列", rows: data.queue.length ? [
      { label: "待投屏", value: `${data.pendingApprovals.length} 人` },
      { label: "等待汇报", value: `${data.statusCounts.waiting} 人` },
      { label: "汇报中", value: `${data.statusCounts.presenting} 人` },
      { label: "待完成评价", value: `${data.statusCounts.evaluating} 人` },
    ] : [] };
  }
  const latest = latestReflectionByStudent(course.reflections);
  const valid = course.students.flatMap((student) => {
    const record = latest.get(student.id);
    return record && normalizeReflectionSurvey(record.survey) ? [record] : [];
  });
  return {
    title: "反思评价分布", empty: "等待有效结构化问卷",
    rows: valid.length ? ([
      ["aiHelpfulness", "AI 帮助度"], ["systemUsability", "系统易理解度"], ["reuseIntention", "继续使用意愿"],
    ] as const).map(([key, label]) => {
      const counts = reflectionSurveyDistribution(valid, key);
      return { label, value: `${valid.length} 份评价`, detail: Object.entries(counts).map(([score, count]) => `${score} 分：${count}`).join("　") };
    }) : [],
  };
}

export function TeacherPresentationAnalytics({ course, stageKey, showcaseData, degraded = false, onDetails }: {
  course: Course;
  stageKey: string;
  showcaseData?: ShowcaseData;
  degraded?: boolean;
  onDetails: () => void;
}) {
  const pulse = deriveTeacherClassroomPulse(course, stageKey, showcaseData);
  const summary = pulse.metrics.length ? stageSummary(course, stageKey, showcaseData) : undefined;
  const metrics = summary?.headlines ?? pulse.metrics;
  const chartLabel = stageKey === "reflection" ? "反思提交状态" : pulse.chartLabel;
  return (
    <section className={styles.root} aria-label="班级学情大屏">
      <header className={styles.header}>
        <h2>班级学情</h2>
        <button type="button" className={styles.details} onClick={onDetails}>查看明细</button>
      </header>
      {degraded ? <p role="status" className={styles.notice}>数据同步延迟，当前显示最近收到的课堂记录</p> : null}
      {!summary ? <p className={styles.empty}>当前阶段暂无可用统计</p> : <>
        {!course.students.length ? <p className={styles.empty}>暂无学生加入课堂</p> : null}
        <div className={styles.metrics}>
          {metrics.map((metric) => (
            <button type="button" className={styles.metric} onClick={onDetails} key={metric.metricId}>
              <span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.helper}</small>
            </button>
          ))}
        </div>
        <div className={styles.charts}>
          <section className={styles.panel} aria-label={chartLabel}>
            <h3>{chartLabel}</h3>
            {pulse.total ? <>
              <div role="img" aria-label={pulse.segments.map((segment) => `${segment.label}${segment.count}`).join("、")} className={styles.stacked}>
                {pulse.segments.map((segment, index) => <span key={segment.label} data-color={index} style={{ width: `${segment.count / pulse.total * 100}%` }} />)}
              </div>
              <div className={styles.legend}>
                {pulse.segments.map((segment, index) => (
                  <button type="button" onClick={onDetails} key={segment.label}>
                    <i aria-hidden="true" data-color={index} /><span>{segment.label}</span><strong>{segment.count}</strong>
                  </button>
                ))}
              </div>
              <p className={styles.caption}>{stageKey === "launch" ? "按每名学生的每份资料统计" : stageKey === "showcase" ? "按汇报队列统计" : "按本班学生统计"}</p>
            </> : <p className={styles.empty}>待产生数据</p>}
          </section>
          <section className={styles.panel} aria-label={summary.title}>
            <h3>{summary.title}</h3>
            <div className={styles.rows}>
              {summary.rows.length ? summary.rows.map((row, index) => (
                <button type="button" key={`${row.label}-${index}`} className={styles.row} onClick={onDetails}>
                  <span className={styles.rowHeading}><span>{row.label}</span><strong>{row.value}</strong></span>
                  {row.percent !== undefined ? <span className={styles.track} aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, row.percent))}%` }} /></span> : null}
                  {row.detail ? <small>{row.detail}</small> : null}
                </button>
              )) : <p className={styles.empty}>{summary.empty}</p>}
            </div>
          </section>
        </div>
      </>}
    </section>
  );
}
