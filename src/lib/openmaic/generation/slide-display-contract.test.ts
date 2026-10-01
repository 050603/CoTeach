import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import fixture from './__fixtures__/native-text-default-placement.json';
import { generateOpenMaicBaselineContent } from './openmaic-baseline';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';
import { auditSlideDensity, buildLayoutRepairDirective, slideRequiredVisibleStatements } from './slide-layout-audit';
import { adoptedPageAuthoringContent } from './adopted-page-content';

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

function verifiedProjectionFixture() {
  const page = structuredClone(outline);
  page.title = '支架撤除的判断';
  page.description = '能力提升与保留支架的判断标准';
  page.keyPoints = [
    '当学生能力逐步提升时，教师应逐步撤除支架，但不应在最后一次性撤销。',
    '支架是否保留应根据学生能否独立完成任务来判断，不能只根据教学进度。',
  ];
  delete page.visualIntent;
  const plan = page.teachingBrief!.teachingPlan!;
  plan.presentationContent = [...page.keyPoints];
  delete plan.presentationItems;
  delete plan.presentationTypography;
  delete plan.visualRelationship;
  const sources = adoptedPageAuthoringContent(page);
  const items = [
    { id: 'ability', sourceContentIds: [sources[0]!.id], label: '逐步撤除', text: '能力提升时逐步减支架，不能最后一次撤销。' },
    { id: 'criterion', sourceContentIds: [sources[1]!.id], label: '独立完成任务', text: '按独立完成能力判断，不能仅看进度。' },
  ];
  const text = (id: string, value: string, top: number) => ({
    ...body(compiled, outline.title), id, left: 50, top, width: 900, height: 80,
    content: `<p style="font-size:24px">${value}</p>`,
  });
  const content: GeneratedSlideContent = {
    elements: [text('title', page.title, 40), text('subtitle', page.description, 130),
      ...items.map((item, index) => text(item.id, `${item.label}：${item.text}`, 240 + index * 110))],
    presentationProjection: { schemaVersion: 1, layoutVersion: 'teaching-infographic-v1', verified: true,
      items, elementIdsBySource: Object.fromEntries(items.map((item) => [item.sourceContentIds[0], [item.id]])) },
  };
  return { page, content };
}

describe('shared adopted slide display acceptance', () => {
  it('accepts host-verified short prose only through its readable mapped native elements', () => {
    const { page, content } = verifiedProjectionFixture();
    const before = structuredClone(page);
    expect(content.elements.some((element) => element.type === 'text' && element.content.includes(page.keyPoints[0]!))).toBe(false);
    const density = auditSlideDensity(page, content);
    expect(density.underrepresentedKeyPoints).toEqual([]);
    expect(density.visibleTextCharacters).toBeLessThan(150);
    expect(density.issues).not.toContainEqual(expect.stringContaining('低于 150'));
    expect(page).toEqual(before);
    expect(slideRequiredVisibleStatements(page)).toEqual(page.keyPoints);
  });

  it.each(['unverified', 'metadata-only', 'off-canvas', 'invisible', 'hidden-html', 'tiny-font', 'no-font',
    'orphan-mapping', 'wrong-mapping', 'unknown-source', 'missing-label', 'partial-prose'])
    ('never credits %s projection metadata as visible source coverage', (mutation) => {
      const { page, content } = verifiedProjectionFixture();
      const projection = content.presentationProjection!;
      const element = body(content, '能力提升时');
      if (mutation === 'unverified') projection.verified = false;
      if (mutation === 'metadata-only') content.elements = content.elements.filter((item) => item !== element);
      if (mutation === 'off-canvas') element.left = 1001;
      if (mutation === 'invisible') element.opacity = 0;
      if (mutation === 'hidden-html') element.content = `<span style="visibility:hidden">${element.content}</span>`;
      if (mutation === 'tiny-font') element.content = element.content.replace('font-size:24px', 'font-size:10px');
      if (mutation === 'no-font') element.content = element.content.replace('font-size:24px', '');
      if (mutation === 'orphan-mapping') projection.elementIdsBySource['adopted-content-1'] = ['does-not-exist'];
      if (mutation === 'wrong-mapping') projection.elementIdsBySource['adopted-content-1'] = ['criterion'];
      if (mutation === 'unknown-source') projection.items[0]!.sourceContentIds = ['external-page-content'];
      if (mutation === 'missing-label') element.content = element.content.replace('逐步撤除：', '');
      if (mutation === 'partial-prose') element.content = element.content.replace('不能最后一次撤销。', '');
      expect(auditSlideDensity(page, content).underrepresentedKeyPoints).toContainEqual({ keyPoint: page.keyPoints[0], coverage: 0 });
    });

  it.each(['no-font', 'tiny-font'])('does not revive literal-word coverage for a verified projection rendered with %s', (mutation) => {
    const { page, content } = verifiedProjectionFixture();
    const projected = content.presentationProjection!.items[0]!;
    projected.text = page.keyPoints[0]!;
    const element = body(content, '能力提升时');
    element.content = `<p${mutation === 'tiny-font' ? ' style="font-size:10px"' : ''}>${projected.label}：${projected.text}</p>`;
    expect(auditSlideDensity(page, content).underrepresentedKeyPoints).toContainEqual({ keyPoint: page.keyPoints[0], coverage: 0 });
  });

  it('requires every separately projected part of the same adopted point', () => {
    const { page, content } = verifiedProjectionFixture();
    const projection = content.presentationProjection!;
    projection.items[0]!.text = '能力提升时逐步减支架';
    projection.items.push({ id: 'boundary', sourceContentIds: ['adopted-content-1'], text: '不能最后一次撤销。' });
    expect(auditSlideDensity(page, content).underrepresentedKeyPoints).toEqual([]);
    body(content, '能力提升时').content = body(content, '能力提升时').content.replace('不能最后一次撤销。', '');
    expect(auditSlideDensity(page, content).underrepresentedKeyPoints).toContainEqual({ keyPoint: page.keyPoints[0], coverage: 0 });
  });

  it.each(['complete', 'missing-row', 'missing-column', 'wrong-cell', 'hidden-cell', 'no-cell-font'])
    ('checks actual comparison headings and their corresponding cell: %s', (mutation) => {
      const { page, content } = verifiedProjectionFixture();
      const projection = content.presentationProjection!;
      projection.items[0]!.row = '支持方式';
      projection.items[0]!.column = '逐步调整';
      const cell = (text: string) => ({ id: text, text, rowspan: 1, colspan: 1, style: { fontsize: '24px' } });
      const data = [
        [cell('比较维度'), cell('逐步调整'), cell('一次撤除')],
        [cell('支持方式'), cell(`逐步撤除：${projection.items[0]!.text}`), cell('没有逐步判断')],
      ];
      if (mutation === 'missing-row') data[1]![0]!.text = '装饰标题';
      if (mutation === 'missing-column') data[0]![1]!.text = '装饰标题';
      if (mutation === 'wrong-cell') [data[1]![1], data[1]![2]] = [data[1]![2]!, data[1]![1]!];
      if (mutation === 'hidden-cell') data[1]![1]!.text = `<p style="display:none">${data[1]![1]!.text}</p>`;
      if (mutation === 'no-cell-font') data[1]![1]!.style.fontsize = '';
      content.elements = content.elements.filter((element) => element.id !== 'ability');
      content.elements.push({ type: 'table', id: 'real-comparison', left: 50, top: 210, width: 900, height: 110,
        rotate: 0, data, colWidths: [0.2, 0.4, 0.4], cellMinHeight: 45,
        outline: { color: '#CBD5E1', width: 1, style: 'solid' } });
      projection.elementIdsBySource['adopted-content-1'] = ['real-comparison'];
      expect(auditSlideDensity(page, content).underrepresentedKeyPoints.some((point) => point.keyPoint === page.keyPoints[0]))
        .toBe(mutation !== 'complete');
    });

  it('retains an explicit process structure duty even when all concise display points satisfy the host contract', () => {
    const { page, content } = verifiedProjectionFixture();
    page.teachingBrief!.teachingPlan!.visualRelationship = { kind: 'process', preferredForm: 'diagram',
      description: '原流程必须在页面呈现', rationale: '完整节点和真实先后关系', readingOrder: [] };
    const density = auditSlideDensity(page, content);
    expect(density.underrepresentedKeyPoints).toEqual([]);
    expect(density.semanticStructureSatisfied).toBe(false);
    expect(density.issues).toContainEqual(expect.stringContaining('需要process语义结构'));
  });

  it('accepts verified shared annotation facts in ordinary visible items while retaining the real diagram duty', () => {
    const { page, content } = verifiedProjectionFixture();
    const originalAnnotation = '学生能力提升时逐步撤除支架，不是最后一次性撤销。';
    page.teachingBrief!.teachingPlan!.presentationContent!.push(originalAnnotation);
    page.visualIntent = { representation: 'native-diagram', observationGoal: '能力与支持关系', diagram: {
      topology: 'sequence', nodes: [{ id: 'support', label: '提供支架' }, { id: 'independent', label: '独立完成' }],
      edges: [{ from: 'support', to: 'independent' }], annotation: originalAnnotation,
    } };
    const projection = content.presentationProjection!;
    projection.items[0]!.sourceContentIds.push('diagram-annotation');
    projection.elementIdsBySource['diagram-annotation'] = ['ability'];
    const density = auditSlideDensity(page, content);
    expect(density.underrepresentedKeyPoints).toEqual([]);
    expect(density.semanticStructureSatisfied).toBe(false);
    expect(density.issues).toContainEqual(expect.stringContaining('需要relationship语义结构'));
    projection.elementIdsBySource['diagram-annotation'] = ['nonexistent-caption'];
    expect(auditSlideDensity(page, content).underrepresentedKeyPoints).toContainEqual({ keyPoint: originalAnnotation, coverage: 0 });
  });

  it('recognizes actual verified display headings without requesting a redundant independent subtitle', () => {
    const { page, content } = verifiedProjectionFixture();
    content.elements = content.elements.filter((element) => element.id !== 'subtitle');
    expect(auditSlideDensity(page, content).hasSubtitle).toBe(true);
    expect(auditSlideDensity(page, content).issues).not.toContainEqual(expect.stringContaining('缺少独立副标题'));
    delete content.presentationProjection!.items[0]!.label;
    delete content.presentationProjection!.items[1]!.label;
    expect(auditSlideDensity(page, content).hasSubtitle).toBe(false);
  });

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
