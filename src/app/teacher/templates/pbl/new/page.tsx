"use client";
import { LearningArt } from "@/components/platform/learning-art";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { TeacherPlatformHeader, TeacherPlatformPage } from "@/components/platform/teacher-shell";
import { teacherPlatformFetch } from "@/lib/platform/client";

const field = "mt-2 min-h-11 w-full rounded-[6px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-3 py-2 text-sm";
export default function NewPblTemplatePage() {
  const router = useRouter();
  const [name, setName] = useState(""); const [subject, setSubject] = useState(""); const [grade, setGrade] = useState(""); const [hours, setHours] = useState(1);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await teacherPlatformFetch("/api/platform/templates/pbl", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, subject, grade, hours }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "创建失败，请重试");
      router.push(`/teacher/prepare/${data.templateId}/verify`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "创建失败，请重试"); setBusy(false); }
  }
  return <TeacherPlatformPage><TeacherPlatformHeader active="templates" backHref="/teacher/templates" backLabel="返回课程库" /><div className="pbl-workspace-content"><div className="mx-auto max-w-4xl">
    <div className="pbl-page-heading"><LearningArt /><div><p className="text-xs tracking-widest text-[var(--pbl-teacher)]">从想法出发 / 新建课程</p><h1 className="mt-5 font-serif text-3xl font-semibold">完整五阶段备课</h1>
    <p className="mt-4 text-sm leading-7 text-[var(--pbl-text-muted)]">设计项目启动、知识讲授、项目实践、成果汇报与评价、学习反思，继续编辑知识图谱、生成课堂资源并预览发布。</p></div></div>
    <form onSubmit={submit} className="pbl-create-form space-y-6"><fieldset disabled={busy} className="space-y-5">
      <label className="block text-sm font-medium">课程名称<input className={field} required maxLength={160} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="grid gap-5 sm:grid-cols-2"><label className="block text-sm font-medium">学科<input className={field} maxLength={100} value={subject} onChange={(e) => setSubject(e.target.value)} /></label><label className="block text-sm font-medium">年级<input className={field} maxLength={100} value={grade} onChange={(e) => setGrade(e.target.value)} /></label></div>
      <label className="block text-sm font-medium">课时<input className={field} type="number" required min={0.1} max={100} step={0.1} value={hours} onChange={(e) => setHours(Number(e.target.value))} /></label>
    </fieldset>{error && <p role="alert" className="text-sm text-[var(--pbl-danger)]">{error}</p>}<button disabled={busy} className="min-h-11 rounded-[6px] bg-[var(--pbl-teacher)] px-5 text-sm font-medium text-white disabled:opacity-50">{busy ? "创建中…" : "创建并进入备课"}</button></form>
  </div></div></TeacherPlatformPage>;
}
