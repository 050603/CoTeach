import type { TeachingVisualComponent, TeachingVisualComponentKind, TeachingVisualScene, VisualEdge, VisualNode } from '../../packages/@openmaic/dsl/src/teaching-visual';
import type { SceneOutline } from '../../src/lib/openmaic/types/generation';

export type FrozenSlideSample = { composition: string; title: string; keyPoints: string[] };
export type VisualBenchmarkImage = { id: string; src: string; width: number; height: number; caption?: string };
export type VisualBenchmarkOutline = SceneOutline & { courseLanguageDirective?: string };
export type VisualBenchmarkCase = {
  id: string;
  kind: TeachingVisualComponentKind;
  sample: boolean;
  outline: VisualBenchmarkOutline;
  scene: TeachingVisualScene;
  images?: VisualBenchmarkImage[];
  source: { kind: 'course-snapshot' | 'fixed-benchmark'; title: string; reference: string; originalPageId?: string; rawKeyPoints?: string[]; note: string };
};

const sourceId = (index: number) => `adopted-content-${index + 1}`;
function node(id: string, label: string, text: string, sources: number[], extra: Partial<VisualNode> = {}): VisualNode {
  return { id, label, ...(text ? { text } : {}), sourceContentIds: sources.map(sourceId), ...extra };
}
function sequence(ids: string[]): VisualEdge[] {
  return ids.slice(1).map((to, index) => ({ from: ids[index], to, kind: 'sequence' }));
}
function component(id: string, kind: TeachingVisualComponentKind, nodes: VisualNode[], extra: Partial<TeachingVisualComponent> = {}): TeachingVisualComponent {
  return { id, kind, nodes, ...extra };
}
function outline(id: string, title: string, keyPoints: string[], focus: string, duration = 60): VisualBenchmarkOutline {
  return {
    id, title, keyPoints, description: focus, teachingObjective: focus, type: 'slide', order: 0,
    audience: 'student', generationPurpose: 'knowledge-teaching', estimatedDuration: duration, targetDurationSec: duration,
    courseLanguageDirective: /^[A-Za-z]/u.test(title) ? 'Use English for learner-facing text in this fixed benchmark. Preserve code, units and source qualifications.'
      : '本固定基准使用简体中文。保留必要标准符号、单位、代码与原始限定条件。',
    teachingBrief: {
      schemaVersion: 1, explanation: keyPoints.join('\n'), examples: [], conditions: [],
      evidence: keyPoints.map((quote) => ({ sourceId: `fixed-benchmark:${id}`, quote })), assessmentFocus: focus,
      teachingPlan: {
        purpose: focus, priorKnowledge: '', newContent: keyPoints.join('\n'), learnerQuestion: focus,
        reasoningSteps: keyPoints, takeaway: keyPoints.join('；'), visibleContent: keyPoints,
        presentationContent: keyPoints, narrationFocus: keyPoints,
      },
    },
  };
}
function scene(page: SceneOutline, focus: string, components: TeachingVisualComponent[]): TeachingVisualScene {
  return { schemaVersion: 1, designVersion: 'teaching-visual-v2', pages: [{ id: page.id, title: page.title, focus, components }] };
}
function illustration(id: string, body: string, width: number, height: number, caption: string): VisualBenchmarkImage {
  return { id, src: `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`).toString('base64')}`, width, height, caption };
}

/** Fixed diagram assets contain no factual text. Every label and exact value
 * is authored as an editable native PPT element by the visual compiler. */
const LEAF = illustration('leaf-diagram', '<rect width="640" height="400" fill="#f0fdfa"/><path d="M100 320C90 170 235 44 528 63C535 218 361 343 100 320Z" fill="#99d8b7" stroke="#17876c" stroke-width="5"/><path d="M96 328L504 80M197 258L198 148M264 225L279 112M330 180L345 84M196 258L303 302M264 225L389 263M330 180L444 213" fill="none" stroke="#17876c" stroke-width="4"/><circle cx="425" cy="280" r="65" fill="#fff" stroke="#17876c" stroke-width="3"/><ellipse cx="412" cy="282" rx="15" ry="35" fill="#b7e4c7" stroke="#17876c" stroke-width="3"/><ellipse cx="440" cy="282" rx="15" ry="35" fill="#b7e4c7" stroke="#17876c" stroke-width="3"/><path d="M351 202L386 240" fill="none" stroke="#64748b" stroke-width="2"/>', 640, 400, '代码绘制叶片示意图；不代表所有植物的精确解剖比例。');
const BILL = illustration('electricity-bill-diagram', '<rect x="125" y="30" width="390" height="340" rx="8" fill="#fff" stroke="#94a3b8" stroke-width="3"/><path d="M165 90H475M165 158H475M165 226H475M165 298H475" stroke="#cbd5e1" stroke-width="2"/><circle cx="458" cy="328" r="14" fill="#ccfbf1" stroke="#14b8a6" stroke-width="2"/>', 640, 400, '固定基准账单示意；用电量、单价及费用以原生文字叠加。');
const CODE = illustration('division-code-diagram', '<rect x="52" y="35" width="536" height="330" rx="10" fill="#eff6ff" stroke="#94a3b8" stroke-width="3"/><path d="M95 105H530M125 175H500M125 245H530M125 315H430" stroke="#bfdbfe" stroke-width="16" stroke-linecap="round"/><circle cx="75" cy="105" r="5" fill="#2563eb"/><circle cx="75" cy="175" r="5" fill="#2563eb"/><circle cx="75" cy="245" r="5" fill="#2563eb"/><circle cx="75" cy="315" r="5" fill="#2563eb"/>', 640, 400, '固定基准代码观察区；实际代码与条件以原生文字叠加。');

export function createTeachingVisualBenchmarkCases(samples: FrozenSlideSample[], original: VisualBenchmarkOutline, snapshotReference: string): VisualBenchmarkCase[] {
  const cases: VisualBenchmarkCase[] = [];
  function add(id: string, kind: TeachingVisualComponentKind, title: string, focus: string, components: TeachingVisualComponent[], options: { sample?: boolean; keyPoints?: string[]; images?: VisualBenchmarkImage[]; duration?: number; courseSource?: boolean } = {}) {
    const fixed = samples.find((sample) => sample.title === title);
    const points = options.keyPoints ?? fixed?.keyPoints;
    if (!points?.length) throw new Error(`缺少冻结基准原材料：${title}`);
    const page = outline(id, title, points, focus, options.duration);
    if (fixed) {
      // Display normalization may spell out an already supplied correspondence.
      // Narration and evidence continue to own the unchanged frozen material.
      page.teachingBrief!.explanation = fixed.keyPoints.join('\n');
      page.teachingBrief!.evidence = fixed.keyPoints.map((quote) => ({ sourceId: `fixed-benchmark:${id}`, quote }));
      page.teachingBrief!.teachingPlan!.newContent = fixed.keyPoints.join('\n');
      page.teachingBrief!.teachingPlan!.reasoningSteps = fixed.keyPoints;
      page.teachingBrief!.teachingPlan!.narrationFocus = fixed.keyPoints;
    }
    if (options.courseSource) {
      page.spatialParentId = original.id;
      page.sourcePageIds = [original.id];
      page.lectureSectionId = original.lectureSectionId;
      page.knowledgePointIds = original.knowledgePointIds;
      page.courseLanguageDirective = original.courseLanguageDirective ?? page.courseLanguageDirective;
      page.teachingBrief!.evidence = original.teachingBrief?.evidence ?? [];
    }
    if (options.images?.length) page.visualIntent = {
      observationGoal: focus, representation: 'source-image',
      resourceRefs: options.images.map((image) => ({ resourceId: image.id, kind: 'source-image', required: true, reason: '固定基准合法代码绘制资产', observationGoal: focus })),
    };
    cases.push({ id, kind, sample: options.sample ?? false, outline: page, scene: scene(page, focus, components), images: options.images,
      source: options.courseSource
        ? { kind: 'course-snapshot', title: '人工智能学科教师素养提升（第三章）', reference: snapshotReference, originalPageId: original.id, note: '第19页隔离来源副本；未修改原课堂、讲稿或音频。' }
        : { kind: 'fixed-benchmark', title: fixed?.title ?? title, reference: 'scripts/fixtures/first-pass-slide-samples.json', rawKeyPoints: fixed?.keyPoints,
          note: `固定基准示例，非教材原文；数据和图片均为明确标记的示例。${options.keyPoints && fixed ? '显示用语将原已给数字的对应关系规范化；原材料独立保留。' : ''}` },
    });
  }

  add('state-01-scaffolding', 'state-change', '支架随学生能力提升而逐步撤除', '定性示意：学生能力提升，支架逐个退出；不对应固定阶段或百分比。', [
    component('support-states', 'state-change', [
      node('needs-support', '需要支持', '暂时性：支架帮助跨越最近发展区', [0], { supportLevel: 'present' }),
      node('developing', '能力逐步提升', '渐消性：随着发展逐个撤除支架', [1], { supportLevel: 'fading' }),
      node('independent', '独立解决问题', '支架作用完成时撤离', [0], { supportLevel: 'withdrawn' }),
    ], { edges: sequence(['needs-support', 'developing', 'independent']) }),
    component('withdrawal-condition', 'text', [node('gradual', '逐个撤除', '不能等到最后一次性撤销', [1]), node('adaptive', '因学生而调整', '把握进入和退出时刻，适应不同学习水平和阶段', [2])]),
  ], { sample: true, courseSource: true, duration: 40, keyPoints: [
    '支架具有暂时性和渐消性，帮助学生穿过最近发展区；学生能独立解决问题时，支架作用完成，需要撤离。',
    '支架一个一个地随着学生发展而撤销，不能等到最后阶段一次性撤销。',
    '把握支架进入和退出时刻，根据学生不同学习水平和学习阶段调整支持。',
  ] });
  add('state-02-total', 'state-change', 'Trace a running total', 'Observe the accumulator after each addition; its value equals the sum processed so far.', [component('accumulator', 'state-change', [
    node('initial', 'total = 0', 'values = [3, 1, 4]', [0]), node('after-3', 'total = 3', 'After adding 3', [1]),
    node('after-1', 'total = 4', 'After adding 1', [0, 1]), node('after-4', 'total = 8', 'Sum of values processed so far', [1, 2]),
  ], { edges: sequence(['initial', 'after-3', 'after-1', 'after-4']) })]);
  add('state-03-invariant', 'state-change', 'An invariant in a loop', 'A valid invariant stays true across iteration; correctness also requires termination.', [component('invariant-states', 'state-change', [
    node('before', 'Before iteration', 'Initialization establishes the invariant', [0, 1]),
    node('after', 'After iteration', 'Maintenance preserves the invariant', [0, 1]),
    node('termination', 'Termination', 'Invariant + termination explain correctness', [2]),
  ], { edges: [{ from: 'before', to: 'after', kind: 'sequence', label: 'Execute one iteration' }, { from: 'after', to: 'before', kind: 'sequence', label: 'Continue' }, { from: 'after', to: 'termination', kind: 'sequence', label: 'Loop ends' }] })]);

  add('process-01-scaffolding', 'process', '支架式教学的五个环节', '五个环节的先后位置，独立探索中的支架渐退，以及评价主体与内容。', [
    component('five-steps', 'process', [
      node('c1', '搭脚手架', '结合学情、目标和主题\n按最近发展区建立概念框架、分层支架', [0]),
      node('c2', '进入情境', '引入贴近生活的问题；范例与问题分解', [1]),
      node('c3', '独立探索', '启发式引导 → 自主探索\n按学习水平给予时间、空间和个性化支架；随能力提升渐退', [2]),
      node('c4', '协作学习', '讨论交流、共享观点、相互启发\n调整并完善概念理解', [3]),
      node('c5', '效果评价', '主体：自评／小组互评／教师评价\n内容：自主学习能力／协作贡献／意义建构', [4]),
    ], { edges: sequence(['c1', 'c2', 'c3', 'c4', 'c5']) }),
  ], { sample: true, courseSource: true, duration: 57, keyPoints: [
    '搭脚手架：根据认知水平、目标和主题，制定符合最近发展区的概念框架，设计有层次的支架。',
    '进入情境：设计贴近学生生活的问题情境，提供范例支架并引导学生分解复杂问题。',
    '独立探索：启发式引导后给予时间和空间自主探索，按学习水平提供个性化支架，随能力提升逐渐减少、撤出支架。',
    '协作学习：组织讨论交流，共享观点并相互启发，调整和完善对概念的理解。',
    '效果评价：自我评价、小组互评和教师评价，围绕自主学习能力、协作贡献和知识意义建构展开。',
  ] });
  add('process-02-debug', 'process', 'Debugging a failing test', 'A failing regression returns to diagnosis; a passing check completes the same repair scope.', [component('debug-loop', 'process', [
    node('reproduce', 'Reproduce', 'Smallest relevant input', [0]), node('inspect', 'Inspect', 'Actual vs expected; first incorrect state', [1]),
    node('fix', 'Fix the cause', 'Rerun the failing test', [2]), node('related', 'Check regressions', 'Related tests pass', [2]),
  ], { edges: [{ from: 'reproduce', to: 'inspect', kind: 'sequence' }, { from: 'inspect', to: 'fix', kind: 'sequence' }, { from: 'fix', to: 'related', kind: 'sequence', label: 'Pass' }, { from: 'fix', to: 'inspect', kind: 'sequence', label: 'Still fails' }] })]);
  add('process-03-investigation', 'process', '科学探究的证据链', '先明确可检验假设，记录受控观察，再依据数据评价假设并开展下一轮验证。', [component('investigation-loop', 'process', [
    node('question', '问题与假设', '说明哪些结果支持或反驳假设', [0]), node('measure', '控制与测量', '改变自变量；记录因变量；多次测量', [1]),
    node('evaluate', '评价假设', '依据数据；公开局限', [2]), node('next', '下一轮验证', '提出下一轮验证', [2]),
  ], { edges: sequence(['question', 'measure', 'evaluate', 'next']).concat([{ from: 'next', to: 'question', kind: 'sequence' }]) })]);

  add('causal-01-greenhouse', 'causal', '温室效应的因果关系', '短波入射、地表红外辐射与温室气体吸收再发射共同影响能量平衡。', [component('radiation', 'causal', [
    node('sun', '太阳短波辐射', '使地表升温', [0]), node('surface', '地表红外辐射', '地表向外发出红外辐射', [0]),
    node('gases', '温室气体', '吸收并再发射部分红外辐射', [1]), node('balance', '能量平衡改变', '其他条件相近时，浓度增加促使地表变暖', [1, 2]),
  ], { edges: [{ from: 'sun', to: 'surface', kind: 'cause' }, { from: 'surface', to: 'gases', kind: 'cause' }, { from: 'gases', to: 'balance', kind: 'cause', label: '影响向太空散失速率' }] })], { sample: true });
  add('causal-02-food-web', 'causal', '食物网中的能量传递', '箭头由被取食者指向取食者；不同捕食路径各自完整，能量逐级减少。', [component('food-web', 'causal', [
    node('grass', '草', '生产者', [0]), node('rabbit', '兔', '取食草', [0]), node('grasshopper', '蚱蜢', '取食草', [0]), node('eagle', '鹰', '捕食兔', [0]),
  ], { edges: [{ from: 'grass', to: 'rabbit', kind: 'cause' }, { from: 'grass', to: 'grasshopper', kind: 'cause' }, { from: 'rabbit', to: 'eagle', kind: 'cause' }] }),
  component('food-web-reading', 'text', [node('direction', '能量传递方向', '被取食者 → 取食者；能量逐级减少，不是循环', [1, 2])])]);
  add('causal-03-queue', 'causal', 'Demand, latency, and queue length', 'When arrivals exceed completion capacity, queues grow and waiting time increases.', [component('queue-mechanism', 'causal', [
    node('arrivals', 'Arrivals > completions', 'Pending work accumulates', [0]), node('queue', 'Longer queue', 'More waiting before processing', [1]),
    node('capacity', 'Stabilize the queue', 'Increase capacity or reduce arrivals', [2]), node('retries', 'Retries', 'Add arrivals', [2]),
  ], { edges: [{ from: 'arrivals', to: 'queue', kind: 'cause' }, { from: 'capacity', to: 'arrivals', kind: 'cause', label: 'Rebalance' }, { from: 'retries', to: 'arrivals', kind: 'cause' }] })]);

  add('structure-01-ecosystem', 'structure', '生态系统的组成层级', '整体包含生物部分和非生物环境；分类关系不表示食物链顺序。', [component('ecosystem', 'structure', [
    node('whole', '生态系统', '', [0]), node('living', '生物部分', '', [0], { parentId: 'whole' }), node('environment', '非生物环境', '阳光／水／温度', [0, 2], { parentId: 'whole' }),
    node('producer', '生产者', '', [1], { parentId: 'living' }), node('consumer', '消费者', '', [1], { parentId: 'living' }), node('decomposer', '分解者', '', [1], { parentId: 'living' }),
  ]), component('ecosystem-reading', 'text', [node('qualification', '分类层级', '不表示食物链顺序', [2])])], { sample: true });
  add('structure-02-energy', 'structure', '能量形式与实例', '表现形式的分类与能量大小排序分别表达；机械能进一步分为动能和势能。', [component('energy-taxonomy', 'structure', [
    node('energy', '能量形式', '分类，不是大小排序', [0, 2]), node('mechanical', '机械能', '', [0], { parentId: 'energy' }),
    node('thermal', '热能', '', [0], { parentId: 'energy' }), node('chemical', '化学能', '', [0], { parentId: 'energy' }), node('electric', '电能', '', [0], { parentId: 'energy' }),
    node('kinetic', '动能', '运动的小车', [1, 2], { parentId: 'mechanical' }), node('potential', '势能', '举高物体的重力势能', [1, 2], { parentId: 'mechanical' }),
  ])]);
  add('structure-03-tests', 'structure', 'A test suite hierarchy', 'Nesting organizes tests; it does not establish execution causality.', [component('test-hierarchy', 'structure', [
    node('suite', 'Test suite', 'Contains related groups', [0]), node('group', 'Group', 'Related test cases', [0], { parentId: 'suite' }),
    node('case', 'Test case', 'Input + operation + expected result', [1], { parentId: 'group' }), node('assertion', 'Assertions', 'Check observations; nesting is not causality', [2], { parentId: 'case' }),
  ])]);

  add('comparison-01-circuits', 'comparison', '串联与并联电路比较', '按照电流路径、电学量和断路影响对齐比较。', [component('circuits', 'comparison', [
    node('series-path', '一条路径', '', [0], { column: '串联', row: '电流路径' }), node('parallel-path', '多条支路', '', [0], { column: '并联', row: '电流路径' }),
    node('series-current', '各处电流相等', '', [1], { column: '串联', row: '电学量' }), node('parallel-voltage', '支路两端电压相等', '', [1], { column: '并联', row: '电学量' }),
    node('series-break', '可能全电路断路', '一个元件断开', [2], { column: '串联', row: '断路影响' }), node('parallel-break', '通常其他支路不受影响', '一条支路断开', [2], { column: '并联', row: '断路影响' }),
  ])]);
  add('comparison-02-cell', 'comparison', '有丝分裂与减数分裂', '相同维度下辨析分裂次数、细胞数量和染色体数变化。', [component('cell-division', 'comparison', [
    node('mitosis-count', '一次', '通常形成两个子细胞', [0], { column: '有丝分裂', row: '分裂与细胞' }), node('meiosis-count', '连续两次', '通常形成四个细胞', [1], { column: '减数分裂', row: '分裂与细胞' }),
    node('mitosis-chromosome', '通常不变', '', [2], { column: '有丝分裂', row: '染色体数' }), node('meiosis-chromosome', '减半', '服务于有性生殖', [2], { column: '减数分裂', row: '染色体数' }),
  ])]);
  add('comparison-03-python', 'comparison', 'Lists and sets in Python', 'Align duplicates and concrete use; retain the separate facts about list order and set indexing.', [component('list-set', 'comparison', [
    node('list-duplicates', 'Duplicates allowed', '', [0], { column: 'list', row: 'Values' }), node('set-unique', 'Unique values', '', [1], { column: 'set', row: 'Values' }),
    node('list-use', 'Sequence of events', '', [2], { column: 'list', row: 'Use' }), node('set-use', 'Deduplicate student IDs', '', [2], { column: 'set', row: 'Use' }),
    node('list-order', 'List: insertion order', 'Preserved', [0]), node('set-indexing', 'Set: positional indexing', 'Not promised', [1]),
  ])], { sample: true });

  add('image-01-leaf', 'annotated-image', '标注植物叶片的结构功能', '定位叶脉、叶肉与气孔，并观察各自功能；示意不代表精确解剖比例。', [component('leaf-annotations', 'annotated-image', [
    node('vein', '叶脉', '支撑与物质运输；不是光能来源', [0], { anchor: { x: 0.38, y: 0.55 } }),
    node('mesophyll', '叶肉', '含叶绿体的细胞进行光合作用', [1], { anchor: { x: 0.59, y: 0.28 } }),
    node('stoma', '气孔', '参与气体交换和蒸腾调节；比例示意', [2], { anchor: { x: 0.66, y: 0.70 } }),
  ], { resourceId: LEAF.id })], { sample: true, images: [LEAF] });
  add('image-02-bill', 'annotated-image', '标注电费单中的关键信息', '把用电量、单价及费用定位到示例账单；明确未计其他计费规则。', [component('bill-annotations', 'annotated-image', [
    node('consumption', '120 kWh', '用电量：累计消耗的电能', [0, 1], { anchor: { x: 0.35, y: 0.29 } }),
    node('price', '0.50 元/kWh', '单价：将电能换算为费用', [0, 1], { anchor: { x: 0.35, y: 0.47 } }),
    node('fee', '60 元', '120 × 0.50 = 60；未计阶梯价与附加费用', [0, 2], { anchor: { x: 0.35, y: 0.65 } }),
  ], { resourceId: BILL.id })], { images: [BILL] });
  add('image-03-code', 'annotated-image', 'Annotate a safe division function', 'The zero-divisor guard runs before division; the example does not validate input types.', [component('code-annotations', 'annotated-image', [
    node('signature', 'def divide(a, b):', '', [0], { anchor: { x: 0.45, y: 0.26 } }),
    node('guard', 'if b == 0:', "raise ValueError('zero divisor')", [0, 1], { anchor: { x: 0.45, y: 0.44 } }),
    node('return', 'return a / b', 'Only if guard permits; no input type validation', [0, 2], { anchor: { x: 0.45, y: 0.75 } }),
  ], { resourceId: CODE.id })], { images: [CODE] });

  add('data-01-electricity', 'data', '教室用电数据解读', '示例数据描述变化；平均12 kWh，周三比周二高4 kWh，不能单独证明因果。', [component('electricity-chart', 'data', [
    node('values', '周一12／周二10／周三14 kWh', '示例数据', [0]), node('mean', '平均 12 kWh', '周三高于周二 4 kWh', [1]),
    node('boundary', '描述变化', '这些数据不能单独证明措施造成变化', [2]),
  ], { data: { chartType: 'bar', labels: ['周一', '周二', '周三'], series: [{ name: '示例耗电量', values: [12, 10, 14] }], unit: 'kWh' } })], { sample: true });
  add('data-02-seeds', 'data', '萌发实验数据', '两组温度光照相同；水分条件与萌发不同，结论限于本实验且需重复。', [component('germination-chart', 'data', [
    node('counts', '18/20 与 2/20', '示例种子实验：适量水／缺水', [0]), node('rates', '90% 与 10%', '两组温度与光照相同', [1]),
    node('limit', '支持水分影响萌发', '限于本实验；需重复并说明样本局限', [2]),
  ], { data: { chartType: 'bar', labels: ['适量水', '缺水'], series: [{ name: '示例萌发率', values: [90, 10] }], unit: '%' } })], { keyPoints: [
    '示例实验：适量水组萌发率90%（18/20粒）；缺水组萌发率10%（2/20粒）。',
    '萌发率分别为90%和10%，两组温度和光照条件相同。',
    '结果支持水分影响本实验种子的萌发；仍需重复实验并说明样本局限。',
  ] });
  add('data-03-timing', 'data', 'Reading a timing table', 'The observed mean differs under measured conditions; three observations do not establish all workloads.', [component('timing-chart', 'data', [
    node('times', 'A: 12, 11, 13 ms', 'B: 8, 9, 7 ms; example data', [0]), node('means', 'Means: A 12 ms; B 8 ms', 'Under measured conditions', [1]),
    node('limits', 'Only three observations', 'Report input size and environment; not all workloads', [2]),
  ], { data: { chartType: 'line', labels: ['1', '2', '3'], series: [{ name: 'A', values: [12, 11, 13] }, { name: 'B', values: [8, 9, 7] }], unit: 'ms' } })], { keyPoints: [
    'Example data: A, observation 1: 12 ms; A, observation 2: 11 ms; A, observation 3: 13 ms; B, observation 1: 8 ms; B, observation 2: 9 ms; B, observation 3: 7 ms.',
    'The mean times are 12 ms for A and 8 ms for B under the measured conditions.',
    'Three observations do not establish performance for all workloads; report input size and environment.',
  ] });

  add('worked-01-lights', 'worked-example', '计算更换灯具节电量', '由功率差推导每日节电，再推导月节电；两种灯具照明需求相同。', [component('saving-calculation', 'worked-example', [
    node('input', '60 W → 10 W', '20 盏，每天 5 h', [0]), node('day', '每日 5 kWh', '(60 − 10) ÷ 1000 × 20 × 5 = 5', [1]),
    node('month', '每月 150 kWh', '按30天计；照明需求相同', [2]),
  ], { edges: sequence(['input', 'day', 'month']) })], { sample: true });
  add('worked-02-density', 'worked-example', '用密度判断物体材料', '质量除以体积得到密度；与铝相近不能排除其他材料或测量误差。', [component('density-calculation', 'worked-example', [
    node('measurements', '54 g；20 cm³', '质量 m 与体积 V', [0]), node('density', '2.7 g/cm³', 'ρ = m / V = 54 / 20', [1]),
    node('interpretation', '与铝的常见密度相近', '仅凭密度不能排除其他材料或测量误差', [2]),
  ], { edges: sequence(['measurements', 'density', 'interpretation']) })]);
  add('worked-03-total', 'worked-example', 'Trace a running total', 'Trace additions and the invariant linking the accumulator to values already processed.', [component('total-trace', 'worked-example', [
    node('start', 'total = 0', 'values = [3, 1, 4]', [0]), node('additions', '0 + 3 = 3; 3 + 1 = 4', '4 + 4 = 8', [0, 1]),
    node('invariant', 'total = processed sum', 'The sum of values processed so far', [2]),
  ], { edges: sequence(['start', 'additions', 'invariant']) })]);
  if (cases.length !== 24 || cases.filter((item) => item.sample).length !== 8) throw new Error('教学图解基准应固定为24例及8个设计样板');
  for (const kind of ['state-change', 'process', 'causal', 'structure', 'comparison', 'annotated-image', 'data', 'worked-example']) {
    if (cases.filter((item) => item.kind === kind).length !== 3) throw new Error(`基准构件 ${kind} 必须恰有3例`);
  }
  return cases;
}
