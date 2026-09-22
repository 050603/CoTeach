import type { Course } from '@/lib/session/types';

import { buildAuthoritativeCourseContext } from './document-policy';
import type {
  DocumentAiComment,
  DocumentAiCommentReplyResult,
} from './document-comment-types';

export const DOCUMENT_COMMENT_REVIEW_VERSION = 4;
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
  left: { issueType?: string; targetText: string },
  right: { issueType?: string; targetText: string },
): boolean {
  if (canonicalIssueType(left.issueType ?? '') !== canonicalIssueType(right.issueType ?? '')) {
    return false;
  }
  const leftTarget = normalizeDocumentParagraphText(left.targetText)
    .replace(/[\s，,。.!！?？；;：“”‘’'"（）()]/g, '');
  const rightTarget = normalizeDocumentParagraphText(right.targetText)
    .replace(/[\s，,。.!！?？；;：“”‘’'"（）()]/g, '');
  if (!leftTarget || !rightTarget) return false;
  return leftTarget === rightTarget
    || (Math.min(leftTarget.length, rightTarget.length) >= 4
      && (leftTarget.includes(rightTarget) || rightTarget.includes(leftTarget)));
}

function clean(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001F]/g, '').trim().slice(0, maxLength)
    : '';
}

function boundedDocument(value: string): string {
  const text = clean(value, 40_000);
  if (text.length <= 10_000) return text;
  return `${text.slice(0, 5_500)}\n\n……（中间内容省略）……\n\n${text.slice(-4_000)}`;
}

const PROACTIVE_COMMENT_STYLE_RULES = [
  '你是正在与学生共同制作项目成果的 AI 小组成员。现在不是伴学提醒、课堂主持或通用写作点评，而是一次针对文档具体段落的组内批注。',
  '只有当目标段落存在明确且值得现在讨论的问题时才发批注，例如：语言错误、表达含混、关键概念含糊、理由与结论脱节、证据缺口、与项目要求不一致、事实需要核验、方案取舍缺少依据。',
  '不要因为段落不完整就催促学生，不要泛泛表扬，不要重复项目要求，不要直接改写段落，也不要替学生完成核心判断。每条批注只谈一个问题，不能在一条批注里罗列多个问题。',
  '像真实组员在文档边上留一句话那样自然表达：直接提到段落里的具体词句，说清最值得现在注意的一件事；有必要时自然地追问一句。使用一到两句连贯短句，控制在 140 个汉字以内。',
  '可以用问句激发学生思考，但只能问一个贴着原文、能够帮助小组继续判断的问题。语气应当像“这里的‘最好’是更省时间，还是效果更好？”这样的同伴商量，不要用“你是否考虑过”“请说明”“请论证”等教师审问式措辞。',
  '不得使用“观察：”“影响：”“问题：”“提问：”“建议：”“下一步：”等栏目标签，不要列序号、清单或小标题，也不要把回复写成评价报告。不要自称老师、助手或 AI。',
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
      ...PROACTIVE_COMMENT_STYLE_RULES,
      '只返回严格 JSON：{"shouldComment":true|false,"comment":"给学生看的段落批注；不需要介入时为空字符串"}',
    ].join('\n'),
    user: [
      '【项目与课程要求】',
      buildAuthoritativeCourseContext(input.course, input.studentId, input.stageKey),
      '',
      '【正在制作的完整成果上下文】',
      boundedDocument(input.documentText),
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
};

export type ProactiveDocumentReviewFocus = 'language' | 'reasoning';

const LANGUAGE_REVIEW_RULES = [
  '本轮只做中文语言与表达质量审阅，必须逐句检查，不能因为内容大意可理解就跳过基础问题。',
  '按以下清单在内部静默检查，不要把清单或分类标签写给学生：错别字与标点；标题语序和并列结构；主谓、动宾、定中搭配；成分残缺或赘余；语序错乱；句式杂糅；指代不明；修饰语位置不当；时间表达重复或矛盾；方位词堆叠；重复比较；成语堆砌、误用或语体不合；同义反复；术语、数字、单位和时态不一致。',
  '只要存在能够引用原文并明确说明的错别字、搭配不当、语序问题、成分残缺等基础语病，就应当介入。“宁可不介入”只适用于没有客观依据的个人风格偏好，不得用来忽略可定位的语言错误。',
  '也检查虽然不算硬性语法错误、但明显妨碍清楚、准确、简洁表达的句子。仅仅是另一种个人写作偏好时不要介入。',
  '基础语病与明显表达问题不得让位于项目逻辑点评；能明确指出依据的都应在本轮一次找全。',
];

const REASONING_REVIEW_RULES = [
  '本轮只做逻辑、证据与项目任务审阅。检查概念是否明确、理由能否支持结论、事实是否需要核验、因果与比较是否成立、是否以偏概全或前后矛盾、方案取舍是否有依据，以及内容是否偏离项目目标和当前任务。',
  '不要重复语言审阅会处理的纯语法或措辞问题。对于跨句关系，引用支撑判断所必需的连续句子；只有问题确实涉及整段结构时才引用整段。',
];

export function buildBatchProactiveDocumentCommentPrompts(input: {
  course: Course;
  studentId: string;
  stageKey: string;
  documentText: string;
  candidates: ProactiveDocumentCommentCandidate[];
  reviewFocus: ProactiveDocumentReviewFocus;
}): { system: string; user: string } {
  const focusRules = input.reviewFocus === 'language'
    ? LANGUAGE_REVIEW_RULES
    : REASONING_REVIEW_RULES;
  return {
    system: [
      ...PROACTIVE_COMMENT_STYLE_RULES,
      ...focusRules,
      '你会同时收到多个候选段落。必须逐段独立、一次完整地检查，不能只检查最后一段，也不能发现一个问题就停止。一个段落若有多个彼此独立且值得提醒的问题，必须为同一个 candidateId 返回多条记录，每条记录只讨论一个问题，让学生能够分别回复。',
      '尽量在本轮找全同类和相关问题，避免学生解决一条后才发现下一条。每段最多返回 10 条高置信度批注，不要为了凑数量制造问题。没有明显问题的段落不要返回。',
      '输入中的 existingComments 是该段已有的历史批注，不得重复这些问题；只补充尚未指出的独立问题。',
      '每个问题都必须提供 quotedText：它必须是候选段落中逐字复制、连续且只出现一次的最小必要原文。词语或句法问题通常只引用所在分句或单句；跨句逻辑问题引用必要的连续句子；只有整段结构都有问题时才允许引用整段。不得改字、补字、概括或使用省略号。',
      'issueType 使用简短准确的中文名称，例如“标题语序”“时间表达冗余”“方位词堆砌”“重复比较”“成语误用”“动宾搭配”“成分残缺”“指代不明”“标点”“事实核验”“证据不足”“逻辑跳跃”“项目一致性”。comment 要直接说明 quotedText 的具体问题及其影响，必要时给一个自然问句或简短修改方向，但不要复述整段原文。',
      'candidateId 必须逐字复制输入值。只返回严格 JSON，不使用 Markdown 代码块：',
      '{"comments":[{"candidateId":"候选ID","issueType":"问题类型","quotedText":"逐字原文","comment":"给学生看的自然组员批注"}]}',
    ].join('\n'),
    user: [
      '【项目与课程要求】',
      buildAuthoritativeCourseContext(input.course, input.studentId, input.stageKey),
      '',
      '【正在制作的完整成果上下文】',
      boundedDocument(input.documentText),
      '',
      '【本轮需要逐段独立检查的候选段落】',
      JSON.stringify(input.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        blockIndex: candidate.blockIndex,
        text: clean(candidate.targetText, 3_000),
        existingComments: (candidate.existingComments ?? [])
          .slice(-8)
          .map((comment) => clean(comment, 600)),
      }))),
      '',
      `【本轮审阅重点】${input.reviewFocus === 'language' ? '中文语法与表达准确性' : '逻辑、证据与项目任务'}`,
      '请一次完成所有候选段落的判断，只返回能够精确引用原文、确有必要显示的批注。',
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

export function normalizeProactiveDocumentComment(raw: unknown): {
  shouldComment: boolean;
  comment: string;
} {
  if (!raw || typeof raw !== 'object') return { shouldComment: false, comment: '' };
  const record = raw as Record<string, unknown>;
  const comment = naturalizeProactiveComment(record.comment);
  return {
    shouldComment: record.shouldComment === true && comment.length >= 8,
    comment,
  };
}

export function normalizeBatchProactiveDocumentComments(
  raw: unknown,
  candidates: ProactiveDocumentCommentCandidate[],
): ProactiveDocumentCommentResult[] {
  if (!raw || typeof raw !== 'object') return [];
  const comments = (raw as Record<string, unknown>).comments;
  if (!Array.isArray(comments)) return [];
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  const candidateById = new Map(candidates.map((candidate) => [
    candidate.candidateId,
    candidate,
  ]));

  return comments.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const candidateId = clean(record.candidateId, 160);
    const candidate = candidateById.get(candidateId);
    const issueType = clean(record.issueType, 40) || '表达问题';
    const quotedText = clean(record.quotedText, 3_000);
    const comment = naturalizeProactiveComment(record.comment);
    if (
      !candidate
      || !quotedText
      || !uniqueOccurrence(candidate.targetText, quotedText)
      || comment.length < 8
    ) return [];
    const fingerprint = `${candidateId}:${issueType}:${quotedText.replace(/\s+/g, '')}`;
    const count = counts.get(candidateId) ?? 0;
    if (seen.has(fingerprint) || count >= 10) return [];
    seen.add(fingerprint);
    counts.set(candidateId, count + 1);
    return [{ candidateId, issueType, quotedText, comment }];
  });
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
