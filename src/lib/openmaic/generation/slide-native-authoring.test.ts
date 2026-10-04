import { afterAll, describe, expect, it, vi } from 'vitest';
import type { TextMeasure } from '@openmaic/generation';
import type { PPTImageElement, PPTTextElement } from '@openmaic/dsl';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import { generateOpenMaicBaselineContent } from './openmaic-baseline';
import { buildSlideDisplayAuthoringContext } from './slide-visual-projection';
import { bindNativeLectureContent, prepareNativeLectureResponse,
  nativeLectureAuthoringPrompt, nativeLectureDisplayIssues, nativeLectureImages, retainNativeLectureTitle, retainNativeSourceCaptions, usesNativeLectureAuthoring } from './slide-native-authoring';
import { auditSlideDensity } from './slide-layout-audit';
import { closeSpatialMeasurementBrowser } from './slide-spatial-measurement';

const page = (): SceneOutline => ({ id: 'native-page', type: 'slide', title: '条件与变化', description: '比较同一条件下的变化',
  generationPurpose: 'knowledge-teaching', keyPoints: ['完成3次测量后再计算平均值', '记录不同条件下的变化'],
  teachingBrief: { teachingPlan: { presentationContent: ['完成3次测量后再计算平均值', '记录不同条件下的变化'] } },
} as SceneOutline);
const measure: TextMeasure = async (input) => ({ width: input.width, height: 45, lines: [input.text],
  naturalWidth: Math.min(input.width, input.text.length * input.fontSize) });
const title: PPTTextElement = { id: 'heading', type: 'text', left: 60, top: 50, width: 870, height: 60,
  rotate: 0, defaultFontName: 'Noto Sans SC', defaultColor: '#1E3A8A',
  textType: 'title', content: '<p style="font-size:32px;color:#1E3A8A">条件与变化</p>' };
const response = () => ({ background: { type: 'solid', color: '#FFFFFF' },
  displayItems: [
    { id: 'measure', sourceContentIds: ['adopted-content-1'], text: '3次测量 → 计算平均值', emphasis: ['3次测量'] },
    { id: 'record', sourceContentIds: ['adopted-content-2'], text: '记录不同条件下的变化' },
  ], elements: [title, { type: 'shape', id: 'focus-background', left: 60, top: 160, width: 550, height: 100, fill: '#EFF6FF',
    path: 'M0 0H550V100H0Z', viewBox: [550, 100], fixedRatio: false }],
  components: [
    { id: 'main', kind: 'textBox', contentRef: 'measure', fontSize: 18, left: 70, top: 165, width: 530 },
    { id: 'support', kind: 'textBox', contentRef: 'record', fontSize: 18, left: 60, top: 290, width: 880 },
  ] });
const restoredResponse = () => ({ background: { type: 'solid', color: '#FFFFFF' },
  elements: [title, { type: 'shape', id: 'focus-background', left: 60, top: 160, width: 550, height: 100,
    fill: '#EFF6FF', path: 'M0 0H550V100H0Z', viewBox: [550, 100], fixedRatio: false },
    { ...title, id: 'main', textType: 'content', top: 165, left: 70, width: 530,
      sourceContentIds: ['adopted-content-1'], content: '<p style="font-size:18px"><strong>3次测量</strong> → 计算平均值</p>' }],
  components: [{ id: 'support', kind: 'textBox', text: '记录不同条件下的变化', fontSize: 18, left: 60, top: 290, width: 880 }],
});
const options = { componentAuthoring: true, textMeasure: measure };
afterAll(closeSpatialMeasurementBrowser);

describe('single-response native lecture composition', () => {
  it('binds the lecture font before DSL fallback and measurement across native text, shape text and cells', () => {
    const outline = page(), authored = response();
    const raw = { ...authored, elements: [...authored.elements,
      { id: 'empty-font', type: 'text', contentRef: 'record', content: '<p style="font-size:18px"></p>', defaultFontName: '' },
      { id: 'shape-label', type: 'shape', text: { contentRef: 'record', content: '<p></p>', defaultFontName: '' } },
      { id: 'cells', type: 'table', data: [[{ id: 'cell', contentRef: 'record', text: '', style: { fontsize: 16 } }]] },
    ] };
    const before = structuredClone(raw);
    const prepared = prepareNativeLectureResponse(JSON.stringify(raw), buildSlideDisplayAuthoringContext(outline), outline);
    const normalized = JSON.parse(prepared.response);
    expect(normalized.elements.find((element: { id: string }) => element.id === 'empty-font').defaultFontName).toBe('Noto Sans SC');
    expect(normalized.elements.find((element: { id: string }) => element.id === 'shape-label').text.defaultFontName).toBe('Noto Sans SC');
    expect(normalized.elements.find((element: { id: string }) => element.id === 'cells').data[0][0].style)
      .toEqual({ fontsize: 16, fontname: 'Noto Sans SC' });
    expect(raw).toEqual(before);
  });

  it('preserves the canonical graph and source duties while asking the first draft to allocate its matching measured profile', () => {
    const outline = page();
    outline.visualIntent = { representation: 'native-diagram', observationGoal: '完整分支与汇合关系', diagram: { topology: 'branch',
      nodes: [{ id: 'new-info', label: '新信息' }, { id: 'compatible', label: '与原有认知结构相容？' },
        { id: 'assimilation', label: '同化' }, { id: 'accommodation', label: '顺应' }],
      edges: [{ from: 'new-info', to: 'compatible' }, { from: 'compatible', to: 'assimilation', label: '相容' },
        { from: 'compatible', to: 'accommodation', label: '冲突或不兼容' }] } };
    const context = buildSlideDisplayAuthoringContext(outline).context;
    const before = structuredClone({ outline, context });
    const prompt = nativeLectureAuthoringPrompt(outline, context);
    expect(prompt).toContain('不能混用不同候选的尺寸');
    expect(prompt).toContain('真实18px字体、方向、样式及图注范围分别测量');
    expect(prompt).toContain('给组件写一个小height不会使实际长图自动缩进该框');
    const catalog = JSON.parse(prompt.slice(prompt.lastIndexOf('## 本页来源与展示职责\n') + '## 本页来源与展示职责\n'.length));
    expect(catalog.diagram).toEqual(outline.visualIntent!.diagram);
    expect(catalog.adoptedDisplayContent).toEqual(context.adoptedDisplayContent);
    expect({ outline, context }).toEqual(before);
  });

  it('does not impose a diagram profile on a page without a canonical diagram', () => {
    const outline = page();
    const prompt = nativeLectureAuthoringPrompt(outline, buildSlideDisplayAuthoringContext(outline).context);
    expect(prompt).not.toContain('不能混用不同候选的尺寸');
    expect(prompt).toContain('没有 composition 模板');
  });

  it('offers single-title vertical rows when measured space fits one real sequence while retaining every canonical node and edge', () => {
    const outline = page();
    outline.visualIntent = { representation: 'native-diagram', observationGoal: '理解每步做法和必要条件', diagram: {
      topology: 'sequence', nodes: [{ id: 'sample', label: '1 采样' }, { id: 'average', label: '2 求均值' }],
      edges: [{ from: 'sample', to: 'average' }],
    } };
    const authoring = buildSlideDisplayAuthoringContext(outline);
    const before = structuredClone({ outline, context: authoring.context });
    const prompt = nativeLectureAuthoringPrompt(outline, authoring.context);
    expect(prompt).toContain('左侧用编号和细连接线表达完整真实顺序');
    expect(prompt).toContain('每行只出现一次完整步骤标题，与同排的具体正文就近对应');
    expect(prompt).toContain('只有完整标题和每步正文都能获得足够横向空间');
    expect(prompt).toContain('不能因 topology 是 sequence 或某个步骤数量就默认采用');
    expect(prompt).toContain('核对完整标题的自然宽度');
    expect(prompt).toContain('横向空间足够时让完整步骤标题保持单行');
    expect(prompt).toContain('最长标题的实测宽度、每步解释的字数与实际换行');
    expect(prompt).toContain('不固定标题/正文的比例');
    expect(prompt).toContain('不是强制默认、整页固定模板');
    expect(prompt).toContain('displayItem.text 可省略与该节点标题完全重复的开头');
    expect(prompt).toContain('不要在上方另画一套流程标题');
    expect(prompt).toContain('不删正文事实、必要条件、节点或真实关系');
    expect(prompt).toContain('不增加模型修补调用');
    const catalog = JSON.parse(prompt.slice(prompt.lastIndexOf('## 本页来源与展示职责\n') + '## 本页来源与展示职责\n'.length));
    expect(catalog.diagram).toEqual(outline.visualIntent.diagram);
    expect({ outline, context: authoring.context }).toEqual(before);

    outline.visualIntent.diagram!.topology = 'branch';
    expect(nativeLectureAuthoringPrompt(outline, authoring.context)).not.toContain('可考虑竖向流程行这一适配候选');
    outline.visualIntent.diagram!.topology = 'sequence';
    outline.visualIntent.diagram!.sequenceGroups = [{ id: 'one', nodeIds: ['sample'] }, { id: 'two', nodeIds: ['average'] }];
    expect(nativeLectureAuthoringPrompt(outline, authoring.context)).not.toContain('可考虑竖向流程行这一适配候选');
  });

  it('keeps source-bound row bodies without copying the titles already present in the canonical diagram', () => {
    const outline = page();
    outline.keyPoints = ['采样：在同一条件下完成3次测量。', '求均值：用3次测量值计算平均值。'];
    outline.teachingBrief!.teachingPlan!.presentationContent = [...outline.keyPoints];
    outline.visualIntent = { representation: 'native-diagram', observationGoal: '完成测量后再计算', diagram: {
      topology: 'sequence', nodes: [{ id: 'sample', label: '1 采样' }, { id: 'average', label: '2 求均值' }],
      edges: [{ from: 'sample', to: 'average' }],
    } };
    const raw = { displayItems: [
      { id: 'sample-body', sourceContentIds: ['adopted-content-1'], diagramNodeId: 'sample', text: '在同一条件下完成3次测量。' },
      { id: 'average-body', sourceContentIds: ['adopted-content-2'], diagramNodeId: 'average', text: '用3次测量值计算平均值。' },
    ], elements: [], components: [
      { kind: 'diagram', id: 'sequence', left: 60, top: 150, width: 240, height: 280, orientation: 'vertical', presentation: 'steps' },
      { kind: 'textBox', id: 'sample-row', contentRef: 'sample-body', left: 330, top: 170, width: 600, fontSize: 18 },
      { kind: 'textBox', id: 'average-row', contentRef: 'average-body', left: 330, top: 290, width: 600, fontSize: 18 },
    ] };
    const before = structuredClone({ outline, raw });
    const prepared = prepareNativeLectureResponse(JSON.stringify(raw), buildSlideDisplayAuthoringContext(outline), outline);
    expect(prepared.sourceIssues).toEqual([]);
    expect(prepared.factIssues).toEqual([]);
    expect(prepared.displayItems.map(({ text }) => text)).toEqual(raw.displayItems.map(({ text }) => text));
    expect(prepared.displayItems.map(({ diagramNodeId }) => diagramNodeId)).toEqual(['sample', 'average']);
    expect(JSON.parse(prepared.response).components).toEqual(raw.components);
    expect({ outline, raw }).toEqual(before);
  });

  it('defines first-compile row alignment only for independently bound vertical sequence explanations', () => {
    const outline = page();
    outline.visualIntent = { representation: 'native-diagram', observationGoal: '理解步骤与条件', diagram: {
      topology: 'sequence', nodes: [{ id: 'measure', label: '完成测量' }, { id: 'calculate', label: '计算结果' }],
      edges: [{ from: 'measure', to: 'calculate' }],
    } };
    const context = buildSlideDisplayAuthoringContext(outline).context;
    const before = structuredClone({ outline, context });
    const prompt = nativeLectureAuthoringPrompt(outline, context);
    expect(prompt).toContain('orientation:"vertical" 的 sequence');
    expect(prompt).toContain('每个节点的一份独立解释');
    expect(prompt).toContain('diagramNodeId 同时是本次首次编译的局部行对齐合同');
    expect(prompt).toContain('对齐相应解释的实际文字墨迹中心');
    expect(prompt).toContain('为完整解释正文的高度和各行间距预留足够空间');
    expect(prompt).toContain('不能另猜一套独立等距坐标');
    expect(prompt).toContain('不能把其他文字或图片放进对齐后需要的行空间');
    expect(prompt).toContain('不要求分支图、横向流程或合并多个节点的段落改成此布局');
    expect(prompt).not.toContain('diagramNodeId 只说明解释属于哪个节点');
    expect({ outline, context }).toEqual(before);

    outline.visualIntent.diagram!.topology = 'branch';
    expect(nativeLectureAuthoringPrompt(outline, buildSlideDisplayAuthoringContext(outline).context))
      .not.toContain('局部行对齐合同');
  });

  it('requires concise wording to retain all adopted independent factual dimensions and counts', () => {
    const outline = page();
    const context = buildSlideDisplayAuthoringContext(outline).context;
    const before = structuredClone(context);
    const prompt = nativeLectureAuthoringPrompt(outline, context);
    expect(prompt).toContain('不能省略已采纳事实中的独立维度、对象、评价方面、数量或必要条件');
    expect(prompt).toContain('不能只保留其中几项或用总括词代替完整范围');
    expect(prompt).toContain('不同维度不能因文字空间而合并丢失');
    expect(prompt).toContain('不代表事实已经完整显示');
    expect(prompt).toContain('requiredFactSets:[{sourceContentId,terms,acceptedForms?}]');
    expect(prompt).toContain('其他来源区域的同一个词代替该命题中的对象');
    expect(prompt).toContain('不会在段间插入 <br><br> 空行');
    expect(context).toEqual(before);
  });

  it('grounds first-draft grouping in complete source members and distinguishes supporting context visually', () => {
    const outline = page();
    const semanticGroups = [{ id: 'material-group', label: '三类材料', sourceContentIds: ['adopted-content-1'],
      members: [{ id: 'metal', label: '金属', sourceContentIds: ['adopted-content-1'] },
        { id: 'plastic', label: '塑料', sourceContentIds: ['adopted-content-1'] },
        { id: 'wood', label: '木材', sourceContentIds: ['adopted-content-1'] }] }];
    const context = { ...buildSlideDisplayAuthoringContext(outline).context, semanticGroups };
    const before = structuredClone({ outline, context });
    const prompt = nativeLectureAuthoringPrompt(outline, context);
    expect(prompt).toContain('区分集合、组成成员、原则、角色和支持资源，再设计整体构图');
    expect(prompt).toContain('semanticBindings?:{groupId:string,role:"overview"|"member"|"context",memberId?:string}[]');
    expect(prompt).toContain('overview 声明该组名称、数量和范围');
    expect(prompt).toContain('memberId 精确绑定该组合法成员并使用该成员真实 label');
    expect(prompt).toContain('context 是与该组相关的真实原则、角色或支持说明，不属于集合成员');
    expect(prompt).toContain('完整成员可以共享一个清晰横列或段落的 overview 正文');
    expect(prompt).toContain('各成员名称真实可读且完整同组，不强制拆成独立 item');
    expect(prompt).toContain('独立展开成员说明或标签时，须保留相应 memberId 的真实归属');
    expect(prompt).toContain('一个项可有多个真实组的绑定');
    expect(prompt).toContain('原文没有独立解释不代表可以删除成员或少画成员');
    expect(prompt).toContain('同辈形式只用于真实同组同层的内容');
    expect(prompt).toContain('完整成员围绕共同组标题或区域呈现');
    expect(prompt).toContain('context 放在不同区域或以清晰主次区分');
    expect(prompt).toContain('不能只填写 semanticBindings');
    expect(prompt).toContain('成员数量不规定卡片数量或固定模板');
    expect(prompt).toContain('没有真实顺序、因果或其他明确关系时不加箭头');
    const catalog = JSON.parse(prompt.slice(prompt.lastIndexOf('## 本页来源与展示职责\n') + '## 本页来源与展示职责\n'.length));
    expect(catalog.semanticGroups).toEqual(semanticGroups);
    expect({ outline, context }).toEqual(before);
  });

  it('requires every member to remain visible within an independently expanded group without forcing one card per member', () => {
    const outline = page();
    const prompt = nativeLectureAuthoringPrompt(outline, buildSlideDisplayAuthoringContext(outline).context);
    expect(prompt).toContain('该完整集合的每个成员都须在这个区域实际可辨');
    expect(prompt).toContain('不能用 overview 中的完整名称掩盖下方少画的成员');
    expect(prompt).toContain('独立可辨的真实名字、contentRef 和 memberId');
    expect(prompt).toContain('有共同真实来源说明的成员放在一处组合');
    expect(prompt).toContain('所有成员名字同等可读并保留各自 memberId');
    expect(prompt).toContain('不能制造定义');
    expect(prompt).toContain('“资料未展开”等教师编辑提示');
    expect(prompt).toContain('不要求每个成员单独一张卡');
    expect(prompt).toContain('overview 可精炼为真实集合名称和数量，不必再次重抄所有成员名称');
    expect(prompt).toContain('全集由展开区域的实际文字槽合计显示');
  });

  it('requires measured rich-text height and padding inside supporting backgrounds during the first composition', () => {
    const outline = page();
    const prompt = nativeLectureAuthoringPrompt(outline, buildSlideDisplayAuthoringContext(outline).context);
    expect(prompt).toContain('真实字体、字号、行高、换行及段内粗体计量');
    expect(prompt).toContain('默认四边至少10px');
    expect(prompt).toContain('容器高度包括实测正文高度与上下内边距');
    expect(prompt).toContain('强调带底部不能让文字墨迹贴边或越过背景');
    expect(prompt).toContain('不能代替背景内部的可读空间检查');
    expect(prompt).toContain('不能依赖程序自动整页重排、缩字或追加美化调用');
  });

  it('does not invent a semantic group when none is supplied', () => {
    const outline = page();
    const context = { ...buildSlideDisplayAuthoringContext(outline).context, semanticGroups: [] };
    const prompt = nativeLectureAuthoringPrompt(outline, context);
    expect(prompt).toContain('没有这类明确集合时不新增集合归属');
    const catalog = JSON.parse(prompt.slice(prompt.lastIndexOf('## 本页来源与展示职责\n') + '## 本页来源与展示职责\n'.length));
    expect(catalog.semanticGroups).toEqual([]);
  });

  it('keeps source and editorial records off the shared classroom canvas while preserving explanatory annotation', () => {
    const outline = page();
    outline.knowledgePointIds = ['kp-1'];
    outline.visualIntent = { representation: 'native-diagram', observationGoal: '观察必要条件和真实顺序', diagram: {
      topology: 'sequence', nodes: [{ id: 'measure', label: '完成3次测量' }, { id: 'calculate', label: '计算平均值' }],
      annotation: '完成3次测量后再计算平均值。条件不足时不能提前计算。',
    } };
    const context = buildSlideDisplayAuthoringContext(outline, {
      sourceKnowledgePoints: [{ id: 'kp-1', evidenceItemIds: ['actual-evidence'] }],
      sourceEvidence: { schemaVersion: 2, version: 1, fingerprint: 'adopted-version', createdAt: '', retrievalMode: 'hybrid',
        selections: [{ revisionId: 'revision', primary: true, sectionIds: [] }], mappings: [], warnings: [],
        items: [{ id: 'actual-evidence', kind: 'source-block', title: '测量原文', content: '完成3次测量后再计算平均值。',
          source: { textbookId: 'book', textbookTitle: '实际采用的教材', revisionId: 'revision', revisionVersion: 1,
            sectionPath: ['测量'], sourceBlockId: 'actual-block', quote: '完成3次测量后再计算平均值。' } }] },
    }).context;
    const before = structuredClone(context);
    const prompt = nativeLectureAuthoringPrompt(outline, context);
    expect(prompt).toContain('师生共用课堂 PPT，教师端与学生端都不显示书目出处');
    expect(prompt).toContain('教师专用的备课、编排、编辑或审阅提示留在系统教师报告');
    expect(prompt).toContain('实际所教的教学法原则继续显示');
    expect(prompt).toContain('继续使用提供的真实 resource ID、sourceContentIds 和 sourceEvidenceIds');
    expect(prompt).not.toContain('原生图注可直接写“来源：sourceTitle，第pageNumber页”');
    expect(prompt).toContain('text 保留提供的 diagram.annotation 全文');
    const catalog = JSON.parse(prompt.slice(prompt.lastIndexOf('## 本页来源与展示职责\n') + '## 本页来源与展示职责\n'.length));
    expect(catalog.adoptedEvidenceIds).toEqual(['actual-evidence']);
    expect(catalog.originalTeachingSources.originalSources[0]).toMatchObject({
      evidenceId: 'actual-evidence', textbookTitle: '实际采用的教材', revisionId: 'revision',
      passages: [expect.objectContaining({ sourceBlockId: 'actual-block', text: '完成3次测量后再计算平均值。' })],
    });
    expect(catalog.diagram.annotation).toBe(outline.visualIntent.diagram!.annotation);
    expect(context).toEqual(before);
  });

  it('restores an omitted known page heading without moving teaching content or manufacturing body coverage', async () => {
    const body = { ...title, id: 'body', textType: undefined, top: 105, content: '<p style="font-size:18px">已有正文</p>' };
    const input = { elements: [body], contentBindings: [{ sourceContentId: 'point', elementId: 'body' }] };
    const result = await retainNativeLectureTitle(page(), input, measure);
    expect(result.elements[0]).toEqual(body);
    expect(result.elements[1]).toMatchObject({ textType: 'title', top: 50, height: 46 });
    expect(result.elements[1]).toHaveProperty('content', expect.stringContaining('条件与变化'));
    expect(result.contentBindings).toEqual([...input.contentBindings, { sourceContentId: 'native-page:title', elementId: 'native-page-main-title' }]);
    expect(input.elements).toHaveLength(1);
  });

  it('preserves an authored heading and diagnoses occupied header space instead of rearranging the page', async () => {
    const authored = { elements: [{ ...title, textType: undefined }] };
    expect(await retainNativeLectureTitle(page(), authored, measure)).toBe(authored);
    const occupied = { elements: [{ ...title, textType: undefined, content: '<p style="font-size:18px">正文</p>' }] };
    const result = await retainNativeLectureTitle(page(), occupied, measure);
    expect(result.elements).toEqual(occupied.elements);
    expect(result.qualityDiagnostics).toContainEqual(expect.stringContaining('main title is missing'));
  });

  it('does not mistake a filled header region for empty space and create an unreadable heading', async () => {
    const input: GeneratedSlideContent = { elements: [{ id: 'filled-header', type: 'shape', left: 50, top: 50,
      width: 900, height: 90, rotate: 0, path: 'M0 0H900V90H0Z', viewBox: [900, 90], fill: '#1E3A8A', fixedRatio: false }] };
    const result = await retainNativeLectureTitle(page(), input, measure);
    expect(result.elements).toEqual(input.elements);
    expect(result.qualityDiagnostics).toContainEqual(expect.stringContaining('no clear measured allocation'));
  });

  it('measures a short missing heading beside an existing figure caption without moving either region', async () => {
    const caption = { ...title, id: 'source-caption', textType: undefined, left: 545, top: 50, width: 405,
      content: '<p style="font-size:16px">来源：已有教材，第1页</p>' };
    const result = await retainNativeLectureTitle(page(), { elements: [caption] }, measure);
    expect(result.elements[0]).toEqual(caption);
    expect(result.elements[1]).toMatchObject({ textType: 'title', left: 50, width: 220 });
    expect(result.qualityDiagnostics ?? []).toEqual([]);
  });

  it('authors concise display text and a mixed native page in one request, independently of saved typography', async () => {
    const outline = page(), before = structuredClone(outline);
    const call = vi.fn(async (system: string) => {
      expect(system).toContain('PPT_RESTORED_NATIVE_4615');
      expect(system).toContain('Write literal rich text');
      expect(system).not.toContain('只返回 JSON {background,displayItems,elements,components}');
      expect(system).not.toContain('## PPT_VISUAL_PROJECTION_V1');
      expect(system).not.toContain('## Measured native text placement choices');
      return JSON.stringify(restoredResponse());
    });
    const content = await generateOpenMaicBaselineContent(outline, call, options) as GeneratedSlideContent;
    expect(call).toHaveBeenCalledTimes(1);
    expect(content.displayItems).toBeUndefined();
    expect(content.elements).toContainEqual(expect.objectContaining({ id: 'focus-background', type: 'shape', left: 60, top: 160 }));
    expect(content.contentBindings).toContainEqual({ sourceContentId: 'adopted-content-1', elementId: 'main' });
    expect(content.elements.filter((element) => element.type === 'text').some((element) => element.content.replace(/<[^>]*>/gu, '').includes('3次测量 → 计算平均值'))).toBe(true);
    expect(content.elements.filter((element) => element.type === 'text').some((element) => element.content.includes('<strong>3次测量</strong>'))).toBe(true);
    expect(content.presentationProjection).toBeUndefined();
    expect(content.qualityDiagnostics ?? []).not.toContainEqual(expect.stringContaining('Restored native display quantity:'));
    expect(outline).toEqual(before);
  });

  it('binds comparison dimensions, object headings and facts to actual table cells', async () => {
    const outline = page();
    outline.teachingBrief!.teachingPlan!.presentationContent = ['状态｜甲：完成3次测量', '状态｜乙：完成4次测量'];
    const cell = (id: string, text: string, sourceContentIds?: string[]) => ({ id, text, sourceContentIds, colspan: 1, rowspan: 1,
      style: { fontsize: '16px', fontname: 'Noto Sans SC', backcolor: '#FFFFFF', color: '#334155' } });
    const call = vi.fn(async () => JSON.stringify({ elements: [title,
      { id: 'comparison', type: 'table', left: 60, top: 170, width: 880, height: 150, colWidths: [0.2, 0.4, 0.4], cellMinHeight: 50,
        data: [[cell('dimension', '维度'), cell('head-a', '甲'), cell('head-b', '乙')],
          [cell('row', '状态'), cell('value-a', '完成3次测量', ['adopted-content-1']), cell('value-b', '完成4次测量', ['adopted-content-2'])]] }], components: [] }));
    const content = await generateOpenMaicBaselineContent(outline, call, options) as GeneratedSlideContent;
    expect(content.contentBindings).toContainEqual({ sourceContentId: 'adopted-content-1', elementId: 'comparison', selector: { cellId: 'value-a' } });
    expect(content.contentBindings).toContainEqual({ sourceContentId: 'adopted-content-2', elementId: 'comparison', selector: { cellId: 'value-b' } });
    expect(content.elements.find((element) => element.type === 'table')).toMatchObject({ data: [
      [expect.anything(), expect.objectContaining({ text: expect.stringContaining('甲') }), expect.objectContaining({ text: expect.stringContaining('乙') })],
      [expect.anything(), expect.objectContaining({ text: expect.stringContaining('完成3次测量') }), expect.objectContaining({ text: expect.stringContaining('完成4次测量') })],
    ] });
  });

  it('retains the saved usable page when proposed wording drops an adopted quantity', async () => {
    const outline = page(), proposed = restoredResponse();
    const proposedBody = proposed.elements.find((element) => element.id === 'main');
    if (!proposedBody || proposedBody.type !== 'text' || !('content' in proposedBody)) throw new Error('Expected editable main text fixture');
    proposedBody.content = '<p>测量 → 计算平均值</p>';
    const baseline = { elements: [title, { ...title, id: 'saved-body', textType: 'content', top: 160,
      content: '<p>完成3次测量后再计算平均值</p><p>记录不同条件下的变化</p>' }], qualityDiagnostics: ['saved observation'] } as GeneratedSlideContent;
    const call = vi.fn(async () => JSON.stringify(proposed));
    const content = await generateOpenMaicBaselineContent(outline, call, { ...options, visualBaseline: baseline }) as GeneratedSlideContent;
    expect(call).toHaveBeenCalledTimes(1);
    expect(content.elements).toEqual(baseline.elements);
    expect(content.qualityDiagnostics).toContainEqual(expect.stringContaining('Restored native display quantity:'));
    expect(content.qualityDiagnostics).toContain('saved observation');
  });

  it('keeps a title-only literal first draft with a quality diagnosis rather than requiring a display protocol', async () => {
    const call = vi.fn(async () => JSON.stringify({ elements: [title] }));
    const failure = vi.fn();
    const content = await generateOpenMaicBaselineContent(page(), call, { ...options, onFailure: failure }) as GeneratedSlideContent;
    expect(content.elements).toEqual([title]);
    expect(content.displayItems).toBeUndefined();
    expect(content.qualityDiagnostics).toContainEqual(expect.stringContaining('Restored native display quantity:'));
    expect(call).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveBeenCalled();
  });

  it('keeps a new literal draft unchanged when its selected quantity is missing, without backfilling source prose', async () => {
    const proposed = restoredResponse();
    const proposedBody = proposed.elements.find((element) => element.id === 'main');
    if (!proposedBody || proposedBody.type !== 'text' || !('content' in proposedBody)) throw new Error('Expected editable main text fixture');
    proposedBody.content = '<p>测量 → 计算平均值</p>';
    const call = vi.fn(async () => JSON.stringify(proposed));
    const content = await generateOpenMaicBaselineContent(page(), call, options) as GeneratedSlideContent;
    const body = content.elements.find((element) => element.id === 'main');
    expect(body).toMatchObject({ type: 'text', content: '<p>测量 → 计算平均值</p>' });
    expect(content.qualityDiagnostics).toContainEqual(expect.stringContaining('Restored native display quantity:'));
    expect(call).toHaveBeenCalledOnce();
  });

  it('rejects an empty literal canvas as technical invalid output without another request', async () => {
    const call = vi.fn(async () => JSON.stringify({ elements: [], components: [] }));
    const failure = vi.fn();
    expect(await generateOpenMaicBaselineContent(page(), call, { ...options, onFailure: failure })).toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid-model-output' }));
  });

  it('keeps a new page executable after a valid response cannot allocate its graph, with no second model request', async () => {
    const outline = page(), proposed = restoredResponse(), before = structuredClone(outline);
    outline.visualIntent = { representation: 'native-diagram', rationale: '已知步骤', observationGoal: '观察先后关系', diagram: {
      topology: 'sequence', nodes: [{ id: 'measure', label: '测量' }, { id: 'record', label: '记录' }],
      edges: [{ from: 'measure', to: 'record' }],
    } };
    const call = vi.fn(async () => JSON.stringify({ ...proposed, components: [...proposed.components,
      { kind: 'diagram', id: 'too-narrow', left: 850, top: 170, width: 30, height: 150 }] }));
    const failure = vi.fn();
    const result = await generateOpenMaicBaselineContent(outline, call, { ...options, onFailure: failure,
      textMeasure: () => ({ naturalWidth: 1000, height: 10000, lines: ['actual measurement reports overflow'] }) }) as GeneratedSlideContent;
    expect(call).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
    expect(result.elements.length).toBeGreaterThan(0);
    const allElements = [...result.elements, ...(result.continuationPages ?? []).flatMap((compiled) => compiled.elements)];
    const text = allElements.map((element) => element.type === 'text' ? element.content
      : element.type === 'shape' ? element.text?.content ?? '' : '').join(' ').replace(/<[^>]*>/gu, '');
    expect(text).toContain('3次测量');
    expect(text).toContain('计算平均值');
    expect(text).toContain('记录不同条件下的变化');
    expect(text).toContain('测量');
    expect(text).toContain('记录');
    expect(result.qualityDiagnostics?.length).toBeGreaterThan(0);
    expect(allElements.filter((element) => element.type === 'line').length).toBeGreaterThan(0);
    expect(allElements.some((element) => element.id.includes('node-measure'))).toBe(true);
    expect(allElements.some((element) => element.id.includes('node-record'))).toBe(true);
    expect(outline.teachingBrief).toEqual(before.teachingBrief);
  });

  it('maps merged display prose to both original sources without adding teaching text', () => {
    const outline = page();
    const source = buildSlideDisplayAuthoringContext(outline);
    const prepared = prepareNativeLectureResponse(JSON.stringify({ displayItems: [
      { id: 'combined', sourceContentIds: source.sources.map((item) => item.id), text: '完成3次测量后计算平均值，同时记录不同条件下的变化' },
    ], elements: [], components: [] }), source, outline);
    const content = bindNativeLectureContent(outline, { elements: [title], contentBindings: [
      { sourceContentId: 'combined', elementId: 'heading' },
    ] }, prepared.displayItems, source.sources);
    expect(prepared.sourceIssues).toEqual([]);
    expect(content.contentBindings).toContainEqual({ sourceContentId: 'native-page:visible-1', elementId: 'heading' });
    expect(content.contentBindings).toContainEqual({ sourceContentId: 'native-page:visible-2', elementId: 'heading' });
    expect(content.elements).toHaveLength(1);
  });

  it('counts native metadata only when condensed words are actually readable on the mapped canvas', async () => {
    const outline = page();
    const authored = restoredResponse();
    const authoredBody = authored.elements.find((element) => element.id === 'main');
    if (!authoredBody || authoredBody.type !== 'text' || !('content' in authoredBody)) throw new Error('Expected editable main text fixture');
    authoredBody.content = '<p>完成3次测量后再计算平均值</p>';
    const content = await generateOpenMaicBaselineContent(outline, async () => JSON.stringify(authored), options) as GeneratedSlideContent;
    expect(auditSlideDensity(outline, content).underrepresentedKeyPoints).toEqual([]);
    const hidden = { ...content, elements: content.elements.filter((element) => element.id === 'heading') };
    expect(auditSlideDensity(outline, hidden).underrepresentedKeyPoints).toHaveLength(2);
  });

  it('recovers only a unique exact literal body slot, keeping table selectors and rejecting ambiguous or hidden text', () => {
    const outline = page();
    const items = [{ id: 'literal', sourceContentIds: ['adopted-content-1'], text: '完成3次测量' }];
    const cell = { id: 'actual-cell', text: '完成3次测量', colspan: 1, rowspan: 1 };
    const table = { id: 'table', type: 'table', left: 60, top: 150, width: 880, height: 100,
      colWidths: [1], cellMinHeight: 50, data: [[cell]], rotate: 0 } as const;
    const draft = { type: 'slide', elements: [structuredClone(table)], background: { type: 'solid', color: '#FFFFFF' } } as unknown as GeneratedSlideContent;
    expect(bindNativeLectureContent(outline, draft, items, []).contentBindings).toContainEqual({
      sourceContentId: 'literal', elementId: 'table', selector: { cellId: 'actual-cell' },
    });
    const text = { ...title, id: 'body', textType: 'content' as const, content: '<p>完成3次测量</p>' };
    expect(bindNativeLectureContent(outline, { ...draft, elements: [...draft.elements, text] }, items, []).contentBindings).toEqual([]);
    expect(bindNativeLectureContent(outline, { ...draft, elements: [{ ...text, content: '<p style="display:none">完成3次测量</p>' }] }, items, []).contentBindings).toEqual([]);
    expect(bindNativeLectureContent(outline, { ...draft, elements: [{ ...text, content: '<p>完成3次测量后再计算平均值</p>' }] }, items, []).contentBindings).toEqual([]);
    const clipped = { ...draft, elements: [{ ...text, left: 990 }], displayItems: items,
      contentBindings: [{ sourceContentId: 'literal', elementId: text.id }] };
    expect(nativeLectureDisplayIssues(clipped)).toHaveLength(1);
    expect(nativeLectureDisplayIssues({ ...clipped, elements: [{ ...text, content: '<p style="opacity:0;">完成3次测量</p>' }] })).toHaveLength(1);
  });

  it('includes native chart and video pages while excluding teacher and quiz scenes', () => {
    expect(usesNativeLectureAuthoring({ ...page(), visualIntent: { representation: 'native-chart', observationGoal: '真实数据' } })).toBe(true);
    expect(usesNativeLectureAuthoring({ ...page(), audience: 'teacher' })).toBe(false);
    expect(usesNativeLectureAuthoring({ ...page(), type: 'quiz' })).toBe(false);
  });

  it('authorizes an external canonical diagram annotation only through a complete real outside reference', () => {
    const outline = page();
    outline.visualIntent = { representation: 'native-diagram', observationGoal: '保留图注与完整关系', diagram: {
      topology: 'sequence', nodes: [{ id: 'a', label: '观察' }, { id: 'b', label: '判断' }],
      edges: [{ from: 'a', to: 'b' }], annotation: '先观察，再依据事实判断。',
    } };
    const authoring = buildSlideDisplayAuthoringContext(outline);
    const raw = { ...response(), displayItems: [...response().displayItems,
      { id: 'annotation', sourceContentIds: ['diagram-annotation'], text: outline.visualIntent!.diagram!.annotation }],
      elements: [title, { id: 'note', type: 'text', contentRef: 'annotation', left: 60, top: 440, width: 880, height: 60 }],
      components: [{ kind: 'diagram', left: 60, top: 200, width: 880, height: 200, annotationPlacement: 'external' }],
    };
    const prepare = (value: unknown) => JSON.parse(prepareNativeLectureResponse(JSON.stringify(value), authoring, outline).response);
    expect(prepare(raw).components[0].annotationPlacement).toBe('external');
    expect(prepare({ ...raw, elements: [{ ...raw.elements[1], top: 250 }] }).components[0].annotationPlacement).toBeUndefined();
    expect(prepare({ ...raw, elements: [{ ...raw.elements[1], contentRef: undefined, content: '没有引用' }] }).components[0].annotationPlacement).toBeUndefined();
    expect(prepare({ ...raw, displayItems: raw.displayItems.map((item) => item.id === 'annotation' ? { ...item, text: '简称' } : item) }).components[0].annotationPlacement).toBeUndefined();
    outline.visualIntent!.diagram!.annotation = '先观察，再依据事实判断。条件不足时暂缓结论。';
    const prefix = { ...raw, displayItems: raw.displayItems.map((item) => item.id === 'annotation' ? { ...item, text: '先观察，再依据事实判断。' } : item) };
    const restored = prepare(prefix);
    expect(restored.displayItems.find((item: { id: string }) => item.id === 'annotation').text).toBe(outline.visualIntent!.diagram!.annotation);
    expect(restored.components[0].annotationPlacement).toBe('external');
    authoring.evidenceIds.add('adopted-evidence');
    const cited = { ...raw, displayItems: raw.displayItems.map((item) => item.id === 'annotation'
      ? { ...item, text: outline.visualIntent!.diagram!.annotation } : { ...item, sourceEvidenceIds: ['adopted-evidence'] }) };
    const exact = prepareNativeLectureResponse(JSON.stringify(cited), authoring, outline);
    expect(exact.sourceIssues).toEqual([]);
    expect(exact.displayItems.find((item) => item.id === 'annotation')?.sourceEvidenceIds).toBeUndefined();
    const rewritten = { ...cited, displayItems: cited.displayItems.map((item) => item.id === 'annotation'
      ? { ...item, text: '先判断，再观察' } : item) };
    expect(prepareNativeLectureResponse(JSON.stringify(rewritten), authoring, outline).sourceIssues)
      .toContain('Missing adopted evidence for annotation');
    const uncited = { ...cited, displayItems: cited.displayItems.map((item) => item.id === 'measure'
      ? { ...item, sourceEvidenceIds: undefined } : item) };
    expect(prepareNativeLectureResponse(JSON.stringify(uncited), authoring, outline).sourceIssues)
      .toContain('Missing adopted evidence for measure');
  });

  it('keeps planned image placeholders for resource binding while attaching only concrete bytes to vision', async () => {
    const outline = page();
    outline.mediaGenerations = [{ type: 'image', elementId: 'gen_img_planned', prompt: '观察示例', aspectRatio: '4:3' }];
    const media = await nativeLectureImages(outline, {});
    expect(media.imageMapping.gen_img_planned).toBe('gen_img_planned');
    expect(media.visionImageMapping).toEqual({});
    const bytes = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS0AAAAASUVORK5CYII=';
    const hydrated = await nativeLectureImages(outline, { assignedImages: [{ id: 'source', src: bytes, pageNumber: 1 }],
      imageMapping: { source: '/api/uploads/protected-figure' } });
    expect(hydrated.imageMapping.source).toBe('/api/uploads/protected-figure');
    expect(hydrated.visionImageMapping.source).toBe(bytes);
    expect(hydrated.visionImageMapping).not.toHaveProperty('gen_img_planned');
  });

  it('places missing source attribution in clear image-column space without covering its explanation', async () => {
    const figure: PPTImageElement = { id: 'figure', type: 'image', left: 550, top: 156, width: 400, height: 278,
      rotate: 0, src: 'data:image/png;base64,source', fixedRatio: true };
    const explanation: PPTTextElement = { ...title, id: 'figure-explanation', textType: undefined,
      left: 550, top: 440, width: 400, height: 44, content: '<p style="font-size:16px">图示说明</p>' };
    const input = { elements: [{ ...title, width: 420 }, figure, explanation] };
    const before = structuredClone(input);
    const result = await retainNativeSourceCaptions(input, [{ id: 'figure', src: figure.src,
      pageNumber: 1, sourceTitle: '教材', description: '' }], measure);
    const caption = result.elements.find((element) => element.id === 'figure-caption')!;
    expect(caption).toMatchObject({ left: 550, top: 104, width: 400, height: 46 });
    expect(result.qualityDiagnostics).toBeUndefined();
    expect(result.contentBindings).toContainEqual({ sourceContentId: 'image:figure:caption', elementId: 'figure-caption' });
    expect(input).toEqual(before);
    expect(result.elements.slice(0, 3)).toEqual(before.elements);
  });

  it('diagnoses a missing caption allocation while preserving the original picture and teaching text', async () => {
    const figure: PPTImageElement = { id: 'figure', type: 'image', left: 60, top: 210, width: 460, height: 267,
      rotate: 0, src: 'data:image/png;base64,source', fixedRatio: true };
    const definition = { ...title, id: 'definition', textType: undefined, top: 114, height: 68,
      content: '<p>完整定义</p>' };
    const explanation = { ...title, id: 'figure-explanation', textType: undefined, left: 60, top: 484,
      width: 460, height: 44, content: '<p>图示说明</p>' };
    const input = { elements: [title, definition, figure, explanation] };
    const result = await retainNativeSourceCaptions(input, [{ id: 'figure', src: figure.src,
      pageNumber: 2, sourceTitle: '教材', description: '' }], async () => ({ height: 68, naturalWidth: 440, lines: ['来源', '教材'] }));
    expect(result.qualityDiagnostics).toContainEqual(expect.stringContaining('no clear allocation'));
    expect(result.elements.slice(0, 4)).toEqual(input.elements);
  });

  it('binds an existing source caption with bibliographic punctuation without duplicating it', async () => {
    const figure: PPTImageElement = { id: 'figure', type: 'image', left: 550, top: 156, width: 400, height: 278,
      rotate: 0, src: 'data:image/png;base64,source', fixedRatio: true };
    const caption = { ...title, id: 'source-caption', textType: undefined, left: 550, top: 440, width: 400,
      height: 44, content: '<p style="font-size:16px">来源：《教材》，第1页</p>' };
    const result = await retainNativeSourceCaptions({ elements: [figure, caption] }, [{ id: 'figure', src: figure.src,
      pageNumber: 1, sourceTitle: '教材', description: '' }], measure);
    expect(result.elements).toHaveLength(2);
    expect(result.contentBindings).toContainEqual({ sourceContentId: 'image:figure:caption', elementId: 'source-caption' });
  });
});
