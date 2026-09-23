import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ canvas: vi.fn() }));
vi.mock('@/components/openmaic/slide-renderer/Editor/ReadonlySlideCanvas', () => ({ ReadonlySlideCanvas: () => { mocks.canvas(); return <div />; } }));
import { CourseQualityReview } from './course-quality-review';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const snapshot = {
  required: true, signature: 'a'.repeat(64), quality: null, renderReview: null, teacherReview: null,
  teacherReviewItems: [], teacherReviewSummary: null,
  classroom: { id: 'classroom', scenes: [{ id: 'slide', type: 'slide', content: { type: 'slide', canvas: { elements: [] } } }] },
};

describe('optional course review panel', () => {
  it('shows unchecked status, allows confirmation and mounts measurement only after a click', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => snapshot });
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
});
