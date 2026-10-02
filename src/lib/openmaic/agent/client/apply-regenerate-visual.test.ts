import { describe, expect, it } from 'vitest';
import { planRegenerateApply, toRuntimeSlideContent } from './apply-regenerate';
import { teachingVisualEditFixture } from '@openmaic/lib/edit/teaching-visual-edit-fixture';
import { applySlideEditOperation } from '@openmaic/lib/edit/slide-ops';
import type { SlideContent } from '@openmaic/lib/types/stage';

describe('regeneration respects visual teacher edits', () => {
  it.each(['locked', 'modified', 'manual'] as const)('keeps both canvas and narration for a %s page', (kind) => {
    const original = teachingVisualEditFixture();
    const content = kind === 'locked'
      ? applySlideEditOperation(original, { type: 'visual.setLocked', componentId: 'support', locked: true })
      : kind === 'modified'
        ? applySlideEditOperation(original, { type: 'element.delete', elementId: 'support-image' })
        : applySlideEditOperation(original, { type: 'element.update', elementId: 'title', patch: { top: 36 } });
    const plan = planRegenerateApply({
      sceneId: 'scene', content: { elements: original.canvas.elements },
      actions: [{ id: 'new-speech', type: 'speech', text: '重新生成的讲稿' }],
    }, { content, actions: [{ id: 'speech', type: 'speech', text: '已保存讲稿' }] }, 'regenerate_scene');
    expect(plan.patch).toBeNull();
    expect(plan.snapshot).toBeNull();
    expect(plan.error).toContain('已保留当前页面和讲稿');
  });

  it('uses mappings from the new compiled scene and drops old mappings on legacy regeneration', () => {
    const original = teachingVisualEditFixture();
    const regenerated = teachingVisualEditFixture();
    regenerated.canvas.teachingVisual!.candidateId = 'focus-stacked';
    const runtime = toRuntimeSlideContent({
      elements: regenerated.canvas.elements, teachingVisual: regenerated.canvas.teachingVisual,
      theme: { ...regenerated.canvas.theme, fontName: 'Noto Sans SC', fontColor: '#253448', backgroundColor: '#FCFCFA' },
    }, original.canvas as unknown as Record<string, unknown>) as SlideContent;
    expect(runtime.canvas.teachingVisual?.candidateId).toBe('focus-stacked');
    expect(runtime.canvas.theme.fontColor).toBe('#253448');
    expect(runtime.canvas.theme.fontName).toBe('Noto Sans SC');
    const legacy = toRuntimeSlideContent({ elements: original.canvas.elements }, original.canvas as unknown as Record<string, unknown>) as SlideContent;
    expect(legacy.canvas.teachingVisual).toBeUndefined();
  });

  it('continues to apply compatible regeneration to unedited scenes', () => {
    const original = teachingVisualEditFixture();
    const plan = planRegenerateApply({
      sceneId: 'scene', content: { elements: original.canvas.elements, teachingVisual: original.canvas.teachingVisual },
      actions: [{ id: 'new-speech', type: 'speech', text: '新讲解' }],
    }, { content: original, actions: [] }, 'regenerate_scene');
    expect(plan.error).toBeUndefined();
    expect((plan.patch?.content as SlideContent).canvas.teachingVisual).toEqual(original.canvas.teachingVisual);
    expect(plan.patch?.actions?.[0].id).toBe('new-speech');
  });
});
