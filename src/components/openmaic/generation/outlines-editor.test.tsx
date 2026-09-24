import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@openmaic/lib/hooks/use-i18n';
import type { SceneOutline } from '@openmaic/lib/types/generation';

import { OutlinesEditor } from './outlines-editor';

const outline: SceneOutline = {
  id: 'scene-1',
  type: 'interactive',
  title: '观察变量之间的关系',
  description: '学生通过调节参数，比较图像变化并记录规律。',
  keyPoints: ['自变量', '变化趋势'],
  order: 1,
  audience: 'student',
  stageKey: 'ai-learning',
  parentActivityId: 'activity-1',
  targetDurationSec: 300,
  widgetType: 'simulation',
  widgetOutline: { concept: '变量关系' },
};

describe('OutlinesEditor lesson script workspace', () => {
  it('numbers knowledge sections in outline order and uses their topics as headings', () => {
    const page = { type: 'slide' as const, description: '', keyPoints: [], order: 1, stageLabel: '知识讲授' };
    const sectionOutlines = [
      { ...page, id: 'scene-1', title: '认识样本', parentActivityId: 'section-a', lectureSectionId: 'section-a', lectureSectionTitle: '训练数据' },
      { ...page, id: 'scene-2', title: '划分样本', parentActivityId: 'section-a', lectureSectionId: 'section-a', lectureSectionTitle: '训练数据' },
      { ...page, id: 'scene-3', title: '检查指标', parentActivityId: 'section-b', lectureSectionId: 'section-b', lectureSectionTitle: '模型评估' },
    ];
    render(
      <I18nProvider locale="zh-CN">
        <OutlinesEditor
          outlines={sectionOutlines}
          onChange={vi.fn()}
          onConfirm={vi.fn()}
          onBack={vi.fn()}
          hideHeader
          hideFooter
          scriptWorkspace
        />
      </I18nProvider>,
    );

    expect(screen.getAllByText('训练数据')).toHaveLength(1);
    expect(screen.getByText('训练数据').parentElement).toHaveTextContent('01训练数据');
    expect(screen.getByText('模型评估').parentElement).toHaveTextContent('02模型评估');
    expect(screen.queryByText('00')).toBeNull();
  });

  it('renders each detail as a structured page card with a solid settings panel', () => {
    render(
      <I18nProvider locale="zh-CN">
        <OutlinesEditor
          outlines={[outline]}
          onChange={vi.fn()}
          onConfirm={vi.fn()}
          onBack={vi.fn()}
          hideHeader
          hideFooter
          bare
          naturalFlow
          distinguishAudience
          scriptWorkspace
          parentActivities={[{ id: 'activity-1', title: '知识建构' }]}
          knowledgePoints={[{ id: 'point-1', name: '函数关系' }]}
        />
      </I18nProvider>,
    );

    const article = screen.getByRole('article', { name: '第 1 页：观察变量之间的关系' });
    const dragHandle = screen.getByRole('button', { name: /拖动排序|Drag to reorder/ });
    expect(article.getAttribute('draggable')).toBe('true');
    expect(dragHandle.getAttribute('draggable')).toBeNull();
    expect(screen.queryByText('页面内容')).toBeNull();
    expect(screen.queryByText('页面设置')).toBeNull();
    expect(screen.queryByText('学生学习页面')).toBeNull();
    expect(screen.getByText('组件')).toBeTruthy();
    expect(screen.getAllByText('互动').length).toBeGreaterThan(1);
    expect(screen.getByText('内容要点')).toBeTruthy();
    expect(screen.getByText('自变量').parentElement?.className).toContain('min-h-[48px]');
    expect(screen.getByRole('complementary', { name: '第 1 页设置' }).className).toContain('flex-wrap');
    expect(screen.getByRole('complementary', { name: '第 1 页设置' }).className).not.toContain('lg:border-l');
    expect(screen.getByRole('button', { name: '互动' }).className).toContain('bg-[var(--pbl-success-soft)]');

    fireEvent.click(screen.getByRole('button', { name: '仿真模拟' }));
    const popoverTitle = screen.getByText('互动组件设置');
    expect(popoverTitle).toBeTruthy();
    expect(popoverTitle.parentElement?.parentElement?.className).toContain('bg-white');
    expect(screen.queryByText('选择交互形式并说明核心概念')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '添加知识点' }));
    expect(screen.getByText('添加知识点')).toBeTruthy();
    expect(screen.queryByText('选择与当前页面直接相关的核心概念')).toBeNull();
  });

  it('places add-page controls at both ends of a fixed stage and preserves stage ownership', () => {
    const onChange = vi.fn();
    const sectionOutline = { ...outline, lectureSectionId: 'section-1', lectureSectionTitle: '函数关系' };
    render(
      <I18nProvider locale="zh-CN">
        <OutlinesEditor
          outlines={[sectionOutline]}
          onChange={onChange}
          onConfirm={vi.fn()}
          onBack={vi.fn()}
          hideHeader
          hideFooter
          bare
          naturalFlow
          scriptWorkspace
          parentActivities={[{ id: 'activity-1', title: '知识建构' }]}
        />
      </I18nProvider>,
    );

    const addButtons = screen.getAllByRole('button', { name: /Insert a scene here|在此处插入一个场景/ });
    expect(addButtons).toHaveLength(2);
    expect(addButtons[0].querySelector('svg')?.parentElement?.className).toContain('opacity-0');
    expect(addButtons[1].querySelector('svg')?.parentElement?.className).toContain('opacity-0');
    fireEvent.click(addButtons[1]);

    const nextOutlines = onChange.mock.calls[0][0] as SceneOutline[];
    expect(nextOutlines).toHaveLength(2);
    expect(nextOutlines[1]).toMatchObject({
      parentActivityId: outline.parentActivityId,
      lectureSectionId: sectionOutline.lectureSectionId,
      lectureSectionTitle: sectionOutline.lectureSectionTitle,
      stageKey: outline.stageKey,
      audience: outline.audience,
      type: 'slide',
    });
  });

  it('replays the target emphasis animation for a directory selection', () => {
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }) as unknown as Animation);
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    });

    const { rerender } = render(
      <I18nProvider locale="zh-CN">
        <OutlinesEditor
          outlines={[outline]}
          onChange={vi.fn()}
          onConfirm={vi.fn()}
          onBack={vi.fn()}
          hideHeader
          hideFooter
          bare
          naturalFlow
          scriptWorkspace
          focusRequest={{ id: outline.id, nonce: 1 }}
        />
      </I18nProvider>,
    );

    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenLastCalledWith(
      expect.any(Array),
      expect.objectContaining({ duration: 3000 }),
    );

    rerender(
      <I18nProvider locale="zh-CN">
        <OutlinesEditor
          outlines={[outline]}
          onChange={vi.fn()}
          onConfirm={vi.fn()}
          onBack={vi.fn()}
          hideHeader
          hideFooter
          bare
          naturalFlow
          scriptWorkspace
          focusRequest={{ id: outline.id, nonce: 2 }}
        />
      </I18nProvider>,
    );

    expect(animate).toHaveBeenCalledTimes(2);
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  });
});
