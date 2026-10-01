import { describe, expect, it } from 'vitest';
import type { PPTElement, PPTTextElement } from '@openmaic/dsl';
import type { TextMeasure } from '@openmaic/generation';
import { buildTeachingBlueprintPrompt } from '@/lib/course-design/teaching-blueprint';
import type { SceneOutline } from '../types/generation';
import { adoptedPageAuthoringContent } from './adopted-page-content';
import {
  buildNativeTextPlacementPlan,
  expandNativeTextPlacements,
  formatNativeTextPlacementPlan,
} from './native-text-placement';
import { generateOpenMaicBaselineContent } from './openmaic-baseline';
import { REFERENCE_LECTURE_TYPOGRAPHY } from './slide-presentation-typography';
import {
  formatLecturePresentationReference,
  LECTURE_PRESENTATION_REFERENCES,
  measureLecturePresentationPage,
  selectLecturePresentationReferences,
} from './lecture-presentation-reference';

function text(id: string, content: string, extra: Partial<PPTTextElement> = {}): PPTTextElement {
  return {
    id, type: 'text', left: 60, top: 150, width: 880, height: 100, rotate: 0,
    content, defaultFontName: 'Noto Sans SC', defaultColor: '#334155', ...extra,
  };
}

describe('approved lecture presentation references', () => {
  it('selects distinct semantic compositions without inserting reference-course facts', () => {
    const prompt = formatLecturePresentationReference();
    expect(selectLecturePresentationReferences().map((reference) => reference.kind))
      .toEqual(['concept', 'mechanism-case', 'flow', 'comparison']);
    expect(new Set(LECTURE_PRESENTATION_REFERENCES.map((reference) => reference.composition)).size).toBe(4);
    expect(prompt).toContain('独立展示文案');
    expect(prompt).toContain('字符数只帮助比较同类型页');
    expect(prompt).toContain('不能成为硬上限');
    expect(prompt).toContain('不把旧课的知识或流程连接用于当前资料');
    for (const sourceFact of ['建构主义', '同化', '顺应', '小鱼', '新加坡', '美国', '传感器']) {
      expect(prompt).not.toContain(sourceFact);
    }
  });

  it('offers the relevant page example while preserving the adopted display propositions', () => {
    const prompt = formatLecturePresentationReference({ pageKind: 'comparison', audience: 'slide' });
    expect(selectLecturePresentationReferences('comparison')).toHaveLength(1);
    expect(prompt).toContain('共同维度对比');
    expect(prompt).not.toContain('代表页诊断：可见正文 222');
    expect(prompt).toContain('展示目录已确定的命题与必要观察材料须呈现');
    expect(prompt).toContain('不要从解释节点或资料追加未选入展示目录的整段文字');
    expect(prompt).toContain('对所选命题保留准确的事实、数量、单位、否定、程度、必要条件和真实关系');
    expect(prompt).toContain('公式、步骤、比较对象、案例条件与教材图片');
    expect(prompt).toContain('讲稿长度不直接增加页面文字或决定拆页');
  });

  it.each(['blueprint', 'slide'] as const)('separates complete teaching from selected display for %s authoring', (audience) => {
    const prompt = formatLecturePresentationReference({ audience });
    expect(prompt).toContain('完整资料事实由完整教学正文与实际讲稿落实，不等于全部上屏');
    expect(prompt).toContain('不表示该节点每句话都必须上屏');
    expect(prompt).toContain('不要求每个节点各摘一段');
    expect(prompt).toContain('heading 写分组小标题，key-point 写核心结论');
    expect(prompt).toContain('comparison 写共同维度下的对应事实');
    expect(prompt).toContain('process-label 写实际步骤标签');
    expect(prompt).toContain('case-observation 写学生需要观察的事实或问题提示');
    expect(prompt).toContain('角色不是分段讲稿');
    expect(prompt).toContain('教材编号名称与真实流程须完整可观察');
    expect(prompt).toContain('已在保留图示中清楚呈现的内容无需再抄成长段');
    expect(prompt).toContain('不能成为硬上限、最低填充量');
    expect(prompt).not.toContain('保持所有已采用事实');
  });

  it.each(['blueprint', 'slide'] as const)('requires scan-friendly core meaning rather than three narrated definitions for %s', (audience) => {
    const prompt = formatLecturePresentationReference({ audience });
    expect(prompt).toContain('PPT 是课堂视觉辅助，不是完整阅读文本');
    expect(prompt).toContain('概念文案应给出区别特征，不能只剩名称或问题');
    expect(prompt).toContain('只有教学任务明确要求阅读完整原文或辨析定义措辞时，才展示完整定义');
    expect(prompt).toContain('引入概念或比较概念不自动触发完整定义上屏');
    expect(prompt).toContain('不用多个串联解释句构成 key-point');
    expect(prompt).toContain('不把完整段落拆成多个 key-point 继续照读');
    expect(prompt).toContain('资料 ⇒ 展示的抽象角色示例');
    expect(prompt).toContain('占位符只示范组织方法，必须换成本课真实事实');
    expect(prompt).toContain('核心含义｜构成与区别');
    expect(prompt).toContain('共同维度—对象甲—对象乙');
    expect(prompt).toContain('实际步骤名与真实连接作为主体');
    expect(prompt).toContain('分支保留原条件，不改成全部必经');
    expect(prompt).toContain('观察对象｜N 个及必要特征；条件｜C；观察结果｜R');
    expect(prompt).toContain('对所选命题保留准确的事实、数量、单位、否定、程度、必要条件和真实关系');
  });

  it.each(['blueprint', 'slide'] as const)('keeps relationship metadata from reinstating full definition paragraphs for %s', (audience) => {
    const prompt = formatLecturePresentationReference({ audience });
    expect(prompt).toContain('页面文字职责以本页独立 presentationItems／展示目录为准');
    expect(prompt).toContain('visualRelationship 描述需要看懂的语义关系与阅读顺序，不是额外展示目录');
    expect(prompt).toContain('不自动增加完整原句的上屏义务，也不固定成三个定义段落');
    expect(prompt).toContain('新蓝图的 rationale 与 readingOrder 应说明当前核心展示怎样帮助理解');
    expect(prompt).toContain('statement／text 允许原生可编辑的文字分组与重点层级');
    expect(prompt).toContain('也不要求所有 statement 页改成表格');
    expect(prompt).toContain('需要完整阅读的明确教学任务仍须落实');
    expect(prompt).toContain('保留原有语义关系、必要观察对象及图示的全部节点、真实连接与分支条件');
    expect(prompt).toContain('阅读顺序不能变成新流程边，概念层级不能变成必经时间步骤');
  });

  it('passes core roles and representation freedom into a fresh blueprint request', () => {
    const prompt = buildTeachingBlueprintPrompt({
      courseTitle: '长度测量', subject: '数学', grade: '小学',
      learningObjectives: ['区分长度与长度单位'], projectContext: '',
      knowledgePoints: [
        { id: 'length', name: '长度', description: '描述距离', level: 'foundation' },
        { id: 'unit', name: '长度单位', description: '约定测量标准', level: 'core' },
      ],
      sourceContext: '长度描述距离，长度单位是约定的测量标准。',
      totalDurationSec: 600, assessmentMode: 'adaptive', generationMode: 'standard',
    });
    expect(prompt.system).toContain('authoringContract 固定为 blueprint-v5');
    expect(prompt.system).toContain(formatLecturePresentationReference({ audience: 'blueprint' }));
    expect(prompt.system).toContain('comparison 写共同维度下的对应事实');
    expect(prompt.system).toContain('不以逐段读定义代替构图理由');
    expect(prompt.system).toContain('核心含义可形成文字层级，共同维度可并排对齐');
    expect(prompt.system).toContain('preferredForm 是教学表达偏好，不是强制模板');
  });

  it('keeps measurable provenance from both approved course files', () => {
    expect(new Set(LECTURE_PRESENTATION_REFERENCES.map((reference) => reference.source.classroomId)))
      .toEqual(new Set(['TXRyDLW0de-edit-7pyozR60', 'xrYxwhzlfX']));
    for (const reference of LECTURE_PRESENTATION_REFERENCES) {
      expect(reference.source.snapshotSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(reference.source.pageNumber).toBeGreaterThan(0);
      expect(reference.measurements.titleFontSizesPx.every((size) => size >= 28 && size <= 32)).toBe(true);
      expect(reference.narrationCharacters).toBeGreaterThan(reference.measurements.bodyCharacters);
    }
  });
});

describe('core display with saved statement metadata', () => {
  const oralDefinition = '这里是需要在讲稿中完整解释的权威定义、推理与适用边界，不能因旧阅读顺序再次追加到页面。';
  const items = [
    { text: '比较用途', nodeIds: ['a', 'b', 'c'], role: 'heading' as const },
    { text: '对象甲｜整理记录', nodeIds: ['a'], role: 'comparison' as const },
    { text: '对象乙｜独立检验', nodeIds: ['b'], role: 'comparison' as const },
    { text: '对象丙｜落实操作', nodeIds: ['c'], role: 'comparison' as const },
    { text: '关系｜各有用途，不能视为固定的时间步骤', nodeIds: ['a', 'b', 'c'], role: 'key-point' as const },
  ];
  function outline(): SceneOutline {
    return {
      id: 'core-concepts', type: 'slide', order: 0, title: '三种用途', description: '',
      generationPurpose: 'knowledge-teaching', keyPoints: items.map((item) => item.text),
      visualIntent: { representation: 'text', observationGoal: '看清三种用途及其并列关系' },
      teachingBrief: {
        schemaVersion: 1, explanation: oralDefinition, examples: [], conditions: [], evidence: [], assessmentFocus: '区分用途',
        teachingPlan: {
          purpose: '辨认核心含义', priorKnowledge: '', newContent: oralDefinition, learnerQuestion: '',
          reasoningSteps: [], takeaway: '按用途区分', visibleContent: items.map((item) => item.text),
          narrationFocus: [oralDefinition], presentationContent: items.map((item) => item.text),
          presentationItems: items, presentationTypography: REFERENCE_LECTURE_TYPOGRAPHY,
          visualRelationship: {
            kind: 'statement', preferredForm: 'text', description: '看清三种用途及其并列关系',
            rationale: '三个定义各是一句完整命题，不能画成必经步骤。',
            readingOrder: ['先看三个名称', '再看每个名称对应的完整含义', '最后看关系'],
          },
        },
      },
    };
  }
  const measure: TextMeasure = (input) => ({
    height: input.fontSize * 1.5 + 20, naturalWidth: input.text.length * input.fontSize, lines: [input.text],
  });

  it('uses only core catalog points, retains roles and allows grouped references without inventing process edges', async () => {
    const page = outline();
    const originalRelationship = structuredClone(page.teachingBrief!.teachingPlan!.visualRelationship);
    const points = adoptedPageAuthoringContent(page);
    const plan = await buildNativeTextPlacementPlan(page, points, { measure });
    expect(plan.points.map((point) => point.text)).toEqual(items.map((item) => item.text));
    expect(plan.flexibleComposition).toBe(true);
    expect(plan.comparisonRows).toBeUndefined();
    expect(plan.presentationRoles?.map(({ role, nodeIds }) => ({ role, nodeIds })))
      .toEqual(items.map(({ role, nodeIds }) => ({ role, nodeIds })));
    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(plan.candidates.every((candidate) => candidate.connectors.length === 0)).toBe(true);
    expect(formatNativeTextPlacementPlan(plan)).toContain('rather than compulsory one-item/one-box placements');
    const draft = JSON.stringify({ elements: [], components: [{ kind: 'textBox', id: 'group',
      paragraphRefs: points.map((point) => point.id), left: 50, top: 140, width: 900, fontSize: 18 }] });
    expect(expandNativeTextPlacements(draft, plan)).toBe(draft);
    expect(JSON.stringify(plan.candidates)).not.toContain(oralDefinition);
    expect(page.teachingBrief!.teachingPlan!.visualRelationship).toEqual(originalRelationship);
  });

  it('supplies the priority rule to actual native authoring and compiles independent core text from a single mocked response', async () => {
    const page = outline();
    const points = adoptedPageAuthoringContent(page);
    let calls = 0;
    const content = await generateOpenMaicBaselineContent(page, async (system, user) => {
      calls += 1;
      expect(system).toContain(formatLecturePresentationReference({ audience: 'slide' }));
      expect(system).toContain('不自动增加完整原句的上屏义务，也不固定成三个定义段落');
      expect(system).toContain('rather than compulsory one-item/one-box placements');
      expect(user).toContain('每个名称对应的完整含义');
      expect(user).toContain('do not derive, rewrite, shorten or expand them again');
      expect(user).not.toContain('Required measured placement for this first response');
      return JSON.stringify({ elements: [], components: [
        { kind: 'textBox', id: 'title', role: 'title', text: page.title,
          left: 50, top: 50, width: 900, fontSize: 32, bold: true },
        { kind: 'textBox', id: 'group', role: 'body', paragraphRefs: points.map((point) => point.id),
          left: 50, top: 140, width: 900, fontSize: 18 },
      ] });
    }, { componentAuthoring: true, slideAuthoring: 'native', textMeasure: measure });
    expect(calls).toBe(1);
    expect(content).not.toBeNull();
    if (!content || !('elements' in content)) throw new Error('Expected native core display');
    const visible = content.elements.filter((element) => element.type === 'text')
      .map((element) => element.type === 'text' ? element.content.replace(/<[^>]*>/gu, '') : '').join('\n');
    for (const item of items) expect(visible).toContain(item.text);
    expect(visible).not.toContain(oralDefinition);
    expect(content.elements.every((element) => element.type === 'text')).toBe(true);
  });
});

describe('lecture page density diagnostics', () => {
  it('counts native table cells and shape labels separately from title and markup', () => {
    const elements: PPTElement[] = [
      text('title', '<p style="font-size:24px">共同维度</p>', { top: 50 }),
      text('body', '<p style="font-size:18px">条件：<b>至少</b> 2 项</p>'),
      {
        id: 'node', type: 'shape', left: 60, top: 300, width: 200, height: 60, rotate: 0,
        path: 'M 0 0 L 200 0 L 200 60 L 0 60 Z', viewBox: [200, 60], fixedRatio: false, fill: '#F1F5F9',
        text: { content: '<p style="font-size:20px">流程甲</p>', defaultFontName: 'Noto Sans SC', defaultColor: '#334155', align: 'middle' },
      },
      {
        id: 'table', type: 'table', left: 300, top: 300, width: 500, height: 120, rotate: 0,
        outline: { color: '#334155', width: 1, style: 'solid' }, colWidths: [0.5, 0.5], cellMinHeight: 40,
        data: [
          [{ id: 'c1', text: '对象', colspan: 1, rowspan: 1, style: { fontsize: '16px' } },
            { id: 'c2', text: '条件<br>不变', colspan: 1, rowspan: 1, style: { fontsize: '16px' } }],
          [{ id: 'c3', text: '结果', colspan: 2, rowspan: 1, style: { fontsize: '16px' } }],
        ],
      },
    ];
    expect(measureLecturePresentationPage({ title: '共同维度', elements })).toEqual({
      bodyCharacters: 18, titleCharacters: 4, bodyTextBlocks: 1, labeledShapes: 1,
      tableCells: 3, tables: [{ rows: 2, columns: 2 }], images: 0, connections: 0,
      bodyFontSizesPx: [16, 18, 20], titleFontSizesPx: [24],
    });
  });

  it('decodes displayed entities and excludes hidden text without treating speech metadata as content', () => {
    const elements = [
      text('body', '<p style="font-size:18px">A&nbsp;&amp;&#x4E2D;&#25991;😀</p>'),
      text('hidden-css', '<p style="display:none">完整长解释不计入页面</p>'),
      text('hidden-opacity', '<p>隐藏文本</p>', { opacity: 0 }),
    ];
    const scene = {
      title: '标题', elements,
      actions: [{ type: 'speech', text: '非常长的教材定义与口头展开'.repeat(100) }],
    };
    const measurements = measureLecturePresentationPage(scene);
    expect(measurements.bodyCharacters).toBe(5);
    expect(measurements.bodyTextBlocks).toBe(1);
    expect(measurements.titleCharacters).toBe(0);
    expect(measurements).not.toHaveProperty('passed');
    expect(measurements).not.toHaveProperty('targetCharacters');
  });
});
