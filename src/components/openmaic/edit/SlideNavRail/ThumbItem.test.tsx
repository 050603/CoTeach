import { render, screen } from '@testing-library/react';
import { Reorder } from 'motion/react';
import { describe, expect, it, vi } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import type { Scene } from '@openmaic/lib/types/stage';
import { I18nProvider } from '@openmaic/lib/hooks/use-i18n';
import { ThumbItem } from './ThumbItem';

vi.mock('@openmaic/components/stage/scene-thumbnail-content', () => ({
  SceneThumbnailContent: () => <div>缩略图</div>,
}));

const action = (value: Record<string, unknown>): Action => value as unknown as Action;

function renderThumb(actions: Action[]) {
  const scene = { id: 'scene', type: 'slide', title: '关系图', actions } as Scene;
  return render(
    <I18nProvider locale="zh-CN">
      <Reorder.Group axis="y" values={[scene.id]} onReorder={vi.fn()}>
        <ThumbItem scene={scene} index={0} active canDelete onActivate={vi.fn()} onDuplicate={vi.fn()} onDelete={vi.fn()} />
      </Reorder.Group>
    </I18nProvider>,
  );
}

describe('page narration diagnoses', () => {
  it('does not mark a page containing narration and legitimate empty-text waits', () => {
    const view = renderThumb([
      action({ id: 'speech', type: 'speech', text: '观察关系图。' }),
      action({ id: 'reflection', type: 'speech', text: '', timelinePauseSec: 30 }),
      action({ id: 'activity', type: 'speech', text: '', activityPauseSec: 60 }),
    ]);
    expect(view.container.querySelector('[aria-label^="本页讲解需补充"]')).toBeNull();
  });

  it('shows specific, deduplicated reasons for genuine missing content', () => {
    renderThumb([
      action({ id: 'empty', type: 'speech', text: '', timelinePauseSec: Infinity }),
      action({ id: 'also-empty', type: 'speech', text: ' ' }),
      action({ id: 'cue', type: 'laser', elementId: '' }),
      action({ id: 'discussion', type: 'discussion', topic: '' }),
    ]);
    const message = '本页讲解需补充：讲稿为空 · 指引未选择元素 · 讨论主题为空';
    expect(screen.getByLabelText(message)).toHaveAttribute('title', message);
  });

  it('explains a page without narration actions', () => {
    renderThumb([]);
    expect(screen.getByLabelText('本页讲解需补充：尚未添加讲解动作')).toBeInTheDocument();
  });
});
