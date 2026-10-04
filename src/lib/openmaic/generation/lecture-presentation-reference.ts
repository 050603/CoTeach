import type { PPTElement } from '@openmaic/dsl';

export const LECTURE_PRESENTATION_REFERENCE_VERSION = 'adopted-lecture-reference-v1' as const;

export type LecturePresentationPageKind = 'concept' | 'mechanism-case' | 'flow' | 'comparison';

export interface LecturePresentationMeasurements {
  /** Unicode characters, including punctuation, excluding markup and whitespace. */
  bodyCharacters: number;
  titleCharacters: number;
  bodyTextBlocks: number;
  labeledShapes: number;
  tableCells: number;
  tables: Array<{ rows: number; columns: number }>;
  images: number;
  connections: number;
  bodyFontSizesPx: number[];
  titleFontSizesPx: number[];
}

export interface LecturePresentationReference {
  kind: LecturePresentationPageKind;
  label: string;
  source: {
    classroomId: string;
    sceneId: string;
    outlineId: string;
    pageNumber: number;
    snapshotSha256: string;
  };
  /** Abstract teaching roles only: reference-course facts never enter a new lesson. */
  structure: readonly string[];
  composition: string;
  measurements: LecturePresentationMeasurements;
  narrationCharacters: number;
}

const THEORY_SOURCE = {
  classroomId: 'TXRyDLW0de-edit-7pyozR60',
  snapshotSha256: 'c103c16fa557df6180655a4b9279ed3a285fd7c6087b42f080a5a79a704aff4d',
} as const;
const COMPARISON_SOURCE = {
  classroomId: 'xrYxwhzlfX',
  snapshotSha256: '7e493d0539a7433f3533806dfd2db0d93dd8d6e6aa30708855a54bdae1d0901a',
} as const;

/**
 * Extracted from the two teacher-approved persisted classroom decks. Geometry
 * and source prose are deliberately absent: these are examples of organization,
 * not page templates, knowledge donors, or mandatory character/element quotas.
 * Images contribute to the composition but their pixels are not OCR-counted.
 */
export const LECTURE_PRESENTATION_REFERENCES: readonly LecturePresentationReference[] = [
  {
    kind: 'concept', label: '概念解释',
    source: { ...THEORY_SOURCE, sceneId: 'scene_BlN9eAaj_5', outlineId: 'teaching-section-1-page-1', pageNumber: 1 },
    structure: ['熟悉的观察或经验', '核心含义', '回答的问题与作用', '必要边界', '本页结论'],
    composition: '用标题、短入口、重点解释区和分组要点建立层级；关键词可强调，完整定义在确有观察需要时呈现。',
    measurements: {
      bodyCharacters: 222, titleCharacters: 10, bodyTextBlocks: 5, labeledShapes: 0,
      tableCells: 0, tables: [], images: 0, connections: 0, bodyFontSizesPx: [18], titleFontSizesPx: [32],
    },
    narrationCharacters: 350,
  },
  {
    kind: 'mechanism-case', label: '机制与案例',
    source: { ...THEORY_SOURCE, sceneId: 'scene_EzaR4NtbMC', outlineId: 'teaching-section-2-page-1', pageNumber: 5 },
    structure: ['机制的核心主张', '案例的必要事实', '可观察证据', '机制差异与结果', '解释性结论'],
    composition: '让案例图片与机制解释共享一页；在观察材料旁用对齐维度比较条件、作用和结果，详细故事由讲稿展开。',
    measurements: {
      bodyCharacters: 178, titleCharacters: 17, bodyTextBlocks: 3, labeledShapes: 0,
      tableCells: 12, tables: [{ rows: 4, columns: 3 }], images: 1, connections: 0,
      bodyFontSizesPx: [16, 18], titleFontSizesPx: [28],
    },
    narrationCharacters: 559,
  },
  {
    kind: 'flow', label: '流程与条件',
    source: { ...THEORY_SOURCE, sceneId: 'scene_IsGpopdMN2', outlineId: 'teaching-section-8-page-2', pageNumber: 22 },
    structure: ['流程的完整节点与真实连接', '流程的整体解释', '关键步骤的案例', '条件或调节依据', '评价依据'],
    composition: '流程为主要观察对象，用原生节点和真实连接表达；案例与条件在其旁侧或下方分组说明，保持步骤名称和顺序完整。',
    measurements: {
      bodyCharacters: 263, titleCharacters: 11, bodyTextBlocks: 4, labeledShapes: 5,
      tableCells: 0, tables: [], images: 0, connections: 4, bodyFontSizesPx: [16, 18, 20], titleFontSizesPx: [32],
    },
    narrationCharacters: 373,
  },
  {
    kind: 'comparison', label: '共同维度对比',
    source: { ...COMPARISON_SOURCE, sceneId: 'scene_GAzL830ho2', outlineId: 'teaching-section-2-page-1', pageNumber: 3 },
    structure: ['比较对象与核心关系', '共同维度', '各对象对应事实', '由事实推出的差异与结论'],
    composition: '短核心说明配原生对比表；列对应比较对象，行对应共同维度，条件与后果在对应单元格或有实际意义的总结行表达。',
    measurements: {
      bodyCharacters: 403, titleCharacters: 22, bodyTextBlocks: 1, labeledShapes: 0,
      tableCells: 16, tables: [{ rows: 6, columns: 3 }], images: 0, connections: 0,
      bodyFontSizesPx: [16], titleFontSizesPx: [32],
    },
    narrationCharacters: 466,
  },
];

export function selectLecturePresentationReferences(
  pageKind?: LecturePresentationPageKind,
): readonly LecturePresentationReference[] {
  return pageKind
    ? LECTURE_PRESENTATION_REFERENCES.filter((reference) => reference.kind === pageKind)
    : LECTURE_PRESENTATION_REFERENCES;
}

/** Shared by blueprint and native-slide prompts; numbers remain diagnostics. */
export function formatLecturePresentationReference(options: {
  pageKind?: LecturePresentationPageKind;
  audience?: 'blueprint' | 'slide';
} = {}): string {
  return [
    '## 已认可讲授课件的表达参考',
    'PPT 是课堂视觉辅助，不是完整阅读文本，也不是缩短后的讲稿。让学生能够扫读核心含义、层级、共同比较维度、必要观察事实与真实流程；概念文案应给出区别特征，不能只剩名称或问题，但不需要完整定义原句和口头展开。',
    '参考两门已认可课程在 1000×562.5 画布上的组织方式：普通正文通常 18px，紧凑正文与表格 16px，标题通常 28–32px；字号与容量以本页采用的统一计量合同为准。浅色重点区、深蓝标题、深灰正文、清楚的分组与选择性粗体构成同一套课件风格；只对决定理解的区别或条件少量使用暖色，不把所有对象标题与正文关键词统一标蓝。',
    '讲授页承载一个完整认识，可共同展示核心含义、相关案例、必要条件、对照或完整流程。内容相关且可读时保持同页，避免按术语或口播段落机械切页，也不为留白增加切换；留白服务分组与阅读，不成为删去已采纳说明或只剩一句话的理由。页面停留随原讲稿推进，不改变小节、教学顺序、讲稿或测验设置，不人为增加等待时间。',
    options.audience === 'slide'
      ? '使用本页已采用的展示目录选择原生可编辑构图，可按教学关系分组并强调关键词。展示目录已确定的命题与必要观察材料须呈现；不要从解释节点或资料追加未选入展示目录的整段文字。'
      : '在同一次设计中分别写完整教学正文和独立展示文案，并将展示项关联到实际解释节点。先依据本页教学关系选择核心认识与必要观察材料，再撰写适合构图的展示文案，不按节点正文逐句摘录。',
    '完整资料事实由完整教学正文与实际讲稿落实，不等于全部上屏。PPT 选择学生需要看见的核心认识与必要观察材料；对所选命题保留准确的事实、数量、单位、否定、程度、必要条件和真实关系。只有教学任务明确要求阅读完整原文或辨析定义措辞时，才展示完整定义；引入概念或比较概念不自动触发完整定义上屏。定义展开、解释推理、故事与自然过渡由讲稿承担。',
    '解释节点引用表示展示文案的来源，不表示该节点每句话都必须上屏，也不要求每个节点各摘一段。展示角色用于组织课堂认识：heading 写分组、比较对象或维度小标题，key-point 写一个核心认识或一个要素的名称与作用，comparison 写共同维度下一个对象的对应事实，process-label 写实际步骤标签，case-observation 写学生需要观察的事实或问题提示。比较双方的事实各自成为独立展示项，便于分别绑定表格单元；需逐项观察的要素各写独立展示项，便于各自成框。角色不是分段讲稿；不用多个串联解释句构成 key-point，也不把完整段落拆成多个 key-point 继续照读。',
    '页面文字职责以本页独立 presentationItems／展示目录为准。visualRelationship 描述需要看懂的语义关系与阅读顺序，不是额外展示目录；rationale 或 readingOrder 中的“完整定义”“完整含义”“整句命题”等旧表述，不自动增加完整原句的上屏义务，也不固定成三个定义段落。需要完整阅读的明确教学任务仍须落实。新蓝图的 rationale 与 readingOrder 应说明当前核心展示怎样帮助理解，不以逐段读定义代替构图理由。',
    '按当前展示角色和实际关系选择分组：核心含义可形成文字层级，共同维度用原生表格对齐；并列要素需要逐项观察时各自使用有名称与必要作用的分组框。真实流程的完整阶段与先后位置需要整体观察时使用原生流程图，顺序本身足以支持图示，不要求另有分支或反馈。statement／text 允许原生可编辑的文字分组与重点层级，不代表单栏、一节点一框或三个完整段落，也不要求所有 statement 页改成表格。选择性强调区别特征与必要条件，可用红色与粗体建立关键词层级。保留原有语义关系、必要观察对象及图示的全部节点、真实连接与分支条件；阅读顺序不能变成新流程边，概念层级不能变成必经时间步骤。',
    '资料 ⇒ 展示的抽象角色示例（占位符只示范组织方法，必须换成本课真实事实，不得作为课程知识输出）：',
    '- 概念：资料解释“概念甲的构成、区别与适用条件，并展开为什么有效” ⇒ 核心含义｜构成与区别；适用条件｜原有条件；作用｜核心关系。理由与展开进讲稿，不能把每个概念写成完整解释段。',
    '- 比较：资料分别介绍对象甲、对象乙的作用、条件与结果 ⇒ 按“共同维度—对象甲—对象乙”对齐，只采用资料支持的维度，单元格写对应核心事实，不重复两段定义再比较。',
    '- 流程：资料给出完整步骤名、真实顺序与分支条件，并逐步解释 ⇒ 实际步骤名与真实连接作为主体；分支保留原条件，不改成全部必经；步骤展开进讲稿。',
    '- 案例：资料叙述 N 个对象在条件 C 下出现现象 R，并作长篇分析 ⇒ 观察对象｜N 个及必要特征；条件｜C；观察结果｜R；认识｜由观察支持的结论。数量、否定与条件保留，故事和推理进讲稿。',
    ...selectLecturePresentationReferences(options.pageKind).map((reference) =>
      `- ${reference.label}：${reference.structure.join(' → ')}。${reference.composition} 代表页诊断：可见正文 ${reference.measurements.bodyCharacters} 字符，讲稿 ${reference.narrationCharacters} 字符。`),
    '上述角色是可选的组织示例，不要求每页全部出现，不设每类页的配额，不把旧课的知识或流程连接用于当前资料。数量差异来自观察任务与必要材料，字符数只帮助比较同类型页，不能成为硬上限、最低填充量、删内容或额外分页的依据。',
    '根据当前知识关系选择文字层级、图文分栏、完整流程或对齐比较；保留需要学生直接观察的公式、步骤、比较对象、案例条件与教材图片。教材编号名称与真实流程须完整可观察，已在保留图示中清楚呈现的内容无需再抄成长段；步骤的口头展开由讲稿承担。讲稿长度不直接增加页面文字或决定拆页；可读的精炼展示文案必须包含实际认识，不能退成孤立词条。',
  ].join('\n');
}

function visibleCharacters(html: string): string {
  const named: Record<string, string> = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    ndash: '–', mdash: '—', hellip: '…', times: '×', ne: '≠', le: '≤', ge: '≥',
  };
  return html.replace(/<[^>]*>/gu, '')
    .replace(/&([a-z]+);/giu, (match, entity: string) => named[entity.toLowerCase()] ?? match)
    .replace(/&#(x[\da-f]+|\d+);/giu, (match, entity: string) => {
      const value = /^x/iu.test(entity) ? parseInt(entity.slice(1), 16) : Number(entity);
      return value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    }).replace(/\s+/gu, '');
}

function fontSizes(html: string): number[] {
  return [...html.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/giu)].map((match) => Number(match[1]));
}

/**
 * Read-only, portable diagnostics for actual native elements. This intentionally
 * returns no pass/fail or density target, and does not accept narration as page
 * content. Renderer layout and teaching/source acceptance still own feasibility.
 */
export function measureLecturePresentationPage(input: {
  title: string;
  elements: readonly PPTElement[];
}): LecturePresentationMeasurements {
  const result: LecturePresentationMeasurements = {
    bodyCharacters: 0, titleCharacters: 0, bodyTextBlocks: 0, labeledShapes: 0,
    tableCells: 0, tables: [], images: 0, connections: 0, bodyFontSizesPx: [], titleFontSizesPx: [],
  };
  const title = visibleCharacters(input.title);
  for (const element of input.elements) {
    if ('opacity' in element && element.opacity === 0) continue;
    const html = element.type === 'text' ? element.content : element.type === 'shape' ? element.text?.content ?? '' : '';
    if (/(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu.test(html)) continue;
    if (element.type === 'text' || element.type === 'shape') {
      const text = visibleCharacters(html);
      if (!text) continue;
      if (element.type === 'text' && (element.textType === 'title' || text === title)) {
        result.titleCharacters += [...text].length;
        result.titleFontSizesPx.push(...fontSizes(html));
      } else {
        result.bodyCharacters += [...text].length;
        result.bodyFontSizesPx.push(...fontSizes(html));
        if (element.type === 'text') result.bodyTextBlocks += 1;
        else result.labeledShapes += 1;
      }
    } else if (element.type === 'table') {
      result.tables.push({ rows: element.data.length, columns: element.colWidths.length });
      for (const row of element.data) for (const cell of row) {
        const text = visibleCharacters(cell.text);
        result.bodyCharacters += [...text].length;
        result.tableCells += 1;
        const size = Number.parseFloat(String(cell.style?.fontsize ?? ''));
        if (Number.isFinite(size)) result.bodyFontSizesPx.push(size);
      }
    } else if (element.type === 'image') result.images += 1;
    else if (element.type === 'line') result.connections += 1;
  }
  result.bodyFontSizesPx = [...new Set(result.bodyFontSizesPx)].sort((a, b) => a - b);
  result.titleFontSizesPx = [...new Set(result.titleFontSizesPx)].sort((a, b) => a - b);
  return result;
}
