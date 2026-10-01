import { describe, expect, it } from 'vitest';
import { compilePageOwnedTeachingNodes } from './teaching-page-authoring';

function firstDraft() {
  return { authoringContract: 'blueprint-v4', sections: [{
    units: [{ id: 'concept-unit', knowledgePointIds: ['concept'] }, { id: 'application-unit', knowledgePointIds: ['application'] }],
    pages: [
      { id: 'first', explanationNodes: [{ id: 'meaning', unitId: 'concept-unit', kind: 'concept',
        knowledgePointIds: ['concept'], prerequisiteNodeIds: [], contentParts: [{ id: 'core', text: '概念的完整含义。' }] }],
        keyPointRefs: [{ nodeId: 'meaning', partIds: ['core'] }] },
      { id: 'second', explanationNodes: [{ id: 'boundary', unitId: 'application-unit', kind: 'condition',
        knowledgePointIds: ['application'], prerequisiteNodeIds: ['meaning'], contentParts: [{ id: 'core', text: '应用的必要条件。' }] }],
        keyPointRefs: [{ nodeId: 'boundary', partIds: ['core'] }, { nodeId: 'meaning', partIds: ['core'] }] },
    ],
  }] };
}

describe('first authoring with actual page ownership', () => {
  it('derives one unit body and page duties from the actual ordered teaching without mutating source authoring', () => {
    const source = firstDraft();
    const before = structuredClone(source);
    const result = compilePageOwnedTeachingNodes(source);
    expect(result.issues).toEqual([]);
    expect(source).toEqual(before);
    const normalized = result.value as { sections: Array<{ units: Array<{ explanationNodes: unknown[] }>; pages: Array<Record<string, unknown>> }> };
    expect(normalized.sections[0]!.units.map((unit) => unit.explanationNodes)).toEqual([
      [{ id: 'meaning', kind: 'concept', knowledgePointIds: ['concept'], prerequisiteNodeIds: [],
        contentParts: [{ id: 'core', text: '概念的完整含义。' }] }],
      [{ id: 'boundary', kind: 'condition', knowledgePointIds: ['application'], prerequisiteNodeIds: ['meaning'],
        contentParts: [{ id: 'core', text: '应用的必要条件。' }] }],
    ]);
    expect(normalized.sections[0]!.pages.map((page) => ({ units: page.unitIds, first: page.introducesNodeIds, refs: page.referencesNodeIds })))
      .toEqual([{ units: ['concept-unit'], first: ['meaning'], refs: [] },
        { units: ['application-unit'], first: ['boundary'], refs: ['meaning'] }]);
  });

  it('allows a premise actually taught earlier in the same page and rejects borrowing its later body', () => {
    const source = firstDraft();
    source.sections[0]!.pages[0]!.explanationNodes.push({ ...source.sections[0]!.pages[1]!.explanationNodes[0]!,
      id: 'local-boundary', prerequisiteNodeIds: ['meaning'] });
    expect(compilePageOwnedTeachingNodes(source).issues).toEqual([]);
    source.sections[0]!.pages[0]!.explanationNodes.reverse();
    expect(compilePageOwnedTeachingNodes(source).issues.some((issue) => issue.includes('本页更早正文'))).toBe(true);
  });

  it.each(['prerequisite', 'display', 'deepens'] as const)('rejects the future page as an existing %s', (kind) => {
    const source = firstDraft();
    const page = source.sections[0]!.pages[0]!;
    if (kind === 'prerequisite') page.explanationNodes[0]!.prerequisiteNodeIds = ['boundary'];
    if (kind === 'display') page.keyPointRefs.push({ nodeId: 'boundary', partIds: ['core'] });
    if (kind === 'deepens') Object.assign(page, { deepensNodeIds: ['boundary'] });
    expect(compilePageOwnedTeachingNodes(source).issues.some((issue) => issue.includes('尚未'))).toBe(true);
  });

  it('retains explicit deepening duties without copying an earlier explanation', () => {
    const source = firstDraft();
    Object.assign(source.sections[0]!.pages[1]!, { deepensNodeIds: ['meaning'] });
    const result = compilePageOwnedTeachingNodes(source);
    expect(result.issues).toEqual([]);
    const value = result.value as { sections: Array<{ pages: Array<Record<string, unknown>> }> };
    expect(value.sections[0]!.pages[1]!.deepensNodeIds).toEqual(['meaning']);
    expect(value.sections[0]!.pages[1]!.unitIds).toEqual(['concept-unit', 'application-unit']);
    expect(value.sections[0]!.pages[1]!.referencesNodeIds).toEqual([]);
  });

  it('derives v5 slide references from independently authored items and preserves their wording', () => {
    const source = { ...firstDraft(), authoringContract: 'blueprint-v5' };
    const pages = source.sections[0]!.pages;
    const secondPresentation = [{ text: '先理解含义，再判断条件', nodeIds: ['meaning', 'boundary'], role: 'comparison' }];
    Object.assign(pages[0]!, { presentationItems: [{ text: '概念含义', nodeIds: ['meaning'], role: 'heading' }] });
    Object.assign(pages[1]!, { presentationItems: secondPresentation });
    const before = structuredClone(source);
    const result = compilePageOwnedTeachingNodes(source);
    expect(result.issues).toEqual([]);
    expect(source).toEqual(before);
    const value = result.value as { sections: Array<{ pages: Array<Record<string, unknown>> }> };
    expect(value.sections[0]!.pages[1]!.referencesNodeIds).toEqual(['meaning']);
    expect(value.sections[0]!.pages[1]!.presentationItems).toEqual(secondPresentation);
  });

  it('rejects a future v5 display reference even though its wording is independently authored', () => {
    const source = { ...firstDraft(), authoringContract: 'blueprint-v5' };
    Object.assign(source.sections[0]!.pages[0]!, { presentationItems: [{
      text: '后页条件尚未建立', nodeIds: ['boundary'], role: 'key-point',
    }] });
    expect(compilePageOwnedTeachingNodes(source).issues.join(';')).toContain('尚未');
  });

  it.each(['unknown-owner', 'duplicate-id', 'duplicated-unit-body', 'conflicting-ownership', 'invalid-prerequisite'] as const)
    ('keeps invalid %s visible to the existing gate', (kind) => {
      const source = firstDraft();
      if (kind === 'unknown-owner') source.sections[0]!.pages[0]!.explanationNodes[0]!.unitId = 'missing';
      if (kind === 'duplicate-id') source.sections[0]!.pages[1]!.explanationNodes[0]!.id = 'meaning';
      if (kind === 'duplicated-unit-body') Object.assign(source.sections[0]!.units[0]!, { explanationNodes: source.sections[0]!.pages[0]!.explanationNodes });
      if (kind === 'conflicting-ownership') Object.assign(source.sections[0]!.pages[0]!, { introducesNodeIds: ['boundary'] });
      if (kind === 'invalid-prerequisite') Object.assign(source.sections[0]!.pages[1]!.explanationNodes[0]!, { prerequisiteNodeIds: ['meaning', null] });
      expect(compilePageOwnedTeachingNodes(source).issues.length).toBeGreaterThan(0);
    });

  it.each(['blueprint-v1', 'blueprint-v2', 'blueprint-v3', undefined])
    ('leaves stored or older authoring %s unchanged', (marker) => {
      const source = { ...firstDraft(), authoringContract: marker };
      expect(compilePageOwnedTeachingNodes(source)).toEqual({ value: source, issues: [] });
      expect(compilePageOwnedTeachingNodes(source).value).toBe(source);
    });
});
