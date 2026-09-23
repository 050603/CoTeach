'use client';

import Link from 'next/link';
import { Component, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FileSearch,
  Loader2,
  MonitorCheck,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui';
import { ReadonlySlideCanvas } from '@/components/openmaic/slide-renderer/Editor/ReadonlySlideCanvas';
import type { PersistedClassroomData } from '@/lib/openmaic/server/classroom-storage';
import type { CourseQualityIssue, CourseQualityReport, TeacherReviewItem } from '@/lib/course-quality-review/types';
import type { CourseRenderPageReview, CourseRenderReview, CourseTeacherReview } from '@/lib/course-quality-review/teacher-review';
import { reviewableIssues } from '@/lib/course-quality-review/teacher-review';
import { inspectRenderedSlide, measureSlideElements } from '@/lib/course-quality-review/render-measurements';
import type { Scene } from '@openmaic/lib/types/stage';

export type TeacherReviewDecision = { canConfirm: boolean; signature: string; acceptedIssueIds: string[]; acknowledgeFailedCheck: boolean };
export type CourseQualityReviewSummary = {
  attentionCount: number;
  blockingCount: number;
  status: 'loading' | 'ready' | 'attention' | 'blocked' | 'confirmed' | 'error';
};
type ReviewSnapshot = {
  required: boolean;
  signature: string;
  classroom: PersistedClassroomData;
  blockingIssues?: CourseQualityIssue[];
  quality: CourseQualityReport | null;
  renderReview: CourseRenderReview | null;
  teacherReview: CourseTeacherReview | null;
  teacherReviewItems: TeacherReviewItem[];
  teacherReviewSummary: string | null;
};

type ReviewFilter = 'action' | 'blocking' | 'content' | 'pages' | 'sources' | 'reviewed';
type CheckScope = 'all' | 'content' | 'pages';

const ORIGIN_LABEL: Record<CourseQualityIssue['origin'], string> = {
  structure: '课程结构',
  semantic: '内容一致性',
  render: 'PPT 页面呈现',
};

const REVIEW_KIND_LABEL: Record<TeacherReviewItem['kind'], string> = {
  'illustrative-data': '示意数据',
  'constructed-example': '构造示例',
  'unverified-claim': '待核事实',
};

const PROVENANCE_LABEL: Record<TeacherReviewItem['provenance'], string> = {
  'course-source': '课程资料',
  derived: '资料推导',
  'general-knowledge': '通用知识',
  constructed: '教学构造',
  unverified: '尚未核实',
};

function isBlockingIssue(issue: CourseQualityIssue): boolean {
  return issue.severity === 'error' && issue.blocking === true;
}

function checkedAtLabel(value?: string): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function editorIssueHref(courseId: string, sceneId: string, elementId?: string, questionId?: string): string {
  const params = new URLSearchParams({ sceneId });
  if (elementId) params.set('elementId', elementId);
  if (questionId) params.set('questionId', questionId);
  return `/teacher/prepare/${encodeURIComponent(courseId)}/classroom-editor?${params.toString()}`;
}

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

export function CourseQualityReview({ courseId, onDecisionChange, onOpenPage, onSummaryChange, visible = true }: {
  courseId: string;
  onDecisionChange: (value: TeacherReviewDecision) => void;
  onOpenPage: (sceneId: string) => void;
  onSummaryChange?: (summary: CourseQualityReviewSummary) => void;
  visible?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState<string[]>([]);
  const [filter, setFilter] = useState<ReviewFilter>('action');
  const [renderRequested, setRenderRequested] = useState(false);
  const [busy, setBusy] = useState<CheckScope | null>(null);
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
        setRenderRequested(false);
        setRetryPageIds([]);
        setFilter('action');
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
  const nextScene = renderRequested && !savingPage && !error ? slides.find((scene) => !pages.some((page) => page.sceneId === scene.id)) : undefined;
  const allRendered = slides.every((scene) => pages.some((page) => page.sceneId === scene.id && page.status === 'completed'));
  const issues = useMemo(() => {
    const byId = new Map<string, CourseQualityIssue>();
    for (const issue of [
      ...(snapshot?.blockingIssues ?? []),
      ...(snapshot?.quality?.issues ?? []),
      ...pages.flatMap((page) => page.issues),
    ]) byId.set(issue.id, issue);
    return [...byId.values()];
  }, [snapshot?.blockingIssues, snapshot?.quality?.issues, pages]);
  const openIssues = useMemo(() => issues.filter((issue) => issue.status !== 'resolved'), [issues]);
  const blockingIssues = useMemo(() => openIssues.filter(isBlockingIssue), [openIssues]);
  const toReview = useMemo(() => reviewableIssues(openIssues), [openIssues]);
  const acceptedSet = useMemo(() => new Set(accepted), [accepted]);
  const reviewedCount = toReview.filter((issue) => acceptedSet.has(issue.id) || issue.status === 'accepted').length;
  const attentionCount = toReview.length - reviewedCount;
  const filteredIssues = useMemo(() => openIssues.filter((issue) => {
    if (filter === 'blocking') return isBlockingIssue(issue);
    const reviewed = acceptedSet.has(issue.id) || issue.status === 'accepted';
    if (filter === 'reviewed') return !isBlockingIssue(issue) && reviewed;
    if (filter === 'content') return !isBlockingIssue(issue) && !reviewed && issue.origin !== 'render';
    if (filter === 'pages') return !isBlockingIssue(issue) && !reviewed && issue.origin === 'render';
    if (filter === 'sources') return false;
    return !reviewed;
  }), [acceptedSet, filter, openIssues]);
  const qualityRunning = snapshot?.quality?.status === 'running' || snapshot?.quality?.status === 'pending';
  const canConfirm = Boolean(snapshot && snapshot.classroom.assetGeneration?.status !== 'running' && blockingIssues.length === 0);
  const completedPageCount = pages.filter((page) => page.status === 'completed').length;
  const contentCheckedAt = checkedAtLabel(snapshot?.quality?.checkedAt);
  const pageCheckedAt = checkedAtLabel(snapshot?.renderReview?.updatedAt);
  const teacherConfirmedAt = checkedAtLabel(snapshot?.teacherReview?.confirmedAt);
  const completedSectionCount = snapshot?.quality?.sections?.filter((section) => section.status === 'completed').length ?? 0;
  const sectionCount = snapshot?.quality?.sections?.length ?? 0;
  useEffect(() => {
    onDecisionChange({
      canConfirm,
      signature: snapshot?.signature ?? '',
      acceptedIssueIds: accepted,
      acknowledgeFailedCheck: snapshot?.quality?.status !== 'completed',
    });
  }, [canConfirm, snapshot?.signature, snapshot?.quality?.status, accepted, onDecisionChange]);
  useEffect(() => {
    if (!onSummaryChange) return;
    onSummaryChange({
      attentionCount,
      blockingCount: blockingIssues.length,
      status: !snapshot
        ? error ? 'error' : 'loading'
        : snapshot.teacherReview ? 'confirmed'
          : blockingIssues.length ? 'blocked'
            : attentionCount ? 'attention' : 'ready',
    });
  }, [attentionCount, blockingIssues.length, error, onSummaryChange, snapshot]);

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
  function preparePageCheck() {
    setRenderRequested(true);
    // A teacher-triggered recheck measures every current slide again.
    setRetryPageIds(slides.map((scene) => scene.id));
    setLocalPages([]);
    setSnapshot((current) => current ? {
      ...current,
      renderReview: current.renderReview ? {
        ...current.renderReview,
        pages: [],
      } : null,
    } : current);
  }

  async function runCheck(scope: CheckScope) {
    setBusy(scope);
    setError('');
    try {
      if (scope === 'all' || scope === 'content') {
        await fetch(`/api/courses/${courseId}/quality-review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'check' }) }).then(responseJson);
      }
      if (scope === 'all' || scope === 'pages') preparePageCheck();
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '检查未能启动，请稍后重试。'); }
    finally { setBusy(null); }
  }

  const contentIssueCount = openIssues.filter((issue) => !isBlockingIssue(issue) && issue.origin !== 'render' && !acceptedSet.has(issue.id) && issue.status !== 'accepted').length;
  const pageIssueCount = openIssues.filter((issue) => !isBlockingIssue(issue) && issue.origin === 'render' && !acceptedSet.has(issue.id) && issue.status !== 'accepted').length;
  const sourceCount = snapshot?.teacherReviewItems.length || (snapshot?.teacherReviewSummary ? 1 : 0) || 0;
  const filterOptions: Array<{ id: ReviewFilter; label: string; count: number }> = [
    { id: 'action', label: '当前待处理', count: blockingIssues.length + attentionCount },
    { id: 'blocking', label: '必须处理', count: blockingIssues.length },
    { id: 'content', label: '内容提示', count: contentIssueCount },
    { id: 'pages', label: '页面提示', count: pageIssueCount },
    { id: 'sources', label: '来源说明', count: sourceCount },
    { id: 'reviewed', label: '已核对', count: reviewedCount },
  ];
  const pageCheckActive = Boolean(nextScene) || savingPage;
  const fullCheckDisabled = !snapshot || qualityRunning || pageCheckActive;

  return <>
  <section aria-label="课程质量与教师终审" aria-labelledby="publish-tab-checks" className="overflow-hidden rounded-[14px] border border-stone-200 bg-white" hidden={!visible} id="publish-panel-checks" role="tabpanel">
    <header className="border-b border-stone-200 bg-stone-50/55 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="max-w-3xl">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-black text-stone-950">课程检查与教师终审</h2>
            {snapshot?.teacherReview ? <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-800">当前版本已终审</span> : null}
          </div>
          <p className="mt-0.5 text-xs leading-5 text-stone-500">按类别查看提示；红色项目需要先修正，其余建议由教师结合课堂意图核对。</p>
        </div>
        <Button
          className="min-h-11 bg-[var(--pbl-teacher)] px-4 text-white hover:bg-[var(--pbl-teacher-hover)]"
          disabled={fullCheckDisabled}
          loading={busy === 'all'}
          onClick={() => void runCheck('all')}
        >
          <RotateCcw size={15} />
          {snapshot?.quality || pages.length ? '重新检查全部' : '开始完整检查'}
        </Button>
      </div>
    </header>

    {!snapshot ? <div className="grid min-h-40 place-items-center px-6 py-10 text-sm text-stone-500"><span className="inline-flex items-center gap-2"><Loader2 className="animate-spin" size={16} />正在读取当前课程版本…</span></div> : <>
      <div aria-live="polite" className="grid gap-px border-b border-stone-200 bg-stone-200 md:grid-cols-3">
        <ReviewStatusCard
          actionLabel={qualityRunning ? '检查进行中' : snapshot.quality ? '仅重查内容' : '检查内容'}
          actionDisabled={qualityRunning || busy !== null}
          actionLoading={busy === 'content'}
          detail={snapshot.quality?.status === 'completed'
            ? `${snapshot.quality.issues.filter((issue) => issue.status !== 'resolved').length} 项内容或结构提示${contentCheckedAt ? ` · ${contentCheckedAt}` : ''}`
            : snapshot.quality?.status === 'failed'
              ? '检查服务未完成，仍可由教师手动核对'
              : qualityRunning ? `正在分段核对课程内容${sectionCount ? ` · ${completedSectionCount} / ${sectionCount} 个小节完成` : ''}` : '尚未运行，可按需启动'}
          icon={qualityRunning ? <Loader2 className="animate-spin" size={18} /> : <FileSearch size={18} />}
          label="内容一致性"
          onAction={() => void runCheck('content')}
          status={snapshot.quality?.status === 'completed' ? '已检查' : snapshot.quality?.status === 'failed' ? '未完成' : qualityRunning ? '检查中' : '未检查'}
          tone={snapshot.quality?.status === 'failed' ? 'warning' : snapshot.quality?.status === 'completed' ? 'success' : 'neutral'}
        />
        <ReviewStatusCard
          actionLabel={pageCheckActive ? '检查进行中' : pages.length ? '重新检查页面' : '检查页面'}
          actionDisabled={pageCheckActive || busy !== null}
          actionLoading={busy === 'pages'}
          detail={!slides.length ? '当前课程没有需要测量的课件页'
            : !pages.length && !renderRequested ? '尚未运行，使用实际浏览器测量'
              : `${completedPageCount} / ${slides.length} 页完成${pageCheckedAt ? ` · ${pageCheckedAt}` : ''}`}
          icon={pageCheckActive ? <Loader2 className="animate-spin" size={18} /> : <MonitorCheck size={18} />}
          label="PPT 页面呈现"
          onAction={() => void runCheck('pages')}
          status={!slides.length ? '无需检查' : allRendered && pages.length ? '已检查' : pageCheckActive ? '检查中' : pages.length ? '未完成' : '未检查'}
          tone={allRendered && pages.length ? 'success' : 'neutral'}
        />
        <ReviewStatusCard
          detail={blockingIssues.length
            ? `${blockingIssues.length} 项必须先修正，暂不能确认发布`
            : snapshot.teacherReview && teacherConfirmedAt ? `当前版本已于 ${teacherConfirmedAt} 完成教师终审`
            : attentionCount ? `${reviewedCount} / ${toReview.length} 项参考建议已核对`
              : toReview.length ? `${toReview.length} 项建议均已核对` : '当前没有待教师处理的检查项'}
          icon={blockingIssues.length ? <CircleAlert size={18} /> : <ShieldCheck size={18} />}
          label="教师确认"
          status={blockingIssues.length ? '有阻断项' : snapshot.teacherReview ? '已终审' : attentionCount ? '待核对' : '可确认'}
          tone={blockingIssues.length ? 'danger' : attentionCount ? 'warning' : 'success'}
        />
      </div>

      {error ? <div className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 sm:mx-6" role="alert">
        <span>{error}</span>
        <button className="min-h-11 font-bold underline underline-offset-4" onClick={() => void load()} type="button">刷新状态</button>
      </div> : null}

      {snapshot.quality?.status === 'failed' ? <div className="mx-4 mt-4 flex items-start gap-2 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950 sm:mx-6">
        <AlertTriangle className="mt-0.5 shrink-0" size={16} />
        <p><strong>内容检查未完成：</strong>{snapshot.quality.error || '检查服务暂时不可用'}。你仍可根据课程资料和实际预览完成人工终审。</p>
      </div> : null}

      <section className="px-4 py-4 sm:px-5" aria-labelledby="review-issues-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-sm font-black text-stone-950" id="review-issues-title">按类别查看检查结果</h3>
            <p className="mt-1 text-xs leading-5 text-stone-500">一次只显示一类提示，数量为 0 的类别也会保留，便于快速确认。</p>
          </div>
          <p className="text-xs font-semibold text-stone-500">{blockingIssues.length} 项阻断 · {attentionCount} 项待核对 · {reviewedCount} 项已核对</p>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6" aria-label="检查结果分类">
          {filterOptions.map((option) => <button
            aria-pressed={filter === option.id}
            className={`inline-flex min-h-11 items-center justify-between gap-2 rounded-[8px] border px-3 text-xs font-bold transition ${filter === option.id ? 'border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]' : option.count ? 'border-stone-200 bg-white text-stone-700 hover:border-stone-300 hover:bg-stone-50' : 'border-stone-200 bg-stone-50 text-stone-400'}`}
            key={option.id}
            onClick={() => setFilter(option.id)}
            type="button"
          >{option.label}<span className="grid min-w-5 place-items-center rounded-full bg-black/5 px-1.5 py-0.5 tabular-nums text-[10px]">{option.count}</span></button>)}
        </div>

        {filter === 'sources' ? <SourceReviewList courseId={courseId} items={snapshot.teacherReviewItems} onOpenPage={onOpenPage} scenes={snapshot.classroom.scenes} summary={snapshot.teacherReviewSummary} /> : filteredIssues.length ? <ol className="mt-4 space-y-3">
          {filteredIssues.map((issue) => {
            const blocking = isBlockingIssue(issue);
            const reviewed = acceptedSet.has(issue.id) || issue.status === 'accepted';
            const scene = issue.sceneId ? snapshot.classroom.scenes.find((entry) => entry.id === issue.sceneId) : undefined;
            const outlineId = scene?.outlineId ?? scene?.id;
            const sceneIndex = scene ? snapshot.classroom.scenes.findIndex((entry) => entry.id === scene.id) : -1;
            return <li className={`border-l-4 px-4 py-4 ${blocking ? 'border-rose-500 bg-rose-50/65' : reviewed ? 'border-emerald-400 bg-emerald-50/35' : 'border-amber-400 bg-stone-50/80'}`} key={issue.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold">
                    <span className={blocking ? 'text-rose-800' : 'text-stone-500'}>{blocking ? '必须处理' : ORIGIN_LABEL[issue.origin]}</span>
                    {scene ? <><span className="text-stone-300">/</span><span className="text-stone-500">第 {sceneIndex + 1} 页 · {scene.title}</span></> : null}
                    {issue.elementId ? <span className="rounded-full bg-white px-2 py-0.5 text-stone-500">页内元素</span> : null}
                    {issue.questionId ? <span className="rounded-full bg-white px-2 py-0.5 text-stone-500">题目</span> : null}
                  </div>
                  <h4 className="mt-1.5 flex items-start gap-2 text-sm font-black leading-6 text-stone-950">
                    {blocking ? <CircleAlert className="mt-1 shrink-0 text-rose-700" size={15} /> : <AlertTriangle className="mt-1 shrink-0 text-amber-700" size={15} />}
                    <span>{issue.title}</span>
                  </h4>
                </div>
                {!blocking ? <label className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-[8px] border px-3 text-xs font-bold ${reviewed ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-stone-200 bg-white text-stone-600 hover:border-stone-300'}`}>
                  <input
                    checked={reviewed}
                    className="sr-only"
                    onChange={(event) => setAccepted((current) => event.target.checked ? [...new Set([...current, issue.id])] : current.filter((id) => id !== issue.id))}
                    type="checkbox"
                  />
                  <span className={`grid size-4 place-items-center rounded-full border ${reviewed ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-stone-300'}`}>{reviewed ? <Check size={11} /> : null}</span>
                  {reviewed ? '已核对' : '标记为已核对'}
                </label> : null}
              </div>

              <div className="mt-3 grid gap-3 text-sm leading-6 lg:grid-cols-2">
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.1em] text-stone-400">发现依据</p>
                  <p className="mt-1 whitespace-pre-wrap text-stone-600">{issue.evidence}</p>
                </div>
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.1em] text-stone-400">建议处理</p>
                  <p className="mt-1 whitespace-pre-wrap text-stone-800">{issue.suggestion}</p>
                </div>
              </div>

              {scene && outlineId ? <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-black/5 pt-2">
                <button className="inline-flex min-h-11 items-center gap-1 text-xs font-bold text-[var(--pbl-teacher)] hover:underline" onClick={() => onOpenPage(outlineId)} type="button">查看页面 <ChevronRight size={14} /></button>
                <Link className="inline-flex min-h-11 items-center gap-1 text-xs font-bold text-[var(--pbl-teacher)] hover:underline" href={editorIssueHref(courseId, scene.id, issue.elementId, issue.questionId)}>
                  定位并修改 <ExternalLink size={13} />
                </Link>
              </div> : null}
            </li>;
          })}
        </ol> : <div className="mt-4 border border-dashed border-stone-300 px-5 py-8 text-center">
          <span className="mx-auto grid size-10 place-items-center rounded-full bg-emerald-50 text-emerald-700"><Check size={18} /></span>
          <p className="mt-3 text-sm font-bold text-stone-900">{filter === 'action' && !openIssues.length && snapshot.quality?.status !== 'completed' && !pages.length ? '尚未生成检查结果' : '这一类当前没有提示'}</p>
          <p className="mt-1 text-xs leading-5 text-stone-500">{filter === 'action' && !openIssues.length && snapshot.quality?.status !== 'completed' && !pages.length ? '可按需运行完整检查，也可以直接完成人工终审。' : '可切换上方类别继续查看。'}</p>
        </div>}
      </section>
    </>}

  </section>
  {nextScene && <RenderCheckBoundary key={`${snapshot?.signature}:${nextScene.id}`} sceneId={nextScene.id} onComplete={onRenderComplete}><RenderPageCheck scene={nextScene} onComplete={onRenderComplete} /></RenderCheckBoundary>}
  </>;
}

function SourceReviewList({ courseId, items, onOpenPage, scenes, summary }: {
  courseId: string;
  items: TeacherReviewItem[];
  onOpenPage: (sceneId: string) => void;
  scenes: Scene[];
  summary: string | null;
}) {
  if (!items.length && !summary) return <div className="mt-4 border border-dashed border-stone-300 px-5 py-8 text-center"><span className="mx-auto grid size-10 place-items-center rounded-full bg-emerald-50 text-emerald-700"><Check size={18} /></span><p className="mt-3 text-sm font-bold text-stone-900">当前没有来源或构造说明</p></div>;
  return <section className="mt-4" aria-labelledby="generation-review-title">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h4 className="text-sm font-black text-stone-950" id="generation-review-title">授课前来源与构造说明{items.length ? `（${items.length} 项）` : ''}</h4><p className="mt-1 text-xs leading-5 text-stone-500">示意数据、构造案例与待核事实集中列在这里。</p></div>
      <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-800">教师参考 · 不阻断发布</span>
    </div>
    {items.length ? <ul className="mt-3 grid gap-3 lg:grid-cols-2">{items.map((item) => {
      const scene = item.sceneId ? scenes.find((entry) => entry.id === item.sceneId) : item.outlineId ? scenes.find((entry) => entry.outlineId === item.outlineId || entry.id === item.outlineId) : undefined;
      const outlineId = scene?.outlineId ?? item.outlineId ?? scene?.id;
      const sceneIndex = scene ? scenes.findIndex((entry) => entry.id === scene.id) : -1;
      return <li className="border-l-2 border-amber-300 bg-amber-50/45 px-4 py-3" key={item.id}>
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold"><span className="text-amber-900">{REVIEW_KIND_LABEL[item.kind]}</span><span className="text-stone-300">/</span><span className="text-stone-500">{PROVENANCE_LABEL[item.provenance]}</span>{scene ? <span className="text-stone-500">第 {sceneIndex + 1} 页 · {scene.title}</span> : null}</div>
        <p className="mt-2 text-sm font-bold leading-6 text-stone-900">{item.content}</p>
        <p className="mt-1 text-xs leading-5 text-stone-600"><strong>教学用途：</strong>{item.teachingPurpose}</p>
        {item.source ? <p className="mt-1 text-xs leading-5 text-stone-500"><strong>相关来源：</strong>{item.source}</p> : null}
        {scene && outlineId ? <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1"><button className="inline-flex min-h-11 items-center gap-1 text-xs font-bold text-[var(--pbl-teacher)] hover:underline" onClick={() => onOpenPage(outlineId)} type="button">查看页面 <ChevronRight size={14} /></button><Link className="inline-flex min-h-11 items-center gap-1 text-xs font-bold text-[var(--pbl-teacher)] hover:underline" href={editorIssueHref(courseId, scene.id, item.elementId)}>定位并修改 <ExternalLink size={13} /></Link></div> : null}
      </li>;
    })}</ul> : <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-stone-600">{summary}</p>}
  </section>;
}

function ReviewStatusCard({
  actionDisabled = false,
  actionLabel,
  actionLoading = false,
  detail,
  icon,
  label,
  onAction,
  status,
  tone,
}: {
  actionDisabled?: boolean;
  actionLabel?: string;
  actionLoading?: boolean;
  detail: string;
  icon: ReactNode;
  label: string;
  onAction?: () => void;
  status: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const toneClass = tone === 'success' ? 'bg-emerald-50 text-emerald-800'
    : tone === 'warning' ? 'bg-amber-50 text-amber-900'
      : tone === 'danger' ? 'bg-rose-50 text-rose-800' : 'bg-stone-100 text-stone-600';
  return <div className="flex flex-col bg-white px-4 py-3">
    <div className="flex items-center gap-2">
      <span className={`grid size-8 shrink-0 place-items-center rounded-[8px] ${toneClass}`}>{icon}</span>
      <p className="min-w-0 flex-1 text-sm font-black text-stone-950">{label}</p>
      <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${toneClass}`}>{status}</span>
    </div>
    <p className="mt-2 flex-1 text-xs leading-5 text-stone-500">{detail}</p>
    {actionLabel && onAction ? <button
      className="mt-1 inline-flex min-h-11 items-center gap-1 self-start text-xs font-bold text-[var(--pbl-teacher)] hover:underline disabled:cursor-not-allowed disabled:text-stone-400 disabled:no-underline"
      disabled={actionDisabled}
      onClick={onAction}
      type="button"
    >{actionLoading ? <Loader2 className="animate-spin" size={13} /> : null}{actionLabel}<ChevronRight size={13} /></button> : null}
  </div>;
}
