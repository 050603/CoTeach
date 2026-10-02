import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedSlideContent } from '../types/generation';
import type { SlideContent } from '../types/stage';
import { teachingVisualEditFixture } from './teaching-visual-edit-fixture';
import { createDefaultShapeElement, createDefaultTextElement } from './slide-edit-elements';
import { applySlideEditOperation, createSlideEditHistory, redoSlideEditOperation, undoSlideEditOperation } from './slide-ops';
import { preserveTeachingVisualEdits } from './teaching-visual-edits';
import { migrateSlideContent } from './slide-schema';
import { toRuntimeSlideContent } from '../agent/client/apply-regenerate';

const mocks = vi.hoisted(() => ({ compile: vi.fn() }));
vi.mock('../generation/teaching-visual-compiler', () => ({ compileTeachingVisualScene: mocks.compile }));
import { recomposeTeachingVisualSlide } from './teaching-visual-recompose';

function fixture() {
  const content = teachingVisualEditFixture();
  const visual = content.canvas.teachingVisual!;
  visual.candidateId = 'visual-1';
  visual.sourceCatalog = [{ id: 'source-1', text: '逐步撤除' }, { id: 'source-2', text: '评价主体' }];
  const components = visual.scene.pages[0]!.components;
  components[0]!.role = 'primary';
  components[0]!.nodes[0]!.icon = 'layers';
  Object.assign(components[1]!, { role: 'support', anchorNodeId: 'withdraw' });
  components[1]!.nodes[0]!.icon = 'checklist';
  components.push({ id: 'takeaway', kind: 'text', role: 'takeaway',
    nodes: [{ id: 'conclusion', text: '逐步撤除', icon: 'flag', sourceContentIds: ['source-1'] }] });
  visual.components[0]!.elementIds.push('support-symbol');
  visual.components.push({ id: 'takeaway', kind: 'text', elementIds: ['takeaway-label'], sourceContentIds: ['source-1'] });
  Object.assign(content.canvas.elements[0]!, { left: 48, top: 28, width: 700, height: 48 });
  Object.assign(content.canvas.elements[1]!, { left: 50, top: 140, width: 220, height: 60 });
  Object.assign(content.canvas.elements[2]!, { left: 50, top: 210, width: 220, height: 100 });
  Object.assign(content.canvas.elements[3]!, { left: 650, top: 160, width: 180, height: 72 });
  content.canvas.elements.push({ ...createDefaultShapeElement('support-symbol'), groupId: 'support',
    left: 50, top: 320, width: 40, height: 40, path: 'M0 20L20 0L40 20L20 40Z', viewBox: [40, 40] },
  { ...createDefaultTextElement('takeaway-label'), groupId: 'takeaway', left: 650, top: 340, width: 180, height: 60,
    content: '<p style="font-size:20px">逐步撤除</p>' });
  return content;
}

function candidate(content: SlideContent): GeneratedSlideContent {
  const next = structuredClone(content.canvas);
  next.teachingVisual!.candidateId = 'visual-2';
  next.elements.find((element) => element.id === 'evaluation-label')!.left = 550;
  return next;
}

beforeEach(() => { mocks.compile.mockReset(); });

describe('optional teaching visual scene fields across editing and regeneration', () => {
  it('keeps roles, anchors and glyph hints with native edits and reversible protection', () => {
    const original = fixture();
    let history = createSlideEditHistory(original);
    history = applySlideEditOperation(history, { type: 'visual.setLocked', componentId: 'support', locked: true });
    history = applySlideEditOperation(history, { type: 'element.update', elementId: 'support-symbol', patch: { fill: '#B8752B' } });
    history = applySlideEditOperation(history, { type: 'text.updateContent', elementId: 'support-label', content: '<p>逐个撤除，不能一次撤销</p>' });
    expect(history.present.canvas.teachingVisual!.scene).toEqual(original.canvas.teachingVisual!.scene);
    expect(history.present.canvas.teachingVisual!.components[0]).toMatchObject({ locked: true, modified: true });
    const undone = undoSlideEditOperation(undoSlideEditOperation(undoSlideEditOperation(history)));
    expect(undone.present).toEqual(original);
    expect(redoSlideEditOperation(redoSlideEditOperation(redoSlideEditOperation(undone))).present).toEqual(history.present);
  });

  it('protects deletion of a native glyph and retains the complete semantic plan while changing other geometry', () => {
    const original = fixture();
    const edited = applySlideEditOperation(original, { type: 'element.delete', elementId: 'support-symbol' });
    const next = toRuntimeSlideContent(candidate(original), { ...original.canvas }) as SlideContent;
    const merged = preserveTeachingVisualEdits(edited, next);
    expect(merged.canvas.elements.find((element) => element.id === 'support-symbol')).toBeUndefined();
    expect(merged.canvas.teachingVisual!.components[0]).toMatchObject({ modified: true, elementIds: expect.arrayContaining(['support-symbol']) });
    expect(merged.canvas.elements.find((element) => element.id === 'evaluation-label')!.left).toBe(550);
    expect(merged.canvas.teachingVisual!.scene).toEqual(original.canvas.teachingVisual!.scene);
  });

  it('passes all layout hints into bounded compilation and retains them when only geometry is recomposed', async () => {
    const original = fixture();
    const next = candidate(original);
    // A compiler may return one-page metadata; the editor owns the full scene.
    next.teachingVisual!.scene = { ...next.teachingVisual!.scene, pages: [] };
    mocks.compile.mockResolvedValue(next);
    const result = await recomposeTeachingVisualSlide(original, { componentId: 'evaluation' });
    const [outline, scene, options] = mocks.compile.mock.calls[0];
    expect(scene).toEqual(original.canvas.teachingVisual!.scene);
    expect(scene.pages[0].components).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'primary', nodes: expect.arrayContaining([expect.objectContaining({ icon: 'layers' })]) }),
      expect.objectContaining({ role: 'support', anchorNodeId: 'withdraw' }),
      expect.objectContaining({ role: 'takeaway' }),
    ]));
    expect(outline.keyPoints).toEqual(['逐步撤除', '评价主体']);
    expect(options).toMatchObject({ allowSplit: false, allowedCandidateIds: ['visual-2'], sourceCatalog: original.canvas.teachingVisual!.sourceCatalog });
    expect(result.canvas.teachingVisual!.scene).toEqual(original.canvas.teachingVisual!.scene);
    expect(result.canvas.elements.find((element) => element.id === 'support-symbol')).toEqual(original.canvas.elements.find((element) => element.id === 'support-symbol'));
    expect(result.canvas.teachingVisual!.components.every((component) => !component.locked && !component.modified)).toBe(true);
  });

  it.each(['locked', 'modified'] as const)('does not recompose a %s primary carrying icons or anchors', async (flag) => {
    const original = fixture();
    original.canvas.teachingVisual!.components[0]![flag] = true;
    await expect(recomposeTeachingVisualSlide(original, { componentId: 'support' })).rejects.toThrow('此构件已保留');
    expect(mocks.compile).not.toHaveBeenCalled();
  });

  it('retains optional scene metadata through runtime conversion, schema migration and JSON persistence', () => {
    const original = fixture();
    const runtime = toRuntimeSlideContent(structuredClone(original.canvas), { ...original.canvas }) as SlideContent;
    const restored = migrateSlideContent(JSON.parse(JSON.stringify(runtime)) as SlideContent);
    expect(restored.canvas.teachingVisual).toEqual(original.canvas.teachingVisual);
    expect(restored.canvas.elements).toEqual(original.canvas.elements);
    expect(migrateSlideContent(restored)).toBe(restored);
    expect(original.schemaVersion).toBeUndefined();
  });

  it('does not add scene hints or rewrite a historical page on load', () => {
    const legacy = teachingVisualEditFixture();
    delete legacy.canvas.teachingVisual;
    const saved = structuredClone(legacy);
    const loaded = migrateSlideContent(legacy);
    expect(loaded.canvas).toEqual(saved.canvas);
    expect(loaded.canvas.teachingVisual).toBeUndefined();
    expect(legacy).toEqual(saved);
    expect(mocks.compile).not.toHaveBeenCalled();
  });
});
