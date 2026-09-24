import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ canvas: vi.fn(), inspect: vi.fn(() => []) }));
vi.mock('@/components/openmaic/slide-renderer/Editor/ReadonlySlideCanvas', async () => {
  const { forwardRef } = await import('react');
  return { ReadonlySlideCanvas: forwardRef<HTMLDivElement, { scene: { id: string } }>(function Canvas({ scene }, ref) {
    mocks.canvas(scene.id);
    return <div ref={ref} />;
  }) };
});
vi.mock('@/lib/course-quality-review/render-measurements', () => ({
  inspectRenderedSlide: mocks.inspect,
  measureSlideElements: () => [],
}));
import { CourseQualityReview } from './course-quality-review';

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const snapshot = {
  required: true, signature: 'a'.repeat(64), quality: null, renderReview: null, teacherReview: null,
  teacherReviewItems: [], teacherReviewSummary: null,
  classroom: { id: 'classroom', scenes: [{ id: 'slide', type: 'slide', content: { type: 'slide', canvas: { elements: [] } } }] },
};
const respond = (body: unknown) => ({ ok: true, json: async () => body });
const renderReview = (runId: string, pages: unknown[] = []) => ({
  schemaVersion: 1, signature: snapshot.signature, classroomId: 'classroom', runId,
  reviewPolicyVersion: 'test-policy', status: 'running', pages, updatedAt: '2026-09-24T00:00:00.000Z',
});

describe('optional course review panel', () => {
  it('shows unchecked status, allows confirmation and mounts measurement only after a click', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url, options) => options?.method === 'POST'
      ? respond({ renderReview: renderReview('run-new') }) : respond(snapshot));
    vi.stubGlobal('fetch', fetchMock);
    const onDecisionChange = vi.fn();
    const onOpenPage = vi.fn();
    const onSummaryChange = vi.fn();
    const view = render(<CourseQualityReview courseId="course" onDecisionChange={onDecisionChange} onOpenPage={onOpenPage} onSummaryChange={onSummaryChange} />);
    await waitFor(() => expect(onDecisionChange).toHaveBeenLastCalledWith(expect.objectContaining({ canConfirm: true, signature: snapshot.signature })));
    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith({ attentionCount: 0, blockingCount: 0, status: 'ready' }));
    expect(screen.getByText('内容一致性')).toBeTruthy();
    expect(screen.getByText('PPT 页面呈现')).toBeTruthy();
    expect(screen.getAllByText('未检查')).toHaveLength(2);
    expect(mocks.canvas).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '检查页面' }));
    await waitFor(() => expect(mocks.canvas).toHaveBeenCalled());
    view.rerender(<CourseQualityReview courseId="course" onDecisionChange={onDecisionChange} onOpenPage={onOpenPage} onSummaryChange={onSummaryChange} visible={false} />);
    expect(view.container.querySelector('#publish-panel-checks')?.hasAttribute('hidden')).toBe(true);
    expect(mocks.canvas).toHaveBeenCalled();
    view.unmount();
  });
  it('sends the content check only after the teacher requests it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => snapshot });
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<CourseQualityReview courseId="course" onDecisionChange={vi.fn()} onOpenPage={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '检查内容' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '检查内容' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'check' }) })));
    expect(mocks.canvas).not.toHaveBeenCalled();
    view.unmount();
  });
  it('shows generation-time confirmation notes only in the teacher review panel', async () => {
    const withReview = {
      ...snapshot,
      teacherReviewItems: [{ id: 'review-1', kind: 'illustrative-data', provenance: 'constructed', content: '67% 为示意数值', teachingPurpose: '比较差异' }],
      teacherReviewSummary: '本次课程有 1 项内容建议授课前确认：\n1. 67% 为示意数值。',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => withReview }));
    const view = render(<CourseQualityReview courseId="course" onDecisionChange={vi.fn()} onOpenPage={vi.fn()} />);
    await screen.findByRole('button', { name: /来源说明/ });
    expect(screen.queryByText('授课前来源与构造说明（1 项）')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /来源说明/ }));
    expect(screen.getByText('授课前来源与构造说明（1 项）')).toBeTruthy();
    expect(screen.getByText(/67% 为示意数值/)).toBeTruthy();
    view.unmount();
  });
  it('groups content and page hints so only the selected category is shown', async () => {
    const categorized = {
      ...snapshot,
      quality: {
        status: 'completed', checkedAt: new Date().toISOString(), sections: [],
        issues: [{ id: 'content-1', origin: 'semantic', severity: 'suggestion', sceneId: 'slide', title: '内容表述需要确认', evidence: '表述可能产生歧义。', suggestion: '结合授课目标确认。' }],
      },
      renderReview: {
        status: 'completed', updatedAt: new Date().toISOString(),
        pages: [{ sceneId: 'slide', status: 'completed', checkedAt: new Date().toISOString(), issues: [{ id: 'page-1', origin: 'render', severity: 'suggestion', sceneId: 'slide', title: '页面文字较密', evidence: '页面信息密度偏高。', suggestion: '精简文字。' }] }],
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => categorized }));
    const view = render(<CourseQualityReview courseId="course" onDecisionChange={vi.fn()} onOpenPage={vi.fn()} />);
    expect(await screen.findByText('内容表述需要确认')).toBeTruthy();
    expect(screen.getByText('页面文字较密')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /内容提示/ }));
    expect(screen.getByText('内容表述需要确认')).toBeTruthy();
    expect(screen.queryByText('页面文字较密')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /页面提示/ }));
    expect(screen.queryByText('内容表述需要确认')).toBeNull();
    expect(screen.getByText('页面文字较密')).toBeTruthy();
    view.unmount();
  });
  it('surfaces deterministic blockers and disables publication before optional checks run', async () => {
    const blocked = {
      ...snapshot,
      blockingIssues: [{
        id: 'hard-1', origin: 'structure', severity: 'error', blocking: true,
        sceneId: 'slide', elementId: 'element-1', title: '课件缺少必要材料',
        evidence: '第 1 页缺少对比数据。', suggestion: '补齐数据后重新检查。',
      }],
      classroom: {
        ...snapshot.classroom,
        scenes: [{ ...snapshot.classroom.scenes[0], outlineId: 'outline-1', title: '认识关键数据' }],
      },
    };
    const onDecisionChange = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => blocked }));
    const view = render(<CourseQualityReview courseId="course" onDecisionChange={onDecisionChange} onOpenPage={vi.fn()} />);
    expect(await screen.findByText('课件缺少必要材料')).toBeTruthy();
    await waitFor(() => expect(onDecisionChange).toHaveBeenLastCalledWith(expect.objectContaining({ canConfirm: false })));
    expect(screen.getByText('有阻断项')).toBeTruthy();
    const editorLink = screen.getByRole('link', { name: /定位并修改/ });
    expect(editorLink.getAttribute('href')).toContain('sceneId=slide');
    expect(editorLink.getAttribute('href')).toContain('elementId=element-1');
    view.unmount();
  });

  it('uses only current server blockers and does not let cached reports hide them', async () => {
    const hard = { id: 'hard-1', origin: 'structure', severity: 'error', blocking: true,
      title: '当前真实故障', evidence: '页面未生成', suggestion: '重新生成页面' };
    const current = {
      ...snapshot, blockingIssues: [hard], teacherReview: { confirmedAt: '2026-09-24T00:00:00.000Z' },
      quality: { status: 'completed', issues: [
        { ...hard, title: '过期同名记录', status: 'resolved' },
        { ...hard, id: 'obsolete', title: '旧规则必须处理' },
      ] },
    };
    const onDecisionChange = vi.fn();
    const onSummaryChange = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(current)));
    const view = render(<CourseQualityReview courseId="course" onDecisionChange={onDecisionChange} onOpenPage={vi.fn()} onSummaryChange={onSummaryChange} />);
    expect(await screen.findByText('当前真实故障')).toBeTruthy();
    expect(screen.queryByText('旧规则必须处理')).toBeNull();
    expect(screen.queryByText('过期同名记录')).toBeNull();
    await waitFor(() => expect(onDecisionChange).toHaveBeenLastCalledWith(expect.objectContaining({ canConfirm: false })));
    expect(onSummaryChange).toHaveBeenLastCalledWith(expect.objectContaining({ blockingCount: 1, status: 'blocked' }));
    view.unmount();
  });

  it('allows confirmation when a cached report is the only source of blocking flags', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond({ ...snapshot, blockingIssues: [], quality: {
      status: 'completed', issues: [{ id: 'legacy', origin: 'structure', severity: 'error', blocking: true,
        title: '必须逐字出现术语', evidence: '旧报告', suggestion: '逐字重复' }],
    } })));
    const onDecisionChange = vi.fn();
    const view = render(<CourseQualityReview courseId="course" onDecisionChange={onDecisionChange} onOpenPage={vi.fn()} />);
    await waitFor(() => expect(onDecisionChange).toHaveBeenLastCalledWith(expect.objectContaining({ canConfirm: true })));
    expect(screen.queryByText('必须逐字出现术语')).toBeNull();
    view.unmount();
  });

  it('remeasures every page in a new batch even when polling returns old completed pages', async () => {
    const slides = ['slide-1', 'slide-2'].map((id) => ({ ...snapshot.classroom.scenes[0], id }));
    const oldPages = slides.map((scene) => ({ sceneId: scene.id, status: 'completed', checkedAt: '', issues: [] }));
    const current = { ...snapshot, classroom: { ...snapshot.classroom, scenes: slides }, renderReview: renderReview('run-old', oldPages) };
    const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
      if (options?.method !== 'POST') return respond(current);
      const body = JSON.parse(options.body);
      return respond(body.action === 'render-start' ? { renderReview: renderReview('run-new') } : { success: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<CourseQualityReview courseId="course" onDecisionChange={vi.fn()} onOpenPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '重新检查页面' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST' && JSON.parse(options.body).action === 'render-page')).toHaveLength(2));
    const posted = fetchMock.mock.calls.flatMap(([, options]) => options?.method === 'POST' ? [JSON.parse(options.body)] : []);
    expect(posted[0]).toEqual({ action: 'render-start', signature: snapshot.signature, mode: 'all' });
    expect(posted.filter((body) => body.action === 'render-page').map((body) => [body.runId, body.page.sceneId])).toEqual([
      ['run-new', 'slide-1'], ['run-new', 'slide-2'],
    ]);
    expect(mocks.inspect).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/2 \/ 2 页完成/)).toBeTruthy();
    view.unmount();
  });

  it('retries unfinished pages without measuring pages retained by the server', async () => {
    const slides = ['slide-1', 'slide-2'].map((id) => ({ ...snapshot.classroom.scenes[0], id }));
    const complete = { sceneId: 'slide-1', status: 'completed', checkedAt: '', issues: [] };
    const failed = { sceneId: 'slide-2', status: 'failed', checkedAt: '', issues: [] };
    const current = { ...snapshot, classroom: { ...snapshot.classroom, scenes: slides }, renderReview: renderReview('run-old', [complete, failed]) };
    const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
      if (options?.method !== 'POST') return respond(current);
      const body = JSON.parse(options.body);
      return respond(body.action === 'render-start' ? { renderReview: renderReview('run-retry', [complete]) } : { success: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<CourseQualityReview courseId="course" onDecisionChange={vi.fn()} onOpenPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '仅重试未完成页面' }));
    await waitFor(() => expect(mocks.inspect).toHaveBeenCalledTimes(1));
    const posted = fetchMock.mock.calls.flatMap(([, options]) => options?.method === 'POST' ? [JSON.parse(options.body)] : []);
    expect(posted[0]).toEqual({ action: 'render-start', signature: snapshot.signature, mode: 'retry' });
    expect(posted.find((body) => body.action === 'render-page')).toMatchObject({ runId: 'run-retry', page: { sceneId: 'slide-2' } });
    expect(mocks.canvas.mock.calls.every(([id]) => id === 'slide-2')).toBe(true);
    view.unmount();
  });

  it('offers separate full content recheck and retry actions after a partial failure', async () => {
    const current = { ...snapshot, quality: { status: 'failed', issues: [], sections: [
      { id: 'done', status: 'completed' }, { id: 'failed', status: 'failed' },
    ] } };
    const fetchMock = vi.fn().mockResolvedValue(respond(current));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<CourseQualityReview courseId="course" onDecisionChange={vi.fn()} onOpenPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '仅重试未完成小节' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ action: 'retry' }) })));
    await waitFor(() => expect(screen.getByRole('button', { name: '仅重查内容' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '仅重查内容' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ action: 'check' }) })));
    view.unmount();
  });

  it('does not restore a previous content batch when an old poll arrives after a recheck', async () => {
    const old = { ...snapshot, quality: { runId: 'old-run', status: 'completed', issues: [], sections: [] } };
    const newQuality = { runId: 'new-run', status: 'pending', issues: [], sections: [] };
    const fetchMock = vi.fn().mockImplementation(async (_url, options) => respond(
      options?.method === 'POST' ? { quality: newQuality } : old,
    ));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<CourseQualityReview courseId="course" onDecisionChange={vi.fn()} onOpenPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '仅重查内容' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      method: 'POST', body: JSON.stringify({ action: 'check' }),
    })));
    await waitFor(() => expect(screen.getByText('正在分段核对课程内容')).toBeTruthy());
    expect(screen.queryByText('已检查')).toBeNull();
    view.unmount();
  });

  it('discloses unchecked lessons before optional checking starts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond({ ...snapshot, reviewScope: {
      kind: 'test-lesson', checkedSectionTitle: '认识对比实验', checkedOutlineIds: ['outline-1'],
      uncheckedOutlineCount: 10, unreviewedSectionCount: 3,
    } })));
    const view = render(<CourseQualityReview courseId="course" onDecisionChange={vi.fn()} onOpenPage={vi.fn()} />);
    expect(await screen.findByText(/当前检查范围：认识对比实验/)).toBeTruthy();
    expect(screen.getByText(/其余 3 个小节未检查，不计为缺失/)).toBeTruthy();
    view.unmount();
  });
});
