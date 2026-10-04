import { describe, expect, it, vi } from 'vitest';
import type { TextMeasure } from '@openmaic/generation';
import type { SceneOutline } from '../types/generation';
import { fingerprintSceneOutline } from '@/lib/course-generation/page-checkpoints';
import { prepareTeachingPageCapacity } from './teaching-page-preflight';

function nativePage(): SceneOutline {
  return { id: 'native-page', type: 'slide', title: '证据支持判断', description: '说明记录与说法的关系', order: 0,
    audience: 'student', generationPurpose: 'knowledge-teaching', lectureSectionId: 'section',
    keyPoints: ['记录必须与具体说法相关。'], targetDurationSec: 60,
    teachingBrief: { schemaVersion: 1, explanation: '保存的解释不参与文字计量。', examples: [], conditions: [],
      evidence: [], assessmentFocus: '', manuscript: { sectionId: 'section', segmentIds: ['speech'] },
      teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [],
        takeaway: '', visibleContent: [], narrationFocus: [], presentationContent: ['记录必须与具体说法相关。'] } },
  };
}

function measurement() {
  return vi.fn<TextMeasure>(async ({ text, width, fontSize, padding }) => {
    const lines = Math.max(1, Math.ceil([...text].length * fontSize / Math.max(1, width - padding * 2)));
    return { naturalWidth: [...text].length * fontSize, height: padding * 2 + lines * fontSize * 1.5,
      lines: Array.from({ length: lines }, () => text) };
  });
}

describe('native runtime capacity typography', () => {
  it.each(['teaching-plan', 'teaching-brief'] as const)('measures an eligible restored page without a %s and keeps its free composition intact', async (missing) => {
    const page = nativePage(), measure = measurement();
    if (missing === 'teaching-brief') delete page.teachingBrief;
    else {
      delete page.teachingBrief!.manuscript;
      delete page.teachingBrief!.teachingPlan;
    }
    const saved = structuredClone(page);
    const result = await prepareTeachingPageCapacity([page], { nativeLectureAuthoring: true, measure });
    expect(result.changed).toBe(false);
    expect(result.outlines[0]).toBe(page);
    expect([...new Set(result.assessments[0]!.layouts.map((layout) => layout.bodyFontSize))].sort()).toEqual([16, 18]);
    expect(page).toEqual(saved);
    expect(page.visualPlan).toBeUndefined();
    expect(page.teachingBrief?.teachingPlan).toBeUndefined();
  });

  it('measures an unfinished eligible page at 18/16 without changing its saved source or request identity', async () => {
    const page = nativePage(), saved = structuredClone(page), before = fingerprintSceneOutline(page);
    const measure = measurement();
    const result = await prepareTeachingPageCapacity([page], { nativeLectureAuthoring: true, measure });
    expect(result.changed).toBe(false);
    expect(result.outlines[0]).toBe(page);
    expect([...new Set(result.assessments[0]!.layouts.map((layout) => layout.bodyFontSize))].sort()).toEqual([16, 18]);
    const bodyFonts = measure.mock.calls.filter(([input]) => input.text === page.keyPoints[0]).map(([input]) => input.fontSize);
    expect(bodyFonts).toContain(18);
    expect(bodyFonts).toContain(16);
    expect(bodyFonts).not.toContain(24);
    expect(bodyFonts).not.toContain(22);
    expect(page.teachingBrief?.teachingPlan?.presentationTypography).toBeUndefined();
    expect(page).toEqual(saved);
    expect(fingerprintSceneOutline(result.outlines[0]!)).toBe(before);
  });

  it.each(['locked', 'legacy-mode', 'teacher'] as const)('preserves the prior measurement contract for %s pages', async (kind) => {
    const page = nativePage();
    if (kind === 'teacher') page.audience = 'teacher';
    const before = fingerprintSceneOutline(page), measure = measurement();
    const result = await prepareTeachingPageCapacity([page], { measure, nativeLectureAuthoring: kind !== 'legacy-mode',
      ...(kind === 'locked' ? { lockedOutlineIds: [page.id] } : {}) });
    expect(result.changed).toBe(false);
    expect(result.assessments[0]!.selectedLayout?.bodyFontSize).toBe(24);
    const bodyFonts = measure.mock.calls.filter(([input]) => input.text === page.keyPoints[0]).map(([input]) => input.fontSize);
    expect(bodyFonts).toContain(24);
    expect(bodyFonts).not.toContain(18);
    expect(bodyFonts).not.toContain(16);
    expect(fingerprintSceneOutline(result.outlines[0]!)).toBe(before);
  });

  it('keeps native typography through bounded replanning without persisting its temporary measurement profile', async () => {
    const page = nativePage(), display = ['甲'.repeat(550), '乙'.repeat(550)];
    page.keyPoints = display;
    page.teachingBrief!.manuscript!.segmentIds = ['first', 'second'];
    page.teachingBrief!.teachingPlan = { ...page.teachingBrief!.teachingPlan!, presentationContent: display,
      presentationItems: display.map((text, index) => ({ text, role: 'key-point', nodeIds: [index ? 'second' : 'first'] })) };
    const saved = structuredClone(page), before = fingerprintSceneOutline(page), measure = measurement();
    const result = await prepareTeachingPageCapacity([page], { nativeLectureAuthoring: true, measure });
    expect(result.changed).toBe(true);
    expect(result.outlines).toHaveLength(2);
    expect(result.assessments.every((assessment) => assessment.selectedLayout?.fits)).toBe(true);
    expect(result.assessments.every((assessment) => [18, 16].includes(assessment.selectedLayout!.bodyFontSize))).toBe(true);
    expect(result.outlines.every((outline) => outline.teachingBrief?.teachingPlan?.presentationTypography === undefined)).toBe(true);
    expect(result.outlines.flatMap((outline) => outline.teachingBrief?.teachingPlan?.presentationContent ?? [])).toEqual(display);
    expect(result.outlines.reduce((sum, outline) => sum + outline.targetDurationSec!, 0)).toBe(60);
    expect(page).toEqual(saved);
    expect(fingerprintSceneOutline(page)).toBe(before);
  });

  it('reports measured joint-plan overflow while preserving the complete authored page', async () => {
    const page = nativePage(), display = ['甲'.repeat(550), '乙'.repeat(550)];
    page.keyPoints = display;
    page.teachingBrief!.pptPlanningVersion = 'joint-native-pages-4615-v1';
    page.teachingBrief!.manuscript!.segmentIds = ['first', 'second'];
    page.teachingBrief!.teachingPlan = { ...page.teachingBrief!.teachingPlan!, presentationContent: display,
      presentationItems: display.map((text, index) => ({ text, role: 'key-point', nodeIds: [index ? 'second' : 'first'] })) };
    const saved = structuredClone(page), before = fingerprintSceneOutline(page), measure = measurement();
    const result = await prepareTeachingPageCapacity([page], { nativeLectureAuthoring: true, measure });
    expect(result.changed).toBe(false);
    expect(result.outlines).toEqual([saved]);
    expect(result.outlines[0]).toBe(page);
    expect(result.assessments[0]!.decision).toBe('page-overflow');
    expect(result.diagnostics).toEqual([expect.stringContaining(page.id)]);
    expect(measure).toHaveBeenCalled();
    expect(fingerprintSceneOutline(page)).toBe(before);
  });

  it.each([true, false])('uses the same diagram node font as the chosen compiler when native=%s', async (native) => {
    const page = nativePage(), measure = measurement();
    page.visualIntent = { representation: 'native-diagram', observationGoal: '观察事实到判断的关系', diagram: {
      topology: 'sequence', nodes: [{ id: 'observe', label: '观察对象' }, { id: 'judge', label: '依据事实判断' }],
      edges: [{ from: 'observe', to: 'judge' }],
    } };
    const saved = structuredClone(page);
    await prepareTeachingPageCapacity([page], { nativeLectureAuthoring: native, measure });
    const fonts = [...new Set(measure.mock.calls.filter(([input]) => input.text === '观察对象').map(([input]) => input.fontSize))];
    expect(fonts).toEqual([native ? 18 : 20]);
    expect(page).toEqual(saved);
  });

  it('keeps completed native pages locked without measuring or changing any saved contract', async () => {
    const page = nativePage(), saved = structuredClone(page), measure = measurement();
    const result = await prepareTeachingPageCapacity([page], { nativeLectureAuthoring: true,
      completedOutlineIds: [page.id], measure });
    expect(measure).not.toHaveBeenCalled();
    expect(result).toEqual({ outlines: [page], assessments: [], changed: false, diagnostics: [] });
    expect(page).toEqual(saved);
  });
});
