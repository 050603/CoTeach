import { describe, expect, it, vi } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import type { GeneratedSlideContent, SceneOutline } from '@openmaic/lib/types/generation';
import {
  auditAndRepairSlideOnce,
  auditSlideDensity,
  auditSlideLayout,
  buildLayoutRepairDirective,
  normalizeAuditedReferenceStyle,
  repairMeasuredSlideGeometry,
  slideKnowledgeCoverage,
  structuralSlideIssues,
  type SlideLayoutAudit,
} from './slide-layout-audit';

const outline: SceneOutline = {
  id: 'scene-1', type: 'slide', title: '抽样', description: '解释随机抽样',
  keyPoints: ['随机抽样减少选择偏差', '样本必须来自目标总体'], order: 0,
};
const text = (
  id: string,
  content: string,
  top = 100,
): Extract<PPTElement, { type: 'text' }> => ({
  id, type: 'text', left: 50, top, width: 800, height: 80, rotate: 0,
  content: `<p>${content}</p>`, defaultFontName: 'Noto Sans SC', defaultColor: '#333333',
});
const original: GeneratedSlideContent = { elements: [
  text('a', '随机抽样减少选择偏差'), text('b', '样本必须来自目标总体', 200),
] };
const badAudit: SlideLayoutAudit = {
  status: 'checked', method: 'openmaic-renderer-chromium-v1', issues: ['文字超出页面'],
};
const goodAudit: SlideLayoutAudit = {
  status: 'checked', method: 'openmaic-renderer-chromium-v1', issues: [],
};

describe('slide layout audit repair policy', () => {
  it('skips a model rewrite when deterministic repair clears the measured defect', async () => {
    const audit = vi.fn().mockResolvedValueOnce(badAudit).mockResolvedValueOnce(goodAudit);
    const regenerate = vi.fn();
    const result = await auditAndRepairSlideOnce({ outline, content: original, audit, regenerate });
    expect(regenerate).not.toHaveBeenCalled();
    expect(result.adopted).toBe('repair');
    expect(result.content.elements[0]).toMatchObject({ id: 'a', defaultColor: '#1E3A8A' });
  });

  it('keeps the official first draft byte-for-byte in production baseline mode', async () => {
    const regenerate = vi.fn();
    const onRepair = vi.fn();
    const result = await auditAndRepairSlideOnce({
      outline: { ...outline, generationPurpose: 'knowledge-teaching' },
      content: original,
      audit: vi.fn().mockResolvedValue(badAudit),
      regenerate,
      onRepair,
      preserveOpenMaicFirstDraft: true,
    });

    expect(result.content).toBe(original);
    expect(result.adopted).toBe('first-draft');
    expect(result.repairAttempted).toBe(false);
    expect(regenerate).not.toHaveBeenCalled();
    expect(onRepair).not.toHaveBeenCalled();
    expect(result.finalAudit).toEqual(badAudit);
  });

  it('does not repair when the browser is unavailable', async () => {
    const audit = vi.fn().mockResolvedValue({ ...badAudit, status: 'unavailable', reason: 'chromium missing' });
    const regenerate = vi.fn();
    const result = await auditAndRepairSlideOnce({ outline, content: original, audit, regenerate });
    expect(regenerate).not.toHaveBeenCalled();
    expect(result.adopted).toBe('first-draft');
  });

  it('rejects a knowledge-losing candidate while retaining the safe style closure', async () => {
    const audit = vi.fn().mockResolvedValueOnce(badAudit).mockResolvedValue(goodAudit);
    const knowledgeLosingCandidate = { elements: [text('a3', '欢迎学习')] };
    const regenerate = vi.fn().mockResolvedValue(knowledgeLosingCandidate);
    const result = await auditAndRepairSlideOnce({ outline, content: original, audit, regenerate });
    expect(result.adopted).toBe('repair');
    expect(result.content).not.toBe(knowledgeLosingCandidate);
    expect(result.content.elements).toHaveLength(2);
    expect(result.finalKnowledgeCoverage).toBe(1);
  });

  it('builds a minimal repair directive and measures semantic coverage', () => {
    expect(buildLayoutRepairDirective(badAudit)).toContain('不得增加或删除知识内容');
    expect(slideKnowledgeCoverage(outline.keyPoints, original.elements)).toBe(1);
    expect(structuralSlideIssues([{
      id: 'bad-table', type: 'table', left: 0, top: 0, width: 100, height: 100, rotate: 0,
      data: [[{ content: 'wrong field' } as never]], colWidths: [1],
    } as unknown as PPTElement])).toContain('table bad-table has 1 malformed cell(s)');
  });

  it('counts a concise visible paraphrase as proposition coverage', () => {
    const longSourcePoint = 'AI可以根据学生答题情况和互动表现动态推荐下一步内容，为基础、中等与进阶学生提供不同难度的任务或支架。';
    expect(slideKnowledgeCoverage([longSourcePoint], [
      text('summary', '依据答题与互动表现推荐下一步内容，为不同水平学生提供差异化任务与支架。'),
    ])).toBe(1);
    expect(slideKnowledgeCoverage([longSourcePoint], [
      text('unrelated', '人工审核生成内容并防止事实错误。'),
    ])).toBe(0);
  });

  it('treats an explicit workflow marked Chart as a process diagram', () => {
    const processOutline: SceneOutline = {
      ...outline,
      generationPurpose: 'knowledge-teaching',
      keyPoints: ['[Chart] 流程图：AI生成草稿 → 人工修改 → 最终资源'],
    };
    const processTitle = text('title', '抽样', 50);
    const density = auditSlideDensity(processOutline, {
      elements: [
        { ...processTitle, defaultColor: '#1E3A8A' } as PPTElement,
        text('subtitle', '从草稿到可用资源', 115),
        text('node-a', 'AI生成草稿', 220),
        text('node-b', '人工修改', 330),
        text('node-c', '最终资源', 440),
        { id: 'arrow', type: 'line', left: 200, top: 260, width: 3, start: [0, 0], end: [300, 0], style: 'solid', color: '#1E3A8A', points: ['', 'arrow'] },
      ],
    });
    expect(density.semanticStructureRequired).toBe(true);
    expect(density.semanticStructures).toContain('connector');
    expect(density.semanticStructureSatisfied).toBe(true);
  });

  it('recognizes editable text layered over separate shapes as semantic groups', () => {
    const comparisonOutline: SceneOutline = {
      ...outline,
      generationPurpose: 'knowledge-teaching',
      title: '两种方法对比',
      description: '比较方法甲与方法乙。',
      keyPoints: ['方法甲：强调主动探究', '方法乙：强调真实情境'],
    };
    const panel = (id: string, left: number): PPTElement => ({
      id,
      type: 'shape',
      left,
      top: 210,
      width: 420,
      height: 220,
      rotate: 0,
      path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
      viewBox: [1, 1],
      fixedRatio: false,
      fill: '#EFF6FF',
    });
    const density = auditSlideDensity(comparisonOutline, {
      background: { type: 'solid', color: '#FFFFFF' },
      elements: [
        { ...text('title', '两种方法对比', 50), defaultColor: '#1E3A8A' },
        { ...text('subtitle', '从目标到课堂活动', 115), defaultColor: '#64748B' },
        panel('left-panel', 60),
        { ...text('left-copy', '方法甲强调主动探究，并通过操作形成理解。', 240), left: 80, width: 380 },
        panel('right-panel', 520),
        { ...text('right-copy', '方法乙强调真实情境，并通过案例促进迁移。', 240), left: 540, width: 380 },
      ],
    });

    expect(density.semanticStructures).toContain('grouped-shapes');
    expect(density.semanticStructureSatisfied).toBe(true);
    expect(density.paletteDeviationCount).toBe(0);
  });

  it('gives geometry-specific repair guidance for rendered text-block collisions', () => {
    const directive = buildLayoutRepairDirective({
      ...badAudit,
      issues: ['文字侵入相邻内容区域：文字 text_a 与 shape shape_b 的实际显示区域相交。'],
    });
    expect(directive).toContain('至少 20px 内边距');
    expect(directive).toContain('至少 12px 可见间距');
    expect(directive).toContain('不得用删掉知识点');
  });

  it('closes an audited title and legacy-blue deviation while preserving the reference light-blue surface', () => {
    const legacy = {
      background: { type: 'solid' as const, color: '#5B9BD5' },
      elements: [
        { ...text('legacy-title', '抽样'), defaultColor: '#4472C4' },
        {
          id: 'legacy-surface', type: 'shape' as const, left: 50, top: 200,
          width: 400, height: 180, rotate: 0, path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
          viewBox: [1, 1] as [number, number], fixedRatio: false, fill: '#E8F4FD',
        },
      ],
    };
    const normalized = normalizeAuditedReferenceStyle(outline, legacy);

    expect(normalized).not.toBeNull();
    expect(normalized?.background).toEqual({ type: 'solid', color: '#FFFFFF' });
    expect(normalized?.elements[0]).toMatchObject({
      id: 'legacy-title', left: 50, top: 100, width: 800, height: 80,
      defaultColor: '#1E3A8A', content: '<p>抽样</p>',
    });
    expect(normalized?.elements[1]).toMatchObject({ fill: '#E8F4FD' });
  });

  it('accepts the supplied OpenMAIC element palette including repeated orange accents', () => {
    const reference = {
      background: { type: 'solid' as const, color: '#F1F5F9' },
      elements: [
        { ...text('reference-title', '抽样'), defaultColor: '#1E3A8A' },
        {
          id: 'reference-surface', type: 'shape' as const, left: 50, top: 180,
          width: 380, height: 160, rotate: 0, path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
          viewBox: [1, 1] as [number, number], fixedRatio: false, fill: '#E8F4FD',
          line: { color: '#ED7D31', width: 2 },
        },
        {
          id: 'reference-accent', type: 'shape' as const, left: 480, top: 180,
          width: 380, height: 160, rotate: 0, path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
          viewBox: [1, 1] as [number, number], fixedRatio: false, fill: '#FFF3E0',
          line: { color: '#ED7D31', width: 2 },
        },
      ],
    };

    expect(auditSlideDensity(outline, reference).paletteDeviationCount).toBe(0);
    expect(normalizeAuditedReferenceStyle(outline, reference)).toBeNull();
  });

  it('detects and closes arbitrary purple, green, and yellow page palettes without moving elements', () => {
    const drifting = {
      background: { type: 'solid' as const, color: '#F3E5F5' },
      elements: [
        { ...text('drift-title', '抽样'), defaultColor: '#1E3A8A' },
        {
          id: 'green-card', type: 'shape' as const, left: 50, top: 180,
          width: 380, height: 160, rotate: 0, path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
          viewBox: [1, 1] as [number, number], fixedRatio: false, fill: '#E8F5E9',
        },
        {
          id: 'yellow-card', type: 'shape' as const, left: 480, top: 180,
          width: 380, height: 160, rotate: 0, path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
          viewBox: [1, 1] as [number, number], fixedRatio: false, fill: '#FFF8E1',
          line: { color: '#7E22CE', width: 2 },
        },
      ],
    };
    const density = auditSlideDensity(outline, drifting);
    expect(density.paletteDeviationCount).toBe(4);

    const normalized = normalizeAuditedReferenceStyle(outline, drifting, density);
    expect(normalized).not.toBeNull();
    expect(normalized?.background).toEqual({ type: 'solid', color: '#FFFFFF' });
    expect(auditSlideDensity(outline, normalized!).paletteDeviationCount).toBe(0);
    expect(normalized?.elements.map((element) => ({
      id: element.id, left: element.left, top: element.top,
      width: 'width' in element ? element.width : undefined,
      height: 'height' in element ? element.height : undefined,
    }))).toEqual(drifting.elements.map((element) => ({
      id: element.id, left: element.left, top: element.top,
      width: element.width, height: element.height,
    })));
  });

  it('keeps the deterministic audited style closure when the model repair is unavailable', async () => {
    const lectureOutline: SceneOutline = {
      ...outline,
      generationPurpose: 'knowledge-teaching',
    };
    const regenerate = vi.fn().mockResolvedValue(null);
    const result = await auditAndRepairSlideOnce({
      outline: lectureOutline,
      content: original,
      audit: vi.fn().mockResolvedValue(goodAudit),
      regenerate,
    });

    expect(regenerate).toHaveBeenCalledOnce();
    expect(result.adopted).toBe('repair');
    expect(result.content.elements[0]).toMatchObject({ defaultColor: '#1E3A8A' });
    expect(result.finalKnowledgeCoverage).toBe(result.initialKnowledgeCoverage);
    expect(result.finalQualityScore).toBeGreaterThan(result.initialQualityScore);
  });

  it('uses measured geometry as the single repair for a card label outside its background', async () => {
    const card = {
      id: 'card', type: 'shape', left: 100, top: 180, width: 300, height: 140,
      rotate: 0, path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z', viewBox: [1, 1],
      fill: '#eef2ff', fixedRatio: false,
    } as PPTElement;
    const label = {
      ...text('label', '随机抽样减少选择偏差', 210),
      left: 70,
      width: 350,
      height: 76,
    } as PPTElement;
    const measuredAudit: SlideLayoutAudit = {
      status: 'checked',
      method: 'openmaic-renderer-chromium-v1',
      issues: ['文字侵入相邻内容区域'],
      findings: [{
        id: 'render:scene-1:collision-card:label',
        title: '文字侵入相邻内容区域',
        evidence: '文字 label 与 shape card 的实际显示区域相交。',
        elementId: 'label',
      }],
      measurements: [
        { id: 'card', type: 'shape', box: { left: 100, top: 180, width: 300, height: 140 }, textRects: [], text: '', opaque: true },
        { id: 'label', type: 'text', box: { left: 70, top: 210, width: 350, height: 76 }, textRects: [{ left: 80, top: 220, width: 320, height: 30 }], text: '随机抽样减少选择偏差', fontSize: 20 },
      ],
    };
    const repaired = repairMeasuredSlideGeometry({ elements: [card, label] }, measuredAudit);
    expect(repaired?.elements[1]).toMatchObject({ left: 120, width: 260, top: 212 });

    const audit = vi.fn().mockResolvedValueOnce(measuredAudit).mockResolvedValue(goodAudit);
    const regenerate = vi.fn();
    const result = await auditAndRepairSlideOnce({
      outline,
      content: { elements: [card, label] },
      audit,
      regenerate,
    });
    expect(regenerate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ adopted: 'repair', repairAttempted: true });
  });

  it('detects a technically valid but visibly sparse knowledge-teaching page', () => {
    const density = auditSlideDensity({
      ...outline,
      generationPurpose: 'knowledge-teaching',
      keyPoints: ['随机抽样减少选择偏差', '样本必须来自目标总体', '抽样框需要完整覆盖总体'],
    }, { elements: [text('title-only', '随机抽样')] });

    expect(density.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('关键教学点可见覆盖率'),
      expect.stringContaining('页面下半部存在大面积'),
    ]));
  });

  it.each([900, 700])('accepts complete readable content at body width %s without imposing 90% utilization', (bodyWidth) => {
    const styledText = (id: string, content: string, top: number, height: number, color: string) => ({
      ...text(id, content, top),
      height,
      width: bodyWidth,
      defaultColor: color,
    }) as PPTElement;
    const density = auditSlideDensity({
      ...outline,
      generationPurpose: 'knowledge-teaching',
      keyPoints: ['随机抽样减少选择偏差', '样本必须来自目标总体'],
    }, { elements: [
      styledText('title', '抽样', 40, 60, '#1E3A8A'),
      styledText('subtitle', '从抽样机会到总体边界', 110, 60, '#64748B'),
      styledText('claim', '随机抽样减少选择偏差：总体中的每个对象按明确机会进入样本，从而降低研究者主观选择造成的系统误差。样本必须来自目标总体，这是后续解释统计结论的前提。', 165, 120, '#334155'),
      styledText('case', '具体执行时先建立覆盖目标总体的抽样框，再使用随机数选择对象，同时记录未响应者以及未进入抽样框的人群，避免把覆盖偏差误判成随机误差。', 280, 120, '#334155'),
      styledText('boundary', '判断边界：抽取步骤随机，并不自动保证样本有效；如果样本不是来自目标总体，后续统计结论仍然可能产生系统性偏差。', 395, 130, '#1E40AF'),
    ] });

    expect(density.issues).toEqual([]);
    expect(density.visibleTextCharacters).toBeGreaterThanOrEqual(150);
    if (bodyWidth === 700) expect(density.contentAreaUtilization).toBeLessThan(0.9);
    else expect(density.contentAreaUtilization).toBeGreaterThanOrEqual(0.9);
    expect(density.hasDeepBlueTitle).toBe(true);
    expect(density.hasSubtitle).toBe(true);
  });

  it('recognizes a full-width subtitle at the lower edge of the title band', () => {
    const density = auditSlideDensity({
      ...outline,
      generationPurpose: 'knowledge-teaching',
      keyPoints: [],
    }, { elements: [
      { ...text('title', '为什么流畅回答也可能出错', 50), width: 880, height: 70, defaultColor: '#1E3A8A' } as PPTElement,
      { ...text('subtitle', '流畅不等于真实，先把回答当作待核验材料', 150), width: 880, height: 49, defaultColor: '#64748B' } as PPTElement,
      text('body', '生成式人工智能按语言模式生成内容，表达质量不能代替证据可靠性。', 230),
    ] });
    expect(density.hasSubtitle).toBe(true);
    expect(density.issues).not.toContain('普通讲授页缺少独立副标题，标题与正文未形成清晰的两级页首层级');
  });

  it('does not mistake two body-column headings for an independent subtitle', () => {
    const density = auditSlideDensity({
      ...outline,
      generationPurpose: 'knowledge-teaching',
    }, { elements: [
      { ...text('title', '抽样', 50), width: 880, height: 70, defaultColor: '#1E3A8A' } as PPTElement,
      { ...text('left-heading', '建构主义', 150), width: 390 },
      { ...text('right-heading', '情境认知', 150), left: 530, width: 390 },
      text('body', '随机抽样减少选择偏差；样本必须来自目标总体。', 230),
    ] });
    expect(density.hasSubtitle).toBe(false);
    expect(density.issues).toContain('普通讲授页缺少独立副标题，标题与正文未形成清晰的两级页首层级');
  });

  it('flags a comparison table whose column object drifts outside the confirmed outline', () => {
    const comparisonOutline: SceneOutline = {
      ...outline,
      generationPurpose: 'knowledge-teaching',
      title: '学习理论基础',
      keyPoints: [
        '建构主义：知识由学习者主动构建',
        '情境认知：学习嵌入真实情境',
        '[Table] 比较两种学习理论',
      ],
    };
    const table = {
      id: 'wrong-comparison', type: 'table', left: 60, top: 300, width: 880, height: 180, rotate: 0,
      data: [
        [{ text: '维度' }, { text: '建构主义' }, { text: '行为主义' }],
        [{ text: '关注点' }, { text: '主动构建' }, { text: '刺激反应' }],
      ],
      colWidths: [0.2, 0.4, 0.4],
    } as unknown as PPTElement;
    const density = auditSlideDensity(comparisonOutline, { elements: [
      { ...text('title', '学习理论基础', 50), defaultColor: '#1E3A8A' } as PPTElement,
      text('subtitle', '两种理论的教学启示', 120),
      text('summary', '建构主义强调主动建构，情境认知强调真实情境。', 190),
      table,
    ] });
    expect(density.issues).toContain('比较表未呈现已确认的比较对象：情境认知；不得用大纲外对象替换表头或比较列');
  });

  it('accepts concise table headers for confirmed comparison labels', () => {
    const comparisonOutline: SceneOutline = {
      ...outline,
      generationPurpose: 'knowledge-teaching',
      keyPoints: ['PBL核心特征：成果导向', '探究式教学路径：提出问题到结论', '[Table] 两种模式对比'],
    };
    const table = {
      id: 'concise-comparison', type: 'table', left: 60, top: 230, width: 880, height: 240, rotate: 0,
      data: [[{ text: '维度' }, { text: 'PBL' }, { text: '探究式教学' }], [{ text: '产出' }, { text: '作品' }, { text: '结论' }]],
      colWidths: [0.2, 0.4, 0.4],
    } as unknown as PPTElement;
    const density = auditSlideDensity(comparisonOutline, { elements: [
      { ...text('title', '抽样', 50), defaultColor: '#1E3A8A' } as PPTElement,
      text('subtitle', '从产出到过程', 120),
      table,
    ] });
    expect(density.issues.some((issue) => issue.includes('比较表未呈现'))).toBe(false);
  });

  it('uses the same single repair attempt for density evidence and adopts a fuller page', async () => {
    const lectureOutline: SceneOutline = {
      ...outline,
      generationPurpose: 'knowledge-teaching',
      keyPoints: ['随机抽样减少选择偏差', '样本必须来自目标总体', '抽样框需要完整覆盖总体'],
    };
    const sparse = { elements: [text('title-only', '随机抽样')] };
    const repaired = { elements: [
      text('title', '随机抽样', 50),
      text('claim', '随机抽样让总体中的个体按明确机会进入样本，从而减少研究者主观选择造成的偏差；样本必须来自目标总体。', 220),
      text('boundary', '应用边界：抽样框需要完整覆盖总体，并记录无法进入抽样框的对象。', 420),
    ] };
    const audit = vi.fn().mockResolvedValue(goodAudit);
    const regenerate = vi.fn().mockResolvedValue(repaired);

    const result = await auditAndRepairSlideOnce({
      outline: lectureOutline,
      content: sparse,
      audit,
      regenerate,
    });

    expect(regenerate).toHaveBeenCalledOnce();
    expect(regenerate.mock.calls[0]?.[0]).toContain('静态内容测量确认页面过疏');
    expect(regenerate.mock.calls[0]?.[0]).toContain('以下已确认要点在可见页面文案中表达不足');
    expect(regenerate.mock.calls[0]?.[0]).toContain('明确允许在这一次修复中重建正文布局');
    expect(regenerate.mock.calls[0]?.[0]).toContain('不要只换颜色或微调坐标后原样返回');
    expect(regenerate.mock.calls[0]?.[0]).not.toContain('110–180');
    expect(result.adopted).toBe('repair');
    expect(result.finalDensityIssues.length).toBeLessThan(result.initialDensityIssues.length);
    expect(result.finalDensityIssues).toEqual(expect.arrayContaining([
      expect.stringContaining('低于 150'),
    ]));
    expect(result.finalDensityIssues).not.toEqual(expect.arrayContaining([
      expect.stringContaining('深蓝视觉角色'),
    ]));
  });

  it('adopts a materially fuller repair even when the issue-label count is unchanged', async () => {
    const styledOriginal = { elements: [
      { ...original.elements[0]!, defaultColor: '#1E3A8A' },
      original.elements[1]!,
    ] };
    const fuller = { elements: [
      { ...text('a-fuller', '随机抽样减少选择偏差'), defaultColor: '#1E3A8A' },
      text('b-fuller', '样本必须来自目标总体', 200),
      text('detail-fuller', '执行时让总体中的对象按明确机会进入样本，降低研究者主观挑选造成的系统性影响；抽取前先界定研究对象与抽样范围，避免把范围之外的对象混入结论。', 300),
    ] };
    const initialDensity = auditSlideDensity(outline, styledOriginal);
    const fullerDensity = auditSlideDensity(outline, fuller);
    expect(fullerDensity.issues).toHaveLength(initialDensity.issues.length);
    expect(fullerDensity.visibleTextCharacters).toBeGreaterThan(initialDensity.visibleTextCharacters);

    const audit = vi.fn().mockResolvedValue(badAudit);
    const regenerate = vi.fn().mockResolvedValue(fuller);
    const result = await auditAndRepairSlideOnce({
      outline,
      content: styledOriginal,
      audit,
      regenerate,
    });

    expect(regenerate).toHaveBeenCalledOnce();
    expect(result.adopted).toBe('repair');
    expect(result.finalQualityScore).toBeGreaterThan(result.initialQualityScore);
    expect(result.finalDensityIssues).toHaveLength(result.initialDensityIssues.length);
  });

  it('feeds measured geometry into the single density rewrite instead of discarding it', async () => {
    const lectureOutline: SceneOutline = {
      ...outline,
      generationPurpose: 'knowledge-teaching',
      keyPoints: ['随机抽样减少选择偏差', '样本必须来自目标总体', '抽样框需要完整覆盖总体'],
    };
    const card = {
      id: 'card-density', type: 'shape', left: 100, top: 180, width: 300, height: 140,
      rotate: 0, path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z', viewBox: [1, 1],
      fill: '#eef2ff', fixedRatio: false,
    } as PPTElement;
    const label = {
      ...text('label-density', '随机抽样', 210), left: 70, width: 350, height: 76,
    } as PPTElement;
    const measuredAudit: SlideLayoutAudit = {
      status: 'checked', method: 'openmaic-renderer-chromium-v1',
      issues: ['文字侵入相邻内容区域'],
      findings: [{
        id: 'render:scene-1:collision-card-density:label-density',
        title: '文字侵入相邻内容区域', evidence: '文字与背景卡片错位。', elementId: 'label-density',
      }],
      measurements: [
        { id: 'card-density', type: 'shape', box: { left: 100, top: 180, width: 300, height: 140 }, textRects: [], text: '', opaque: true },
        { id: 'label-density', type: 'text', box: { left: 70, top: 210, width: 350, height: 76 }, textRects: [{ left: 80, top: 220, width: 320, height: 30 }], text: '随机抽样', fontSize: 20 },
      ],
    };
    const repaired = { elements: [
      card,
      text('claim', '随机抽样让总体中的每个对象按明确机会进入样本，从而减少研究者主观挑选造成的选择偏差；样本必须来自目标总体。', 180),
      text('case', '案例：先建立完整名单，再使用随机数抽取对象，并记录未响应者。', 320),
      text('boundary', '应用边界：抽样框需要完整覆盖总体；遗漏某类对象时，随机步骤本身也不能消除覆盖偏差。', 440),
    ] };
    const audit = vi.fn().mockResolvedValueOnce(measuredAudit).mockResolvedValue(goodAudit);
    const regenerate = vi.fn().mockResolvedValue(repaired);

    const result = await auditAndRepairSlideOnce({
      outline: lectureOutline,
      content: { elements: [card, label] },
      audit,
      regenerate,
    });

    expect(regenerate).toHaveBeenCalledOnce();
    expect(regenerate.mock.calls[0]?.[1].elements[1]).toMatchObject({ left: 120, width: 260 });
    expect(regenerate.mock.calls[0]?.[0]).toContain('以下已确认要点在可见页面文案中表达不足');
    expect(result.adopted).toBe('repair');
    expect(result.finalDensityIssues.length).toBeLessThan(result.initialDensityIssues.length);
  });

  it('keeps a measured overflow fix when the one density rewrite is unusable', async () => {
    const lectureOutline: SceneOutline = {
      ...outline,
      generationPurpose: 'knowledge-teaching',
      keyPoints: ['随机抽样减少选择偏差', '样本必须来自目标总体', '抽样框需要完整覆盖总体'],
    };
    const overflowing = {
      ...text('overflowing-density', '随机抽样', 440),
      height: 30,
    } as PPTElement;
    const measuredAudit: SlideLayoutAudit = {
      status: 'checked', method: 'openmaic-renderer-chromium-v1',
      issues: ['文字超出原有排版区域'],
      findings: [{
        id: 'render:scene-1:box-overflow:overflowing-density',
        title: '文字超出原有排版区域', evidence: '文字底部超过文本框。', elementId: 'overflowing-density',
      }],
      measurements: [{
        id: 'overflowing-density', type: 'text',
        box: { left: 50, top: 440, width: 800, height: 30 },
        textRects: [{ left: 60, top: 450, width: 100, height: 45 }],
        text: '随机抽样', fontSize: 20,
      }],
    };
    const audit = vi.fn()
      .mockResolvedValueOnce(measuredAudit)
      .mockResolvedValueOnce(goodAudit);
    const regenerate = vi.fn().mockResolvedValue(null);

    const result = await auditAndRepairSlideOnce({
      outline: lectureOutline,
      content: { elements: [overflowing] },
      audit,
      regenerate,
    });

    expect(regenerate).toHaveBeenCalledOnce();
    expect(result.adopted).toBe('repair');
    expect(result.content.elements[0]).toMatchObject({ height: 67 });
    expect(result.finalAudit.issues).toEqual([]);
    expect(result.finalDensityIssues.length).toBeGreaterThan(0);
  });

  it.runIf(process.env.OPENPBL_RUN_BROWSER_AUDIT === '1')(
    'measures an actual OpenMAIC renderer page in Chromium',
    async () => {
      for (let index = 0; index < 4; index += 1) {
        const audited = await auditSlideLayout({
          elements: [
            text(`outside-${index}`, '超出画布的文字', 540),
            ...(index === 0 ? [{
              id: 'audit-image', type: 'image' as const, left: 600, top: 120,
              width: 260, height: 180, rotate: 0, src: 'gen_img_audit', fixedRatio: false,
            }] : []),
          ],
        }, `browser-fixture-${index}`);
        expect(audited.status).toBe('checked');
        expect(audited.issues.length).toBeGreaterThan(0);
      }
    },
    60_000,
  );
});
