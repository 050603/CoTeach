import { describe, expect, it } from 'vitest';
import { teachingVisualEditFixture } from './teaching-visual-edit-fixture';
import { applySlideEditOperation, createSlideEditHistory, redoSlideEditOperation, undoSlideEditOperation } from './slide-ops';
import { commitSlideEdit } from './scene-edit-bridge';
import { hasProtectedTeachingVisualEdits, isRendererUserEdit, markTeachingVisualEdits, preserveTeachingVisualEdits } from './teaching-visual-edits';
import { createDefaultTextElement } from './slide-edit-elements';

describe('teaching visual teacher ownership', () => {
  it('tracks image replacement, rich text and deletion in the same undo snapshot', () => {
    const original = teachingVisualEditFixture();
    let history = createSlideEditHistory(original);
    history = applySlideEditOperation(history, { type: 'element.update', elementId: 'support-image', patch: { src: '/teacher-image.png', clip: undefined } });
    expect(history.present.canvas.teachingVisual?.components[0].modified).toBe(true);
    expect(history.present.canvas.teachingVisual?.components[1].modified).toBeUndefined();
    expect(undoSlideEditOperation(history).present.canvas.teachingVisual?.components[0].modified).toBeUndefined();
    expect(redoSlideEditOperation(undoSlideEditOperation(history)).present).toEqual(history.present);
    history = applySlideEditOperation(history, { type: 'text.updateContent', elementId: 'support-label', content: '<p>逐个撤除，不能一次撤销</p>' });
    history = applySlideEditOperation(history, { type: 'element.delete', elementId: 'support-image' });
    expect(history.present.canvas.teachingVisual?.components[0].elementIds).toContain('support-image');
    expect(history.present.canvas.teachingVisual?.scene).toEqual(original.canvas.teachingVisual?.scene);
    expect(history.present.canvas.elements.find((element) => element.id === 'support-image')).toBeUndefined();
  });

  it('protects components without preventing direct editing and restores lock with undo', () => {
    let history = createSlideEditHistory(teachingVisualEditFixture());
    history = applySlideEditOperation(history, { type: 'visual.setLocked', componentId: 'support', locked: true });
    expect(history.present.canvas.teachingVisual?.components[0]).toMatchObject({ locked: true });
    expect(history.present.canvas.teachingVisual?.components[0].modified).toBeUndefined();
    expect(history.present.canvas.elements.every((element) => !element.lock)).toBe(true);
    history = applySlideEditOperation(history, { type: 'element.update', elementId: 'support-label', patch: { left: 240 } });
    expect(history.present.canvas.teachingVisual?.components[0]).toMatchObject({ locked: true, modified: true });
    history = applySlideEditOperation(history, { type: 'visual.setLocked', componentId: 'support', locked: false });
    expect(history.present.canvas.teachingVisual?.components[0]).toMatchObject({ locked: false, modified: true });
    expect(undoSlideEditOperation(history).present.canvas.teachingVisual?.components[0].locked).toBe(true);
  });

  it('marks a multi-element renderer gesture once without marking unaffected components', () => {
    const original = teachingVisualEditFixture();
    const next = structuredClone(original);
    next.canvas.elements[1].left += 100;
    next.canvas.elements[2].top += 30;
    const history = commitSlideEdit(createSlideEditHistory(original), next);
    expect(history.past).toHaveLength(1);
    expect(history.present.canvas.teachingVisual?.components.map((component) => component.modified)).toEqual([true, undefined]);
    expect(undoSlideEditOperation(history).present).toEqual(original);
    const deleted = structuredClone(original);
    deleted.canvas.elements.splice(1, 1);
    expect(markTeachingVisualEdits(original, deleted).canvas.teachingVisual?.components[1].modified).toBeUndefined();
  });

  it('distinguishes auto-height normalization from debounced keyboard or toolbar input', () => {
    const original = teachingVisualEditFixture();
    const normalized = structuredClone(original);
    const normalizedLabel = normalized.canvas.elements[1];
    if (normalizedLabel.type !== 'text') throw new Error('Expected the editable text label');
    normalizedLabel.height += 20;
    expect(isRendererUserEdit(original, normalized, false)).toBe(false);
    expect(isRendererUserEdit(original, normalized, true)).toBe(true);
    const typed = structuredClone(normalized);
    const text = typed.canvas.elements[1];
    if (text.type === 'text') text.content = '<p>能独立解决问题时撤离</p>';
    expect(isRendererUserEdit(normalized, typed, false)).toBe(true);
  });

  it('keeps renderer z-order and its ownership flags in the same reversible commit', () => {
    const original = teachingVisualEditFixture();
    const reordered = structuredClone(original);
    const [first] = reordered.canvas.elements.splice(1, 1);
    reordered.canvas.elements.push(first);
    const history = commitSlideEdit(createSlideEditHistory(original), reordered);
    expect(history.present.canvas.elements.map((element) => element.id)).toEqual(reordered.canvas.elements.map((element) => element.id));
    expect(history.present.canvas.teachingVisual?.components[0].modified).toBe(true);
    expect(undoSlideEditOperation(history).present.canvas.elements.map((element) => element.id)).toEqual(original.canvas.elements.map((element) => element.id));
  });

  it('preserves manual objects, title edits, deletion tombstones and backgrounds', () => {
    const original = teachingVisualEditFixture();
    let edited = applySlideEditOperation(original, { type: 'element.add', element: createDefaultTextElement('manual-note') });
    edited = applySlideEditOperation(edited, { type: 'element.update', elementId: 'title', patch: { left: 40 } });
    edited = applySlideEditOperation(edited, { type: 'element.delete', elementId: 'manual-note' });
    edited = applySlideEditOperation(edited, { type: 'slide.update', patch: { background: { type: 'solid', color: '#effaf7' } } });
    expect(edited.canvas.teachingVisual).toMatchObject({ manualElementIds: ['manual-note', 'title'], modifiedSlide: true });
    const candidate = structuredClone(original);
    candidate.canvas.elements.push(createDefaultTextElement('manual-note'));
    candidate.canvas.elements[3].top = 280;
    const merged = preserveTeachingVisualEdits(edited, candidate);
    expect(merged.canvas.background).toEqual(edited.canvas.background);
    expect(merged.canvas.elements.find((element) => element.id === 'title')?.left).toBe(40);
    expect(merged.canvas.elements.find((element) => element.id === 'manual-note')).toBeUndefined();
    expect(merged.canvas.elements.find((element) => element.id === 'evaluation-label')?.top).toBe(280);
  });

  it('merges only unprotected components and never resurrects deleted images', () => {
    const original = teachingVisualEditFixture();
    let edited = applySlideEditOperation(original, { type: 'element.delete', elementId: 'support-image' });
    edited = applySlideEditOperation(edited, { type: 'text.updateContent', elementId: 'support-label', content: '<p>教师修改的撤除条件</p>' });
    const candidate = structuredClone(original);
    candidate.canvas.teachingVisual!.candidateId = 'focus-stacked';
    candidate.canvas.elements[3].left = 440;
    const merged = preserveTeachingVisualEdits(edited, candidate);
    expect(merged.canvas.elements.find((element) => element.id === 'support-image')).toBeUndefined();
    expect(merged.canvas.elements.find((element) => element.id === 'support-label')).toEqual(edited.canvas.elements[1]);
    expect(merged.canvas.elements.find((element) => element.id === 'evaluation-label')?.left).toBe(440);
    expect(merged.canvas.teachingVisual?.candidateId).toBe('focus-stacked');
  });

  it('retains the executable draft when protected ownership cannot be mapped safely', () => {
    const original = teachingVisualEditFixture();
    const locked = applySlideEditOperation(original, { type: 'visual.setLocked', componentId: 'support', locked: true });
    const incompatible = teachingVisualEditFixture();
    incompatible.canvas.teachingVisual!.components.splice(0, 1);
    expect(preserveTeachingVisualEdits(locked, incompatible)).toBe(locked);
    delete incompatible.canvas.teachingVisual;
    expect(preserveTeachingVisualEdits(locked, incompatible)).toBe(locked);
  });

  it('does not inject visual ownership into legacy slides or push ineffective lock steps', () => {
    const original = teachingVisualEditFixture();
    delete original.canvas.teachingVisual;
    const edited = applySlideEditOperation(original, { type: 'element.update', elementId: 'support-label', patch: { left: 200 } });
    expect(edited.canvas.teachingVisual).toBeUndefined();
    expect(hasProtectedTeachingVisualEdits(edited)).toBe(false);
    const history = createSlideEditHistory(teachingVisualEditFixture());
    expect(applySlideEditOperation(history, { type: 'visual.setLocked', componentId: 'missing', locked: true })).toBe(history);
    expect(applySlideEditOperation(history, { type: 'visual.setLocked', componentId: 'support', locked: false })).toBe(history);
  });
});
