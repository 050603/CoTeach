"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  FileText,
  ListVideo,
  MonitorUp,
  MousePointerClick,
  Presentation,
  Square,
} from "lucide-react";
import { OpenMaicResourcePlayer } from "./openmaic-resource-player";
import { useSession } from "@/lib/session/store";
import type { Course, TeacherResourceScene, TeacherResourceProjection } from "@/lib/session/types";
import type { ProjectionMode } from "@/lib/session/types";
import type { PlaybackSyncState } from "@openmaic/components/stage-experience";
import {
  getTeacherResourcesForStage,
  teacherResourceTypeLabel,
} from "@/lib/openmaic-bridge/teacher-resources";
import { useInteractionSyncStore } from "@openmaic/lib/store/interaction-sync";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui";
import { userFacingName, userFacingStageLabel } from "@/lib/user-facing-labels";

function ResourceIcon({ type }: { type: TeacherResourceScene["type"] }) {
  if (type === "interactive") return <MousePointerClick size={16} />;
  if (type === "pbl") return <ListVideo size={16} />;
  return <Presentation size={16} />;
}

export function TeacherStageResources({
  course,
  stageKey,
}: {
  course: Course;
  stageKey: string;
}) {
  const { setUiState, addActivity, refresh } = useSession();
  const resources = useMemo(
    () => getTeacherResourcesForStage(course, stageKey),
    [course, stageKey],
  );
  const [requestedId, setRequestedId] = useState(resources[0]?.id ?? "");
  const [projectionMode, setProjectionMode] = useState<ProjectionMode>("forced");
  const [scaffoldLoading, setScaffoldLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const classroomId = course.teacherClassroomId ?? course.content.teacherClassroomId;
  const projection = course.uiState?.teacherResourceProjection;

  const selectedId = resources.some((resource) => resource.id === requestedId)
    ? requestedId
    : (resources[0]?.id ?? "");

  const selected = resources.find((resource) => resource.id === selectedId) ?? resources[0];
  const selectedIndex = selected
    ? resources.findIndex((resource) => resource.id === selected.id)
    : -1;
  const isSelectedProjected = Boolean(
    selected && projection?.sceneId === selected.id && projection.stageKey === stageKey,
  );
  const selectedScaffold = course.dynamicFacilitationScaffolds?.find(
    (item) => item.stageKey === stageKey && item.kind === selected?.scaffoldKind,
  );

  function buildProjection(resource: TeacherResourceScene): TeacherResourceProjection | null {
    if (!classroomId) return null;
    return {
      classroomId,
      sceneId: resource.id,
      stageKey,
      title: resource.title,
      sceneType: resource.type,
      startedAt: new Date().toISOString(),
      mode: projectionMode,
      version: (projection?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      engineMode: "idle",
      playback: { sceneIndex: 0, actionIndex: 0, consumedDiscussions: [], sceneId: resource.id },
      // 互动状态在新投屏或切换资源时重置；后续由 effect 从同步 store 填充
      interactionState: null,
    };
  }

  function selectResource(resource: TeacherResourceScene) {
    setRequestedId(resource.id);
    if (projection?.stageKey === stageKey) {
      const nextProjection = buildProjection(resource);
      if (nextProjection) {
        setUiState(course.id, { teacherResourceProjection: nextProjection });
      }
    }
  }

  function projectResource() {
    if (!selected) {
      toast.error("授课资源数据不完整", { description: "请重新生成课程资源后再投屏。" });
      return;
    }
    const nextProjection = buildProjection(selected);
    if (!nextProjection) {
      toast.error("授课资源课堂未关联", { description: "请重新生成课程资源后再投屏。" });
      return;
    }
    setUiState(course.id, { teacherResourceProjection: nextProjection });
    addActivity(course.id, "投屏授课资源", selected.title);
  }

  function stopProjection() {
    setUiState(course.id, { teacherResourceProjection: null });
    addActivity(course.id, "停止资源投屏", projection?.title);
  }

  function syncProjection(state: Omit<PlaybackSyncState, "version">) {
    if (!selected || !projection || projection.sceneId !== selected.id) return;
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

  // ===== 互动场景状态同步 =====
  // 当投屏中的资源是 interactive 类型时，订阅互动同步 store 中该 sceneId
  // 的最新状态。bridge 脚本在教师 iframe 内捕获用户操作并广播 →
  // InteractiveIframeHost 写入 store → 此 effect 检测到版本变化 →
  // 将状态写入 projection.interactionState，学生端再通过 apply-state
  // postMessage 应用到自己的 iframe。
  const projectedSceneId = projection?.sceneId ?? null;
  const interactionVersion = useInteractionSyncStore(
    (s) => (projectedSceneId ? s.versions[projectedSceneId] ?? 0 : 0),
  );
  const interactionState = useInteractionSyncStore(
    (s) => (projectedSceneId ? s.states[projectedSceneId] ?? null : null),
  );

  useEffect(() => {
    if (!projection || !selected) return;
    if (projection.sceneId !== selected.id) return;
    if (selected.type !== "interactive") return;
    // Avoid redundant updates: skip if state hasn't meaningfully changed
    const current = projection.interactionState ?? null;
    if (interactionState === null && current === null) return;
    const nextStamp = interactionState ? JSON.stringify(interactionState) : "";
    const curStamp = current ? JSON.stringify(current) : "";
    if (nextStamp === curStamp) return;
    setUiState(course.id, {
      teacherResourceProjection: {
        ...projection,
        version: (projection.version ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        interactionState: interactionState ?? null,
      },
    });
  }, [interactionVersion, interactionState, projection, selected, course.id, setUiState]);

  async function fillScaffold() {
    if (!selectedScaffold) return;
    setScaffoldLoading(true);
    try {
      const response = await fetch("/api/teaching-ai/facilitation-scaffold", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId: course.id, scaffoldId: selectedScaffold.id }) });
      if (!response.ok) throw new Error(response.status === 409 ? "当前还没有足够的真实学生证据" : "主持支架生成失败");
      await refresh();
      toast.success("已基于真实课堂证据填充主持支架");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "主持支架生成失败");
    } finally { setScaffoldLoading(false); }
  }

  async function confirmScaffold() {
    if (!selectedScaffold) return;
    try {
      const response = await fetch("/api/teaching-ai/facilitation-scaffold", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId: course.id, scaffoldId: selectedScaffold.id }) });
      if (!response.ok) throw new Error(`主持支架确认失败（HTTP ${response.status}）`);
      await refresh();
      toast.success("主持支架已确认");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "主持支架确认失败");
    }
  }

  return (
    <section data-openpbl-embed className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)]">
      <div className={cn("flex flex-wrap items-center justify-between gap-3 bg-stone-50/80 px-4 py-3", expanded && "border-b border-stone-200")}>
        <button
          aria-controls={`teacher-stage-resources-${stageKey}`}
          aria-expanded={expanded}
          className="flex min-w-0 items-center gap-3 text-left"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]">
            <Presentation size={18} />
          </span>
          <span className="min-w-0">
            <span className="block text-base font-bold text-stone-900">本阶段授课资源</span>
            <span className="mt-0.5 block text-xs text-stone-500">{resources.length} 个资源 · {expanded ? "点击收起" : "点击展开"}</span>
          </span>
          <ChevronDown className={cn("shrink-0 text-stone-400 transition-transform", expanded && "rotate-180")} size={17} />
        </button>
        {projection ? (
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--pbl-success-soft)] px-3 text-xs font-bold text-[var(--pbl-success)] ring-1 ring-[var(--pbl-student-border)]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--pbl-success)]" />
              正在投屏：{projection.title}
            </span>
            <button
              className="inline-flex h-9 items-center gap-1.5 rounded-[6px] border border-rose-200 bg-white px-3 text-xs font-bold text-rose-600 hover:bg-rose-50"
              onClick={stopProjection}
              type="button"
            >
              <Square size={13} /> 停止投屏
            </button>
          </div>
        ) : null}
      </div>

      {expanded ? resources.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-stone-500" id={`teacher-stage-resources-${stageKey}`}>
          本阶段暂无生成的授课资源。
        </div>
      ) : (
        <div className="grid xl:h-[480px] xl:grid-cols-[210px_minmax(0,1fr)_300px]" id={`teacher-stage-resources-${stageKey}`}>
          <div className="border-b border-stone-200 bg-stone-50/60 p-3 xl:min-h-0 xl:overflow-y-auto xl:border-b-0 xl:border-r">
            <div className="mb-2 px-2 text-[11px] font-bold uppercase text-stone-400">资源列表</div>
            <div className="space-y-1.5">
              {resources.map((resource, index) => (
                <button
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-[6px] border px-3 py-2.5 text-left transition",
                    selected?.id === resource.id
                      ? "border-[var(--pbl-teacher-border)] bg-white text-[var(--pbl-teacher)] shadow-sm"
                      : "border-transparent text-stone-600 hover:border-stone-200 hover:bg-white",
                  )}
                  key={resource.id}
                  onClick={() => selectResource(resource)}
                  type="button"
                >
                  <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-[5px] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]">
                    <ResourceIcon type={resource.type} />
                  </span>
                  <span className="min-w-0">
                    <span className="line-clamp-2 block text-xs font-bold leading-5">{userFacingName(resource.title, "未命名授课资源")}</span>
                    <span className="mt-0.5 block text-[10px] text-stone-400">
                      {index + 1} · {userFacingStageLabel(stageKey, resource.stageLabel)} · {teacherResourceTypeLabel(resource.type)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex min-w-0 flex-col border-b border-stone-200 p-3 xl:min-h-0 xl:border-b-0 xl:border-r">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-bold text-stone-900">{userFacingName(selected?.title, "未命名授课资源")}</div>
                <div className="text-xs text-stone-500">
                  {selected ? teacherResourceTypeLabel(selected.type) : ""}
                  {selected ? ` · ${userFacingStageLabel(stageKey, selected.stageLabel)}` : ""}
                  {selectedIndex >= 0 ? ` · ${selectedIndex + 1}/${resources.length}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="mr-1 inline-flex rounded-[6px] border border-stone-200 bg-white p-0.5" aria-label="投屏方式">
                  <button className={cn("h-7 rounded-[4px] px-2 text-[11px] font-bold", projectionMode === "forced" ? "bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]" : "text-stone-500")} onClick={() => setProjectionMode("forced")} type="button">强制全屏</button>
                  <button className={cn("h-7 rounded-[4px] px-2 text-[11px] font-bold", projectionMode === "optional" ? "bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]" : "text-stone-500")} onClick={() => setProjectionMode("optional")} type="button">自主查看</button>
                </div>
                <button
                  aria-label="上一个授课资源"
                  className="grid h-9 w-9 place-items-center rounded-[6px] border border-stone-200 text-stone-600 disabled:cursor-not-allowed disabled:opacity-35"
                  disabled={selectedIndex <= 0}
                  onClick={() => selectResource(resources[selectedIndex - 1])}
                  title="上一个授课资源"
                  type="button"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  aria-label="下一个授课资源"
                  className="grid h-9 w-9 place-items-center rounded-[6px] border border-stone-200 text-stone-600 disabled:cursor-not-allowed disabled:opacity-35"
                  disabled={selectedIndex < 0 || selectedIndex >= resources.length - 1}
                  onClick={() => selectResource(resources[selectedIndex + 1])}
                  title="下一个授课资源"
                  type="button"
                >
                  <ChevronRight size={16} />
                </button>
                <button
                  className={cn(
                    "inline-flex h-9 items-center gap-1.5 rounded-[6px] px-3 text-xs font-bold text-white",
                    isSelectedProjected
                      ? "bg-[var(--pbl-success)] hover:bg-[var(--pbl-success)]/90"
                      : "bg-[var(--pbl-teacher)] hover:bg-[var(--pbl-teacher-hover)]",
                  )}
                  onClick={projectResource}
                  type="button"
                >
                  <MonitorUp size={15} /> {isSelectedProjected ? "重新同步投屏" : projection ? "切换投屏" : "投屏给学生"}
                </button>
              </div>
            </div>
            {classroomId && selected ? (
              <OpenMaicResourcePlayer
                className="h-[420px] rounded-[6px] border border-stone-200 xl:min-h-0 xl:flex-1"
                classroomId={classroomId}
                sceneId={selected.id}
                experience="teacher-resource"
                onPlaybackStateChange={syncProjection}
              />
            ) : (
              <div className="grid h-[420px] place-items-center rounded-[6px] border border-dashed border-rose-200 bg-rose-50 text-sm text-rose-700 xl:min-h-0 xl:flex-1">
                授课资源课堂未关联，请重新生成课程。
              </div>
            )}
          </div>

          <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-white p-4">
            <h3 className="flex items-center gap-2 text-sm font-bold text-stone-900">
              <FileText className="text-amber-600" size={17} /> 教师讲稿
            </h3>
            {selected?.keyPoints.length ? (
              <ul className="mt-3 space-y-1.5 border-b border-stone-100 pb-3">
                {selected.keyPoints.map((point) => (
                  <li className="flex gap-2 text-xs leading-5 text-stone-600" key={point}>
                    <span className="text-[var(--pbl-teacher-border)]">·</span><span>{point}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {selected?.script ? (
              <div className="mt-3 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-[6px] bg-amber-50/70 p-3 text-sm leading-7 text-stone-700 ring-1 ring-amber-100">
                {selected.script}
              </div>
            ) : (
              <div className="mt-3 rounded-[6px] border border-dashed border-stone-200 bg-stone-50 p-3 text-xs leading-5 text-stone-500">
                该资源没有生成讲稿。系统不会使用本地占位内容，请在备课阶段重新生成或补充讲稿。
              </div>
            )}
            {selected?.generationMode === "dynamic-scaffold" && selectedScaffold ? (
              <div className="mt-4 rounded-[6px] border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)]/60 p-3">
                <div className="text-xs font-black text-[var(--pbl-teacher)]">动态教师主持支架 · {selectedScaffold.status === "template" ? "待课堂数据" : selectedScaffold.status === "draft" ? "待教师确认" : "已确认"}</div>
                <p className="mt-2 text-xs leading-5 text-stone-600">备课阶段不预设学生表现；课堂中只依据真实产物、对话与共性问题填充。</p>
                {selectedScaffold.filledContent ? <div className="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-white p-2 text-xs leading-5 text-stone-700">{selectedScaffold.filledContent}</div> : null}
                <div className="mt-3 flex gap-2"><button className="h-8 rounded bg-[var(--pbl-teacher)] px-3 text-xs font-bold text-white disabled:opacity-50" disabled={scaffoldLoading} onClick={() => void fillScaffold()} type="button">{scaffoldLoading ? "生成中..." : "用课堂证据填充"}</button>{selectedScaffold.status === "draft" ? <button className="h-8 rounded border border-[var(--pbl-teacher-border)] bg-white px-3 text-xs font-bold text-[var(--pbl-teacher)]" onClick={() => void confirmScaffold()} type="button">教师确认</button> : null}</div>
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
    </section>
  );
}

export function StudentProjectedTeacherResource({
  projection,
  projectionVersion,
  fullscreen = false,
}: {
  projection: TeacherResourceProjection;
  projectionVersion?: number;
  fullscreen?: boolean;
}) {
  return (
    <section data-openpbl-embed data-projection-version={projectionVersion} className={cn("overflow-hidden bg-[var(--pbl-surface)]", fullscreen ? "h-full" : "rounded-[var(--radius-lg)] border border-[var(--pbl-border)]")}>
      {!fullscreen ? <div className="flex items-center justify-between gap-3 border-b border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-bold text-[var(--pbl-teacher)]">
            <MonitorUp size={17} /> 教师正在投屏
          </div>
          <div className="mt-0.5 truncate text-xs text-[var(--pbl-teacher)]">{projection.title}</div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-[11px] font-bold text-[var(--pbl-success)] ring-1 ring-[var(--pbl-student-border)]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--pbl-success)]" /> 实时同步
        </span>
      </div> : null}
      <OpenMaicResourcePlayer
        className={fullscreen ? "h-full min-h-0" : "h-[min(760px,calc(100vh-170px))] min-h-[620px]"}
        classroomId={projection.classroomId}
        sceneId={projection.sceneId}
        experience="projected-readonly"
        playbackState={projection.playback && projection.engineMode ? {
          version: projection.version ?? 0,
          engineMode: projection.engineMode,
          snapshot: projection.playback,
        } : undefined}
        interactionState={projection.interactionState ?? null}
      />
    </section>
  );
}
