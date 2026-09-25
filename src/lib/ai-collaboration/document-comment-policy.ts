import type { Course } from '@/lib/session/types';

import { buildAuthoritativeCourseContext } from './document-policy';
import type {
  DocumentAiComment,
  DocumentAiCommentReplyResult,
} from './document-comment-types';

// Keep existing checkpoints valid so a policy upgrade does not re-review old work.
export const DOCUMENT_COMMENT_REVIEW_VERSION = 4;
export const DOCUMENT_COMMENT_REVIEW_BATCH_SIZE = 8;
export const DOCUMENT_COMMENT_MAX_PARAGRAPH_LENGTH = 2_000;
export const DOCUMENT_COMMENT_MIN_MEANINGFUL_CHARACTERS = 6;

export function normalizeDocumentParagraphText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isReviewableDocumentParagraph(value: string): boolean {
  const normalized = normalizeDocumentParagraphText(value);
  if (normalized.length > DOCUMENT_COMMENT_MAX_PARAGRAPH_LENGTH) return false;
  const meaningfulCharacters = normalized.replace(/[\p{P}\p{S}\s]/gu, '');
  return meaningfulCharacters.length >= DOCUMENT_COMMENT_MIN_MEANINGFUL_CHARACTERS;
}

/** Stable across Plate remounts: paragraph IDs are intentionally not included. */
export function documentParagraphVersionFingerprint(value: string): string {
  const normalized = normalizeDocumentParagraphText(value);
  let hash = 2_166_136_261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${normalized.length}:${(hash >>> 0).toString(36)}`;
}

function canonicalIssueType(value: string): string {
  const type = normalizeDocumentParagraphText(value);
  if (/错别字|错字/.test(type)) return 'typo';
  if (/标点/.test(type)) return 'punctuation';
  if (/冗余|赘余|重复|同义反复|堆砌/.test(type)) return 'redundancy';
  if (/搭配|主谓|动宾|定中/.test(type)) return 'collocation';
  if (/语序|句式杂糅|成分残缺|修饰语/.test(type)) return 'grammar';
  if (/指代|含混|含糊|歧义|概念/.test(type)) return 'clarity';
  if (/事实|核验|来源/.test(type)) return 'fact';
  if (/证据|依据/.test(type)) return 'evidence';
  if (/逻辑|因果|比较|以偏概全|矛盾/.test(type)) return 'reasoning';
  if (/项目|任务|一致性|偏离/.test(type)) return 'project';
  return type.replace(/[\s：:、，,。.!！?？]/g, '');
}

export function areDocumentCommentIssuesEquivalent(
  left: { issueType?: string; targetText: string; issueKey?: string; evidenceQuote?: string },
  right: { issueType?: string; targetText: string; issueKey?: string; evidenceQuote?: string },
): boolean {
  if (canonicalIssueType(left.issueType ?? '') !== canonicalIssueType(right.issueType ?? '')) {
    return false;
  }
  // A shared root cause can span paragraphs. A model-supplied key alone is not
  // sufficient: the supporting evidence must also be the same.
  const leftKey = normalizeIssueIdentity(left.issueKey ?? '');
  const rightKey = normalizeIssueIdentity(right.issueKey ?? '');
  if (leftKey && rightKey) {
    if (leftKey !== rightKey) return false;
    const leftEvidence = normalizeIssueIdentity(left.evidenceQuote ?? '');
    const rightEvidence = normalizeIssueIdentity(right.evidenceQuote ?? '');
    if (leftEvidence && rightEvidence) return leftEvidence === rightEvidence;
  }
  const leftTarget = normalizeIssueIdentity(left.targetText);
  const rightTarget = normalizeIssueIdentity(right.targetText);
  if (!leftTarget || !rightTarget) return false;
  return leftTarget === rightTarget
    || (Math.min(leftTarget.length, rightTarget.length) >= 4
      && (leftTarget.includes(rightTarget) || rightTarget.includes(leftTarget)));
}

function normalizeIssueIdentity(value: string): string {
  return normalizeDocumentParagraphText(value)
    .replace(/[\s，,。.!！?？；;：“”‘’'"（）()]/g, '');
}

function clean(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001F]/g, '').trim().slice(0, maxLength)
    : '';
}

function boundedDocument(value: string, focusTexts: string[] = []): string {
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (text.length <= 40_000) return text;

  // Keep the project introduction and each changed paragraph's surroundings.
  // A head-only slice hid the very paragraphs being reviewed in long work.
  const ranges: Array<{ start: number; end: number }> = [{ start: 0, end: 4_000 }];
  const windowLength = Math.floor(34_000 / Math.max(1, focusTexts.length));
  focusTexts.forEach((focus) => {
    const anchor = focus.trim();
    if (!anchor) return;
    const directIndex = text.indexOf(anchor);
    const index = directIndex >= 0 ? directIndex : text.indexOf(anchor.slice(0, 24));
    if (index < 0) return;
    const start = Math.max(0, index - Math.floor((windowLength - anchor.length) / 2));
    ranges.push({ start, end: Math.min(text.length, start + windowLength) });
  });
  ranges.sort((left, right) => left.start - right.start);
  const merged: typeof ranges = [];
  ranges.forEach((range) => {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  });
  return merged.map((range) => text.slice(range.start, range.end)).join('\n\n……（其余内容未显示，不能据此推断缺失）……\n\n');
}

function containsEvidence(haystack: string, quote: string): boolean {
  return haystack.includes(quote)
    || normalizeDocumentParagraphText(haystack).includes(normalizeDocumentParagraphText(quote));
}

function hasIndependentEvidence(
  issueType: string,
  quotedText: string,
  evidenceSource: unknown,
  evidenceQuote: string,
): boolean {
  if (evidenceSource !== 'document') return true;
  if (!['数据矛盾', '关键推理', '核心事实核验', '关键方案风险', '要求冲突'].includes(issueType)) {
    return true;
  }
  // Repeating the disputed sentence as its own evidence would let a vague
  // critique pass the structural gate without any external support.
  const target = normalizeIssueIdentity(quotedText);
  const evidence = normalizeIssueIdentity(evidenceQuote);
  return Boolean(evidence && !target.includes(evidence) && !evidence.includes(target));
}

const DOCUMENT_COMMENT_STYLE_RULES = [
  '你是正在与学生共同制作项目成果的 AI 小组成员。现在不是伴学提醒、课堂主持或通用写作点评，而是一次针对文档具体段落的组内批注。',
  '不要泛泛表扬、重复项目要求、直接改写段落或替学生完成核心判断。每条批注只谈一个问题，不能在一条批注里罗列多个独立问题。',
  '像真实组员在文档边上留一句话那样自然表达：提到具体原文，说清它为什么影响当前任务，并给一个可行的下一步。一般使用一到三句连贯短句，控制在 180 个汉字以内。',
  '可以用问句激发学生思考，但只能问一个贴着原文、能够帮助小组继续判断的问题。语气应当像“这里的‘最好’是更省时间，还是效果更好？”这样的同伴商量，不要用“你是否考虑过”“请说明”“请论证”等教师审问式措辞。',
  '不得使用“观察：”“影响：”“问题：”“提问：”“建议：”“下一步：”等栏目标签，不要列序号、清单或小标题，也不要把回复写成评价报告。不要自称老师、助手或 AI。',
];

const PROACTIVE_INTERVENTION_RULES = [
  '主动介入必须同时满足：有可逐字定位的原文或课程依据；会明显影响项目方向、关键论证、验证结果或硬性交付要求；如果现在不提醒，学生可能沿着错误内容继续推进。任一条件不满足就不介入。',
  '把问题分为关键问题、值得完善、表达偏好。只有关键问题才主动批注。普通措辞、语法、标点、冗余、文风、例子不够丰富，不要主动介入；只有语言错误改变关键含义（如关键单位错误）时例外。',
  '“还没写到”不是“遗漏”，“暂定”不是“结论错误”。不要只因本段没有引用就认定全文缺乏证据；先检查完整成果上下文。无法核验的事实不能直接判错，只有它支撑关键决策且需要核验时才提醒。不要依据文风或复制粘贴推测外部 AI 使用。',
  '若没有明显且有价值的问题，必须选择不介入。宁可不介入，也不要制造存在感。',
];

export function buildProactiveDocumentCommentPrompts(input: {
  course: Course;
  studentId: string;
  stageKey: string;
  documentText: string;
  targetText: string;
}): { system: string; user: string } {
  return {
    system: [
      ...DOCUMENT_COMMENT_STYLE_RULES,
      ...PROACTIVE_INTERVENTION_RULES,
      '只返回严格 JSON：{"shouldComment":true|false,"severity":"critical|improvement|style","issueType":"数据矛盾|要求冲突|关键推理|关键单位|核心事实核验|关键含义|关键方案风险","quotedText":"目标段落中逐字连续、唯一的原文","evidenceSource":"document|course","evidenceQuote":"成果或课程要求中逐字复制的依据","impact":"会怎样影响当前项目","needsInterventionNow":true|false,"comment":"给学生看的批注；不介入时为空字符串"}',
    ].join('\n'),
    user: [
      '【项目与课程要求】',
      buildAuthoritativeCourseContext(input.course, input.studentId, input.stageKey),
      '',
      '【正在制作的完整成果上下文】',
      boundedDocument(input.documentText, [input.targetText]),
      '',
      '【本次只评估的具体段落】',
      clean(input.targetText, 3_000),
      '',
      '判断此刻是否确有必要在该段右侧留下一个小组批注。',
    ].join('\n'),
  };
}

export type ProactiveDocumentCommentCandidate = {
  candidateId: string;
  blockId?: string;
  blockIndex: number;
  targetText: string;
  existingComments?: string[];
};

export type ProactiveDocumentCommentResult = {
  candidateId: string;
  issueType: string;
  quotedText: string;
  comment: string;
  severity: 'critical' | 'improvement' | 'style';
  evidenceSource: 'document' | 'course';
  evidenceQuote: string;
  impact: string;
  issueKey?: string;
  relatedAnchors?: Array<{ candidateId: string; quotedText: string }>;
};

export type ProactiveDocumentReviewFocus = 'language' | 'reasoning' | 'comprehensive';
export type ProactiveDocumentReviewMode = 'proactive' | 'on-demand';

const LANGUAGE_REVIEW_RULES = [
  '本轮关注语言是否改变项目中的关键含义：数字、单位、对象、范围、前后术语或关键条件。一般错别字、搭配、语序、标点和润色偏好仅在学生主动要求语言检查时解释，不作为主动介入。',
];

const PROACTIVE_ISSUE_TYPES = new Set([
  '数据矛盾',
  '要求冲突',
  '关键推理',
  '关键单位',
  '核心事实核验',
  '关键含义',
  '关键方案风险',
]);
const ON_DEMAND_ISSUE_TYPES = new Set([
  ...PROACTIVE_ISSUE_TYPES,
  '证据完善',
  '结构建议',
  '表达建议',
]);

const REASONING_REVIEW_RULES = [
  '本轮关注会误导项目推进的逻辑、证据和任务问题：结论与已有数据矛盾，关键推理不能成立，方案明确违反课程硬性约束，或者支撑核心决策的事实必须核验。',
  '不要把观点尚未展开、个别段落没有引用、局部可以写得更充分，直接判成关键缺陷；查看全文已有内容。对于跨句关系，引用支撑判断所必需的最短连续句子。',
];

export function buildBatchProactiveDocumentCommentPrompts(input: {
  course: Course;
  studentId: string;
  stageKey: string;
  documentText: string;
  candidates: ProactiveDocumentCommentCandidate[];
  reviewFocus: ProactiveDocumentReviewFocus;
  reviewMode?: ProactiveDocumentReviewMode;
}): { system: string; user: string } {
  const reviewMode = input.reviewMode ?? 'proactive';
  const focusRules = input.reviewFocus === 'language'
    ? LANGUAGE_REVIEW_RULES
    : input.reviewFocus === 'reasoning'
      ? REASONING_REVIEW_RULES
      : [...LANGUAGE_REVIEW_RULES, ...REASONING_REVIEW_RULES];
  const focusLabel = input.reviewFocus === 'language'
    ? '关键含义与语言表达'
    : input.reviewFocus === 'reasoning'
      ? '逻辑、证据与项目任务'
      : '关键含义、逻辑证据与项目任务';
  return {
    system: [
      ...DOCUMENT_COMMENT_STYLE_RULES,
      ...(reviewMode === 'proactive' ? PROACTIVE_INTERVENTION_RULES : [
        '学生主动要求检查文稿时，可以指出值得完善和语言表达问题。请解释具体影响与修改方向；表达偏好须明确说成可选建议。',
        '不要把尚未写完当作遗漏，也不要只因本段没有引用就认定全文缺少证据；先检查完整成果上下文。',
      ]),
      ...focusRules,
      reviewMode === 'on-demand'
        ? '学生主动要求检查文稿。可以指出值得完善的问题，并按请求解释语言表达；这些结果不可自动当成日常主动批注。'
        : '本轮是后台主动检查。只返回同时满足依据、重要性和立即提醒必要性的关键问题；值得完善或表达偏好一律不返回。',
      '你会同时收到多个候选段落。逐段判断，不能只检查最后一段，也不能发现一处问题就停止。同一版本中多个彼此独立的关键问题应全部返回，同一个 candidateId 可有多条记录；不要按数量配额截断。',
      '同一根本问题出现在多段时，为每个相关候选分别提供锚点记录，并在 issueKey 使用相同的简短根因描述和同一处关键依据；系统会把它们合成一条批注。不同问题必须使用不同 issueKey。',
      '输入中的 existingComments 是该段已有的历史批注，不得重复这些问题；只补充尚未指出的独立问题。',
      '每个问题都必须提供 quotedText：它必须是候选段落中逐字复制、连续且只出现一次的最小必要原文。词语或句法问题通常只引用所在分句或单句；跨句逻辑问题引用必要的连续句子；只有整段结构都有问题时才允许引用整段。不得改字、补字、概括或使用省略号。',
      `issueType 只允许：${[...(reviewMode === 'proactive' ? PROACTIVE_ISSUE_TYPES : ON_DEMAND_ISSUE_TYPES)].join('、')}。severity 只允许 critical、improvement、style。needsInterventionNow 说明是否必须此刻提醒。`,
      'evidenceSource 为 document 或 course；evidenceQuote 必须从完整成果或课程要求逐字复制，不能概括、虚构或用“缺少证据”作为依据。impact 要具体说明继续沿用会怎样影响项目。comment 用同伴语气说清原文、影响和一个可行下一步。',
      '文档或课程内容过长导致上下文不完整时，不得凭未看到的部分推断内容不存在。请仅依据实际看到且能引用的内容判断。',
      '每个候选段落完整审阅后，才把其 candidateId 加入 checkedCandidateIds；即使该段没有问题也要加入。只有所有输入候选都已完整审阅时 complete 才为 true。无法完成时返回已经完成的候选，不要把未检查的段落当成无问题。',
      'candidateId 必须逐字复制输入值。只返回严格 JSON，不使用 Markdown 代码块：',
      '{"checkedCandidateIds":["已完整审阅的候选ID"],"complete":true,"comments":[{"candidateId":"候选ID","severity":"critical","needsInterventionNow":true,"issueType":"关键问题类别","issueKey":"同根问题的简短描述","quotedText":"逐字原文","evidenceSource":"document","evidenceQuote":"逐字依据","impact":"对当前项目的具体影响","comment":"给学生看的自然组员批注"}]}',
    ].join('\n'),
    user: [
      '【项目与课程要求】',
      buildAuthoritativeCourseContext(input.course, input.studentId, input.stageKey),
      '',
      '【正在制作的完整成果上下文】',
      boundedDocument(input.documentText, input.candidates.map((candidate) => candidate.targetText)),
      '',
      '【本轮需要检查的候选段落】',
      JSON.stringify(input.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        blockIndex: candidate.blockIndex,
        text: clean(candidate.targetText, 3_000),
        existingComments: (candidate.existingComments ?? [])
          .slice(-8)
          .map((comment) => clean(comment, 600)),
      }))),
      '',
      `【本轮审阅重点】${focusLabel}`,
      `【检查方式】${reviewMode === 'proactive' ? '后台主动介入，仅返回关键且需要现在提醒的问题' : '学生主动检查，可说明值得完善的问题'}`,
      '请一次完成所有候选段落的判断，只返回能够精确引用依据、符合本次检查方式的批注。',
    ].join('\n'),
  };
}

function naturalizeProactiveComment(value: unknown): string {
  const comment = clean(value, 260)
    .replace(/\*\*/g, '')
    .replace(/(?:^|\s)[-•]\s*/g, ' ')
    .trim();
  const labelPattern = /(观察|影响|问题|提问|建议|理由|下一步)\s*[：:]\s*/g;
  const matches = [...comment.matchAll(labelPattern)];
  if (matches.length === 0) return comment;

  const parts = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? comment.length;
    const text = comment.slice(start, end).trim().replace(/^[-—–；;、\s]+/, '');
    if (!text) return '';
    if (/[。！？!?]$/.test(text)) return text;
    return `${text}${match[1] === '问题' || match[1] === '提问' ? '？' : '。'}`;
  }).filter(Boolean);

  return parts.join('').slice(0, 260);
}

export type ProactiveDocumentSingleCommentResult =
  | { shouldComment: false; comment: '' }
  | {
    shouldComment: true;
    comment: string;
    issueType: string;
    quotedText: string;
    severity: 'critical';
    evidenceSource: 'document' | 'course';
    evidenceQuote: string;
    impact: string;
    issueKey?: string;
  };

export function normalizeProactiveDocumentComment(
  raw: unknown,
  context: ProactiveDocumentEvidenceContext & { targetText?: string } = {},
): ProactiveDocumentSingleCommentResult {
  if (!raw || typeof raw !== 'object') return { shouldComment: false, comment: '' };
  const record = raw as Record<string, unknown>;
  const comment = naturalizeProactiveComment(record.comment);
  const quotedText = clean(record.quotedText, 3_000);
  const evidenceQuote = clean(record.evidenceQuote, 1_000);
  const validCriticalIssue = record.severity === 'critical'
    && record.needsInterventionNow === true
    && PROACTIVE_ISSUE_TYPES.has(clean(record.issueType, 40))
    && quotedText.length >= 2
    && (!context.targetText || uniqueOccurrence(context.targetText, quotedText))
    && (record.evidenceSource === 'document' || record.evidenceSource === 'course')
    && evidenceQuote.length >= 2
    && hasIndependentEvidence(
      clean(record.issueType, 40), quotedText, record.evidenceSource, evidenceQuote,
    )
    && (record.evidenceSource !== 'document'
      || !context.documentText
      || (containsEvidence(context.documentText, evidenceQuote)
        && containsEvidence(boundedDocument(context.documentText, [context.targetText ?? '']), evidenceQuote)))
    && (record.evidenceSource !== 'course'
      || Boolean(context.courseText && containsEvidence(context.courseText, evidenceQuote)))
    && clean(record.impact, 500).length >= 8;
  const shouldComment = record.shouldComment === true && validCriticalIssue && comment.length >= 8;
  if (!shouldComment) return { shouldComment: false, comment: '' };
  const issueKey = clean(record.issueKey, 120);
  return {
    shouldComment: true,
    comment,
    issueType: clean(record.issueType, 40),
    quotedText,
    severity: 'critical',
    evidenceSource: record.evidenceSource as 'document' | 'course',
    evidenceQuote,
    impact: clean(record.impact, 500),
    ...(issueKey ? { issueKey } : {}),
  };
}

export type ProactiveDocumentEvidenceContext = {
  documentText?: string;
  courseText?: string;
  reviewMode?: ProactiveDocumentReviewMode;
};

export type ProactiveDocumentReviewResult = {
  comments: ProactiveDocumentCommentResult[];
  reviewedCandidateIds: string[];
  complete: boolean;
};

export function normalizeBatchProactiveDocumentReview(
  raw: unknown,
  candidates: ProactiveDocumentCommentCandidate[],
  context: ProactiveDocumentEvidenceContext = {},
): ProactiveDocumentReviewResult {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const knownIds = new Set(candidates.map((candidate) => candidate.candidateId));
  const claimedReviewedIds = Array.isArray(record.checkedCandidateIds)
    ? [...new Set(record.checkedCandidateIds.filter((id): id is string =>
      typeof id === 'string' && knownIds.has(id)
    ))]
    : [];
  // "Incomplete" while claiming every candidate was checked is ambiguous;
  // retry the whole batch instead of recording a false all-clear.
  const reviewedCandidateIds = record.complete === false
    && claimedReviewedIds.length === knownIds.size
    ? []
    : claimedReviewedIds;
  const complete = record.complete === true
    && reviewedCandidateIds.length === knownIds.size;
  const reviewedSet = new Set(reviewedCandidateIds);
  return {
    comments: normalizeBatchProactiveDocumentComments(
      raw,
      candidates.filter((candidate) => reviewedSet.has(candidate.candidateId)),
      context,
    ),
    reviewedCandidateIds,
    complete,
  };
}

export function normalizeBatchProactiveDocumentComments(
  raw: unknown,
  candidates: ProactiveDocumentCommentCandidate[],
  context: ProactiveDocumentEvidenceContext = {},
): ProactiveDocumentCommentResult[] {
  if (!raw || typeof raw !== 'object') return [];
  const comments = (raw as Record<string, unknown>).comments;
  if (!Array.isArray(comments)) return [];
  const candidateById = new Map(candidates.map((candidate) => [
    candidate.candidateId,
    candidate,
  ]));
  const documentText = context.documentText
    ? boundedDocument(context.documentText, candidates.map((candidate) => candidate.targetText))
    : candidates.map((candidate) => candidate.targetText).join('\n');
  const results: ProactiveDocumentCommentResult[] = [];

  comments.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    const candidateId = clean(record.candidateId, 160);
    const candidate = candidateById.get(candidateId);
    const issueType = clean(record.issueType, 40);
    const severity = record.severity;
    const quotedText = clean(record.quotedText, 3_000);
    const evidenceSource = record.evidenceSource;
    const evidenceQuote = clean(record.evidenceQuote, 1_000);
    const impact = clean(record.impact, 500);
    const issueKey = clean(record.issueKey, 120);
    const comment = naturalizeProactiveComment(record.comment);
    const isOnDemand = context.reviewMode === 'on-demand';
    if (
      !candidate
      || !quotedText
      || !uniqueOccurrence(candidate.targetText, quotedText)
      || comment.length < 8
      || !(isOnDemand ? ON_DEMAND_ISSUE_TYPES : PROACTIVE_ISSUE_TYPES).has(issueType)
      || (severity !== 'critical' && !(isOnDemand && (severity === 'improvement' || severity === 'style')))
      || (!isOnDemand && record.needsInterventionNow !== true)
      || (evidenceSource !== 'document' && evidenceSource !== 'course')
      || evidenceQuote.length < 2
      || impact.length < 8
      || !hasIndependentEvidence(issueType, quotedText, evidenceSource, evidenceQuote)
      || (evidenceSource === 'document'
        && (!containsEvidence(documentText, evidenceQuote)
          || Boolean(context.documentText && !containsEvidence(context.documentText, evidenceQuote))))
      || (evidenceSource === 'course'
        && (!context.courseText || !containsEvidence(context.courseText, evidenceQuote)))
      || candidate.existingComments?.some((existing) =>
        normalizeDocumentParagraphText(existing) === normalizeDocumentParagraphText(comment)
      )
    ) return;

    const duplicate = results.find((existing) => areDocumentCommentIssuesEquivalent(
      {
        issueType: existing.issueType,
        targetText: existing.quotedText,
        issueKey: existing.issueKey,
        evidenceQuote: existing.evidenceQuote,
      },
      { issueType, targetText: quotedText, issueKey, evidenceQuote },
    ));
    if (duplicate) {
      if (duplicate.candidateId !== candidateId || duplicate.quotedText !== quotedText) {
        duplicate.relatedAnchors ??= [];
        if (!duplicate.relatedAnchors.some((anchor) =>
          anchor.candidateId === candidateId && anchor.quotedText === quotedText
        )) duplicate.relatedAnchors.push({ candidateId, quotedText });
      }
      return;
    }
    results.push({
      candidateId,
      issueType,
      quotedText,
      comment,
      severity: severity as ProactiveDocumentCommentResult['severity'],
      evidenceSource,
      evidenceQuote,
      impact,
      ...(issueKey ? { issueKey } : {}),
    });
  });
  return results;
}

export function buildDocumentCommentReplyPrompts(input: {
  course: Course;
  studentId: string;
  stageKey: string;
  documentText: string;
  targetText: string;
  history: DocumentAiComment[];
  studentReply: string;
  protectedBoundary?: string;
}): { system: string; user: string } {
  const history = input.history.slice(-8).map((comment) =>
    `${comment.role === 'student' ? '学生' : 'AI组员'}：${clean(comment.content, 800)}`
  ).join('\n');
  return {
    system: [
      '你是学生项目小组中的 AI 成员，正在 Word 风格的段落批注线程里与学生讨论一处具体内容。',
      '始终围绕被批注段落和当前成果任务回答，不把对话扩展成泛化聊天，不复述整份项目要求。',
      '先回应学生刚才的想法，再指出它如何影响这段内容；必要时给出比较维度、核验方法或下一步支架。最多提出一个问题。',
      '当学生明确要求删除、改写、精简、整理这段里的具体内容时，你可以像框选修改一样生成局部修改建议，但不能声称已经写入；界面会先显示 Plate 红删绿增标记，并由学生接受或拒绝。',
      'kind=edit-suggestion 时，message 只说明修改理由，不得再次询问是否修改，不得出现“请确认”“是否接受”“要不要应用”等确认提示；接受或拒绝只由界面的修改建议卡表达一次。',
      '修改建议只能处理【批注锚定段落】中的一段连续原文：targetText 必须逐字复制该段中的唯一片段，replacement 是替换结果；删除时 replacement 为空字符串。不得把修改扩大到其他段落。',
      '若学生要求在这段中新增内容，选择相邻的唯一原文作为 targetText：在其后新增时 replacement 必须为“targetText原文 + 新增内容”，在其前新增时为“新增内容 + targetText原文”。不要把新增误写成整段重写。',
      '若学生只是讨论、解释想法或询问原因，返回 discussion，不要擅自生成修改。若请求需要你替学生发明或决定核心问题、关键方案、核心结论，返回 boundary，并提供帮助学生自己判断的支架。',
      '只返回严格 JSON，不使用 Markdown 代码块：',
      '{"kind":"discussion|edit-suggestion|boundary","message":"给学生看的简洁回复","suggestion":null}',
      'kind=edit-suggestion 时 suggestion 必须为：',
      '{"operation":"replace","title":"修改标题","targetText":"逐字复制锚定段落中的唯一原文","replacement":"建议替换文字；删除时为空","reason":"为什么这样修改"}',
    ].join('\n'),
    user: [
      '【项目与课程要求】',
      buildAuthoritativeCourseContext(input.course, input.studentId, input.stageKey),
      '',
      '【当前成果上下文】',
      boundedDocument(input.documentText),
      '',
      '【批注锚定段落】',
      clean(input.targetText, 3_000),
      '',
      '【本批注线程】',
      history || '无',
      '',
      '【学生刚才的回复】',
      clean(input.studentReply, 1_200),
      ...(input.protectedBoundary ? [
        '',
        '【协作边界提醒】',
        `该请求可能涉及学生必须亲自完成的核心工作：${clean(input.protectedBoundary, 200)}。不得返回修改建议。`,
      ] : []),
    ].join('\n'),
  };
}

function uniqueOccurrence(haystack: string, needle: string): boolean {
  const first = haystack.indexOf(needle);
  return first >= 0 && haystack.indexOf(needle, first + needle.length) < 0;
}

export function normalizeDocumentCommentReply(
  raw: unknown,
  targetParagraph = '',
  protectedBoundary?: string,
): DocumentAiCommentReplyResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const message = clean(record.message, 1_200);
  if (!message) return null;
  const requestedKind = clean(record.kind, 40);
  if (protectedBoundary) return { kind: 'boundary', message };

  if (requestedKind === 'edit-suggestion' && record.suggestion && typeof record.suggestion === 'object') {
    const suggestion = record.suggestion as Record<string, unknown>;
    const targetText = clean(suggestion.targetText, 3_000);
    const rawReplacement = typeof suggestion.replacement === 'string'
      ? suggestion.replacement.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, 6_000)
      : '';
    if (
      targetText
      && uniqueOccurrence(targetParagraph, targetText)
      && rawReplacement !== targetText
    ) {
      const rawReason = clean(suggestion.reason, 500);
      const reason = rawReason.replace(/[\p{P}\p{S}\s]/gu, '').length >= 4
        ? rawReason
        : '这项调整可以让当前内容更清楚，同时保持学生对正文的最终决定权。';
      return {
        kind: 'edit-suggestion',
        message: reason,
        suggestion: {
          operation: 'replace',
          title: clean(suggestion.title, 80) || (rawReplacement ? '局部修改建议' : '删除内容建议'),
          targetText,
          replacement: rawReplacement,
          reason,
        },
      };
    }
  }

  return {
    kind: requestedKind === 'boundary' ? 'boundary' : 'discussion',
    message,
  };
}
