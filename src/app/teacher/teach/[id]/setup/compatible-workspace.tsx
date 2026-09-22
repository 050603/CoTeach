"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowLeft, BookOpen, PlayCircle, RefreshCw } from "lucide-react";
import { DashboardShell } from "@/components/dashboard-shell";
import { InviteCodeCard } from "@/components/invite-code-card";
import { Card, PrimaryButton, AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, Button } from "@/components/ui";

import { readTemplateContent } from "@/lib/platform/template-content";

type Props = { id: string; title: string; userName: string; offeringId: string; activityId: string; templateVersionId: string; status: string; inviteCode?: string; snapshot: unknown };

export default function CompatibleWorkspace(props: Props) {
  const router = useRouter();
  const [saving, setBusy] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const busy = saving || refreshing;
  const [error, setError] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const status = props.status.toLowerCase();
  const lesson = readTemplateContent(props.snapshot);
  async function act(action: "start" | "finish" | "again") {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(action === "again" ? `/api/platform/activities/${props.activityId}/instance` : `/api/platform/classroom-instances/${props.id}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, ...(action === "again" ? { body: JSON.stringify({ templateVersionId: props.templateVersionId }) } : {}) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "课堂操作失败，请重试");
      setConfirmEnd(false);
      startTransition(() => {
        if (action === "again") router.push(`/teacher/teach/${data.instance.id}/setup`);
        else router.refresh();
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "课堂操作失败，请重试"); }
    finally { setBusy(false); }
  }
  return <DashboardShell backHref={`/teacher/classes/${encodeURIComponent(props.offeringId)}`} backLabel="返回教学班" role="teacher" userName={props.userName} variant="bare">
    <div className="mb-5 flex items-center gap-3"><Link className="grid h-9 w-9 place-items-center rounded-md border border-stone-200 bg-white" href={`/teacher/classes/${props.offeringId}`} aria-label="返回课程"><ArrowLeft size={17}/></Link><div><p className="text-sm text-stone-500">课堂工作台</p><h1 className="text-2xl font-bold">{props.title}</h1></div></div>
    <div className="grid gap-5 xl:grid-cols-[1fr_360px]"><div className="space-y-5"><Card><h2 className="flex items-center gap-2 text-xl font-bold"><BookOpen size={20}/>课堂教案</h2><p className="mt-3 text-sm leading-7 text-stone-500">沿用本课堂的已发布教案。学生在各自的学习工作区完成实践与提交。</p>{lesson ? <><p className="mt-4 whitespace-pre-wrap break-words text-sm leading-7">{lesson.summary}</p><p className="mt-3 text-xs text-stone-500">{[lesson.subject, lesson.grade, `${lesson.durationMinutes} 分钟`].filter(Boolean).join(" · ")}</p><h3 className="mt-5 font-semibold">学习目标</h3><ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-7">{lesson.learningObjectives.map((objective, index) => <li key={index}>{objective}</li>)}</ul>{lesson.outline.map((section, index) => <section key={index} className="mt-5 rounded-lg border border-stone-200 p-4"><h3 className="font-semibold">{section.title}<span className="ml-3 text-xs font-normal text-stone-500">{section.durationMinutes} 分钟</span></h3><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7">{section.description}</p></section>)}{lesson.resources.length > 0 && <section className="mt-5"><h3 className="font-semibold">学习资源</h3><ul className="mt-3 space-y-3 text-sm">{lesson.resources.map((resource, index) => <li key={index}>{resource.url ? <a className="break-words text-blue-700 underline" href={resource.url} target="_blank" rel="noopener noreferrer">{resource.title}</a> : resource.title}</li>)}</ul></section>}</> : <p role="alert" className="mt-4 text-sm text-amber-800">此教案内容格式暂不支持预览，请到课程库核对已发布版本。已有学生记录仍可查看。</p>}</Card></div><aside className="space-y-5">{props.inviteCode && <InviteCodeCard code={props.inviteCode} hint="教学班邀请码；学生加入课程后进入本课堂"/>}<Card><h2 className="text-lg font-bold">{status === "teaching" ? "课堂进行中" : status === "finished" ? "本场课堂已结束" : "准备开始课堂"}</h2><p className="mt-3 text-sm leading-7 text-stone-500">{status === "teaching" ? "学生可以学习、创作并提交成果。" : status === "finished" ? "本场学习记录已保留，再次授课将创建新的待授课场次。" : "进入工作台不会自动开始课堂。开始后学生可以编辑和提交。"}</p><PrimaryButton className="mt-4 w-full" disabled={busy} onClick={() => status === "teaching" ? setConfirmEnd(true) : void act(status === "finished" ? "again" : "start")}>{status === "finished" ? <RefreshCw size={18}/> : <PlayCircle size={18}/>} {busy ? "正在保存…" : status === "teaching" ? "结束课堂" : status === "finished" ? "再次授课" : "开始上课"}</PrimaryButton><Link className="mt-4 block text-center text-sm text-blue-700" href={`/teacher/classrooms/${props.id}`}>查看课堂学习记录</Link>{error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}</Card></aside></div>
    <AlertDialog open={confirmEnd} onOpenChange={setConfirmEnd}><AlertDialogContent><AlertDialogTitle>结束本次课堂？</AlertDialogTitle><AlertDialogDescription>结束后学生可以回看本场记录，无法继续编辑和提交。</AlertDialogDescription>{error && <p role="alert" className="text-sm text-red-700">{error}</p>}<AlertDialogFooter><AlertDialogCancel>继续授课</AlertDialogCancel><Button variant="danger" disabled={busy} onClick={() => void act("finish")}>{busy ? "正在结束…" : "结束课堂"}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </DashboardShell>;
}
