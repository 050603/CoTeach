"use client";

import { useState } from "react";
import type { ShowcaseAction, ShowcaseData } from "@/lib/showcase/types";
import { PrimaryButton } from "@/components/ui";

export function ShowcaseSelectionPanel({ data, busy, save }: {
  data: ShowcaseData; busy: boolean; save: (action: ShowcaseAction) => Promise<void>;
}) {
  const config = data.queueConfig;
  const locked = new Set(data.queue.filter((item) => !["waiting", "not-ready"].includes(item.status)).map((item) => item.studentId));
  const [selected, setSelected] = useState([...new Set([...(config?.selectedStudentIds ?? []), ...locked])]);
  const [presentationSec, setPresentationSec] = useState(config?.presentationSec ?? 180);
  const [discussionSec, setDiscussionSec] = useState(config?.discussionSec ?? 60);
  const [transitionSec, setTransitionSec] = useState(config?.transitionSec ?? 20);
  const total = selected.length * (presentationSec + discussionSec + transitionSec);
  return <section aria-label="选择现场汇报学生" className="my-4 space-y-3 border-y border-stone-200 py-4">
    <p className="font-semibold">全班提交作品，教师选择现场汇报者</p>
    <p className="text-sm text-stone-600">已选 {selected.length} 人 · 每人含点评与衔接 {presentationSec + discussionSec + transitionSec} 秒 · 完整安排 {total} 秒</p>
    {data.budget ? <p className="text-sm text-stone-600">本阶段剩余 {Math.floor(data.budget.stageRemainingSec)} 秒；已保存名单尚需 {data.budget.plannedRemainingSec} 秒{data.budget.overrunSec ? `，超出 ${data.budget.overrunSec} 秒，请调整安排` : ""}</p> : null}
    <div className="grid gap-2 sm:grid-cols-3">{([
      ["汇报秒数", presentationSec, setPresentationSec, 15, 3600],
      ["讨论与点评秒数", discussionSec, setDiscussionSec, 0, 1800],
      ["衔接秒数", transitionSec, setTransitionSec, 0, 600],
    ] as const).map(([label, value, setter, min, max]) => <label className="text-xs" key={label}>{label}<input aria-label={label} className="mt-1 h-11 w-full rounded-md border border-stone-300 bg-white px-2" type="number" min={min} max={max} value={value} onChange={(event) => setter(Math.max(min, Math.min(max, Math.round(Number(event.target.value) || min))))} /></label>)}</div>
    <div className="max-h-64 overflow-y-auto">{data.students.map((student) => <div key={student.studentId} className="border-b border-stone-100 py-1">
      <label className="flex min-h-11 items-center gap-2 text-sm"><input className="size-5" aria-label={`选择${student.name}现场汇报`} type="checkbox" checked={selected.includes(student.studentId)} disabled={busy || locked.has(student.studentId)} onChange={(event) => setSelected(event.target.checked ? [...selected, student.studentId] : selected.filter((id) => id !== student.studentId))} /><span>{student.name}</span><span className="text-xs text-stone-500">{student.artifacts.length ? `已交 ${student.artifacts.length} 份成果` : "尚未提交成果"}</span></label>
      {student.artifacts.map((artifact) => <a key={artifact.versionId} className="ml-7 inline-flex min-h-11 items-center text-xs text-blue-800 underline" href={artifact.downloadUrl ?? `/api/courses/${encodeURIComponent(data.courseId)}/showcase/artifacts/${encodeURIComponent(artifact.versionId)}?download=1`} download>{artifact.title}</a>)}
    </div>)}</div>
    <PrimaryButton disabled={busy} onClick={() => void save({ action: "save-queue", selectionMode: "teacher-selected", selectedStudentIds: selected,
      orderedStudentIds: [...data.queue.map((item) => item.studentId).filter((id) => selected.includes(id)), ...selected.filter((id) => !data.queue.some((item) => item.studentId === id))],
      presentationSec, discussionSec, transitionSec, minutesPerStudent: Math.min(60, Math.max(1, Math.ceil((presentationSec + discussionSec + transitionSec) / 60))),
    })} tone="blue">保存汇报名单与时间</PrimaryButton>
  </section>;
}
