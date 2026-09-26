"use client";

import { useState } from "react";
import type { Course } from "@/lib/session/types";
import { firstKnowledgeLectureAttempts, isCurrentAiLearningEntry } from "@/lib/knowledge-lecture";
import type { KnowledgeDashboardMetrics } from "@/lib/classroom/teacher-dashboard-metrics";
import styles from "./teacher-presentation-analytics.module.css";

type StudentRow = KnowledgeDashboardMetrics["studentRows"][number];

export function knowledgeMountainBins(rows: StudentRow[]) {
  const bins = Array.from({ length: 10 }, (_, index) => ({
    index,
    label: index === 9 ? "90–100%" : `${index * 10}–${index * 10 + 9}%`,
    students: [] as StudentRow[],
  }));
  const unknown: StudentRow[] = [];
  for (const row of rows) {
    if (row.preciseProgress === undefined) {
      unknown.push(row);
      continue;
    }
    bins[Math.min(9, Math.floor(row.preciseProgress / 10))]!.students.push(row);
  }
  return { bins, unknown };
}

function currentSection(course: Course, row: StudentRow): string {
  if (row.preciseProgress === undefined) return "进度待核验";
  if (row.preciseProgress >= 100) return "主课已完成";
  if (!row.hasEvidence) return "尚未开始";
  const sections = course.content.knowledgeLectureSections ?? [];
  const completed = new Set(course.aiLearningProgress?.[row.student.id]?.completedOutlineIds ?? []);
  const next = sections.find((section) => section.sceneOutlineIds.some((id) => !completed.has(id)));
  return next?.title ?? "主课学习中";
}

function quizStatus(course: Course, row: StudentRow): string {
  const entry = course.aiLearningProgress?.[row.student.id];
  const attempts = entry && isCurrentAiLearningEntry(course, entry) ? firstKnowledgeLectureAttempts(entry) : [];
  if (!attempts.length) return "尚未提交小测";
  const graded = attempts.filter((attempt) => attempt.gradingSource === "server" && attempt.gradingStatus === "graded").length;
  return graded === attempts.length ? `已批阅 ${graded} 节` : `已交 ${attempts.length} 节，已批阅 ${graded} 节`;
}

export function KnowledgeLearningMountain({ course, data, onDetails, onStudentDetails }: {
  course: Course;
  data: KnowledgeDashboardMetrics;
  onDetails: () => void;
  onStudentDetails?: (studentId: string) => void;
}) {
  const [selected, setSelected] = useState<number | "unknown" | null>(null);
  const { bins, unknown } = knowledgeMountainBins(data.studentRows);
  const valid = data.studentRows.filter((row) => row.preciseProgress !== undefined);
  const average = valid.length
    ? valid.reduce((sum, row) => sum + row.preciseProgress!, 0) / valid.length
    : undefined;
  const started = valid.filter((row) => row.hasEvidence || row.preciseProgress! > 0);
  const highest = started.length ? Math.max(...started.map((row) => row.preciseProgress!)) : undefined;
  const leaders = highest === undefined ? [] : started.filter((row) => row.preciseProgress === highest)
    .sort((left, right) => left.student.name.localeCompare(right.student.name, "zh-CN"));
  const leaderNames = leaders.slice(0, 3).map((row) => row.student.name).join("、");
  const maxCount = Math.max(1, ...bins.map((bin) => bin.students.length));
  const topPoints = bins.map((bin) => `${36 + bin.index * 72},${112 - bin.students.length / maxCount * 94}`).join(" ");
  const selectedRows = selected === "unknown" ? unknown : selected === null ? [] : bins[selected]?.students ?? [];
  const selectedLabel = selected === "unknown" ? "待核验" : selected === null ? "" : bins[selected]?.label ?? "";

  return <section aria-label="班级学习山形图" className={styles.knowledgeMountain}>
    <div className={styles.mountainHeading}>
      <div><h3>班级学习山形图</h3><p>山形高度代表人数；每个点代表一名学生</p></div>
      <div className={styles.mountainStats}>
        <span>平均进度 <strong>{average === undefined ? "—" : `${Math.round(average)}%`}</strong><small>有效 {valid.length}/{data.studentRows.length} 人</small></span>
        <span>已完成 <strong>{data.stateCounts.completed}</strong><small>本场参与学生</small></span>
        <span>领先学生 <strong title={leaderNames}>{leaders.length ? leaderNames : "等待开始"}</strong><small>{leaders.length > 3 ? `等 ${leaders.length} 人并列` : leaders.length > 1 ? `${leaders.length} 人并列` : highest === undefined ? "" : `${Math.round(highest)}%`}</small></span>
      </div>
    </div>
    <div className={styles.mountainScroller}>
      <div className={styles.mountainPlot}>
        <svg aria-label={`学习进度分布：${bins.map((bin) => `${bin.label} ${bin.students.length}人`).join("、")}；待核验${unknown.length}人`} className={styles.mountainShape} role="img" viewBox="0 0 720 132" preserveAspectRatio="none">
          {[0, 0.5, 1].map((fraction) => <line key={fraction} x1="0" x2="720" y1={112 - fraction * 94} y2={112 - fraction * 94} stroke="#e2e9ee" strokeDasharray="3 4" />)}
          <polygon points={`0,112 ${topPoints} 720,112`} fill="#cce7e1" fillOpacity="0.78" stroke="#358274" strokeWidth="2" strokeLinejoin="round" />
          {average !== undefined ? <line aria-hidden="true" x1={Math.max(0, Math.min(720, average / 100 * 720))} x2={Math.max(0, Math.min(720, average / 100 * 720))} y1="3" y2="116" stroke="#344a6a" strokeDasharray="4 3" strokeWidth="2" /> : null}
        </svg>
        <div className={styles.mountainColumns}>
          {bins.map((bin) => <button aria-label={`${bin.label}，${bin.students.length}人，查看名单`} aria-pressed={selected === bin.index} className={styles.mountainColumn} key={bin.index} onClick={() => setSelected((value) => value === bin.index ? null : bin.index)} type="button">
            <strong>{bin.students.length} 人</strong>
            <span className={styles.mountainDots}>
              {bin.students.slice(0, 40).map((row) => <i aria-hidden="true" data-state={row.preciseProgress === 100 ? "completed" : row.hasEvidence ? "learning" : "not-started"} key={row.student.id} />)}
            </span>
            {bin.students.length > 40 ? <em>另有 {bin.students.length - 40} 人</em> : null}
            <small>{bin.label}</small>
          </button>)}
        </div>
      </div>
    </div>
    <div className={styles.mountainFoot}>
      <button aria-pressed={selected === "unknown"} className={styles.unknownButton} onClick={() => setSelected((value) => value === "unknown" ? null : "unknown")} type="button">待核验 {unknown.length} 人</button>
      <span>虚线表示全班有效记录的平均进度</span>
      <button className={styles.mountainDetails} onClick={onDetails} type="button">查看全部明细</button>
    </div>
    {selected !== null ? <div aria-label={`${selectedLabel}学生名单`} className={styles.mountainList} role="region">
      <div><strong>{selectedLabel} · {selectedRows.length} 人</strong><button aria-label="收起名单" onClick={() => setSelected(null)} type="button">收起</button></div>
      {selectedRows.length ? <ul>{selectedRows.map((row) => <li key={row.student.id}>
        <span><strong title={row.student.name}>{row.student.name}</strong><small>{currentSection(course, row)} · {quizStatus(course, row)}</small></span>
        <b>{row.preciseProgress === undefined ? "待核验" : `${Number(row.preciseProgress.toFixed(2))}%`}</b>
        <button onClick={() => onStudentDetails ? onStudentDetails(row.student.id) : onDetails()} type="button">查看明细</button>
      </li>)}</ul> : <p>该区间暂无学生</p>}
    </div> : null}
  </section>;
}
