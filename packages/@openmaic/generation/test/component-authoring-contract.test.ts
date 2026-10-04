import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '../src/outline-types.js';
import { componentAuthoringContract, type NativeDiagramAllocationHint } from '../src/component-authoring-contract.js';

function page(annotation?: string): SceneOutline {
  return { id: 'seven-step-page', type: 'slide', title: '完整教学设计步骤', order: 0, description: '', keyPoints: [],
    presentationTypography: { bodyFontSize: 18, minimumBodyFontSize: 16, titleFontSize: 32, minimumTitleFontSize: 28 },
    visualIntent: { representation: 'native-diagram', observationGoal: '观察完整七步及其顺序', diagram: { topology: 'sequence',
      nodes: Array.from({ length: 7 }, (_, index) => ({ id: `step${index + 1}`, label: `完整步骤${index + 1}` })),
      edges: Array.from({ length: 6 }, (_, index) => ({ from: `step${index + 1}`, to: `step${index + 2}` })),
      ...(annotation ? { annotation } : {}) } } } as SceneOutline;
}

function advertisedHints(user: string): NativeDiagramAllocationHint[] {
  const line = user.split('\n').find((line) => line.startsWith('Measured complete diagram space references, scoped by rendering profile: '));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice(line!.indexOf(': ') + 2));
}

describe('native diagram measurement authoring contract', () => {
  it('keeps every complete size pair bound to its exact font, direction, presentation and caption scope', () => {
    const outline = page('这是完整的真实图注。');
    const hints: NativeDiagramAllocationHint[] = [
      { width: 360, height: 327, orientation: 'vertical', presentation: 'steps', nodeFontSize: 18, annotationIncluded: false },
      { width: 700, height: 240, orientation: 'horizontal', presentation: 'cards', nodeFontSize: 18, annotationIncluded: true },
    ];
    const before = structuredClone({ outline, hints });
    const contract = componentAuthoringContract(outline, [], [{ id: 'original-point', text: '原始展示职责' }], [], true, true, hints);
    expect(advertisedHints(contract.user)).toEqual(hints);
    expect(contract.user).toContain(JSON.stringify(outline.visualIntent!.diagram));
    expect(contract.user).toContain('width AND height of the SAME matching tuple');
    expect(contract.user).toContain('OUTSIDE the graph');
    expect(contract.user).toContain('not response syntax');
    expect(contract.user).not.toContain('Immutable adopted presentation-point catalog');
    expect({ outline, hints }).toEqual(before);
  });

  it('does not claim a missing diagram profile fits or proves the whole page cannot fit', () => {
    const contract = componentAuthoringContract(page(), [], undefined, [], true, true, []);
    expect(advertisedHints(contract.user)).toEqual([]);
    expect(contract.user).toContain('never zero-height content, a fitting claim, or proof that every other composition fails');
    expect(contract.user).toContain('Natural diagram growth beyond the authored rectangle or canvas is not fitting space');
  });

  it('leaves the legacy native and flow-free immutable display contract intact', () => {
    const contract = componentAuthoringContract(page(), [{ width: 900, height: 360 }],
      [{ id: 'adopted-point', text: '完整已确认文字' }]);
    expect(contract.user).toContain('Immutable adopted presentation-point catalog');
    expect(contract.user).toContain('"width":900,"height":360');
    expect(contract.user).not.toContain('Measured complete diagram space references');
    expect(contract.system).toContain('do not perform another summarization of the catalog');
  });
});
