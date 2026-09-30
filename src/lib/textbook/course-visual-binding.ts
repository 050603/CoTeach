import type {
  SceneOutline,
  SceneVisualIntent,
  VisualResourceReference,
} from '@/lib/openmaic/types/generation';
import type { CourseEvidenceSnapshot, CourseTextbookFigureResource } from './course-evidence-types';
import { bindKnowledgeSourceSequenceReferences } from './course-evidence-types';
import type {
  KnowledgePoint,
  TeachingBlueprint,
  TeachingBlueprintPage,
  TeachingBlueprintSection,
} from '@/lib/session/types';
import type { TeachingResourceNeed } from '@/lib/course-quality-review/types';
import { projectTeachingPageContent } from '@/lib/course-design/teaching-page-content';

export type FigureSequenceContract = {
  resourceId: string;
  required: boolean;
  knowledgePointIds: readonly string[];
  orderedSteps?: readonly { label: string }[];
  scope?: 'single-page' | 'knowledge-point';
  sequenceSemantics?: 'ordered-steps' | 'enumerated-items';
};

type SequenceContentGroup = {
  statements: readonly string[];
  diagramLabels?: readonly string[];
};

type SequenceDefinition = Pick<FigureSequenceContract, 'orderedSteps' | 'sequenceSemantics'>;

const CHINESE_COUNT: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function compact(value: string): string {
  return value.normalize('NFKC').replace(/[\s，。！？、；：,.!?;:'“”‘’()（）【】\[\]《》<>—_-]+/gu, '');
}

// Only a source's entire “进行 + quoted term” label licenses the shorter term.
// Do not strip meaningful verbs, modifiers, or conditions from ordinary labels.
export function sourceSequenceLabelKey(value: string): string {
  const quotedAction = value.trim().match(/^进行\s*[“「『"‘']([^“”「」『』"‘']+)[”」』"’']$/u);
  return compact(quotedAction?.[1] ?? value);
}

export function hasSourceSequenceLabel(text: string, label: string): boolean {
  const normalized = compact(text);
  const full = compact(label);
  if (normalized.includes(full)) return true;
  const short = sourceSequenceLabelKey(label);
  if (short === full) return false;
  // Naming an entire method (抛锚式教学法) does not teach its 抛锚 step.
  for (let start = normalized.indexOf(short); start >= 0; start = normalized.indexOf(short, start + 1)) {
    if (!/^[式型法]/u.test(normalized.slice(start + short.length))) return true;
  }
  return false;
}

/** Match an entire diagram label against spellings licensed by its source.
 * A quoted action may retain its verb without quotes or use the quoted term;
 * arbitrary diagram labels never license removing meaningful verbs. */
function sourceDiagramLabelKeys(
  diagramLabels: readonly string[],
  orderedSteps: readonly { label: string }[],
): string[] {
  return diagramLabels.map((label) => {
    const full = compact(label);
    const matches = orderedSteps.filter((step) => compact(step.label) === full
      || sourceSequenceLabelKey(step.label) === full);
    return matches.length === 1 ? sourceSequenceLabelKey(matches[0]!.label) : full;
  });
}

function orderedStatementText(value: string): string {
  const listStart = /(?:基本流程|流程|步骤|环节)(?:分别|依次)?(?:是|为|包括|分为|由)/u.exec(value);
  // A method's name can itself contain one action label (抛锚式教学法).
  // Only the actual enumeration owns that action's position in this claim.
  return compact(listStart ? value.slice(listStart.index + listStart[0].length) : value);
}

function coveredLabelCount(text: string, steps: readonly { label: string }[]): number {
  return steps.filter((step) => hasSourceSequenceLabel(text, step.label)).length;
}

function missingSequenceLabels(text: string, steps: readonly { label: string }[]): string[] {
  return steps.filter((step) => !hasSourceSequenceLabel(text, step.label)).map((step) => step.label);
}

/** A measured split keeps an original's obligation on the first sibling that
 * actually teaches its complete sequence. Unrelated pages and raw authoring
 * never move a required original away from its first teaching page. */
function firstSequenceTeachingCandidate<T>(
  candidates: readonly T[],
  pageOf: (candidate: T) => { sectionPlanVersion?: string; sourcePageIds?: readonly string[] },
  contentOf: (candidate: T) => readonly SequenceContentGroup[],
  orderedSteps?: readonly { label: string }[],
): T | undefined {
  const first = candidates[0];
  if (!first || !orderedSteps?.length) return first;
  const original = pageOf(first);
  if (!original.sectionPlanVersion || !original.sourcePageIds?.length) return first;
  const sourceIds = new Set(original.sourcePageIds);
  return candidates.find((candidate) => {
    const page = pageOf(candidate);
    if (page.sectionPlanVersion !== original.sectionPlanVersion
      || !page.sourcePageIds?.some((id) => sourceIds.has(id))) return false;
    // The second group is the actual page brief and visible teaching content.
    // Titles, objectives, evidence quotes and unused unit prose cannot make a
    // partial measured page count as a complete teaching page.
    const actualText = contentOf(candidate).slice(1).flatMap((group) => group.statements).join('\n');
    return missingSequenceLabels(actualText, orderedSteps).length === 0;
  }) ?? first;
}

function countRefersToWholeSequence(sentence: string, match: RegExpMatchArray): boolean {
  const prefix = sentence.slice(0, match.index).trimEnd();
  // Remaining steps, individual lesson positions, and warnings about a wrong
  // count are not claims about the adopted source's complete list.
  if (/(?:后面|后续|剩余|剩下|其余|余下|至少|至多|最多|不超过|不少于|避免(?:写成)?|不得(?:写成)?|不能(?:写成)?|误(?:写成|写为)|不是|并非)\s*$/u.test(prefix)) return false;
  const count = CHINESE_COUNT[match[1]!] ?? Number(match[1]);
  return count !== 1 || /(?:有|共|包含|包括|分为|分成|仅|只|为|是)\s*$/u.test(prefix);
}

type CountCandidate = { signature: string; labels: readonly string[] };
type CountOwner = { hasEvidence: boolean; signature?: string };

function sequenceCountOwner(context: string, candidates: readonly CountCandidate[]): CountOwner {
  const text = compact(context);
  const supported = candidates.map((candidate) => ({ ...candidate,
    matched: new Set(candidate.labels.filter((label) => text.includes(label))) }))
    .filter((candidate) => candidate.matched.size > 0);
  // Extra independent labels are separate lists, not weaker evidence for the
  // longest list. A complete larger source may still own its shared subset.
  const owners = supported.filter((candidate) => supported.every((other) => other === candidate
    || (candidate.matched.size > other.matched.size
      && [...other.matched].every((label) => candidate.matched.has(label)))));
  return { hasEvidence: supported.length > 0,
    ...(owners.length === 1 ? { signature: owners[0]!.signature } : {}) };
}

function localCountPrefix(sentence: string, match: RegExpMatchArray): string {
  const prefix = sentence.slice(0, match.index);
  return prefix.slice(Math.max(prefix.lastIndexOf('，'), prefix.lastIndexOf(',')) + 1);
}

function isDetachedCountReference(input: {
  sentence: string;
  match: RegExpMatchArray;
  candidates: readonly CountCandidate[];
}): boolean {
  const prefix = localCountPrefix(input.sentence, input.match);
  const previousTopic = /(?:上一(?:页|节|课)|前一(?:页|节|课)|前面|前文|先前|此前|之前|刚才)/u.test(prefix);
  const referenceVerb = /(?:回顾|复习|回想|记住|记得|学过|讲过|介绍过|看过|提过|提及过|提到过)/u.test(prefix);
  if (!previousTopic && !referenceVerb) return false;
  // A present list assertion remains a source claim even inside a review.
  // "Remember this list has four stages" must still fail a three-stage source.
  if (/(?:本(?:清单|列表|流程|框架|图)|这(?:一|个|份|组|些)?(?:清单|列表|流程|框架|图)|当前|本页)/u.test(prefix)
    || (!previousTopic && /(?:有|共|共计|共有|包含|包括|分为|分成|覆盖|设有|构成|由)\s*$/u.test(prefix))) return false;
  // Canonical labels attached to the count bind it directly, irrespective of
  // a reference verb. Later clauses about a new topic cannot supply that bind.
  const following = input.sentence.slice(input.match.index)
    .split(/[，,]/u)[0]!;
  const attached = sequenceCountOwner(following, input.candidates);
  const namedBeforeCount = input.candidates.some((candidate) => candidate.labels
    .filter((label) => compact(prefix).includes(label)).length >= 2);
  return !attached.hasEvidence && !namedBeforeCount;
}

function isExplicitWholeCountAssertion(sentence: string, match: RegExpMatchArray): boolean {
  const prefix = localCountPrefix(sentence, match).trimEnd();
  const suffix = sentence.slice(match.index! + match[0].length).trim();
  return /(?:有|共|共计|共有|包含|包括|分为|分成|覆盖|设有|构成|由|为|是)\s*$/u.test(prefix)
    || /^(?:组成|构成|分别是|分别为|依次是|依次为)/u.test(suffix)
    || (!prefix.trim() && !suffix);
}

function isSelectedSubsetCountReference(input: {
  sentence: string;
  match: RegExpMatchArray;
  orderedSteps: readonly { label: string }[];
}): boolean {
  const count = CHINESE_COUNT[input.match[1]!] ?? Number(input.match[1]);
  if (count >= input.orderedSteps.length) return false;
  const prefix = localCountPrefix(input.sentence, input.match).trimEnd();
  const suffix = input.sentence.slice(input.match.index! + input.match[0].length).trimStart();
  // Selecting a subset cannot excuse an assertion that it is the source's
  // complete/basic process. Only the local use count loses whole-list scope.
  if (/(?:基本|主要)/u.test(input.match[0])
    || /(?:全部|所有|全套|完整)(?:的)?\s*$/u.test(prefix)
    || /^(?:就|便|即|已经)?(?:构成|组成|形成|就是|即是|是|为|代表|涵盖|覆盖)[^，,。；;]{0,16}(?:完整|全部|所有|全套|整个|整体|基本|标准)(?:的)?(?:[\p{L}\p{N}]{0,16}(?:流程|过程|清单|列表|环节|阶段|步骤)|$)/u.test(suffix)) return false;
  const selected = /(?:选用|选取|选择|选出|取出|挑选|抽取|提取|采用)\s*(?:其中(?:的)?|前|后|这)?\s*$/u.test(prefix)
    || /(?:其中(?:的)?|前|后)\s*$/u.test(prefix);
  const transferred = /(?:把|将)?\s*(?:这|上述|所选|选定|已选|其中的)\s*$/u.test(prefix)
    && /^(?:放入|放进|纳入|编入|写入|嵌入|迁移到|运用到|应用于|用于|用在|组合成)/u.test(suffix);
  return selected || transferred;
}

function countSpansSeveralGroups(prefix: string): boolean {
  // A total across stages, dimensions or lists cannot be compared with one
  // child list. The exact-item gate continues to check every adopted source.
  const group = '(?:阶段|方面|维度|类别|组|类|清单|列表|流程)';
  const multiple = prefix.match(new RegExp(`(?:各|不同|所有|多个|全部)${group}[^，,。；;]{0,24}$`, 'u'));
  const numbered = prefix.match(new RegExp(`([一二三四五六七八九十]|\\d{1,2})\\s*(?:个|种)?${group}[^，,。；;]{0,24}$`, 'u'));
  const count = numbered ? CHINESE_COUNT[numbered[1]!] ?? Number(numbered[1]) : 0;
  return Boolean(multiple || count > 1);
}

function namedStageCountOwner(input: {
  prefix: string;
  group: SequenceContentGroup;
  relatedSequences: readonly SequenceDefinition[];
  candidates: readonly CountCandidate[];
}): CountOwner {
  const stages = [...new Set([
    ...input.relatedSequences.filter((sequence) => sequence.orderedSteps?.length
      && sequence.orderedSteps.every((step) => /(?:阶段|环节)$/u.test(step.label)))
      .flatMap((sequence) => sequence.orderedSteps!.map((step) => sourceSequenceLabelKey(step.label))),
    ...input.group.statements.flatMap((statement) => [...statement.matchAll(
      /(?:^|[。！？!?；;\n])\s*(?:在|针对|对于)?([\p{L}\p{N}]{1,24}(?:阶段|环节))(?=[:：，,]|的(?:建议|策略|要点)|有|包含|包括|关注|需要)/gu,
    )].map((match) => compact(match[1]!))),
  ])];
  const prefix = compact(input.prefix);
  const named = stages.filter((stage) => prefix.includes(stage));
  if (named.length !== 1) return { hasEvidence: named.length > 1 };
  const evidence = input.group.statements.flatMap((statement) => {
    const text = compact(statement);
    const headings = stages.map((stage) => ({ stage, index: text.indexOf(stage) }))
      .filter((heading) => heading.index >= 0).sort((left, right) => left.index - right.index);
    return headings.flatMap((heading, index) => heading.stage === named[0]
      ? [sequenceCountOwner(text.slice(heading.index, headings[index + 1]?.index), input.candidates)] : []);
  }).filter((owner) => owner.hasEvidence);
  const signatures = new Set(evidence.map((owner) => owner.signature));
  return { hasEvidence: evidence.length > 0,
    ...(signatures.size === 1 && !signatures.has(undefined) ? { signature: evidence[0]!.signature } : {}) };
}

function isCountForSequence(input: {
  sentence: string;
  match: RegExpMatchArray;
  nextMatchIndex?: number;
  group: SequenceContentGroup;
  orderedSteps: readonly { label: string }[];
  relatedSequences: readonly SequenceDefinition[];
  sequenceSemantics?: FigureSequenceContract['sequenceSemantics'];
}): boolean {
  const signature = (steps: readonly { label: string }[]) => steps.map((step) => sourceSequenceLabelKey(step.label)).join('|');
  const ownSignature = signature(input.orderedSteps);
  const candidates = [...new Map([
    { orderedSteps: input.orderedSteps, sequenceSemantics: input.sequenceSemantics },
    ...input.relatedSequences.filter((sequence) => sequence.orderedSteps?.length
      && (sequence.sequenceSemantics ?? 'ordered-steps') === (input.sequenceSemantics ?? 'ordered-steps')),
  ].map((sequence) => [signature(sequence.orderedSteps!), {
    signature: signature(sequence.orderedSteps!), labels: sequence.orderedSteps!.map((step) => sourceSequenceLabelKey(step.label)),
  }])).values()];
  const prefix = localCountPrefix(input.sentence, input.match);
  if (countSpansSeveralGroups(prefix)) return false;
  if (isDetachedCountReference({ sentence: input.sentence, match: input.match, candidates })) return false;
  if (isSelectedSubsetCountReference(input)) return false;
  // The list following a quantity anchors that quantity even when another
  // list shares the page or teaching unit. Fall back to this page's content
  // only for short annotations such as "seven steps in order".
  const localContexts = [
    input.sentence.slice(input.match.index, input.nextMatchIndex),
    input.sentence,
  ];
  for (const context of localContexts) {
    const owner = sequenceCountOwner(context, candidates);
    if (owner.hasEvidence) return owner.signature === ownSignature;
  }
  const namedOwner = namedStageCountOwner({ prefix, group: input.group,
    relatedSequences: input.relatedSequences, candidates });
  if (namedOwner.hasEvidence) return namedOwner.signature === ownSignature;
  const pageContexts = [
    (input.group.diagramLabels ?? []).join('\n'),
    [...input.group.statements, ...(input.group.diagramLabels ?? [])].join('\n'),
  ];
  for (const context of pageContexts) {
    const owner = sequenceCountOwner(context, candidates);
    if (owner.hasEvidence) return owner.signature === ownSignature;
  }
  // A sole mapped source can own an explicit complete-list assertion even
  // before its labels are rendered. Merely mentioning a remembered count does
  // not make it a fact about that source.
  return candidates.length === 1 && isExplicitWholeCountAssertion(input.sentence, input.match);
}

/** Check only source facts that can be verified without interpreting a picture. */
export function inspectFigureSequence(input: {
  orderedSteps: readonly { label: string }[];
  statements: readonly string[];
  diagramLabels?: readonly string[];
  requireCompleteText?: boolean;
  contentGroups?: readonly SequenceContentGroup[];
  relatedSequences?: readonly SequenceDefinition[];
  sequenceSemantics?: FigureSequenceContract['sequenceSemantics'];
}): string[] {
  const labels = input.orderedSteps.map((step) => sourceSequenceLabelKey(step.label));
  if (labels.length < 2) return [];
  const groups = input.contentGroups ?? [{ statements: input.statements, diagramLabels: input.diagramLabels }];
  const text = groups.flatMap((group) => group.statements).join('\n');
  const problems: string[] = [];
  const enumeration = input.sequenceSemantics === 'enumerated-items';
  const quantity = enumeration
    ? /(?<!第)([一二三四五六七八九十]|\d{1,2})\s*(?:个|条|项)\s*(?:基本|主要)?\s*(?:原则|建议|策略|要点|特征|特点)/gu
    : /(?<!第)([一二三四五六七八九十]|\d{1,2})\s*个\s*(?:基本|主要)?\s*(?:流程(?:环节|阶段|步骤)?|环节|阶段|步骤)/gu;
  for (const group of groups) for (const statement of group.statements) {
    for (const sentence of statement.split(/[。！？!?；;\n]/u)) {
      const claims = [...sentence.matchAll(quantity)];
      for (const [index, match] of claims.entries()) {
        if (!countRefersToWholeSequence(sentence, match)
          || !isCountForSequence({ sentence, match, nextMatchIndex: claims[index + 1]?.index,
            group, orderedSteps: input.orderedSteps, relatedSequences: input.relatedSequences ?? [],
            sequenceSemantics: input.sequenceSemantics })) continue;
        const claimed = CHINESE_COUNT[match[1]!] ?? Number(match[1]);
        if (claimed !== labels.length) problems.push(enumeration
          ? `写成 ${claimed} 条，教材正文清单为 ${labels.length} 条`
          : `写成 ${claimed} 个环节，教材原图与原文均为 ${labels.length} 个`);
      }
    }
  }
  if (input.requireCompleteText) {
    const missing = missingSequenceLabels(text, input.orderedSteps);
    if (missing.length) problems.push(`${enumeration ? '遗漏教材条目' : '遗漏教材步骤'}：${missing.join('、')}`);
  }
  if (!enumeration) {
    for (const statement of groups.flatMap((group) => group.statements)
      .flatMap((value) => value.split(/[。！？!?；;\n]/u))) {
      if (!/(?:流程|步骤|环节)(?:分别|依次)?(?:是|为|包括|分为|由)|(?:首先|然后|随后|接着|依次)|[→⇒]/u.test(statement)) continue;
      const normalized = orderedStatementText(statement);
      const positions = labels.map((label, index) => ({ index, position: normalized.indexOf(label) }))
        .filter((entry) => entry.position >= 0).sort((left, right) => left.position - right.position);
      if (positions.some((entry, index) => index > 0 && entry.index < positions[index - 1]!.index)) {
        problems.push(`正文流程未保留教材的 ${labels.length} 个步骤顺序`);
      }
    }
    const diagrams = groups.map((group) => group.diagramLabels ?? []).filter((diagramLabels) => {
      const diagram = sourceDiagramLabelKeys(diagramLabels, input.orderedSteps);
      const ownLabels = diagram.filter((label) => labels.includes(label));
      return !(input.relatedSequences ?? []).some((sequence) => sequence.orderedSteps?.length
        && (sequence.sequenceSemantics ?? 'ordered-steps') === 'ordered-steps'
        && ownLabels.every((label) => sequence.orderedSteps!.some((step) => sourceSequenceLabelKey(step.label) === label))
        && sourceDiagramLabelKeys(diagramLabels, sequence.orderedSteps!)
          .filter((label) => sequence.orderedSteps!.some((step) => sourceSequenceLabelKey(step.label) === label)).length > ownLabels.length);
    }).map((diagramLabels) => sourceDiagramLabelKeys(diagramLabels, input.orderedSteps));
    const related = diagrams.map((diagram) => diagram.filter((label) => labels.includes(label)));
    const shown = new Set(related.flat());
    if (shown.size >= 2) {
      if (labels.some((label) => !shown.has(label))) problems.push(`辅助顺序图未完整保留教材的 ${labels.length} 个步骤`);
      const firstAppearances = [...shown];
      if ([...related, firstAppearances].some((diagram) => diagram.some((label, index) => index > 0
        && labels.indexOf(label) < labels.indexOf(diagram[index - 1]!)))) {
        problems.push(`辅助顺序图未保留教材的 ${labels.length} 个步骤顺序`);
      }
    }
  }
  return [...new Set(problems)];
}

export function findKnowledgeSourceSequenceIssues(
  points: readonly Pick<KnowledgePoint, 'id' | 'name' | 'description' | 'keyInfo' | 'evidenceItemIds'
    | 'sourceId' | 'sourceKnowledgePointIds' | 'sourceSequenceReferences'>[],
  evidence?: CourseEvidenceSnapshot,
): string[] {
  const boundById = new Map(bindKnowledgeSourceSequenceReferences(points, evidence)
    .map((point) => [point.id, point]));
  const referencesIdentity = (references: NonNullable<KnowledgePoint['sourceSequenceReferences']>) =>
    JSON.stringify(references.map((reference) => ({
      resourceId: reference.resourceId,
      sourceEvidenceFingerprint: reference.sourceEvidenceFingerprint,
      sourceEvidenceVersion: reference.sourceEvidenceVersion,
      evidenceItemIds: [...reference.evidenceItemIds].sort(),
      sequenceSemantics: reference.sequenceSemantics,
      orderedSteps: reference.orderedSteps.map((step) => ({
        label: step.label, sourceBlockId: step.sourceBlockId,
        excerpt: step.excerpt, excerptBlockId: step.excerptBlockId,
      })),
    })).sort((left, right) => left.resourceId.localeCompare(right.resourceId)));
  return points.flatMap((point) => {
    const sequences = boundById.get(point.id)?.sourceSequenceReferences ?? [];
    const distinctListCount = new Set(sequences.map((sequence) => JSON.stringify([
      sequence.sequenceSemantics, sequence.orderedSteps.map((step) => sourceSequenceLabelKey(step.label)),
    ]))).size;
    const issues: string[] = [];
    if (evidence && point.sourceSequenceReferences !== undefined) {
      try {
        if (referencesIdentity(point.sourceSequenceReferences) !== referencesIdentity(sequences)) {
          issues.push('来源列表身份、版本或完整条目与当前采用教材不一致');
        }
      } catch {
        issues.push('来源列表引用结构不可核对');
      }
    }
    const statements = [point.name, point.description, point.keyInfo]
      .filter((value): value is string => typeof value === 'string' && Boolean(value))
      .map((value) => value
        .replace(/两(?=\s*(?:个|条|项|步))/gu, '二')
        .replace(/(?<!第)([一二三四五六七八九十]|\d{1,2})\s*个\s*(?:教学设计|教学|设计)\s*(步骤|环节|阶段)/gu, '$1个$2')
        .replace(/(?<!第)([一二三四五六七八九十]|\d{1,2})\s*步(?=流程|教学|设计)/gu, '$1个步骤'));
    // A lesson summary may name representative responsibilities or use short
    // names. Its adopted references carry the entire canonical list upstream;
    // they are never substituted for the executed page/narration gates below.
    const completeEnumeration = /(?:完整|全部|所有).{0,16}(?:流程|步骤|环节|原则|建议|策略|要点|特征|特点)(?:分别|依次)?(?:是|为|包括|分为|如下)|(?:基本流程|流程|步骤|环节|原则|建议|策略|要点|特征|特点)(?:分别|依次)?(?:是|为|包括|分为|由)|(?:分别|依次)(?:是|为)/u;
    for (const sequence of sequences) {
      const relatedSequences = sequences.map((related) => ({
        orderedSteps: related.orderedSteps, sequenceSemantics: related.sequenceSemantics,
      }));
      const requireCompleteText = statements.some((statement) => completeEnumeration.test(statement)
        && (distinctListCount === 1 || coveredLabelCount(statement, sequence.orderedSteps) >= 2));
      issues.push(...inspectFigureSequence({
        orderedSteps: sequence.orderedSteps, statements, requireCompleteText,
        sequenceSemantics: sequence.sequenceSemantics, relatedSequences,
      }));
      if (sequence.sequenceSemantics === 'ordered-steps') {
        // Independent source lists may share a closing label (e.g. 效果评价).
        // A preceding list's first occurrence cannot determine this list's order.
        for (const statement of statements.flatMap((text) => text.split(/[。！？!?；;\n]/u))) {
          if (!completeEnumeration.test(statement) && !/(?:首先|先|然后|随后|接着|再|最后|依次)/u.test(statement)) continue;
          const normalized = orderedStatementText(statement);
          const namedSteps = sequence.orderedSteps.map((step, sourceIndex) => ({
            sourceIndex, position: normalized.indexOf(sourceSequenceLabelKey(step.label)),
          })).filter((step) => step.position >= 0).sort((left, right) => left.position - right.position);
          if (namedSteps.some((step, index) => index > 0 && step.sourceIndex < namedSteps[index - 1]!.sourceIndex)) {
            issues.push(`摘要步骤未保留教材的 ${sequence.orderedSteps.length} 个步骤顺序`);
          }
        }
      }
    }
    return [...new Set(issues)].map((issue) => `知识点“${point.name}”与教材完整步骤不一致：${issue}`);
  });
}

export function findBlueprintFigureSequenceIssues(
  blueprint: Pick<TeachingBlueprint, 'sections'>,
  contracts: readonly FigureSequenceContract[],
): Array<{ resourceId: string; pageId: string; sectionIndex: number; pageIndex: number; detail: string;
  missingCanonicalLabels?: string[] }> {
  return contracts.flatMap((contract) => {
    if (!contract.required || !contract.orderedSteps?.length) return [];
    const candidates = blueprint.sections.flatMap((section, sectionIndex) =>
      section.pages.flatMap((page, pageIndex) => page.type === 'slide'
        && page.knowledgePointIds.some((id) => contract.knowledgePointIds.includes(id))
        ? [{ section, sectionIndex, page, pageIndex }] : []));
    if (!candidates.length) return [{ resourceId: contract.resourceId, pageId: '',
      sectionIndex: -1, pageIndex: -1, detail: contract.scope === 'knowledge-point'
        ? '缺少承接教材完整步骤的知识讲解页' : '缺少承接教材原图完整步骤的知识讲解页' }];
    const firstTeachingPage = firstSequenceTeachingCandidate(candidates, (candidate) => candidate.page,
      (candidate) => blueprintSequenceContent(candidate.section, candidate.page), contract.orderedSteps);
    const matches = contract.scope === 'knowledge-point' ? candidates : firstTeachingPage ? [firstTeachingPage] : [];
    const projectedMatches = matches.map((match) => {
      const contentGroups = blueprintSequenceContent(match.section, match.page);
      return { ...match, contentGroups, coveredItems: coveredLabelCount(
        contentGroups.flatMap((group) => group.statements).join('\n'), contract.orderedSteps!) };
    });
    const contentGroups = projectedMatches.flatMap((match) => match.contentGroups);
    // A source list can span several knowledge points. Locate repairs where
    // its actual explanation is developed instead of on an earlier theory page.
    const target = contract.scope === 'knowledge-point'
      ? projectedMatches.reduce((best, candidate) => candidate.coveredItems > best.coveredItems ? candidate : best)
      : projectedMatches[0]!;
    return inspectFigureSequence({ orderedSteps: contract.orderedSteps, statements: [], contentGroups,
      sequenceSemantics: contract.sequenceSemantics,
      relatedSequences: contracts.filter((related) => related.required
        && matches.some(({ page }) => page.knowledgePointIds.some((id) => related.knowledgePointIds.includes(id)))),
      requireCompleteText: true }).map((detail) => ({
      resourceId: contract.resourceId, pageId: target.page.outlineId ?? target.page.id,
      sectionIndex: target.sectionIndex, pageIndex: target.pageIndex, detail,
      ...(/^(?:遗漏教材条目|遗漏教材步骤)：/u.test(detail) ? {
        missingCanonicalLabels: missingSequenceLabels(
          contentGroups.flatMap((group) => group.statements).join('\n'), contract.orderedSteps!),
      } : {}),
    }));
  });
}

type SequencePageContent = Pick<SceneOutline,
  'description' | 'teachingObjective' | 'keyPoints' | 'visualIntent'> & {
  teachingBrief?: {
    explanation: string;
    teachingPlan?: { visibleContent: readonly string[] };
  };
};

function outlineSequenceContent(outline: SequencePageContent): SequenceContentGroup[] {
  return [{ statements: [outline.description, outline.teachingObjective,
    ...(outline.teachingBrief?.teachingPlan?.visibleContent ?? outline.keyPoints ?? []),
    outline.visualIntent?.observationGoal, outline.visualIntent?.rationale,
    outline.visualIntent?.diagram?.annotation].filter((value): value is string => Boolean(value)),
  diagramLabels: outline.visualIntent?.diagram?.nodes.map((node) => node.label) },
  { statements: [outline.teachingBrief?.explanation,
    ...(outline.teachingBrief?.teachingPlan?.visibleContent ?? [])]
    .filter((value): value is string => Boolean(value)) }];
}

function blueprintSequenceContent(
  section: TeachingBlueprintSection,
  page: TeachingBlueprintPage,
): SequenceContentGroup[] {
  // A measured section plan replaces the original node projection with its
  // accepted brief. Use the same choice and visible content as the compiler.
  let teachingBrief: SequencePageContent['teachingBrief'] = page.sectionPlanVersion ? page.teachingBrief : undefined;
  if (!teachingBrief) {
    const projection = projectTeachingPageContent(section, page);
    teachingBrief = { explanation: [...projection.explanation, ...projection.reasoningSteps].join('\n'),
      teachingPlan: { visibleContent: projection.visibleContent } };
  }
  return outlineSequenceContent({
    description: page.description,
    teachingObjective: page.teachingObjective,
    keyPoints: [...(teachingBrief.teachingPlan?.visibleContent ?? page.keyPoints)],
    teachingBrief,
    visualIntent: {
      representation: page.visualRelationship?.diagram ? 'native-diagram' : 'text',
      observationGoal: page.visualRelationship?.description
        || page.resourceNeeds?.map((need) => need.purpose).join('；')
        || page.teachingObjective,
      diagram: page.visualRelationship?.diagram,
      rationale: page.visualRelationship?.rationale,
    },
  });
}

export function assertRequiredFigureSequencesInOutlines(
  outlines: readonly SceneOutline[],
  resources: readonly CourseTextbookFigureResource[],
  relatedSequences: readonly SequenceDefinition[] = [],
): void {
  for (const resource of resources.filter((item) => item.required && item.orderedSteps?.length)) {
    const candidates = outlines.filter((page) => page.type === 'slide'
      && page.generationPurpose === 'knowledge-teaching'
      && page.knowledgePointIds?.some((id) => resource.knowledgePointIds.includes(id)));
    const outline = firstSequenceTeachingCandidate(candidates, (page) => page, outlineSequenceContent, resource.orderedSteps);
    if (!outline) throw new Error(`教材原图 ${resource.figureId} 缺少对应知识讲解页`);
    const problems = inspectFigureSequence({ orderedSteps: resource.orderedSteps!, statements: [],
      contentGroups: outlineSequenceContent(outline),
      relatedSequences: [...resources, ...relatedSequences],
      requireCompleteText: true });
    if (problems.length) throw new Error(`教材原图 ${resource.figureId} 与课程大纲不一致：${problems.join('；')}`);
  }
}

export function assertSourceSequencesInOutlines(
  outlines: readonly SceneOutline[],
  contracts: readonly FigureSequenceContract[],
  relatedSequences: readonly SequenceDefinition[] = [],
): void {
  for (const contract of contracts.filter((item) => item.required && item.orderedSteps?.length)) {
    const pages = outlines.filter((page) => page.type === 'slide'
      && page.generationPurpose === 'knowledge-teaching'
      && page.knowledgePointIds?.some((id) => contract.knowledgePointIds.includes(id)));
    if (!pages.length) throw new Error(`教材完整步骤 ${contract.resourceId} 缺少知识讲解页`);
    const contentGroups = pages.flatMap(outlineSequenceContent);
    const problems = inspectFigureSequence({ orderedSteps: contract.orderedSteps!, statements: [], contentGroups,
      sequenceSemantics: contract.sequenceSemantics,
      relatedSequences: [...contracts.filter((related) => related.required
        && pages.some((page) => page.knowledgePointIds?.some((id) => related.knowledgePointIds.includes(id)))),
      ...relatedSequences], requireCompleteText: true });
    if (problems.length) throw new Error(`教材完整步骤 ${contract.resourceId} 与课程大纲不一致：${problems.join('；')}`);
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function assertRequiredTextbookFiguresAvailable(
  resources: readonly CourseTextbookFigureResource[],
): void {
  const unavailable = resources.filter((resource) => resource.required && resource.status !== 'available');
  if (!unavailable.length) return;
  throw new Error([
    '教材中与本课知识点直接关联的必用原图不可读取，课程不能标记为完整生成。',
    ...unavailable.map((resource) => `${resource.sourceTitle} / ${resource.figureId}：${resource.failureReason ?? '图片不可用'}`),
  ].join('\n'));
}

function withoutResource(
  intent: SceneVisualIntent | undefined,
  resourceId: string,
): SceneVisualIntent | undefined {
  if (!intent?.resourceRefs?.some((reference) => reference.resourceId === resourceId)) return intent;
  const resourceRefs = intent.resourceRefs.filter((reference) => reference.resourceId !== resourceId);
  return { ...intent, ...(resourceRefs.length ? { resourceRefs } : { resourceRefs: undefined }) };
}

function representationWithRequiredSource(intent: SceneVisualIntent | undefined): SceneVisualIntent['representation'] {
  if (!intent || intent.representation === 'text' || intent.representation === 'source-image') {
    return 'source-image';
  }
  return 'mixed';
}

function requiredNeed(resource: CourseTextbookFigureResource): TeachingResourceNeed {
  return { kind: 'source-image', assetId: resource.id, required: true,
    purpose: resource.description ?? `观察《${resource.sourceTitle}》中的教材原图。` };
}

/** Persist the same obligation in the source of every later outline rebuild. */
export function bindRequiredTextbookFiguresToBlueprint(
  blueprint: TeachingBlueprint,
  resources: readonly CourseTextbookFigureResource[],
  sourceSequences: readonly FigureSequenceContract[] = [],
): TeachingBlueprint {
  const result = structuredClone(blueprint);
  const ownedPages = result.sections.flatMap((section) => section.pages.map((page) => ({ section, page })));
  const pages = ownedPages.map(({ page }) => page);
  for (const resource of resources.filter((candidate) => candidate.required)) {
    const candidates = ownedPages.filter(({ page }) => page.type === 'slide'
      && page.knowledgePointIds.some((id) => resource.knowledgePointIds.includes(id)));
    const target = firstSequenceTeachingCandidate(candidates, (candidate) => candidate.page,
      (candidate) => blueprintSequenceContent(candidate.section, candidate.page), resource.orderedSteps)?.page;
    if (!target) throw new Error(`必用教材原图 ${resource.figureId} 没有可绑定的首次知识讲解页。`);
    for (const page of pages) {
      page.resourceNeeds = page.resourceNeeds?.filter((need) =>
        !(need.kind === 'source-image' && need.assetId === resource.id));
      if (page !== target) continue;
      page.resourceNeeds = [...(page.resourceNeeds ?? []), requiredNeed(resource)];
      if (page.teachingBrief) page.teachingBrief.resourceNeeds = [...(page.teachingBrief.resourceNeeds ?? [])
        .filter((need) => !(need.kind === 'source-image' && need.assetId === resource.id)), requiredNeed(resource)];
      page.caseObservation = {
        ...page.caseObservation,
        kind: 'source-image', imageWouldHelp: true,
        subjects: [...new Set([...(page.caseObservation?.subjects ?? []), resource.description ?? resource.sourceTitle])],
        resourceIds: unique([...(page.caseObservation?.resourceIds ?? []), resource.id]),
        observableDifference: page.caseObservation?.observableDifference || resource.description || '观察教材原图的关键结构。',
        reason: resource.description ?? `本知识点使用《${resource.sourceTitle}》的原图。`,
      };
    }
  }
  const sequenceIssues = findBlueprintFigureSequenceIssues(result, [...resources.map((resource) => ({
    resourceId: resource.id, required: resource.required,
    knowledgePointIds: resource.knowledgePointIds, orderedSteps: resource.orderedSteps,
  })), ...sourceSequences]);
  if (sequenceIssues.length) throw new Error(`教材原图步骤与教学蓝图不一致：${sequenceIssues.map((issue) => issue.detail).join('；')}`);
  return result;
}

function bindResource(
  outline: SceneOutline,
  resource: CourseTextbookFigureResource,
): SceneOutline {
  const reference: VisualResourceReference = {
    resourceId: resource.id,
    kind: 'source-image',
    required: true,
    reason: resource.description ?? `Use the original figure from ${resource.sourceTitle}.`,
    observationGoal: resource.description,
  };
  const existingRefs = outline.visualIntent?.resourceRefs ?? [];
  return {
    ...outline,
    suggestedImageIds: unique([...(outline.suggestedImageIds ?? []), resource.id]),
    ...(outline.teachingBrief ? { teachingBrief: { ...outline.teachingBrief,
      resourceNeeds: [...(outline.teachingBrief.resourceNeeds ?? [])
        .filter((need) => !(need.kind === 'source-image' && need.assetId === resource.id)), requiredNeed(resource)],
    } } : {}),
    visualIntent: {
      observationGoal: outline.visualIntent?.observationGoal
        || resource.description
        || `Observe the source figure from ${resource.sourceTitle}.`,
      ...outline.visualIntent,
      representation: representationWithRequiredSource(outline.visualIntent),
      resourceRefs: [
        ...existingRefs.filter((candidate) => candidate.resourceId !== resource.id),
        reference,
      ],
      rationale: outline.visualIntent?.rationale
        || 'The textbook directly associates this original figure with the knowledge point introduced here.',
    },
  };
}

/**
 * Place each required textbook figure exactly on the first complete slide for
 * its linked knowledge point. The model still chooses optional visuals, while
 * this direct evidence contract cannot be silently moved to a review page.
 */
export function bindRequiredTextbookFiguresToOutlines<T extends SceneOutline>(
  outlines: readonly T[],
  resources: readonly CourseTextbookFigureResource[],
  sourceSequences: readonly SequenceDefinition[] = [],
): T[] {
  let result = outlines.map((outline) => ({ ...outline })) as T[];
  for (const resource of resources.filter((candidate) => candidate.required)) {
    const knowledgePointIds = new Set(resource.knowledgePointIds);
    const candidates = result.filter((outline) => (
      outline.type === 'slide'
      && outline.generationPurpose === 'knowledge-teaching'
      && (outline.knowledgePointIds ?? []).some((id) => knowledgePointIds.has(id))
    ));
    const target = firstSequenceTeachingCandidate(candidates, (page) => page, outlineSequenceContent, resource.orderedSteps);
    const targetIndex = target ? result.indexOf(target) : -1;
    if (targetIndex < 0) {
      throw new Error(`必用教材原图 ${resource.figureId} 没有可绑定的首次知识讲解页。`);
    }

    result = result.map((outline, index) => {
      if (index === targetIndex) return bindResource(outline, resource) as T;
      const suggestedImageIds = outline.suggestedImageIds?.filter((id) => id !== resource.id);
      const visualIntent = withoutResource(outline.visualIntent, resource.id);
      const teachingBrief = outline.teachingBrief ? { ...outline.teachingBrief,
        resourceNeeds: outline.teachingBrief.resourceNeeds?.filter((need) =>
          !(need.kind === 'source-image' && need.assetId === resource.id)),
      } : undefined;
      return {
        ...outline,
        ...(suggestedImageIds?.length ? { suggestedImageIds } : { suggestedImageIds: undefined }),
        ...(visualIntent ? { visualIntent } : { visualIntent: undefined }),
        ...(teachingBrief ? { teachingBrief } : {}),
      } as T;
    });
  }
  assertRequiredFigureSequencesInOutlines(result, resources, sourceSequences);
  return result;
}
