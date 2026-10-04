import { parseJsonResponse, type AuthoringContentItem, type TextMeasure } from '@openmaic/generation';
import type { SlideContentBinding, SlidePresentationItem } from '@openmaic/dsl';
import type { GeneratedSlideContent, PdfImage, SceneOutline } from '../types/generation';
import { buildSlideDisplayAuthoringContext, deterministicProjectionIssues, projectionData } from './slide-visual-projection';
import { pagePresentationContent } from './adopted-page-content';
import { formatLecturePresentationReference } from './lecture-presentation-reference';
import { REFERENCE_LECTURE_STYLE, REFERENCE_LECTURE_TYPOGRAPHY } from './slide-presentation-typography';
import { normalizeNativeAuthoringEnvelope } from './native-authoring-envelope';
import { applyClassroomSlideAuthoringPolicy } from './classroom-slide-content-policy';
import { nativeSemanticBindingIssues } from './slide-semantic-hierarchy';
import { nativeDisplayFactItemIssues } from './native-display-fact-sets';

export const NATIVE_LECTURE_AUTHORING_VERSION = 'native-lecture-composition-v5-plain-sequence-rows';
export const NATIVE_LECTURE_OPERATION = 'PPT_NATIVE_LECTURE_V1';

/** Semantic page eligibility is separate from saved typography and layout. */
export function usesNativeLectureAuthoring(outline: SceneOutline): boolean {
  const plan = outline.teachingBrief?.teachingPlan;
  return outline.type === 'slide' && outline.audience !== 'teacher'
    && outline.generationPurpose === 'knowledge-teaching'
    && Boolean(plan?.presentationItems?.length || plan?.presentationContent?.length);
}

/** These examples describe composable visual roles, never curriculum facts or templates. */
const COMPOSITION_EXAMPLES = [
  '概念页：标题下可有一句入口认识；宽重点带承载核心含义，下面以不同占比呈现支持说明和实际条件；同一段中的概念名、区别和条件分别强调。重点带、并列说明、例子及底部提示可以共同出现，不要求每句话先写标签。',
  '比较页：共同维度作为行、实际对象作为列，浅蓝表头与白色表身保持对齐；表格旁可放观察图，必要背景在上方、已有结论在下方，区域按实际内容占比设计。不能用同等颜色的一组卡片代替对应关系。',
  '图示页：完整流程或关系图占一个局部区域；案例、条件和边界在旁边或下方组织，解释与节点就近。短流程可横向，长流程、循环或分支按真实拓扑选形状；不要把整页变成两个并排的同等文字框。',
];

export function nativeLectureAuthoringPrompt(outline: SceneOutline,
  context: ReturnType<typeof buildSlideDisplayAuthoringContext>['context']): string {
  const style = REFERENCE_LECTURE_STYLE;
  return [
    `## ${NATIVE_LECTURE_OPERATION}`,
    `本次是同一次 PPT 首稿创作：精炼展示文案并设计整页原生可编辑构图。协议版本 ${NATIVE_LECTURE_AUTHORING_VERSION}。以下页专属协议优先于通用文案、字号及示例要求。`,
    '只返回 JSON {background,displayItems,elements,components}。displayItems 是本次来源约束的展示文案；elements 是原生 text/shape/line/table/image/chart/latex/video，components 是可选局部 textBox/labelGrid/diagram。你负责整页构图的坐标、区域、比例、形状、阅读顺序、段内强调和混合表达；程序只测量与编译局部组件。没有 composition 模板、design 分组协议或强制 placementRef，不能返回 layout、items/design/links 代替原生页面。',
    'adoptedDisplayContent 指定本页已采纳的展示职责；原始资料和实际 owned 解释节点决定含义、条件与范围。允许在 displayItems 内合并重复表达、重组段落或精炼短句，保留每个来源 ID 的职责及所选事实、数量、否定、必要条件和真实关系。讲稿、推理展开、案例故事及过渡保持独立，不能逐句上屏，也不能新增课堂内容。不要按来源项数量机械决定框数量。',
    '精炼展示文案不能省略已采纳事实中的独立维度、对象、评价方面、数量或必要条件；并列列出的各项都承担事实含义，不能只保留其中几项或用总括词代替完整范围。允许缩短措辞、合并真正重复的表达，但不同维度不能因文字空间而合并丢失。填写了 sourceContentIds 或 diagramNodeId 不代表事实已经完整显示，实际正文仍须保留这些区别。',
    'requiredFactSets:[{sourceContentId,terms,acceptedForms?}] 是从本页已采纳短句提取的必要并列事实，每个 terms 都须保留在引用该 sourceContentId 的实际正文中；可用原名或已提供的 acceptedForms 短写，不以总括词或其他来源区域的同一个词代替该命题中的对象。它约束事实范围，不新增视觉分组、卡片或箭头，不扩大本页内容。请在同一次创作内核对每组完整后设计实际引用槽。',
    '用 sourceContentId 与 adoptedSourceBindings.nodeRefs 找到 teachingAuthoring.explanationNodes 的唯一 bodyRef，正文经 texts 解析；不要把规划标签当事实。教材事实、生成推断、案例假设和类比限制按实际来源保留，案例部分映射不等于整个概念的全部条件都被证明。已有 manuscript 表示实际讲稿已保存，本次不修改口播。',
    '首次创作先依据原文与 semanticGroups 区分集合、组成成员、原则、角色和支持资源，再设计整体构图。semanticGroups:[{id,label,sourceContentIds,members:[{id,label,sourceContentIds}]}] 只记录本页明确完整列举的真实集合，不是所有来源项的并列清单。保留每组的完整成员及名称；原则、角色或资源不能冒充集合成员，也不能用它们替换未单独展开的成员。没有这类明确集合时不新增集合归属。',
    'displayItems:[{id:string,sourceContentIds:string[],text:string,label?:string,emphasis?:string[],emphasisStyle?:"bold"|"color"|"highlight",sourceEvidenceIds?:string[],row?:string,column?:string,diagramNodeId?:string,semanticBindings?:{groupId:string,role:"overview"|"member"|"context",memberId?:string}[]}]。id 唯一，sourceContentIds 是 adoptedDisplayContent 的精确 ID 数组；有 adoptedEvidenceIds 时每项填写实际证据 ID。text 写能独立读懂的实际认识；label 只用于需要单独观察的真实对象或概念，不是必填。比较正文项同时填写 row=维度名、column=对象名；表头通过正文项的 :row/:column 引用，不另建只写行列名称的展示项。row/column 是字符串，不是 true/false 标记；emphasis 是短片段数组，emphasisStyle 是一个枚举字符串。不要用“本页结论”等编辑标签，也不靠删冒号或空格换行模拟设计。',
    '与某个 semanticGroups 集合有关的展示项用 semanticBindings 标明实际归属：groupId 使用已提供的精确 ID；overview 声明该组名称、数量和范围；member 用 memberId 精确绑定该组合法成员并使用该成员真实 label，正文依据该成员提供的 sourceContentIds；context 是与该组相关的真实原则、角色或支持说明，不属于集合成员。一个项可有多个真实组的绑定，不凭词语相似猜归属。未独立展开成员时，完整成员可以共享一个清晰横列或段落的 overview 正文，保持各成员名称真实可读且完整同组，不强制拆成独立 item。独立展开成员说明或标签时，须保留相应 memberId 的真实归属；若展开区域已完整呈现全部成员，overview 可精炼为真实集合名称和数量，不必再次重抄所有成员名称，全集由展开区域的实际文字槽合计显示。',
    'semanticGroups 非空时，每个 displayItem 至少填写一条合法 semanticBindings，不允许只给概览绑定、让后面的成员或支持说明失去层级身份。多个集合分别使用各自的真实归属，不必把每项绑定到所有集合。context 仅区分页内周边说明与成员身份，不表示新增因果、顺序或组成关系。',
    '实际画面必须体现这些层级：同辈形式只用于真实同组同层的内容；完整成员围绕共同组标题或区域呈现，context 放在不同区域或以清晰主次区分。不能只填写 semanticBindings，却把成员、原则、角色和支持资源继续混列为一组同款框。横列、段落、分组等均可，成员数量不规定卡片数量或固定模板；没有真实顺序、因果或其他明确关系时不加箭头。',
    '一旦选择独立展开成员的视觉区域，该完整集合的每个成员都须在这个区域实际可辨，不能用 overview 中的完整名称掩盖下方少画的成员。原文没有独立解释不代表可以删除成员或少画成员：仍须以原声明来源呈现独立可辨的真实名字、contentRef 和 memberId；也可把有共同真实来源说明的成员放在一处组合，所有成员名字同等可读并保留各自 memberId。不能制造定义、把支持说明冒充成员，或加“资料未展开”等教师编辑提示补位；不要求每个成员单独一张卡，不固定卡片数量或坐标。',
    '每个 displayItem 的正文以 contentRef:"该item.id" 引用，多个正文可用 paragraphRefs 组合；label/row/column 分别可通过 contentRef:"item.id:label"、"item.id:row"、"item.id:column" 引用。引用放在 text 元素、shape.text、table.data 单元格或 components 的实际文字槽里，不能作为顶层覆盖清单。程序填入文字并测量，不需要在 content 中再复制整段。表格的 row=共同维度、column=实际对象；单元格只引用 item.id 的正文，表头和首列分别引用 column/row，不能把“维度｜对象：正文”整串放进一个单元格。',
    'paragraphRefs 表示真实独立段落，首次编译将各段填入原生 <p> 并按渲染器 paragraphSpace（默认5px）计量，保留段内原有换行、字号和强调，不会在段间插入 <br><br> 空行。设计共享正文槽时按全部段落总行高、段距及文字框四边10px padding 预留高度；段落数不能当作行数，粗体和窄栏产生的换行同样占空间。',
    '引用语法示例（只是槽结构，省略的几何与样式须自行设计）：text 元素 {"type":"text","contentRef":"point-a","content":"<p style=\\"font-size:18px;color:#334155\\"></p>"}；形状内部 {"type":"shape","text":{"contentRef":"point-a","content":"<p style=\\"font-size:18px\\"></p>"}}；表格实际单元格 {"id":"cell-a","contentRef":"point-a","text":"","colspan":1,"rowspan":1,"style":{"fontsize":16,"backcolor":"#FFFFFF"}}；测量组件 {"kind":"textBox","paragraphRefs":["point-a","point-b"],"fontSize":18}。每个正文槽必须有引用；content/text 只保留样式壳，不重复写一份未绑定正文。',
    '同一 displayItem 可在同一个真实文字区域中组合多个来源，或把同一含义分成几项；全部 items 必须有实际可见承载。必要的原始 diagram 节点与图注由局部 diagram 组件完整显示，对应解释用 diagramNodeId 绑定，不能重复创建另一套步骤。没有真实关系的并列要素用位置、名称与分组显示，不发明箭头。',
    ...(outline.visualIntent?.diagram?.annotation ? ['diagram-annotation 是这幅完整图示的原图注，使用一个专属 displayItem，text 保留提供的 diagram.annotation 全文，不把最后一句拆成另一处来代替完整图注。可以通过真实 contentRef 放在组件外的宽提示区，程序据实际绑定避免组件内部再次重复；也可在图示区域内预留其完整空间。逐字引用该完整已确认图注时，来源就是 diagram-annotation 的原始身份；sourceEvidenceIds 使用已提供的确切对应关系，缺少对应关系时不猜证据编号。改写或新增解释仍须提供实际证据。'] : []),
    'diagramNodeId 绑定解释所属节点，仍须用 contentRef/paragraphRefs 的真实文字槽显示解释正文。diagram 编译保留原始节点标签和拓扑；如果 displayItem.text 是定义、条件或较完整说明，必须真实呈现，并与相应图示就近组织。只有节点名称而没有本页必要解释不算完成展示。annotationRef 不是原生组件支持的引用槽；图注可直接使用已提供的原图注，解释仍通过真实正文槽引用。',
    ...(outline.visualIntent?.diagram?.topology === 'sequence' && !outline.visualIntent.diagram.sequenceGroups?.length ? [
      '每步都需要具体解释的单一线性流程，可考虑竖向流程行这一适配候选：左侧用编号和细连接线表达完整真实顺序，每行只出现一次完整步骤标题，与同排的具体正文就近对应。只有完整标题和每步正文都能获得足够横向空间、所有行能在真实字体下完整容纳时才选择；不能因 topology 是 sequence 或某个步骤数量就默认采用。节点标题由 canonical diagram 节点完整显示，displayItem.text 可省略与该节点标题完全重复的开头，直接写该步的事实、做法、条件或作用，并用 diagramNodeId 绑定到该节点。不要在上方另画一套流程标题，再在下方解释区域逐项重复这些标题；也不要在节点旁另设同名解释标题或重复编号。去重只针对同一步的标题，不删正文事实、必要条件、节点或真实关系，不把原始节点标签改成空串、纯编号或缩略词。',
      '选择竖向流程行时，先依据真实字体、字号和粗体计量核对完整标题的自然宽度，加上真实内边距；横向空间足够时让完整步骤标题保持单行，不要在有空间时因固定窄标题栏制造换行。按最长标题的实测宽度、每步解释的字数与实际换行共同分配编号区、标题列和正文列，不固定标题/正文的比例；每行可用一处浅色背景表达共同归属，但不是必需装饰。标题与正文共同构成该步的一个完整阅读区域，按实际文字行高和相同节点的墨迹中心安排对应关系；正文必须有足够行宽，按真实18px字体与10px内边距预留完整高度，不能靠缩字或狭长文字栏容纳。这是由模型在首次创作时按本页真实内容、关系和空间动态选择的候选，不是强制默认、整页固定模板、节点数对应的版式配额或编译失败后的自动重排；短流程、并列独立流程、分支和循环继续按其真实关系自由选择清晰构图，不增加模型修补调用。',
    ] : []),
    ...(outline.visualIntent?.diagram?.topology === 'sequence' ? ['当你选择 orientation:"vertical" 的 sequence，并将每个节点的一份独立解释放在图旁清晰的一一对应侧栏时，diagramNodeId 同时是本次首次编译的局部行对齐合同：编译器按真实绑定节点的中心，对齐相应解释的实际文字墨迹中心。创作时须按所选方向与样式的同一实测空间参考，为完整解释正文的高度和各行间距预留足够空间；解释侧栏、图示及相邻区域应共同容纳这一组行，不能另猜一套独立等距坐标，也不能把其他文字或图片放进对齐后需要的行空间。该合同不要求分支图、横向流程或合并多个节点的段落改成此布局；它们继续按真实关系设计构图，不能为了获得对齐而拆改事实或拓扑。'] : []),
    ...(outline.visualIntent?.diagram ? ['diagram 局部组件明确指定 orientation:"vertical"|"horizontal" 与 presentation:"cards"|"steps"；steps 仅用于真实 sequence，以简洁顺序节点、编号与细连接线表达。本次首稿请求中的完整空间参考按真实18px字体、方向、样式及图注范围分别测量。先为选定方向和样式选择同一条参考的完整 width/height，再设计图区及相邻解释，不能混用不同候选的尺寸或拿普通卡片、横向图的计量代替竖向 steps。某模式没有实测候选时不能把空列表当作已经容纳，也不能据此认定其他构图都不可用。你仍决定整页构图与实际坐标，参考不是固定页面模板。长流程应给标签足够行宽；steps 可以减少装饰与空白，但不能缩字、删步骤或让末尾节点越过画布。图的全部节点、连线和图注都要落在安全区内；给组件写一个小height不会使实际长图自动缩进该框。必要时使用清楚的分段表达并保留完整真实关系，不排成窄列、网格、之字形或跨行斜线，也不依赖失败回退替你改版。分支图保持每个分支的归属和汇合点清楚，解释段落与对应概念就近；风格一致不等于所有图都用同一外观。'] : []),
    `统一采用 ${JSON.stringify(style)}；画布1000×562.5，安全区 x=50..950/y=50..512.5，标题28–32px，普通正文18px，紧凑正文与表格最低16px。这组页专属字体覆盖通用22–28px/32–40px示例。不得等看到溢出再缩字。`,
    '表格默认每个表头单元格浅蓝背景、深蓝文字，每个正文单元格白色背景、深灰文字；不要给不同对象填不同颜色。概念名可以蓝色，必要区别、条件少量暖色或粗体，正文不可大段标蓝。emphasis 只能是 text 中逐字出现的短片段；样式通过原生槽 emphasis:[{text,color?,bold?}] 指定，普通强调用粗体，warm color/highlight 保持选择性。',
    '模型选择整页层级和几何位置；可以混合完整短段落、重点带、并列要素、提示区、图表与图文，按本页认识设计。不轮换模板凑多样性，不让所有框同等醒目。中心是整体视觉重心；同时保留自然的上到下阅读路径，不把完整说明塞进狭长竖栏。正文行宽至少约12个汉字，短标签除外。',
    ...COMPOSITION_EXAMPLES,
    '同一主题的图片、观察事实、必要比较和结论优先同页，让学生边观察边理解。不为了留白增加短页；空间确实不足时保留真实诊断，不删内容、改讲稿或发明额外翻页。',
    '原生形状可以承托文字，背景矩形与内部文字的包含关系合理；两个前景文字区域不能相撞。不要用一段文字一条小横杠作为整页通用设计。箭头与标签避开文字和图片，长关系解释放在命题区域，箭头只标简短真实关系词。',
    '承托文字的背景容器须按完整正文的真实字体、字号、行高、换行及段内粗体计量，为全部文字保留内边距，默认四边至少10px；容器高度包括实测正文高度与上下内边距。强调带底部不能让文字墨迹贴边或越过背景，文字落在画布内且不撞其他文字，仍不能代替背景内部的可读空间检查。本次首次编译可测量并记录风险，不能依赖程序自动整页重排、缩字或追加美化调用来修补空间。',
    '教材图片和已生成图片使用 supplied resource ID 作 src，保留实际比例、完整细节和教学观察说明。生成图片沿用已有资源身份，不发起新请求，不把媒体URL/来源元数据当学生正文。已有 diagram 由 canonical nodes/edges 维护，不删节点、分支或反馈，不把阅读顺序变成新关系。',
    '师生共用课堂 PPT，教师端与学生端都不显示书目出处：仅用于出处标注的教材书名、sourceTitle、作者出版信息、出处页码或“来源：……”只保留在系统来源记录和实际证据 ID 绑定中，供教师追溯，不写入 elements、components 的可见文字或 displayItems.text/label。继续使用提供的真实 resource ID、sourceContentIds 和 sourceEvidenceIds，不删除、改名或虚构来源。图片的观察说明、完整 diagram.annotation、事实、条件和教学解释仍须显示并分配真实空间；说明性图注不是书目出处，不能因隐藏出处而省略。教学事实涉及的人物或名称也不能当作书目出处删去。',
    '教师专用的备课、编排、编辑或审阅提示留在系统教师报告，不放在师生共用画布中；例如关于如何讲授或修改当前这张 PPT 的建议、制作注意和来源核查备注，不作为可见正文或图注。直接帮助学习者理解的概念说明、操作提示、知识条件和实际所教的教学法原则继续显示；这些教学内容不能被误当作教师编辑提示删去。',
    '原生标题和说明性图注可直接使用已提供的对应内容；其余教学命题由 displayItems 的引用槽承载，不生成无来源的额外解释。',
    '整页保留本页提供的主标题，使用28–32px深蓝文字，并与第一处正文保持明确间距；概念区域内的小标题不能代替整页主标题。',
    formatLecturePresentationReference({ audience: 'slide' }),
    `## 本页来源与展示职责\n${JSON.stringify(context)}`,
  ].join('\n');
}

/** Single-response compile preparation. Facts are diagnosed before references are expanded. */
export function prepareNativeLectureResponse(raw: string,
  authoring: ReturnType<typeof buildSlideDisplayAuthoringContext>, outline: SceneOutline) {
  const native = parseJsonResponse<Record<string, unknown>>(normalizeNativeAuthoringEnvelope(raw));
  if (!native || !Array.isArray(native.displayItems) || !native.displayItems.length) {
    throw new Error('Native lecture response requires a nonempty displayItems array');
  }
  applyClassroomSlideAuthoringPolicy(native);
  // Bind the lecture font before DSL defaults and actual measurement. An empty
  // model font otherwise becomes Microsoft YaHei while space references and
  // measured components use Noto Sans SC, changing wrapping after authoring.
  if (Array.isArray(native.elements)) for (const element of native.elements) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) continue;
    const value = element as Record<string, unknown>;
    if (value.type === 'text') value.defaultFontName = REFERENCE_LECTURE_STYLE.fontFamily;
    if (value.type === 'shape' && value.text && typeof value.text === 'object' && !Array.isArray(value.text)) {
      (value.text as Record<string, unknown>).defaultFontName = REFERENCE_LECTURE_STYLE.fontFamily;
    }
    if (value.type === 'table' && Array.isArray(value.data)) for (const cell of value.data.flat()) {
      if (!cell || typeof cell !== 'object' || Array.isArray(cell)) continue;
      const slot = cell as Record<string, unknown>;
      const style = slot.style && typeof slot.style === 'object' && !Array.isArray(slot.style) ? slot.style : {};
      slot.style = { ...style, fontname: REFERENCE_LECTURE_STYLE.fontFamily };
    }
  }
  const diagnostics: string[] = [];
  const annotation = outline.visualIntent?.diagram?.annotation?.trim();
  // Complete an exact source-caption prefix before measuring it. This local
  // reconciliation uses only the graph's existing text, never invented prose.
  if (annotation) for (const item of native.displayItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    if (Array.isArray(value.sourceContentIds) && value.sourceContentIds.length === 1
      && value.sourceContentIds[0] === 'diagram-annotation' && typeof value.text === 'string'
      && value.text.trim() !== annotation && /[。；]$/u.test(value.text.trim())
      && annotation.startsWith(value.text.trim())) value.text = annotation;
  }
  const projection = projectionData(JSON.stringify({ items: native.displayItems }), diagnostics);
  const semanticIssues = nativeSemanticBindingIssues(projection.items, authoring.context.semanticGroups);
  const factIssues = nativeDisplayFactItemIssues(projection.items, authoring.context.requiredFactSets);
  const evidenceForPassage = new Map<string, string | null>();
  for (const source of authoring.original.originalSources) for (const passage of source.passages) {
    if (!passage.sourceBlockId) continue;
    const owner = evidenceForPassage.get(passage.sourceBlockId);
    evidenceForPassage.set(passage.sourceBlockId, owner === undefined || owner === source.evidenceId ? source.evidenceId : null);
  }
  for (const item of projection.items) if (item.sourceEvidenceIds) {
    item.sourceEvidenceIds = [...new Set(item.sourceEvidenceIds.map((id) => authoring.evidenceIds.has(id)
      ? id : evidenceForPassage.get(id) ?? id))];
  }
  const canonicalAnnotations = new Set(projection.items.filter((item) => annotation
    && item.sourceContentIds.length === 1 && item.sourceContentIds[0] === 'diagram-annotation'
    && item.text.trim() === annotation).map((item) => item.id));
  // The host already owns the exact canonical caption and its source identity.
  // A verbatim reference does not need a guessed, duplicated evidence number.
  // Rewritten prose and all other display points keep the evidence contract.
  const sourceIssues = deterministicProjectionIssues(projection, authoring.sources,
    authoring.evidenceIds, outline.visualIntent?.diagram?.nodes)
    .filter((issue) => ![...canonicalAnnotations].some((id) => issue === `Missing adopted evidence for ${id}`));
  for (const item of projection.items) if (item.diagramNodeId
    && !outline.visualIntent?.diagram?.nodes.some((node) => node.id === item.diagramNodeId)) {
    sourceIssues.push(`Unknown diagram node for ${item.id}`);
  }
  const content: AuthoringContentItem[] = projection.items.flatMap((item) => [
    { id: item.id, text: item.text, required: true },
    ...(['label', 'row', 'column'] as const).flatMap((field) => item[field]
      ? [{ id: `${item.id}:${field}`, text: item[field]!, required: false }] : []),
  ]);
  const byId = new Map(projection.items.map((item) => [item.id, item]));
  const applyEmphasis = (slot: unknown): void => {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return;
    const value = slot as Record<string, unknown>;
    const refs = typeof value.contentRef === 'string' ? [value.contentRef]
      : Array.isArray(value.paragraphRefs) ? value.paragraphRefs.filter((ref): ref is string => typeof ref === 'string') : [];
    if (value.emphasis === undefined) {
      const terms = refs.flatMap((ref) => {
        const item = byId.get(ref);
        return (item?.emphasis ?? []).map((text) => ({ text, bold: true,
          ...(item?.emphasisStyle === 'color' ? { color: REFERENCE_LECTURE_STYLE.emphasis } : {}) }));
      });
      if (terms.length) value.emphasis = terms;
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach((entry) => Array.isArray(entry) ? entry.forEach(applyEmphasis) : applyEmphasis(entry));
      else if (child && typeof child === 'object') applyEmphasis(child);
    }
  };
  if (Array.isArray(native.elements)) native.elements.forEach(applyEmphasis);
  if (Array.isArray(native.components)) native.components.forEach(applyEmphasis);
  locateExternalDiagramAnnotations(native, projection.items, outline);
  return { response: JSON.stringify(native), content, displayItems: projection.items, sourceIssues, semanticIssues, factIssues,
    diagnostics: [...diagnostics, ...sourceIssues].map((issue) => `Native lecture display: ${issue}`) };
}

/** The model cannot suppress a canonical annotation. The compiler may avoid
 * its duplicate only after a complete reference is placed outside the graph. */
function locateExternalDiagramAnnotations(native: Record<string, unknown>, items: SlidePresentationItem[], outline: SceneOutline): void {
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value)
    && typeof value === 'object' && !Array.isArray(value);
  const components = Array.isArray(native.components) ? native.components.filter(object) : [];
  const annotation = outline.visualIntent?.diagram?.annotation?.trim();
  const ids = new Set(items.filter((item) => annotation && item.text.trim() === annotation
    && item.sourceContentIds.includes('diagram-annotation')).map((item) => item.id));
  for (const diagram of components.filter((component) => component.kind === 'diagram' || component.type === 'diagram')) {
    delete diagram.annotationPlacement;
    if (!ids.size || ![diagram.left, diagram.top, diagram.width, diagram.height].every((value) => typeof value === 'number' && Number.isFinite(value))) continue;
    const references = (slot: unknown) => object(slot) && (ids.has(String(slot.contentRef))
      || Array.isArray(slot.paragraphRefs) && slot.paragraphRefs.some((ref) => typeof ref === 'string' && ids.has(ref)));
    const exterior = (owner: Record<string, unknown>) => {
      const left = Number(owner.left), top = Number(owner.top), width = Number(owner.width), height = Number(owner.height);
      if (![left, top, width].every(Number.isFinite) || width <= 0) return false;
      return left >= Number(diagram.left) + Number(diagram.width) || left + width <= Number(diagram.left)
        || top >= Number(diagram.top) + Number(diagram.height)
        || Number.isFinite(height) && height > 0 && top + height <= Number(diagram.top);
    };
    const elements = Array.isArray(native.elements) ? native.elements.filter(object) : [];
    const displayed = elements.some((element) => exterior(element) && (element.type === 'text' && references(element)
      || element.type === 'shape' && references(element.text)
      || element.type === 'table' && Array.isArray(element.data) && element.data.flat().some(references)))
      || components.some((component) => component.kind === 'textBox' && references(component) && exterior(component));
    if (displayed) diagram.annotationPlacement = 'external';
  }
}

/** A reference is useful only after compilation resolves it to a real visible element. */
export function bindNativeLectureContent(outline: SceneOutline, content: GeneratedSlideContent,
  displayItems: SlidePresentationItem[], sources: readonly AuthoringContentItem[]): GeneratedSlideContent {
  const ids = new Set(content.elements.map((element) => element.id));
  const valid = (content.contentBindings ?? []).filter((binding) => ids.has(binding.elementId));
  // Compatibility for native authors which repeated a whole display phrase.
  // Bind only one exact visible slot; headings, partial phrases and ambiguous
  // repeated occurrences cannot manufacture missing-body coverage.
  for (const item of displayItems) {
    if (valid.some((binding) => binding.sourceContentId === item.id)) continue;
    const matching = content.elements.flatMap((element): SlideContentBinding[] => {
      if (!visibleNativeElement(element)) return [];
      if (element.type === 'table') return element.data.flatMap((row) => row.flatMap((cell) =>
        visibleNativeText(cell.text) === visibleNativeText(item.text)
          ? [{ sourceContentId: item.id, elementId: element.id, selector: { cellId: cell.id } }] : []));
      const text = element.type === 'text' && element.textType !== 'title' ? element.content
        : element.type === 'shape' ? element.text?.content ?? '' : '';
      return visibleNativeText(text) === visibleNativeText(item.text)
        ? [{ sourceContentId: item.id, elementId: element.id }] : [];
    });
    if (matching.length === 1) valid.push(matching[0]!);
  }
  const bindings: SlideContentBinding[] = [...valid];
  for (const item of displayItems) {
    const refs = new Set([item.id, `${item.id}:label`, `${item.id}:row`, `${item.id}:column`]);
    const targets = valid.filter((binding) => refs.has(binding.sourceContentId))
      .sort((a, b) => Number(b.sourceContentId === item.id) - Number(a.sourceContentId === item.id));
    for (const source of item.sourceContentIds) for (const target of targets) {
      bindings.push({ ...target, sourceContentId: source });
    }
  }
  for (const [index, text] of pagePresentationContent(outline).entries()) {
    const sourceIds = sources.filter((source) => source.text.trim() === text.trim()).map((source) => source.id);
    const nodes = outline.visualIntent?.diagram?.nodes.filter((node) => node.label.trim() === text.trim()) ?? [];
    sourceIds.push(...nodes.map((node) => `diagram-node:${node.id}`));
    if (outline.visualIntent?.diagram?.annotation?.trim() === text.trim()) sourceIds.push('diagram-annotation');
    for (const target of bindings.filter((binding) => sourceIds.includes(binding.sourceContentId))) {
      bindings.push({ ...target, sourceContentId: `${outline.id}:visible-${index + 1}` });
    }
  }
  const unique = [...new Map(bindings.map((binding) => [JSON.stringify(binding), binding])).values()];
  return { ...content, displayItems, contentBindings: unique };
}

function visibleNativeText(value: string): string {
  if (/(?:display\s*:\s*none|visibility\s*:\s*hidden|(?:opacity|font-size)\s*:\s*0(?:px|[;"\s])|color\s*:\s*transparent)/iu.test(value)) return '';
  return value.replace(/<[^>]*>/gu, '').replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&lt;/giu, '<').replace(/&gt;/giu, '>').replace(/&amp;/giu, '&').replace(/&quot;/giu, '"').replace(/\s/gu, '');
}

function visibleNativeElement(element: GeneratedSlideContent['elements'][number]): boolean {
  if (!('height' in element)) return false;
  return (!('opacity' in element) || element.opacity !== 0)
    && [element.left, element.top, element.width, element.height].every(Number.isFinite)
    && element.width > 0 && element.height > 0 && element.left >= 0 && element.top >= 0
    && element.left + element.width <= REFERENCE_LECTURE_STYLE.canvasWidth + 0.5
    && element.top + element.height <= REFERENCE_LECTURE_STYLE.canvasHeight + 0.5;
}

/** Source references do not prove that their actual words reached the canvas. */
export function nativeLectureDisplayIssues(content: GeneratedSlideContent): string[] {
  const issues: string[] = [];
  for (const item of content.displayItems ?? []) {
    const body = (content.contentBindings ?? []).filter((binding) => binding.sourceContentId === item.id);
    const shown = body.some((binding) => {
      const element = content.elements.find((element) => element.id === binding.elementId);
      if (!element || !visibleNativeElement(element)) return false;
      const html = element.type === 'text' ? element.content : element.type === 'shape' ? element.text?.content ?? ''
        : element.type === 'table' ? element.data.flat().filter((cell) => !binding.selector || !('cellId' in binding.selector)
          || cell.id === binding.selector.cellId).map((cell) => cell.text).join('\n') : '';
      const expected = visibleNativeText(item.text);
      return expected.length > 0 && visibleNativeText(html).includes(expected);
    });
    if (!shown) issues.push(`Native display item ${item.id} has no actual visible body slot`);
  }
  return issues;
}

export function nativeLectureTypography() {
  const { bodyFontSize, minimumBodyFontSize, titleFontSize, minimumTitleFontSize } = REFERENCE_LECTURE_TYPOGRAPHY;
  return { bodyFontSize, minimumBodyFontSize, titleFontSize, minimumTitleFontSize, chartFontSize: bodyFontSize };
}

/** Real source bytes and declared generated-resource ratios enter before sizing. */
export async function nativeLectureImages(outline: SceneOutline, options: {
  assignedImages?: PdfImage[]; imageMapping?: Record<string, string>; generatedMediaMapping?: Record<string, string>;
  visualBaseline?: GeneratedSlideContent;
}) {
  const dimensions = async (src: string) => {
    const encoded = src.match(/^data:image\/[^;,]+;base64,([\s\S]+)$/u);
    if (!encoded) return undefined;
    const sharp = (await import('sharp')).default;
    const metadata = await sharp(Buffer.from(encoded[1]!, 'base64')).metadata();
    const rotated = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
    const width = (rotated ? metadata.height : metadata.width) ?? 0;
    const height = (rotated ? metadata.width : metadata.height) ?? 0;
    return width > 0 && height > 0 ? { width, height } : undefined;
  };
  const images = await Promise.all((options.assignedImages ?? []).map(async (image) => {
    const src = options.imageMapping?.[image.id] ?? image.src;
    const actual = await dimensions(src) ?? await dimensions(image.src);
    return { ...image, src, ...(actual ?? {}) };
  }));
  const requests = (outline.mediaGenerations ?? []).filter((request) => request.type === 'image');
  const generatedIds = new Set([...requests.map((request) => request.elementId),
    ...(outline.visualIntent?.resourceRefs ?? []).filter((ref) => ref.kind === 'generated-image').map((ref) => ref.resourceId)]);
  const saved = [options.visualBaseline, ...(options.visualBaseline?.continuationPages ?? [])]
    .flatMap((page) => page?.elements ?? []).filter((element) => element.type === 'image');
  for (const id of generatedIds) {
    if (images.some((image) => image.id === id)) continue;
    const alias = id.startsWith('gen_img_') ? id : `gen_img_${id}`;
    const original = saved.find((image) => image.id === id || image.src === id || image.src === alias);
    const src = options.generatedMediaMapping?.[id] ?? options.generatedMediaMapping?.[alias]
      ?? options.imageMapping?.[id] ?? original?.src ?? id;
    const actual = await dimensions(src);
    const request = requests.find((item) => item.elementId === id);
    const parts = (request?.aspectRatio ?? '').split(':').map(Number);
    const planned = parts.length === 2 && parts.every((value) => Number.isFinite(value) && value > 0)
      ? { width: parts[0]! * 1000, height: parts[1]! * 1000 } : undefined;
    images.push({ id, src, pageNumber: 0, description: '已规划的生成图片，不再次生成',
      ...(actual ?? (original && original.width > 0 && original.height > 0
        ? { width: original.width, height: original.height } : planned) ?? {}) });
  }
  const concrete = (value: string | undefined): value is string => Boolean(value)
    && /^(?:data:image\/[^;,]+[;,]|https?:\/\/)/iu.test(value!);
  const visionImageMapping = Object.fromEntries(images.flatMap((image) => {
    const original = options.assignedImages?.find((item) => item.id === image.id)?.src;
    const candidates = [original, image.src].filter(concrete);
    const src = candidates.find((value) => value.startsWith('data:')) ?? candidates[0];
    return src ? [[image.id, src]] : [];
  }));
  return { images, visionImageMapping,
    imageMapping: { ...options.imageMapping, ...Object.fromEntries(images.map((image) => [image.id, image.src])) } };
}

/** Restore an omitted known heading only in genuinely unused space. */
export async function retainNativeLectureTitle(outline: SceneOutline, content: GeneratedSlideContent, measure: TextMeasure) {
  const hasHeading = content.elements.some((element) => element.type === 'text' && visibleNativeElement(element)
    && visibleNativeText(element.content) && (element.textType === 'title' || /<h[1-3]\b/iu.test(element.content)
      || /font-size\s*:\s*(?:2[89]|3[0-2])(?:\.\d+)?px\b/iu.test(element.content)));
  if (hasHeading || !outline.title.trim()) return content;
  const title = outline.title.trim();
  const html = `<p style="font-size:28px;font-weight:700;color:${REFERENCE_LECTURE_STYLE.title}">${title.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')}</p>`;
  const spec = { html, text: title, fontSize: 28, fontWeight: 700 as const,
    fontFamily: REFERENCE_LECTURE_STYLE.fontFamily, align: 'left', lineHeight: 1.1, padding: 10,
    paragraphSpace: 0, preserveRichText: true } as const;
  const initial = await measure({ ...spec, width: 900 });
  // A short heading can share a row with the figure's provenance at the
  // opposite side. Its unused 900px allocation is not visible text.
  const width = Math.min(900, Math.max(220, Math.ceil(initial.naturalWidth ?? 900) + 20));
  const geometry = width === 900 ? initial : await measure({ ...spec, width });
  const height = Math.ceil(Math.max(geometry.height, geometry.inkBottom ?? 0)) + 1;
  const occupied = content.elements.some((element) => {
    if (element.type === 'shape' && !element.text?.content?.trim()
      && /^(?:#fff(?:fff)?|white|transparent|none)$/iu.test(element.fill ?? 'none')) return false;
    const rect = element.type === 'line'
      ? { left: element.left + Math.min(element.start[0], element.end[0]), top: element.top + Math.min(element.start[1], element.end[1]),
        width: Math.max(element.width, Math.abs(element.end[0] - element.start[0])),
        height: Math.max(element.width, Math.abs(element.end[1] - element.start[1])) }
      : element;
    return rect.left < 50 + width && rect.left + rect.width > 50 && rect.top < 50 + height + 2
      && rect.top + rect.height > 50;
  });
  if (!Number.isFinite(height) || height <= 0 || height > 462.5 || occupied) {
    return { ...content, qualityDiagnostics: [...new Set([...(content.qualityDiagnostics ?? []),
      'Native lecture main title is missing and has no clear measured allocation; retained the authored composition for review.'])] };
  }
  let id = `${outline.id}-main-title`;
  for (let suffix = 2; content.elements.some((element) => element.id === id); suffix += 1) id = `${outline.id}-main-title-${suffix}`;
  return { ...content, elements: [...content.elements, { id, type: 'text' as const, textType: 'title' as const,
    left: 50, top: 50, width, height, rotate: 0, content: html, defaultFontName: REFERENCE_LECTURE_STYLE.fontFamily,
    defaultColor: REFERENCE_LECTURE_STYLE.title, lineHeight: 1.1, paragraphSpace: 0 }],
  contentBindings: [...(content.contentBindings ?? []), { sourceContentId: `${outline.id}:title`, elementId: id }] };
}

/** Preserve source attribution even when an otherwise usable first draft omits its caption. */
export async function retainNativeSourceCaptions(content: GeneratedSlideContent, images: PdfImage[], measure: TextMeasure) {
  const elements = [...content.elements], diagnostics = [...(content.qualityDiagnostics ?? [])];
  const bindings = [...(content.contentBindings ?? [])];
  const normalizedCaption = (text: string) => visibleNativeText(text).replace(/[《》〈〉“”‘’「」『』：:,，()（）\s]/gu, '');
  for (const image of images) {
    const placed = elements.find((element) => element.type === 'image' && (element.id === image.id || element.src === image.src));
    if (!placed || placed.type !== 'image') continue;
    bindings.push({ sourceContentId: `image:${image.id}`, elementId: placed.id });
    if (!image.sourceTitle) continue;
    const caption = `来源：${image.sourceTitle}${image.pageNumber > 0 ? `，第${image.pageNumber}页` : ''}`;
    const existingCaption = elements.find((element) => {
      const html = element.type === 'text' ? element.content : element.type === 'shape' ? element.text?.content ?? '' : '';
      return visibleNativeElement(element) && normalizedCaption(html).includes(normalizedCaption(caption));
    });
    if (existingCaption) {
      bindings.push({ sourceContentId: `image:${image.id}:caption`, elementId: existingCaption.id });
      continue;
    }
    const html = `<p style="font-size:16px;color:${REFERENCE_LECTURE_STYLE.muted}">${caption.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')}</p>`;
    const geometry = await measure({ html, text: caption, width: placed.width, fontSize: 16, fontWeight: 400, align: 'left',
      fontFamily: REFERENCE_LECTURE_STYLE.fontFamily, lineHeight: 1.5, padding: 10, paragraphSpace: 5, preserveRichText: true });
    let id = `${image.id}-caption`;
    for (let suffix = 2; elements.some((element) => element.id === id); suffix += 1) id = `${image.id}-caption-${suffix}`;
    const height = geometry.height + 1;
    const rect = { left: placed.left, width: placed.width, height };
    const intersects = (a: { left: number; top: number; width: number; height: number },
      b: { left: number; top: number; width: number; height: number }) =>
      a.left < b.left + b.width - 0.5 && a.left + a.width > b.left + 0.5
      && a.top < b.top + b.height - 0.5 && a.top + a.height > b.top + 0.5;
    const peers = elements.flatMap((element) => {
      if (element.type === 'line') {
        const [startX, startY] = element.start, [endX, endY] = element.end;
        return [{ left: element.left + Math.min(startX, endX), top: element.top + Math.min(startY, endY),
          width: Math.max(element.width, Math.abs(endX - startX)), height: Math.max(element.width, Math.abs(endY - startY)) }];
      }
      if (!('height' in element) || !Number.isFinite(element.height)) return [];
      if (element.type === 'shape' && !element.text?.content?.trim()) return [];
      return [{ left: element.left, top: element.top, width: element.width, height: element.height }];
    });
    // An explanation below a figure is a real display region, not spare room
    // for a second provenance label. Search the same image column's clear space
    // without moving the image, changing its scale, or touching teaching text.
    const nearbyCaptions = elements.filter((element) => element.type === 'text'
      && element.top >= placed.top + placed.height - 0.5
      && element.top <= placed.top + placed.height + 50
      && Math.min(element.left + element.width, placed.left + placed.width) - Math.max(element.left, placed.left)
        >= Math.min(element.width, placed.width) * 0.75);
    const below = Math.max(placed.top + placed.height + 6,
      ...nearbyCaptions.map((element) => element.top + ('height' in element ? element.height : 0) + 4));
    const candidates = [below, placed.top - height - 6,
      ...peers.flatMap((peer) => [peer.top - height - 4, peer.top + peer.height + 4])];
    const top = candidates.find((candidate) => candidate >= 50 && candidate + height <= 512.5
      && !peers.some((peer) => intersects({ ...rect, top: candidate }, peer))) ?? below;
    elements.push({ id, type: 'text', left: placed.left, top, width: placed.width, height: geometry.height + 1, rotate: 0,
      content: html, defaultFontName: REFERENCE_LECTURE_STYLE.fontFamily, defaultColor: REFERENCE_LECTURE_STYLE.muted, lineHeight: 1.5, paragraphSpace: 5 });
    bindings.push({ sourceContentId: `image:${image.id}:caption`, elementId: id });
    if (top + height > 512.5 || peers.some((peer) => intersects({ ...rect, top }, peer))) {
      diagnostics.push(`Source caption for ${image.id} has no clear allocation in the safe page area; retained attribution for review.`);
    }
  }
  return { ...content, elements, contentBindings: bindings,
    ...(diagnostics.length ? { qualityDiagnostics: [...new Set(diagnostics)] } : {}) };
}
