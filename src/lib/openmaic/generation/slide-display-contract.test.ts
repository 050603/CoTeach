import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import fixture from './__fixtures__/native-text-default-placement.json';
import { generateOpenMaicBaselineContent } from './openmaic-baseline';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';
import { auditSlideDensity, buildLayoutRepairDirective, slideRequiredVisibleStatements } from './slide-layout-audit';

const outline = fixture.outline as unknown as SceneOutline;
let compiled: GeneratedSlideContent;
beforeAll(async () => {
  const result = await generateOpenMaicBaselineContent(outline, async () => fixture.response, {
    componentAuthoring: true, slideAuthoring: 'native', textMeasure: measureAuthoredSlideText,
  });
  if (!result || !('elements' in result)) throw new Error('Expected fixture to compile');
  compiled = result;
});
afterAll(() => closeSpatialMeasurementBrowser());
function body(content: GeneratedSlideContent, point: string) {
  const element = content.elements.find((element) => element.type === 'text' && element.content.includes(point));
  if (!element || element.type !== 'text') throw new Error(`Missing point ${point}`);
  return element;
}

describe('shared adopted slide display acceptance', () => {
  it('shares the four actual presentation duties and first-pass palette without importing narration prose onto the canvas', () => {
    const before = JSON.stringify(outline);
    expect(slideRequiredVisibleStatements(outline)).toEqual(outline.teachingBrief!.teachingPlan!.presentationContent);
    const density = auditSlideDensity(outline, compiled);
    expect(density.visibleTextCharacters).toBe(93);
    expect(density.underrepresentedKeyPoints).toEqual([]);
    expect(density.semanticStructures).toContain('text-relation-caption');
    expect(density.semanticStructureRequired).toBe(true);
    expect(density.semanticStructureSatisfied).toBe(true);
    expect(density.issues).toEqual([]);
    expect(body(compiled, outline.title).defaultColor).toBe('#1E3A8A');
    expect(body(compiled, '系统阐述').defaultColor).toBe('#334155');
    expect(buildLayoutRepairDirective({ status: 'checked', method: 'openmaic-renderer-chromium-v1', issues: [] }, density))
      .not.toContain('至少呈现 150');
    expect(JSON.stringify(outline)).toBe(before);
    expect(outline.teachingBrief!.teachingPlan!.visibleContent!.join('')).toContain('基于教育学、生物学、心理学');
  });

  it.each(['missing-caption', 'partial-chain', 'wrong-order', 'reverse-arrows', 'missing-definition', 'missing-condition',
    'metadata-only', 'off-canvas', 'invisible', 'hidden-html', 'tiny-font'])
    ('refuses the semantic-evidence exception for %s', (mutation) => {
      const content = structuredClone(compiled);
      const caption = body(content, '三者关系');
      if (mutation === 'missing-caption' || mutation === 'metadata-only') {
        content.elements = content.elements.filter((element) => element !== caption);
        if (mutation === 'metadata-only') Object.assign(content, { relationCaption: '三者关系：理论 → 模式 → 方法，从抽象到具体。' });
      }
      if (mutation === 'partial-chain') caption.content = caption.content.replace('模式 → ', '');
      if (mutation === 'wrong-order') caption.content = caption.content.replace('理论 → 模式 → 方法', '方法 → 模式 → 理论');
      if (mutation === 'reverse-arrows') caption.content = caption.content.replaceAll('→', '←');
      if (mutation === 'missing-definition') content.elements = content.elements.filter((element) => element !== body(content, '系统阐述'));
      if (mutation === 'missing-condition') body(content, '相对固定').content = body(content, '相对固定').content.replace('相对固定的', '');
      if (mutation === 'off-canvas') caption.left = 1001;
      if (mutation === 'invisible') caption.opacity = 0;
      if (mutation === 'hidden-html') caption.content = `<div style="display:none">${caption.content}</div>`;
      if (mutation === 'tiny-font') caption.content = caption.content.replaceAll('font-size:24px', 'font-size:10px');
      const density = auditSlideDensity(outline, content);
      expect(density.semanticStructures).not.toContain('text-relation-caption');
      expect(density.issues).toContainEqual(expect.stringContaining('低于 150'));
      expect(density.semanticStructureSatisfied).toBe(false);
      if (mutation !== 'tiny-font') expect(density.underrepresentedKeyPoints.length).toBeGreaterThan(0);
    });

  it('keeps the legacy coverage contract and ordinary 150-character baseline', () => {
    const legacy = structuredClone(outline);
    delete legacy.teachingBrief!.teachingPlan!.presentationContent;
    expect(slideRequiredVisibleStatements(legacy)).toHaveLength(7);
    const density = auditSlideDensity(legacy, compiled);
    expect(density.underrepresentedKeyPoints.length).toBeGreaterThan(0);
    expect(density.issues).toContainEqual(expect.stringContaining('低于 150'));
    expect(buildLayoutRepairDirective({ status: 'checked', method: 'openmaic-renderer-chromium-v1', issues: [] }, density))
      .toContain('至少呈现 150');
  });

  it.each(['comparison', 'process', 'branch', 'diagram', 'required-source-figure'])
    ('does not replace a real %s responsibility with a text caption', (kind) => {
      const page = structuredClone(outline);
      const relation = page.teachingBrief!.teachingPlan!.visualRelationship!;
      if (kind === 'comparison') { relation.kind = 'comparison'; relation.preferredForm = 'table'; }
      if (kind === 'process') relation.kind = 'process';
      if (kind === 'branch') relation.description += '必须呈现分支及反馈。';
      if (kind === 'diagram') page.visualIntent!.representation = 'native-diagram';
      if (kind === 'required-source-figure') page.visualIntent!.resourceRefs = [{ resourceId: 'actual-source-figure', kind: 'source-image', required: true, reason: '学生必须看见来源图' }];
      const density = auditSlideDensity(page, compiled);
      expect(density.semanticStructures).not.toContain('text-relation-caption');
      expect(density.issues).toContainEqual(expect.stringContaining('低于 150'));
      expect(density.semanticStructureSatisfied).toBe(false);
    });

  it('does not infer a relationship from reading order or narration alone', () => {
    const page = structuredClone(outline);
    page.teachingBrief!.teachingPlan!.visualRelationship!.description = '列出定义。';
    page.visualIntent!.observationGoal = '列出定义。';
    page.teachingBrief!.teachingPlan!.narrationFocus = ['理论 → 模式 → 方法'];
    const density = auditSlideDensity(page, compiled);
    expect(density.semanticStructures).not.toContain('text-relation-caption');
    expect(density.issues).toContainEqual(expect.stringContaining('低于 150'));
  });

  it('does not treat an off-canvas source image as visible semantic evidence', () => {
    const page = structuredClone(outline);
    delete page.teachingBrief!.teachingPlan!.presentationContent;
    const content = structuredClone(compiled);
    content.elements.push({ type: 'image', id: 'hidden-source-figure', left: 1001, top: 180, width: 200, height: 180,
      rotate: 0, fixedRatio: true, src: '/actual-source.png' });
    expect(auditSlideDensity(page, content).issues).toContainEqual(expect.stringContaining('低于 150'));
  });

  it('retains authored valid colors and rejects explicit palette drift instead of recoloring it', async () => {
    const raw = JSON.parse(fixture.response);
    raw.components[0].color = '#1E40AF';
    raw.components[1].color = '#475569';
    raw.components[2].color = '#00FF00';
    const result = await generateOpenMaicBaselineContent(outline, async () => JSON.stringify(raw), {
      componentAuthoring: true, slideAuthoring: 'native', textMeasure: measureAuthoredSlideText,
    });
    if (!result || !('elements' in result)) throw new Error('Expected fixture to compile');
    expect(body(result, outline.title).defaultColor).toBe('#1E40AF');
    expect(body(result, '系统阐述').defaultColor).toBe('#475569');
    expect(body(result, '具体化').defaultColor).toBe('#00FF00');
    expect(auditSlideDensity(outline, result).paletteDeviationCount).toBeGreaterThan(0);
  });
});
