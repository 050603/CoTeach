"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Loader2,
  MonitorUp,
  Presentation,
  Square,
} from "lucide-react";
import type { PlaybackSyncState } from "@openmaic/components/stage-experience";
import type { Scene } from "@openmaic/lib/types/stage";
import { OpenMaicResourcePlayer } from "@/components/openmaic-bridge/openmaic-resource-player";
import { Card, Pill, toast } from "@/components/ui";
import {
  aggregateKnowledgePointMastery,
} from "@/lib/knowledge-lecture";
import type {
  ClassCommonIssue,
  Course,
  OpenMaicSceneOutlineSnapshot,
  TeacherResourceProjection,
} from "@/lib/session/types";
import { useSession } from "@/lib/session/store";
import { cn } from "@/lib/utils";

type Recommendation = {
  id: string;
  name: string;
  unmetRate: number;
  scoreLossRate: number;
  responseCoverage: number;
  incorrectStudents: number;
  answeredStudents: number;
  explanation: string;
  teachingStrategy: string;
  misconceptionGroups: Array<{ code: string; label: string; studentCount: number; examples: string[] }>;
  issues: ClassCommonIssue[];
  pages: Array<{ outline: OpenMaicSceneOutlineSnapshot; pageNumber: number }>;
};

function teachingOutlines(course: Course): OpenMaicSceneOutlineSnapshot[] {
  return (course.content._openmaicSceneOutlines ?? [])
    .filter((outline) =>
      outline.stageKey === "ai-learning"
      && outline.audience !== "teacher"
      && outline.type !== "quiz",
    )
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function recommendationTone(unmetRate: number): string {
  if (unmetRate >= 50) return "border-rose-200 bg-rose-50/55";
  return "border-amber-200 bg-amber-50/55";
}

function strategyFor(code?: string): string {
  if (code === "concept") return "重新界定概念，用正反例对比后安排一道快速检查题。";
  if (code === "interpretation") return "标出题目条件和关键词，示范如何把题意转换为判断依据。";
  if (code === "calculation") return "定位共同出错步骤，示范校验方法后让学生独立复核。";
  if (code === "evidence") return "先给出结论，再补充能够支撑结论的证据或理由。";
  if (code === "method") return "拆解关键步骤，完整示范一题后安排同结构迁移练习。";
  if (code === "unanswered") return "先确认题意与作答要求，再用口头提问帮助学生启动作答。";
  return "澄清核心判断依据，用原页面例子重新验证后进行快速检查。";
}

export function ClassInterventionPanel({
  course,
  commonIssues,
}: {
  course: Course;
  commonIssues: ClassCommonIssue[];
}) {
  const { addActivity, setUiState } = useSession();
  const progress = useMemo(() => course.aiLearningProgress ?? {}, [course.aiLearningProgress]);
  const rows = useMemo(
    () => aggregateKnowledgePointMastery(course, progress),
    [course, progress],
  );
  const outlines = useMemo(() => teachingOutlines(course), [course]);
  const recommendations = useMemo<Recommendation[]>(() => rows
    .filter((row) => row.status === "confirmed")
    .slice(0, 4)
    .map((row) => {
      const point = course.content.knowledgePoints.find((item) => item.id === row.knowledgePointId);
      const pages = outlines.flatMap((outline, index) =>
        outline.knowledgePointIds?.includes(row.knowledgePointId)
          ? [{ outline, pageNumber: index + 1 }]
          : [],
      );
      const issues = commonIssues.filter((issue) =>
        issue.content?.knowledgePointIds?.includes(row.knowledgePointId),
      );
      const pageGuidance = pages[0]?.outline.teachingObjective
        || pages[0]?.outline.description
        || pages[0]?.outline.keyPoints?.join("、");
      return {
        id: row.knowledgePointId,
        name: row.name,
        unmetRate: row.unmetRate,
        scoreLossRate: row.scoreLossRate,
        responseCoverage: row.responseCoverage,
        incorrectStudents: row.incorrectStudents,
        answeredStudents: row.answeredStudents,
        explanation: point?.description || pageGuidance || `重新梳理“${row.name}”的判断依据与应用步骤。`,
        teachingStrategy: strategyFor(row.misconceptionGroups[0]?.code),
        misconceptionGroups: row.misconceptionGroups,
        issues,
        pages,
      };
    }), [commonIssues, course.content.knowledgePoints, outlines, rows]);
  const observingRows = rows.filter((row) => row.status === "observing").slice(0, 4);
  const mappedIssueIds = new Set(recommendations.flatMap((item) => item.issues.map((issue) => issue.id)));
  const otherIssues = commonIssues.filter((issue) => !mappedIssueIds.has(issue.id));
  const [selectedOutlineId, setSelectedOutlineId] = useState("");
  const [selectedScene, setSelectedScene] = useState<Scene>();
  const [loadingOutlineId, setLoadingOutlineId] = useState("");
  const [sceneCache, setSceneCache] = useState<Scene[]>();
  const [selectionSource, setSelectionSource] = useState<"teacher" | "recommendation">("teacher");
  const [selectedRecommendationId, setSelectedRecommendationId] = useState("");
  const projection = course.uiState?.teacherResourceProjection;
  const selectedOutline = outlines.find((outline) => outline.id === selectedOutlineId);
  const selectedPageNumber = selectedOutline
    ? outlines.findIndex((outline) => outline.id === selectedOutline.id) + 1
    : 0;
  const isProjected = Boolean(selectedScene && projection?.sceneId === selectedScene.id);
  const selectedRecommendation = recommendations.find((item) => item.id === selectedRecommendationId);
  const selectedKnowledgePoint = rows.find((item) => item.knowledgePointId === selectedRecommendationId);

  async function resolveScene(
    outline: OpenMaicSceneOutlineSnapshot,
    source: "teacher" | "recommendation" = "teacher",
  ): Promise<Scene | undefined> {
    setSelectionSource(source);
    setSelectedOutlineId(outline.id);
    if (selectedOutlineId !== outline.id) setSelectedScene(undefined);
    const cached = sceneCache?.find((scene) =>
      scene.outlineId === outline.id || scene.title === outline.title,
    );
    if (cached) {
      setSelectedScene(cached);
      return cached;
    }
    if (!course.aiLearningClassroomId) {
      toast.error("知识讲授课堂尚未生成");
      return undefined;
    }
    setLoadingOutlineId(outline.id);
    try {
      const response = await fetch(`/api/openmaic/classroom?id=${encodeURIComponent(course.aiLearningClassroomId)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`页面加载失败（HTTP ${response.status}）`);
      const payload = await response.json() as { classroom?: { scenes?: Scene[] } };
      const scenes = payload.classroom?.scenes ?? [];
      setSceneCache(scenes);
      const scene = scenes.find((item) => item.outlineId === outline.id || item.title === outline.title);
      if (!scene) throw new Error("未找到该知识点对应的课堂页面");
      setSelectedScene(scene);
      return scene;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "页面加载失败");
      return undefined;
    } finally {
      setLoadingOutlineId("");
    }
  }

  function projectionFor(scene: Scene): TeacherResourceProjection {
    return {
      classroomId: course.aiLearningClassroomId!,
      sceneId: scene.id,
      stageKey: "ai-learning",
      title: `全班补讲 · ${scene.title}`,
      sceneType: scene.type,
      startedAt: new Date().toISOString(),
      mode: "forced",
      version: (projection?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      engineMode: "idle",
      playback: { sceneIndex: 0, actionIndex: 0, consumedDiscussions: [], sceneId: scene.id },
      interactionState: null,
    };
  }

  async function projectOutline(
    outline: OpenMaicSceneOutlineSnapshot,
    source: "teacher" | "recommendation" = "teacher",
  ) {
    if (course.status !== "teaching") return;
    const scene = await resolveScene(outline, source);
    if (!scene) return;
    setUiState(course.id, { teacherResourceProjection: projectionFor(scene) });
    addActivity(course.id, "投屏全班补讲页面", scene.title);
    toast.success("已投屏给全班");
  }

  function scrollRecommendationIntoView() {
    window.requestAnimationFrame(() => {
      document.getElementById("knowledge-lecture-ppt-recommendation")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  function selectRecommendation(item: Recommendation) {
    setSelectedRecommendationId(item.id);
    const firstPage = item.pages[0]?.outline;
    if (firstPage) void resolveScene(firstPage, "recommendation");
    scrollRecommendationIntoView();
  }

  useEffect(() => {
    const handleKnowledgePointSelection = (event: Event) => {
      const knowledgePointId = (event as CustomEvent<{ knowledgePointId?: string }>).detail?.knowledgePointId;
      const recommendation = recommendations.find((item) => item.id === knowledgePointId);
      if (recommendation) {
        selectRecommendation(recommendation);
        return;
      }
      const row = rows.find((item) => item.knowledgePointId === knowledgePointId);
      const page = outlines.find((outline) => outline.knowledgePointIds?.includes(knowledgePointId ?? ""));
      if (row) {
        setSelectedRecommendationId(row.knowledgePointId);
        if (page) void resolveScene(page, "recommendation");
        scrollRecommendationIntoView();
      }
    };
    window.addEventListener("openpbl:recommend-knowledge-point", handleKnowledgePointSelection);
    return () => window.removeEventListener("openpbl:recommend-knowledge-point", handleKnowledgePointSelection);
    // Recommendation selection intentionally rebinds when live analytics changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendations, rows, outlines]);

  function stopProjection() {
    setUiState(course.id, { teacherResourceProjection: null });
    addActivity(course.id, "停止全班补讲页面投屏", projection?.title);
  }

  function syncProjection(state: Omit<PlaybackSyncState, "version">) {
    if (!selectedScene || !projection || projection.sceneId !== selectedScene.id) return;
    setUiState(course.id, {
      teacherResourceProjection: {
        ...projection,
        version: (projection.version ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        engineMode: state.engineMode,
        playback: state.snapshot,
      },
    });
  }

  return (
    <Card className="overflow-hidden p-0">
      <header className="border-b border-stone-100 bg-white px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-[var(--pbl-teacher)] text-white"><Presentation size={18} /></span>
            <div>
              <div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-bold text-stone-950">教师介入与 PPT 投屏</h3><Pill tone={recommendations.length || commonIssues.length || observingRows.length ? "orange" : "green"}>{recommendations.length || commonIssues.length ? "有平台建议" : observingRows.length ? "有早期信号" : "暂无共性问题"}</Pill></div>
              <p className="mt-1 text-xs leading-5 text-stone-500">教师既可采用平台推荐，也可自主选择任意知识讲授页面进行补充讲解。</p>
            </div>
          </div>
        </div>
      </header>

      <div className="grid xl:grid-cols-[minmax(0,.9fr)_minmax(460px,1.1fr)]">
        <section className="border-b border-stone-100 p-4 xl:border-b-0 xl:border-r">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div><h4 className="text-sm font-bold text-stone-900">建议优先补讲</h4><p className="mt-0.5 text-[11px] text-stone-500">样本量充足，且至少 2 人、30% 作答学生未达 80%</p></div>
            <span className="text-[11px] font-bold text-stone-400">按未达标率排序</span>
          </div>

          {recommendations.length ? (
            <ol className="space-y-3">
              {recommendations.map((item, index) => (
                <li className={cn("rounded-xl border p-3.5 transition", recommendationTone(item.unmetRate), selectedRecommendationId === item.id && "ring-2 ring-[var(--pbl-teacher)] ring-offset-2")} key={item.id}>
                  <div className="flex items-start gap-3">
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-white text-xs font-bold text-stone-700 shadow-sm ring-1 ring-stone-200">{index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2"><button className="group text-left" onClick={() => selectRecommendation(item)} type="button"><h5 className="font-bold text-stone-900 underline decoration-transparent underline-offset-4 transition group-hover:text-[var(--pbl-teacher)] group-hover:decoration-[var(--pbl-teacher)]">{item.name}</h5><span className="mt-0.5 block text-[10px] font-bold text-[var(--pbl-teacher)]">点击自动匹配推荐 PPT</span></button><strong className={cn("text-sm", item.unmetRate >= 50 ? "text-rose-700" : "text-amber-700")}>{item.unmetRate}% 未达标率</strong></div>
                      <p className="mt-1 text-xs text-stone-600">{item.incorrectStudents}/{item.answeredStudents} 人未达 80% · 平均失分率 {item.scoreLossRate}% · 作答覆盖率 {item.responseCoverage}%</p>
                      <div className="mt-3 rounded-lg bg-white/80 px-3 py-2 ring-1 ring-black/5">
                        <p className="text-[10px] font-bold uppercase tracking-[.12em] text-stone-400">重点补充或强调</p>
                        <p className="mt-1 text-xs leading-5 text-stone-700">{item.explanation}</p>
                        <p className="mt-1.5 text-[11px] font-semibold leading-5 text-[var(--pbl-teacher-hover)]">建议讲法：{item.teachingStrategy}</p>
                        {item.misconceptionGroups.length ? <p className="mt-1.5 text-[11px] leading-5 text-rose-700">主要错误模式：{item.misconceptionGroups.map((group) => `${group.label}（${group.studentCount} 人）`).join("；")}</p> : null}
                        {item.misconceptionGroups[0]?.examples.length ? <p className="mt-1 text-[11px] leading-5 text-stone-500">代表性评阅反馈：{item.misconceptionGroups[0].examples.join("；")}</p> : null}
                        {item.issues.length ? <p className="mt-1.5 text-[11px] leading-5 text-amber-800">实时学习信号：{item.issues.map((issue) => `${issue.title}（${issue.studentIds.length} 人）`).join("；")}</p> : null}
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <span className="text-[11px] font-bold text-stone-500">调用知识讲授 PPT</span>
                        {item.pages.length ? item.pages.map(({ outline, pageNumber }) => (
                          <span className="inline-flex overflow-hidden rounded-[7px] bg-white ring-1 ring-stone-200" key={outline.id}>
                            <button className="inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 px-2.5 text-[11px] font-bold text-[var(--pbl-teacher-hover)] hover:bg-[var(--pbl-teacher-soft)]" onClick={() => void resolveScene(outline, "recommendation")} type="button">
                              {loadingOutlineId === outline.id ? <Loader2 className="shrink-0 animate-spin" size={12} /> : <Presentation className="shrink-0" size={12} />}<span className="max-w-[220px] truncate">第 {pageNumber} 页 · {outline.title}</span><ChevronRight className="shrink-0" size={12} />
                            </button>
                            <button className="border-l border-stone-200 px-2.5 text-[11px] font-bold text-[var(--pbl-teacher-hover)] hover:bg-[var(--pbl-teacher-soft)] disabled:opacity-40" disabled={course.status !== "teaching"} onClick={() => void projectOutline(outline, "recommendation")} type="button">一键投屏</button>
                          </span>
                        )) : <span className="text-[11px] text-stone-400">暂无可索引页面</span>}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/55 px-3 py-3 text-sm font-semibold text-emerald-800">
              <CircleCheck size={19} />当前无共性问题，可继续授课
            </div>
          )}

          {observingRows.length ? (
            <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50/45 p-3">
              <h4 className="text-xs font-bold text-blue-900">早期信号 · 等待更多作答</h4>
              <p className="mt-1 text-[10px] leading-4 text-blue-700">以下知识点目前比例偏高，但尚未达到最低有效样本量，不会直接触发全班补讲。</p>
              <ul className="mt-2 space-y-1.5">
                {observingRows.map((row) => <li className="flex items-center justify-between gap-3 rounded-lg bg-white/80 px-2.5 py-2 text-[11px]" key={row.knowledgePointId}><span className="font-bold text-stone-700">{row.name}</span><span className="shrink-0 text-stone-500">{row.incorrectStudents}/{row.answeredStudents} 人未达标 · 需 {row.minimumSampleSize} 人作答</span></li>)}
              </ul>
            </div>
          ) : null}

          {otherIssues.length ? (
            <div className="mt-4 border-t border-stone-100 pt-4">
              <h4 className="flex items-center gap-2 text-xs font-bold text-stone-800"><CircleAlert className="text-amber-600" size={15} />其他共性学习信号</h4>
              <ul className="mt-2 space-y-2">
                {otherIssues.map((issue) => {
                  const relatedPage = outlines.find((outline) =>
                    outline.title === issue.content?.sceneTitle
                    || outline.knowledgePointIds?.some((id) => issue.content?.knowledgePointIds?.includes(id)),
                  );
                  const pageNumber = relatedPage ? outlines.indexOf(relatedPage) + 1 : 0;
                  return (
                    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600" key={issue.id}>
                      <span><strong className="text-stone-800">{issue.title}</strong><span className="ml-2">影响 {issue.studentIds.length} 人 · {issue.summary}</span></span>
                      {relatedPage ? <button className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-white px-2 font-bold text-[var(--pbl-teacher-hover)] ring-1 ring-stone-200 hover:bg-[var(--pbl-teacher-soft)]" onClick={() => void resolveScene(relatedPage, "recommendation")} type="button"><Presentation size={11} />调用第 {pageNumber} 页</button> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </section>

          <section className="min-w-0 bg-white p-4" aria-label="补讲页面调用区" id="knowledge-lecture-ppt-recommendation">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[.14em] text-[var(--pbl-teacher)]">{selectedOutline ? `${selectionSource === "recommendation" ? "平台推荐" : "教师自主选择"} · 第 ${selectedPageNumber} 页` : "教师自主选择 PPT"}</p><h4 className="mt-1 truncate text-sm font-bold text-stone-900">{selectedOutline?.title ?? "选择需要补充讲解的知识讲授页面"}</h4></div>
              <div className="flex items-center gap-2">
                {projection ? <button className="inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-rose-200 bg-white px-3 text-xs font-bold text-rose-700 hover:bg-rose-50" onClick={stopProjection} type="button"><Square size={13} />停止投屏</button> : null}
                <button className={cn("inline-flex h-9 items-center gap-1.5 rounded-[8px] px-3 text-xs font-bold text-white disabled:opacity-40", isProjected ? "bg-emerald-600" : "bg-[var(--pbl-teacher)] hover:bg-[var(--pbl-teacher-hover)]")} disabled={!selectedScene || !selectedOutline || course.status !== "teaching"} onClick={() => selectedOutline && selectedScene && void projectOutline(selectedOutline, selectionSource)} type="button"><MonitorUp size={14} />{isProjected ? "正在投屏" : "投屏给全班"}</button>
              </div>
            </div>
            {selectedKnowledgePoint ? (
              <div className="mb-3 rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2.5">
                <p className="text-[10px] font-black uppercase tracking-[.12em] text-blue-700">推荐原因</p>
                <p className="mt-1 text-xs leading-5 text-stone-700">“{selectedKnowledgePoint.name}”当前有 {selectedKnowledgePoint.incorrectStudents}/{selectedKnowledgePoint.answeredStudents} 人未达标；推荐页面直接覆盖该知识点。{selectedRecommendation?.explanation ?? "可回到原讲解页面澄清判断依据，并用一道快速检查题确认理解。"}</p>
              </div>
            ) : null}
            <label className="mb-3 block text-[11px] font-bold text-stone-600">
              从全部知识讲授 PPT 中选择
              <select aria-label="自主选择知识讲授PPT页面" className="mt-1.5 h-10 w-full rounded-[8px] border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-700 outline-none focus:border-[var(--pbl-teacher)]" onChange={(event) => {
                const outline = outlines.find((item) => item.id === event.target.value);
                if (outline) void resolveScene(outline, "teacher");
              }} value={selectedOutlineId}>
                <option value="">请选择 PPT 页面</option>
                {outlines.map((outline, index) => <option key={outline.id} value={outline.id}>第 {index + 1} 页 · {outline.title}</option>)}
              </select>
            </label>
            {selectedScene && course.aiLearningClassroomId ? (
              <OpenMaicResourcePlayer className="h-[380px] rounded-xl border border-stone-200 bg-white" classroomId={course.aiLearningClassroomId} experience="teacher-resource" onPlaybackStateChange={syncProjection} sceneId={selectedScene.id} />
            ) : (
              <div className="grid h-[380px] place-items-center rounded-xl border border-dashed border-stone-300 bg-white text-center text-sm text-stone-500"><span>{loadingOutlineId ? <Loader2 className="mx-auto mb-2 animate-spin text-[var(--pbl-teacher)]" size={24} /> : <Presentation className="mx-auto mb-2 text-stone-300" size={28} />}{loadingOutlineId ? "正在加载对应页面" : outlines.length ? "可采用左侧推荐，或从上方自主选择任意页面" : "当前课程暂无可调用的知识讲授页面"}</span></div>
            )}
          </section>
      </div>
    </Card>
  );
}
