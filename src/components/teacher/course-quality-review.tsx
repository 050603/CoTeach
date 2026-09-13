'use client';

import { Component, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui';
import { ReadonlySlideCanvas } from '@/components/openmaic/slide-renderer/Editor/ReadonlySlideCanvas';
import type { PersistedClassroomData } from '@/lib/openmaic/server/classroom-storage';
import type { CourseQualityReport } from '@/lib/course-quality-review/types';
import type { CourseRenderPageReview, CourseRenderReview, CourseTeacherReview } from '@/lib/course-quality-review/teacher-review';
import { reviewableIssues, unresolvedHardIssues } from '@/lib/course-quality-review/teacher-review';
import { inspectRenderedSlide, measureSlideElements } from '@/lib/course-quality-review/render-measurements';
import type { Scene } from '@openmaic/lib/types/stage';

export type TeacherReviewDecision = { canConfirm: boolean; signature: string; acceptedIssueIds: string[]; acknowledgeFailedCheck: boolean };
type ReviewSnapshot = { required: boolean; signature: string; classroom: PersistedClassroomData; quality: CourseQualityReport | null; renderReview: CourseRenderReview | null; teacherReview: CourseTeacherReview | null };

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '检查请求失败，请稍后重试。');
  return body as T;
}

class RenderCheckBoundary extends Component<{ sceneId: string; onComplete: (page: CourseRenderPageReview) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() {
    this.props.onComplete({ sceneId: this.props.sceneId, status: 'failed', checkedAt: new Date().toISOString(), issues: [{ id: `render:${this.props.sceneId}:failed`, sceneId: this.props.sceneId, origin: 'render', severity: 'suggestion', title: '页面无法渲染', evidence: '实际播放渲染器无法打开该页。', suggestion: '修正或重新生成该页，然后重试检查。' }] });
  }
  render() { return this.state.failed ? null : this.props.children; }
}

function RenderPageCheck({ scene, onComplete }: { scene: Scene; onComplete: (page: CourseRenderPageReview) => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    async function check() {
      try {
        await Promise.race([
          (async () => {
            if (document.fonts) await document.fonts.ready;
            const images = Array.from(root.current?.querySelectorAll('img') ?? []);
            await Promise.all(images.map((image) => image.decode().catch(() => undefined)));
            await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          })(),
          new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('字体或图片加载超时，请重试该页。')), 15000); }),
        ]);
        if (cancelled || !root.current || scene.content.type !== 'slide') return;
        const canvas = scene.content.canvas;
        const width = canvas.viewportSize || 1000;
        const issues = inspectRenderedSlide(scene.id, measureSlideElements(root.current, canvas.elements), width, width * (canvas.viewportRatio || 0.5625));
        onComplete({ sceneId: scene.id, status: 'completed', checkedAt: new Date().toISOString(), issues });
      } catch (error) {
        if (!cancelled) onComplete({ sceneId: scene.id, status: 'failed', checkedAt: new Date().toISOString(), issues: [{ id: `render:${scene.id}:failed`, sceneId: scene.id, origin: 'render', severity: 'suggestion', title: '页面呈现检查未完成', evidence: error instanceof Error ? error.message : '页面无法检查。', suggestion: '重试页面检查并查看实际预览。' }] });
      } finally { if (timeout) clearTimeout(timeout); }
    }
    void check();
    return () => { cancelled = true; if (timeout) clearTimeout(timeout); };
  }, [scene, onComplete]);
  return <div aria-hidden="true" style={{ position: 'fixed', left: -20000, top: 0, pointerEvents: 'none' }}>
    <ReadonlySlideCanvas ref={root} scene={scene} />
  </div>;
}

export function CourseQualityReview({ courseId, onDecisionChange, onOpenPage }: {
  courseId: string; onDecisionChange: (value: TeacherReviewDecision) => void; onOpenPage: (sceneId: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState<string[]>([]);
  const [manualReview, setManualReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingPage, setSavingPage] = useState(false);
  const [localPages, setLocalPages] = useState<CourseRenderPageReview[]>([]);
  const [retryPageIds, setRetryPageIds] = useState<string[]>([]);
  const mounted = useRef(true);
  const signature = useRef('');
  const inFlightPage = useRef(false);
  const load = useCallback(async () => {
    try {
      const next = await fetch(`/api/courses/${courseId}/quality-review`, { cache: 'no-store' }).then(responseJson<ReviewSnapshot>);
      if (!mounted.current) return;
      if (signature.current !== next.signature) {
        signature.current = next.signature;
        setLocalPages(next.renderReview?.pages ?? []);
        setAccepted(next.teacherReview?.acceptedIssueIds ?? []);
        setManualReview(false);
        setRetryPageIds([]);
      }
      // Keep stable scene references while polling the same content version.
      setSnapshot((previous) => previous?.signature === next.signature ? { ...next, classroom: previous.classroom } : next);
      setError('');
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : '检查暂时不可用。'); }
  }, [courseId]);
  useEffect(() => {
    mounted.current = true;
    const start = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), 4000);
    return () => { mounted.current = false; clearTimeout(start); clearInterval(timer); };
  }, [load]);
  const pages = useMemo(() => {
    const byId = new Map((snapshot?.renderReview?.pages ?? []).map((page) => [page.sceneId, page]));
    for (const page of localPages) byId.set(page.sceneId, page);
    return [...byId.values()].filter((page) => page.status === 'completed' || !retryPageIds.includes(page.sceneId));
  }, [snapshot?.renderReview?.pages, localPages, retryPageIds]);
  const slides = useMemo(() => snapshot?.classroom.scenes.filter((scene) => scene.type === 'slide' && scene.content.type === 'slide') ?? [], [snapshot?.classroom]);
  const nextScene = !savingPage && !error ? slides.find((scene) => !pages.some((page) => page.sceneId === scene.id)) : undefined;
  const allRendered = slides.every((scene) => pages.some((page) => page.sceneId === scene.id && page.status === 'completed'));
  const issues = useMemo(() => [...(snapshot?.quality?.issues ?? []), ...pages.flatMap((page) => page.issues)], [snapshot?.quality?.issues, pages]);
  const hard = unresolvedHardIssues(issues);
  const toReview = reviewableIssues(issues);
  const contentChecked = snapshot?.quality?.status === 'completed' || (snapshot?.quality?.status === 'failed' && manualReview);
  const canConfirm = Boolean(snapshot && !error && !savingPage && allRendered && contentChecked && !hard.length && toReview.every((issue) => accepted.includes(issue.id)));
  useEffect(() => {
    onDecisionChange({ canConfirm, signature: snapshot?.signature ?? '', acceptedIssueIds: accepted, acknowledgeFailedCheck: manualReview });
  }, [canConfirm, snapshot?.signature, accepted, manualReview, onDecisionChange]);

  const savePage = useCallback(async (page: CourseRenderPageReview) => {
    if (inFlightPage.current) return;
    inFlightPage.current = true;
    const currentSignature = signature.current;
    setSavingPage(true);
    try {
      await fetch(`/api/courses/${courseId}/quality-review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'render-page', signature: currentSignature, page }) }).then(responseJson);
      if (signature.current === currentSignature && mounted.current) {
        setLocalPages((current) => [...current.filter((item) => item.sceneId !== page.sceneId), page]);
        setRetryPageIds((current) => current.filter((id) => id !== page.sceneId));
      }
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : '页面检查未保存。'); }
    finally { inFlightPage.current = false; if (mounted.current) setSavingPage(false); }
  }, [courseId]);
  const onRenderComplete = useCallback((page: CourseRenderPageReview) => { void savePage(page); }, [savePage]);
  async function retry() {
    setBusy(true);
    try {
      if (snapshot?.quality?.status === 'failed') await fetch(`/api/courses/${courseId}/quality-review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'retry' }) }).then(responseJson);
      // Recheck failed browser pages without throwing away successful pages.
      setRetryPageIds(pages.filter((page) => page.status === 'failed').map((page) => page.sceneId));
      setLocalPages((current) => current.filter((page) => page.status === 'completed'));
      setSnapshot((current) => current ? { ...current, renderReview: current.renderReview ? { ...current.renderReview, pages: current.renderReview.pages.filter((page) => page.status === 'completed') } : null } : current);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '重试失败。'); }
    finally { setBusy(false); }
  }
  return <section className="mt-5 rounded-xl border border-stone-200 bg-white p-5" aria-label="课程质量与教师终审">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="font-bold text-stone-900">课程检查与教师终审</h2>
        <p className="mt-1 text-sm leading-6 text-stone-600">先预览课程草稿，再核对内容和页面问题。检查结果用于辅助判断，最终由教师确认。</p></div>
      {(error || snapshot?.quality?.status === 'failed' || pages.some((page) => page.status === 'failed')) && <Button loading={busy} onClick={() => void retry()}><RotateCcw size={14} />重试检查</Button>}
    </div>
    <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-stone-600">
      <span className="inline-flex items-center gap-2">{snapshot?.quality?.status === 'completed' ? <Check size={15} /> : <Loader2 className="animate-spin" size={15} />}
        内容检查：{snapshot?.quality?.status === 'completed' ? '已完成' : snapshot?.quality?.status === 'failed' ? '未完成' : '正在后台检查'}</span>
      <span>页面呈现：{pages.filter((page) => page.status === 'completed').length} / {slides.length} 页{allRendered && snapshot ? '，已检查' : '，请保持本页打开'}</span>
      <span>{hard.length ? `${hard.length} 项必须修正` : `${toReview.length} 项待核对建议`}</span>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p>}
    {snapshot?.quality?.status === 'failed' && <label className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
      <input type="checkbox" checked={manualReview} onChange={(event) => setManualReview(event.target.checked)} className="mt-1" />
      <span>自动内容检查未完成：{snapshot.quality.error || '服务暂时不可用'}。我已人工核对知识、讲稿、互动和题目答案，并承担本次课程终审。</span>
    </label>}
    {issues.length > 0 && <div className="mt-4 max-h-96 space-y-3 overflow-y-auto">
      {issues.filter((issue) => issue.status !== 'resolved').map((issue) => {
        const blocking = issue.origin === 'structure' && issue.severity === 'error';
        return <div key={issue.id} className={`rounded-lg border p-3 text-sm ${blocking ? 'border-rose-200 bg-rose-50' : 'border-stone-200 bg-stone-50'}`}>
          <div className="flex flex-wrap items-center justify-between gap-2"><strong className="inline-flex items-center gap-2"><AlertTriangle size={14} />{issue.title}{blocking ? ' · 必须修正' : ''}</strong>
            {issue.sceneId && <button type="button" className="font-semibold text-blue-700 underline" onClick={() => onOpenPage(snapshot?.classroom.scenes.find((scene) => scene.id === issue.sceneId)?.outlineId ?? issue.sceneId!)}>查看对应页面</button>}</div>
          <p className="mt-2 whitespace-pre-wrap leading-6 text-stone-600">{issue.evidence}</p><p className="mt-1 leading-6">{issue.suggestion}</p>
          {!blocking && <label className="mt-2 flex items-start gap-2"><input type="checkbox" className="mt-1" checked={accepted.includes(issue.id)} onChange={(event) => setAccepted((current) => event.target.checked ? [...new Set([...current, issue.id])] : current.filter((id) => id !== issue.id))} /><span>已核对，这一项可以用于本次授课</span></label>}
        </div>;
      })}
    </div>}
    {nextScene && <RenderCheckBoundary key={`${snapshot?.signature}:${nextScene.id}`} sceneId={nextScene.id} onComplete={onRenderComplete}><RenderPageCheck scene={nextScene} onComplete={onRenderComplete} /></RenderCheckBoundary>}
  </section>;
}
