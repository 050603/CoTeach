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
    const view = render(<CourseQualityReview courseId="course" onDecisionChange={onDecisionChange} onOpenPage={vi.fn()} />);
    await waitFor(() => expect(onDecisionChange).toHaveBeenLastCalledWith(expect.objectContaining({ canConfirm: true, signature: snapshot.signature })));
    expect(screen.getByText('内容一致性')).toBeTruthy();
    expect(screen.getByText('PPT 页面呈现')).toBeTruthy();
    expect(screen.getAllByText('未检查')).toHaveLength(2);
    expect(mocks.canvas).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '检查页面' }));
    await waitFor(() => expect(mocks.canvas).toHaveBeenCalled());
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
    expect(await screen.findByText('授课前来源与构造说明（1 项）')).toBeTruthy();
    expect(screen.getByText(/67% 为示意数值/)).toBeTruthy();
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
    const editorLink = screen.getByRole('link', { name: /在编辑器中定位元素/ });
    expect(editorLink.getAttribute('href')).toContain('sceneId=slide');
    expect(editorLink.getAttribute('href')).toContain('elementId=element-1');
    view.unmount();
  });
});
