"use client";

import { useEffect, useMemo, useState } from "react";
import { BookOpenText, ChevronLeft, ChevronRight, Loader2, MonitorUp, Presentation, Square } from "lucide-react";
import type { PlaybackSyncState } from "@openmaic/components/stage-experience";
import type { Scene } from "@openmaic/lib/types/stage";
import { OpenMaicResourcePlayer } from "@/components/openmaic-bridge/openmaic-resource-player";
import { toast } from "@/components/ui";
import { useCourse, useSession } from "@/lib/session/store";
import { ownsProjection } from "@/lib/realtime/projection-controller";
import type {
  Course,
  KnowledgeLectureSection,
  KnowledgePoint,
  OpenMaicSceneOutlineSnapshot,
  StudentAiProgress,
  TeacherResourceProjection,
} from "@/lib/session/types";
import { cn } from "@/lib/utils";
import { KnowledgeLectureAnalytics } from "./knowledge-lecture-analytics";

export function KnowledgeLectureHistory({
  initialCourse,
  archivedProgress,
  archivedStudentCount,
  archivedLecture,
}: {
  initialCourse: Course;
  archivedProgress?: Record<string, StudentAiProgress>;
  archivedStudentCount?: number;
  archivedLecture?: {
    classroomId?: string;
    knowledgePoints?: KnowledgePoint[];
    sections?: KnowledgeLectureSection[];
    sceneOutlines?: OpenMaicSceneOutlineSnapshot[];
  };
}) {
  const liveCourse = useCourse(initialCourse.id) ?? initialCourse;
  const { setUiState, addActivity } = useSession();
  const [classroomScenes, setClassroomScenes] = useState<{ classroomId: string; scenes: Scene[] }>({
    classroomId: "",
    scenes: [],
  });
  const [selectedOutlineId, setSelectedOutlineId] = useState("");
  const classroomId = archivedLecture?.classroomId ?? liveCourse.aiLearningClassroomId;
  const scenes = classroomScenes.classroomId === classroomId ? classroomScenes.scenes : [];
  const loading = Boolean(classroomId && classroomScenes.classroomId !== classroomId);
  const lectureCourse = useMemo<Course>(() => archivedLecture ? {
    ...liveCourse,
    content: {
      ...liveCourse.content,
      knowledgePoints: archivedLecture.knowledgePoints ?? liveCourse.content.knowledgePoints,
      knowledgeLectureSections: archivedLecture.sections ?? liveCourse.content.knowledgeLectureSections,
      _openmaicSceneOutlines: archivedLecture.sceneOutlines ?? liveCourse.content._openmaicSceneOutlines,
    },
  } : liveCourse, [archivedLecture, liveCourse]);
  const outlines = useMemo(
    () => (lectureCourse.content._openmaicSceneOutlines ?? []).filter((outline) =>
      outline.stageKey === "ai-learning" && outline.audience !== "teacher",
    ),
    [lectureCourse.content._openmaicSceneOutlines],
  );

  useEffect(() => {
    if (!classroomId) return;
    const controller = new AbortController();
    fetch(`/api/openmaic/classroom?id=${encodeURIComponent(classroomId)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("知识讲授课堂加载失败");
        const payload = await response.json() as { classroom?: { scenes?: Scene[] } };
        setClassroomScenes({ classroomId, scenes: payload.classroom?.scenes ?? [] });
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setClassroomScenes({ classroomId, scenes: [] });
        toast.error(error instanceof Error ? error.message : "知识讲授课堂加载失败");
      });
    return () => controller.abort();
  }, [classroomId]);

  const selectedOutline = outlines.find((outline) => outline.id === selectedOutlineId) ?? outlines[0];
  const selectedScene = scenes.find((scene) => scene.outlineId === selectedOutline?.id)
    ?? scenes.find((scene) => scene.title === selectedOutline?.title);
  const selectedIndex = selectedOutline ? outlines.findIndex((outline) => outline.id === selectedOutline.id) : -1;
  const projection = liveCourse.uiState?.teacherResourceProjection;
  const controlsProjection = ownsProjection(liveCourse.uiState);
  const needsTakeover = Boolean(liveCourse.uiState?.projectionController && !controlsProjection);
  const isProjected = Boolean(selectedScene && projection?.sceneId === selectedScene.id);

  function projectionFor(scene: Scene): TeacherResourceProjection {
    const stageKey = liveCourse.stages[liveCourse.currentStageIndex]?.key ?? "ai-learning";
    return {
      classroomId: classroomId!,
      sceneId: scene.id,
      stageKey,
      title: `易错点回看 · ${scene.title}`,
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

  function projectSelected() {
    if (!selectedScene || !classroomId || liveCourse.status !== "teaching") return;
    setUiState(liveCourse.id, { teacherResourceProjection: projectionFor(selectedScene) }, ...(needsTakeover ? [{ takeover: true }] : []));
    addActivity(liveCourse.id, "投屏知识讲授历史页面", selectedScene.title);
    toast.success("已将该页投屏给当前课堂");
  }

  function stopProjection() {
    if (!controlsProjection) return;
    setUiState(liveCourse.id, { teacherResourceProjection: null });
    addActivity(liveCourse.id, "停止知识讲授历史页面投屏", projection?.title);
  }

  function syncProjection(state: Omit<PlaybackSyncState, "version">) {
    if (!controlsProjection || !selectedScene || !projection || projection.sceneId !== selectedScene.id) return;
    setUiState(liveCourse.id, {
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
    <div className="space-y-5">
      <KnowledgeLectureAnalytics course={lectureCourse} progressOverride={archivedProgress} studentCountOverride={archivedStudentCount} title={archivedProgress ? "历史课次知识讲授汇总" : "本课知识讲授汇总"} />

      <section className="overflow-hidden rounded-[var(--radius-lg)] border border-stone-200 bg-white">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 bg-[linear-gradient(120deg,#f0fdfa,#fff_55%,#f5f3ff)] px-4 py-3">
          <div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-[10px] bg-cyan-950 text-white"><BookOpenText size={17} /></span><div><h3 className="text-sm font-black text-stone-950">知识讲授页面回看与投屏</h3><p className="mt-0.5 text-xs text-stone-500">选择任一历史页面，重新讲解难点并投屏给当前课堂</p></div></div>
          {projection && controlsProjection ? <button className="inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-rose-200 bg-white px-3 text-xs font-bold text-rose-700 hover:bg-rose-50" onClick={stopProjection} type="button"><Square size={13} />停止当前投屏</button> : null}
        </header>
        <div className="grid lg:grid-cols-[230px_minmax(0,1fr)]">
          <nav className="max-h-[560px] overflow-y-auto border-b border-stone-200 bg-stone-50/70 p-3 lg:border-b-0 lg:border-r" aria-label="知识讲授历史页面">
            <p className="mb-2 px-2 text-[10px] font-black uppercase tracking-[.14em] text-stone-400">课程页面 · {outlines.length}</p>
            <div className="space-y-1.5">
              {outlines.map((outline, index) => (
                <button className={cn("flex w-full items-start gap-2 rounded-[8px] border px-3 py-2.5 text-left transition", outline.id === selectedOutline?.id ? "border-cyan-300 bg-white text-cyan-950 shadow-sm" : "border-transparent text-stone-600 hover:border-stone-200 hover:bg-white")} key={outline.id} onClick={() => setSelectedOutlineId(outline.id)} type="button">
                  <span className="grid size-6 shrink-0 place-items-center rounded-md bg-cyan-50 text-[10px] font-black text-cyan-800">{index + 1}</span>
                  <span className="min-w-0"><span className="line-clamp-2 block text-xs font-bold leading-5">{outline.title}</span><span className="mt-0.5 block text-[10px] text-stone-400">{outline.type === "quiz" ? "节末小测" : outline.type === "interactive" ? "互动讲解" : "知识页面"}</span></span>
                </button>
              ))}
            </div>
          </nav>
          <div className="min-w-0 p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0"><p className="truncate text-sm font-black text-stone-900">{selectedOutline?.title ?? "暂无页面"}</p><p className="mt-0.5 text-[11px] text-stone-500">{selectedIndex >= 0 ? `${selectedIndex + 1}/${outlines.length}` : "—"} · 只读回看</p></div>
              <div className="flex items-center gap-1.5">
                <button aria-label="上一页" className="grid size-9 place-items-center rounded-[8px] border border-stone-200 text-stone-600 disabled:opacity-35" disabled={selectedIndex <= 0} onClick={() => setSelectedOutlineId(outlines[selectedIndex - 1]?.id ?? "")} type="button"><ChevronLeft size={16} /></button>
                <button aria-label="下一页" className="grid size-9 place-items-center rounded-[8px] border border-stone-200 text-stone-600 disabled:opacity-35" disabled={selectedIndex < 0 || selectedIndex >= outlines.length - 1} onClick={() => setSelectedOutlineId(outlines[selectedIndex + 1]?.id ?? "")} type="button"><ChevronRight size={16} /></button>
                <button className={cn("inline-flex h-9 items-center gap-1.5 rounded-[8px] px-3 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-40", isProjected ? "bg-emerald-600" : "bg-cyan-950 hover:bg-cyan-900")} disabled={!selectedScene || liveCourse.status !== "teaching"} onClick={projectSelected} title={liveCourse.status === "teaching" ? "投屏给当前课堂学生" : "课程授课中才可投屏"} type="button"><MonitorUp size={14} />{needsTakeover ? "接管并投屏" : isProjected ? "重新同步" : "投屏给学生"}</button>
              </div>
            </div>
            {loading ? <div className="grid h-[480px] place-items-center rounded-xl border border-stone-200 bg-stone-50 text-sm text-stone-500"><span><Loader2 className="mx-auto mb-2 animate-spin text-cyan-800" size={22} />正在加载课堂页面</span></div> : classroomId && selectedScene ? (
              <OpenMaicResourcePlayer className="h-[480px] rounded-xl border border-stone-200" classroomId={classroomId} experience="teacher-resource" onPlaybackStateChange={syncProjection} sceneId={selectedScene.id} />
            ) : <div className="grid h-[480px] place-items-center rounded-xl border border-dashed border-stone-300 bg-stone-50 text-center text-sm text-stone-500"><span><Presentation className="mx-auto mb-2 text-stone-300" size={28} />该历史课堂没有可读取的页面资源</span></div>}
          </div>
        </div>
      </section>
    </div>
  );
}
