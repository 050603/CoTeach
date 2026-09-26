"use client";

/**
 * TeacherResourceViewer — 教师授课资源查看器
 *
 * 展示从 OpenMAIC 生成结果中拆分出的教师资源（课程引入 + PBL 题目讲解）：
 * - PPT 预览：使用轻量场景渲染器展示教师资源课堂
 * - 讲稿文本：按场景列出讲稿内容，教师可复制/打印
 *
 * 使用 teacherClassroomId 加载独立的教师资源课堂，与学生 AI 授知课堂完全隔离。
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Copy, FileText, Monitor } from "lucide-react";
import { toast } from "sonner";
import { copyTextToClipboard } from "@/lib/browser/copy-text";
import type { TeacherResources } from "@/lib/session/types";
import { teacherResourceTypeLabel } from "@/lib/openmaic-bridge/teacher-resources";
import { cn } from "@/lib/utils";
import { OpenMaicResourcePlayer } from "./openmaic-resource-player";
import { userFacingName, userFacingStageLabel } from "@/lib/user-facing-labels";

type Tab = "slides" | "script";

export function TeacherResourceViewer({
  teacherClassroomId,
  teacherResources,
  courseName,
  backHref,
}: {
  teacherClassroomId: string;
  teacherResources?: TeacherResources;
  courseName: string;
  backHref: string;
}) {
  const [tab, setTab] = useState<Tab>("slides");
  const scenes = useMemo(
    () => teacherResources?.scenes ?? [],
    [teacherResources?.scenes],
  );
  const [requestedSceneId, setRequestedSceneId] = useState(scenes[0]?.id ?? "");
  const selectedSceneId = scenes.some((scene) => scene.id === requestedSceneId)
    ? requestedSceneId
    : (scenes[0]?.id ?? "");

  return (
    <div className="space-y-4">
      {/* 顶部导航 */}
      <div className="flex items-center gap-3">
        <Link
          className="grid h-9 w-9 place-items-center rounded-[6px] border border-stone-200 bg-white text-stone-500 hover:bg-stone-50"
          href={backHref}
        >
          <ArrowLeft size={17} />
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-[24px] font-bold">{courseName} · 教师授课资源</h1>
          <p className="text-sm text-stone-500">
            按课程阶段生成的 PPT、互动演示与讲稿 · {scenes.length} 个资源场景
          </p>
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="flex gap-1 rounded-[var(--radius-sm)] border border-stone-200 bg-stone-50 p-1">
        <button
          type="button"
          onClick={() => setTab("slides")}
          className={cn(
            "inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-[6px] text-sm font-semibold transition",
            tab === "slides"
              ? "bg-white text-blue-700 shadow-sm"
              : "text-stone-500 hover:text-stone-700",
          )}
        >
          <Monitor size={16} /> PPT 预览
        </button>
        <button
          type="button"
          onClick={() => setTab("script")}
          className={cn(
            "inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-[6px] text-sm font-semibold transition",
            tab === "script"
              ? "bg-white text-blue-700 shadow-sm"
              : "text-stone-500 hover:text-stone-700",
          )}
        >
          <FileText size={16} /> 讲稿文本
        </button>
      </div>

      {/* 内容区 */}
      {tab === "slides" ? (
        <section className="grid overflow-hidden rounded-[var(--radius-lg)] border border-stone-200 bg-white shadow-sm lg:grid-cols-[260px_minmax(0,1fr)]">
          <div className="border-b border-stone-200 bg-stone-50 p-3 lg:border-b-0 lg:border-r">
            <div className="space-y-1.5">
              {scenes.map((scene, index) => (
                <button
                  className={cn(
                    "w-full rounded-[6px] border px-3 py-2.5 text-left",
                    scene.id === selectedSceneId
                      ? "border-blue-200 bg-white text-blue-800 shadow-sm"
                      : "border-transparent text-stone-600 hover:border-stone-200 hover:bg-white",
                  )}
                  key={scene.id}
                  onClick={() => setRequestedSceneId(scene.id)}
                  type="button"
                >
                  <span className="block text-xs font-bold">{index + 1}. {userFacingName(scene.title, "未命名授课资源")}</span>
                  <span className="mt-1 block text-[10px] text-stone-400">
                    {userFacingStageLabel(scene.stageKey, scene.stageLabel)}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <OpenMaicResourcePlayer
            className="h-[640px]"
            classroomId={teacherClassroomId}
            sceneId={selectedSceneId || undefined}
          />
        </section>
      ) : (
        <ScriptTab scenes={scenes} />
      )}
    </div>
  );
}

// ===== 讲稿文本 Tab =====
function ScriptTab({
  scenes,
}: {
  scenes: TeacherResources["scenes"];
}) {
  if (scenes.length === 0) {
    return (
      <div className="rounded-[8px] border border-dashed border-stone-200 bg-stone-50 p-8 text-center text-sm text-stone-500">
        暂无讲稿数据。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {scenes.map((scene, index) => (
        <div
          key={scene.id}
          className="overflow-hidden rounded-[var(--radius-md)] border border-stone-200 bg-white shadow-sm"
        >
          <div className="flex items-center justify-between border-b border-stone-100 bg-stone-50/80 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <span className="grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] bg-blue-50 text-xs font-bold text-blue-700">
                {index + 1}
              </span>
              <div>
                <div className="text-sm font-bold text-stone-900">{userFacingName(scene.title, "未命名授课资源")}</div>
                <div className="text-xs text-stone-500">
                  {scene.role === "introduction"
                    ? "课程引入"
                    : scene.role === "pbl-topic"
                      ? "PBL 题目讲解"
                      : "课堂演示"}{" "}
                  · {teacherResourceTypeLabel(scene.type)} · {userFacingStageLabel(scene.stageKey, scene.stageLabel)} · {teacherResourcePurposeLabel(scene.generationPurpose)}
                </div>
              </div>
            </div>
            {scene.script ? (
              <button
                type="button"
                onClick={() => { void copyTextToClipboard(scene.script!).then(() => toast.success("讲稿已复制"), () => toast.error("复制失败，请选中讲稿后手动复制。")); }}
                className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-xs)] px-2.5 text-xs font-semibold text-stone-500 transition hover:bg-white hover:text-blue-700"
              >
                <Copy size={13} /> 复制讲稿
              </button>
            ) : null}
          </div>
          <div className="px-4 py-4">
            {scene.description ? (
              <p className="mb-3 text-sm leading-6 text-stone-600">{scene.description}</p>
            ) : null}
            {scene.keyPoints.length > 0 ? (
              <div className="mb-3">
                <div className="mb-1.5 text-xs font-bold text-stone-400">核心要点</div>
                <ul className="space-y-1">
                  {scene.keyPoints.map((kp, i) => (
                    <li key={i} className="flex gap-2 text-sm leading-6 text-stone-600">
                      <span className="text-stone-300">·</span>
                      <span>{kp}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {scene.script ? (
              <div>
                <div className="mb-1.5 text-xs font-bold text-stone-400">讲稿</div>
                <div className="whitespace-pre-wrap rounded-[var(--radius-sm)] bg-stone-50 p-3 text-sm leading-7 text-stone-700 ring-1 ring-stone-200/70">
                  {scene.script}
                </div>
              </div>
            ) : (
              <div className="rounded-[var(--radius-sm)] border border-dashed border-stone-200 bg-stone-50 p-3 text-xs text-stone-400">
                该场景暂无讲稿文本（可能未启用 TTS 语音合成）。
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function teacherResourcePurposeLabel(
  purpose: TeacherResources["scenes"][number]["generationPurpose"],
): string {
  switch (purpose) {
    case "facilitation-scaffold":
      return "教师主持支架";
    case "companion-guidance":
      return "伴学引导提示";
    case "knowledge-teaching":
      return "知识讲解";
    default:
      return "教师资源";
  }
}
