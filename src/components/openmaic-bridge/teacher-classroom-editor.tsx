'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Loader2, RefreshCw, Save } from 'lucide-react';
import { Stage } from '@openmaic/components/stage';
import { ServerProvidersInit } from '@openmaic/components/server-providers-init';
import { MediaStageProvider } from '@openmaic/lib/contexts/media-stage-context';
import { migrateScene } from '@openmaic/lib/edit/slide-schema';
import { preloadEditor } from '@openmaic/lib/edit/preload-editor';
import { I18nProvider } from '@openmaic/lib/hooks/use-i18n';
import { ThemeProvider } from '@openmaic/lib/hooks/use-theme';
import { useCanvasStore, useStageStore } from '@openmaic/lib/store';
import { useSlideEditSession } from '@openmaic/components/edit/surfaces/slide/slide-edit-session';
import { useQuizEditSession } from '@openmaic/components/edit/surfaces/quiz/quiz-edit-session';
import type { Scene, Stage as StageType } from '@openmaic/lib/types/stage';
import { collectClassroomAudioUploads } from '@openmaic/lib/audio/classroom-edit-audio';
import { classroomFingerprint, reconcileClassroomSave } from '@/lib/openmaic-bridge/classroom-editor-save';
import { toast } from '@/components/ui';

type PersistedClassroom = {
  id: string;
  stage: StageType;
  scenes: Scene[];
  revision?: number;
  assetGeneration?: { status?: 'running' | 'completed' | 'partial-failure' };
};

type EditorState = 'loading' | 'ready' | 'saving' | 'error' | 'conflict';

export function TeacherClassroomEditor({
  courseId,
  courseName,
  backHref,
  initialSceneId,
  initialElementId,
}: {
  courseId: string;
  courseName: string;
  backHref: string;
  initialSceneId?: string;
  initialElementId?: string;
}) {
  const [state, setState] = useState<EditorState>('loading');
  const [error, setError] = useState<string>();
  const [classroomId, setClassroomId] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const savedFingerprintRef = useRef('');
  const hydratedRef = useRef(false);
  const loadRequestRef = useRef<AbortController | null>(null);
  const saveRequestRef = useRef<AbortController | null>(null);
  const lifecycleRef = useRef(0);

  const hydrate = useCallback(async () => {
    const current = useStageStore.getState();
    if (hydratedRef.current
      && classroomFingerprint(current.stage, current.scenes) !== savedFingerprintRef.current
      && !window.confirm('重新加载会丢弃当前未保存的修改，确定继续吗？')) return;
    const lifecycle = ++lifecycleRef.current;
    loadRequestRef.current?.abort();
    saveRequestRef.current?.abort();
    saveRequestRef.current = null;
    const abort = new AbortController();
    loadRequestRef.current = abort;
    setState('loading');
    setError(undefined);
    hydratedRef.current = false;
    try {
      const [response] = await Promise.all([
        fetch(`/api/courses/${encodeURIComponent(courseId)}/classroom-resource`, {
          cache: 'no-store',
          signal: abort.signal,
        }),
        preloadEditor(),
      ]);
      const payload = await response.json() as {
        success?: boolean;
        classroom?: PersistedClassroom;
        error?: string;
      };
      if (abort.signal.aborted || lifecycleRef.current !== lifecycle) return;
      if (!response.ok || !payload.success || !payload.classroom) {
        throw new Error(payload.error || `课堂资源加载失败（HTTP ${response.status}）`);
      }
      const classroom = payload.classroom;
      const scenes = classroom.scenes.map(migrateScene);
      if (!scenes.length) throw new Error('课堂中没有可编辑页面');
      const requestedScene = initialSceneId
        ? scenes.find((scene) => scene.id === initialSceneId)
        : undefined;
      const currentSceneId = useStageStore.getState().currentSceneId;
      const nextSceneId = requestedScene?.id ?? (scenes.some((scene) => scene.id === currentSceneId)
        ? currentSceneId
        : scenes[0].id);
      useStageStore.setState({
        stage: classroom.stage,
        scenes,
        currentSceneId: nextSceneId,
        mode: 'edit',
        outlines: [],
        generatingOutlines: [],
        generationComplete: true,
        generationStatus: 'completed',
        failedOutlines: [],
      });
      const canvas = useCanvasStore.getState();
      canvas.clearSelection();
      if (requestedScene?.content.type === 'slide' && initialElementId
        && requestedScene.content.canvas.elements.some((element) => element.id === initialElementId)) {
        canvas.setActiveElementIdList([initialElementId]);
      }
      setClassroomId(classroom.id);
      setRevision(classroom.revision ?? 0);
      savedFingerprintRef.current = classroomFingerprint(classroom.stage, scenes);
      setDirty(false);
      hydratedRef.current = true;
      setState('ready');
    } catch (cause) {
      if (abort.signal.aborted || lifecycleRef.current !== lifecycle) return;
      setError(cause instanceof Error ? cause.message : '课堂资源加载失败');
      setState('error');
    } finally {
      if (loadRequestRef.current === abort) loadRequestRef.current = null;
    }
  }, [courseId, initialElementId, initialSceneId]);

  useEffect(() => {
    // Opening a new course is the external synchronization boundary for this
    // client-only editor store.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void hydrate();
    return () => {
      lifecycleRef.current += 1;
      loadRequestRef.current?.abort();
      saveRequestRef.current?.abort();
      loadRequestRef.current = null;
      saveRequestRef.current = null;
      hydratedRef.current = false;
      useCanvasStore.getState().clearSelection();
      useStageStore.getState().clearStore();
    };
  }, [hydrate]);

  useEffect(() => useStageStore.subscribe((current) => {
    if (!hydratedRef.current) return;
    const nextDirty = classroomFingerprint(current.stage, current.scenes)
      !== savedFingerprintRef.current;
    setDirty((previous) => previous === nextDirty ? previous : nextDirty);
  }), []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!dirty || saveRequestRef.current || !hydratedRef.current) return;
    const snapshot = useStageStore.getState();
    if (!snapshot.stage || !snapshot.scenes.length) return;
    const lifecycle = lifecycleRef.current;
    const abort = new AbortController();
    saveRequestRef.current = abort;
    const isCurrent = () => !abort.signal.aborted && lifecycleRef.current === lifecycle
      && useStageStore.getState().stage?.id === snapshot.stage?.id;
    setState('saving');
    setError(undefined);
    try {
      const audioUploads = await collectClassroomAudioUploads(snapshot.scenes);
      if (!isCurrent()) return;
      const response = await fetch(
        `/api/courses/${encodeURIComponent(courseId)}/classroom-resource`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          signal: abort.signal,
          body: JSON.stringify({
            classroomId: snapshot.stage.id,
            revision,
            stage: snapshot.stage,
            scenes: snapshot.scenes,
            audioUploads,
          }),
        },
      );
      const payload = await response.json() as {
        success?: boolean;
        classroom?: PersistedClassroom;
        forkedDraft?: boolean;
        narrationChanged?: boolean;
        code?: string;
        error?: string;
      };
      if (!isCurrent()) return;
      if (!response.ok || !payload.success || !payload.classroom) {
        if (response.status === 409 && payload.code === 'REVISION_CONFLICT') {
          setError(payload.error || '课堂资源已更新，请重新加载');
          setState('conflict');
          return;
        }
        throw new Error(payload.error || `保存失败（HTTP ${response.status}）`);
      }
      const classroom = payload.classroom;
      const scenes = classroom.scenes.map(migrateScene);
      const live = useStageStore.getState();
      if (!live.stage) return;
      const merged = reconcileClassroomSave(
        { stage: snapshot.stage, scenes: snapshot.scenes },
        { stage: live.stage, scenes: live.scenes },
        { stage: classroom.stage, scenes },
      );
      const currentSceneId = live.currentSceneId;
      savedFingerprintRef.current = classroomFingerprint(classroom.stage, scenes);
      useStageStore.setState({
        ...merged,
        currentSceneId: merged.scenes.some((scene) => scene.id === currentSceneId)
          ? currentSceneId
          : merged.scenes[0]?.id ?? null,
        mode: 'edit',
      });
      // A published-resource fork changes media URLs even on the active canvas.
      // Its independent undo session must adopt those URLs before the next edit.
      const slideSession = useSlideEditSession.getState();
      const quizSession = useQuizEditSession.getState();
      for (const scene of merged.scenes) {
        if (scene.type === 'slide' && slideSession.sceneId === scene.id
          && JSON.stringify(slideSession.history?.present) !== JSON.stringify(scene.content)) {
          slideSession.seed(scene.id, scene.content);
        }
        if (scene.type === 'quiz' && quizSession.sceneId === scene.id
          && JSON.stringify(quizSession.history?.present) !== JSON.stringify(scene.content)) {
          quizSession.seed(scene.id, scene.content);
        }
      }
      setClassroomId(classroom.id);
      setRevision(classroom.revision ?? 0);
      setDirty(classroomFingerprint(merged.stage, merged.scenes) !== savedFingerprintRef.current);
      setState('ready');
      if (payload.narrationChanged) {
        toast.warning('课堂修改已保存', {
          description: '讲稿发生变化，旧语音已失效。请在讲稿时间线中重新生成语音后再次保存。',
        });
      } else {
        toast.success(payload.forkedDraft ? '已创建并保存新的课程草稿' : '课堂修改已保存');
      }
    } catch (cause) {
      if (!isCurrent()) return;
      const message = cause instanceof Error ? cause.message : '课堂资源保存失败';
      setError(message);
      setState('ready');
      toast.error('保存失败', { description: message });
    } finally {
      if (saveRequestRef.current === abort) saveRequestRef.current = null;
    }
  }, [courseId, dirty, revision]);

  function leaveEditor() {
    if (dirty && !window.confirm('还有未保存的修改，确定返回吗？')) return;
    window.location.assign(backHref);
  }

  return (
    <ThemeProvider>
      <I18nProvider locale="zh-CN">
        <ServerProvidersInit />
        <MediaStageProvider value={classroomId}>
          <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-[#F4F2ED] text-[#1F2933]">
            <header className="flex min-h-[76px] shrink-0 flex-wrap items-center gap-2 border-b border-[#D8D6D0] bg-[#FCFBF8] px-3 py-2 sm:flex-nowrap sm:gap-4 sm:px-6">
              <button
                aria-label="返回预览发布"
                className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-[8px] px-2 text-sm font-medium text-[#5F6B76] hover:bg-[#EFEEE8] hover:text-[#1F2933] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#344A6A]"
                onClick={leaveEditor}
                type="button"
              >
                <ArrowLeft size={18} />
                <span className="hidden lg:inline">预览与发布</span>
              </button>
              <span className="hidden h-7 w-px bg-[#D8D6D0] sm:block" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold tracking-[0.12em] text-[#344A6A]">编辑 AI 课堂</p>
                <h1 className="mt-0.5 truncate text-base font-semibold leading-tight sm:text-lg">{courseName}</h1>
              </div>
              <span className="order-3 inline-flex min-h-9 max-w-full items-center gap-2 rounded-[8px] bg-[#F0EEE8] px-3 text-xs font-medium text-[#5F6B76] sm:order-none">
                <span className={`size-1.5 shrink-0 rounded-full ${state === 'loading' ? 'bg-[#9AA4AA]' : state === 'error' ? 'bg-[#A43B38]' : dirty ? 'bg-[#B17735]' : 'bg-[#2F6F65]'}`} aria-hidden="true" />
                {state === 'loading' ? '正在读取课堂' : state === 'error' ? '课堂加载失败' : dirty ? '有修改尚未保存' : '所有修改已保存'}
              </span>
              {error && state !== 'error' ? (
                <p className="order-4 max-w-full truncate text-xs font-medium text-[#8A6422] sm:order-none sm:max-w-48" title={error}>
                  {error}
                </p>
              ) : null}
              {state === 'conflict' ? (
                <button
                  className="inline-flex min-h-11 items-center gap-2 rounded-[8px] border border-[#D5B985] bg-[#FFF5E8] px-3 text-xs font-semibold text-[#8A6422] hover:bg-[#FCEBD4]"
                  onClick={() => void hydrate()}
                  type="button"
                >
                  <RefreshCw size={14} /> 重新加载
                </button>
              ) : (
                <button
                  className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-[8px] bg-[#344A6A] px-4 text-sm font-semibold text-white hover:bg-[#263B58] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#344A6A] disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!dirty || state === 'saving' || state === 'loading'}
                  onClick={() => void save()}
                  type="button"
                >
                  {state === 'saving' ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
                  {state === 'saving' ? '保存中…' : '保存课堂'}
                </button>
              )}
            </header>

            <section className="relative flex min-h-0 flex-1">
              {state === 'loading' ? (
                <div className="grid h-full w-full place-items-center bg-[#FCFBF8] text-sm text-[#5F6B76]">
                  <span className="inline-flex items-center gap-2"><Loader2 className="animate-spin" size={18} />正在打开课堂编辑器…</span>
                </div>
              ) : state === 'error' ? (
                <div className="grid h-full w-full place-items-center bg-[#FCFBF8] p-6">
                  <div className="max-w-md text-center">
                    <AlertTriangle className="mx-auto text-rose-600" size={30} />
                    <h2 className="mt-4 text-lg font-black">无法打开课堂编辑器</h2>
                    <p className="mt-2 text-sm leading-6 text-stone-600">{error}</p>
                    <button
                      className="mt-5 inline-flex min-h-10 items-center gap-2 rounded-[8px] bg-stone-900 px-4 text-xs font-bold text-white"
                      onClick={() => void hydrate()}
                      type="button"
                    >
                      <RefreshCw size={14} /> 重试
                    </button>
                  </div>
                </div>
              ) : (
                <Stage experience="teacher-resource" editorCourseId={courseId} />
              )}
            </section>
          </main>
        </MediaStageProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
