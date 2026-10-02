'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@openmaic/lib/hooks/use-i18n';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import { useSlideEditSession } from './slide-edit-session';

export function teachingVisualEditMessages(locale: string) {
  return locale.startsWith('zh') ? {
    lock: '锁定构件', unlock: '解锁构件', recompose: '换构图', recomposePage: '整页换构图',
    pending: '正在换构图', complete: '构图已更新',
    locked: '构件已锁定，仍可直接编辑', modified: '已保留手动修改',
    unavailable: '这页的构件均已锁定或手动修改，已保留当前构图。',
    changed: '页面在换构图期间已被修改，已保留你的最新内容。',
    failed: '换构图未完成，已保留当前页面。',
  } : {
    lock: 'Lock component', unlock: 'Unlock component', recompose: 'Change layout', recomposePage: 'Change page layout',
    pending: 'Changing layout', complete: 'Layout updated',
    locked: 'Component protected; direct editing remains available', modified: 'Manual edits preserved',
    unavailable: 'All components are locked or edited. The current layout is preserved.',
    changed: 'This page changed during layout. Your latest edits are preserved.',
    failed: 'Layout could not be changed. The current page is preserved.',
  };
}

/** Captures the exact editing snapshot before asynchronous DOM measurement. */
export async function recomposeCurrentTeachingVisual(componentId?: string): Promise<boolean> {
  const session = useSlideEditSession.getState();
  const expected = session.history?.present;
  const sceneId = session.sceneId;
  if (!sceneId || !expected?.canvas.teachingVisual) return false;
  const visual = expected.canvas.teachingVisual;
  if (componentId) {
    const component = visual.components.find((item) => item.id === componentId);
    if (!component || component.locked || component.modified) return false;
  }

  const { recomposeTeachingVisualSlide } = await import('@openmaic/lib/edit/teaching-visual-recompose');
  const next = await recomposeTeachingVisualSlide(expected, { componentId });
  const current = useSlideEditSession.getState();
  if (current.sceneId !== sceneId || !current.commitComposition(expected, next)) return false;
  const liveIds = new Set(useSlideEditSession.getState().history?.present.canvas.elements.map((element) => element.id));
  const canvas = useCanvasStore.getState();
  canvas.setActiveElementIdList(canvas.activeElementIdList.filter((id) => liveIds.has(id)));
  return true;
}

export function useTeachingVisualRecompose() {
  const { locale } = useI18n();
  const [pending, setPending] = useState(false);
  const messages = teachingVisualEditMessages(locale);
  const recompose = useCallback(async (componentId?: string) => {
    if (pending) return;
    setPending(true);
    try {
      const applied = await recomposeCurrentTeachingVisual(componentId);
      if (applied) toast.success(teachingVisualEditMessages(locale).complete);
      else toast.info(teachingVisualEditMessages(locale).changed);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : teachingVisualEditMessages(locale).failed);
    } finally {
      setPending(false);
    }
  }, [locale, pending]);
  return { pending, recompose, messages };
}
