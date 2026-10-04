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
import { hasExplicitNativeSourceSequenceUse, pageSourceSequenceUses, scopeSourceSequenceContracts, usesSourceSequence } from './source-sequence-use';
import { hasExplicitFigureScope, selectedFigureIds, type FigureUsePage } from './figure-use';
import { PPT_PAGE_PLANNING_VERSION } from '@/lib/course-design/ppt-page-planning-contract';
import { compactSourceSequenceText as compact, findSourceSequenceLabelPosition,
  hasSourceSequenceLabel, sourceSequenceLabelKey } from './source-sequence-label';
export { hasSourceSequenceLabel, sourceSequenceLabelKey } from './source-sequence-label';

export type FigureSequenceContract = {
  resourceId: string;
  required: boolean;
  knowledgePointIds: readonly string[];
  orderedSteps?: readonly { label: string; sourceBlockId?: string }[];
  coveragePolicy?: 'authored-scope';
  /** Selected source facts; the original whole list still determines counts and true process order. */
  requiredStepLabels?: readonly string[];
  scope?: 'single-page' | 'knowledge-point';
  sequenceSemantics?: 'ordered-steps' | 'enumerated-items';
};

type SequenceContentGroup = {
  statements: readonly string[];
  diagramLabels?: readonly string[];
};

type SequenceDefinition = Pick<FigureSequenceContract, 'orderedSteps' | 'sequenceSemantics'>;

const CHINESE_COUNT: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

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

/** Bind a sequence figure to its first complete, actually owned explanation.
 * An earlier concept overview sharing the knowledge ID does not own a later
 * procedure. Measured plans may move that duty only among their own siblings. */
function firstSequenceTeachingCandidate<T>(
  candidates: readonly T[],
  pageOf: (candidate: T) => { sectionPlanVersion?: string; sourcePageIds?: readonly string[];
    introducesNodeIds?: readonly string[]; deepensNodeIds?: readonly string[];
    teachingBrief?: { teachingPlan?: { introduces?: readonly string[]; deepens?: readonly string[] } };
    resourceNeeds?: readonly { kind: string; assetId?: string }[];
    caseObservation?: { kind?: string; resourceIds?: readonly string[] };
    suggestedImageIds?: readonly string[];
    visualIntent?: { resourceRefs?: readonly { resourceId: string; kind: string }[] } },
  contentOf: (candidate: T) => readonly SequenceContentGroup[],
  orderedSteps?: readonly { label: string }[],
  resourceId?: string,
): T | undefined {
  const first = resourceId ? candidates.find((candidate) => {
    const page = pageOf(candidate);
    return page.resourceNeeds?.some((need) => need.kind === 'source-image' && need.assetId === resourceId)
      || page.caseObservation?.kind === 'source-image' && page.caseObservation.resourceIds?.includes(resourceId)
      || page.suggestedImageIds?.includes(resourceId)
      || page.visualIntent?.resourceRefs?.some((reference) => reference.kind === 'source-image' && reference.resourceId === resourceId);
  }) ?? candidates[0] : candidates[0];
  if (!first) return first;
  const original = pageOf(first);
  if (!orderedSteps?.length) {
    // Native pagination moves a concept's full owned explanation and original
    // together. A preceding text-only fragment is not a new first concept page.
    // Preserve that actual measured responsibility, not merely a media receipt.
    if (original.sectionPlanVersion) {
      const hasOwnedContent = (candidate: T) => {
        const page = pageOf(candidate);
        const owned = page.introducesNodeIds ?? page.teachingBrief?.teachingPlan?.introduces ?? [];
        const deepens = page.deepensNodeIds ?? page.teachingBrief?.teachingPlan?.deepens ?? [];
        return Boolean((owned.length || deepens.length) && contentOf(candidate).slice(1)
          .some((group) => group.statements.some((statement) => statement.trim())));
      };
      if (hasOwnedContent(first)) return first;
      const sourceIds = new Set(original.sourcePageIds ?? []);
      const actualOwner = candidates.find((candidate) => {
        const page = pageOf(candidate);
        return page.sectionPlanVersion === original.sectionPlanVersion
          && page.sourcePageIds?.some((id) => sourceIds.has(id)) && hasOwnedContent(candidate);
      });
      if (actualOwner) return actualOwner;
    }
    return candidates[0];
  }
  const sourceIds = new Set(original.sourcePageIds ?? []);
  return candidates.find((candidate) => {
    const page = pageOf(candidate);
    if (original.sectionPlanVersion) {
      if (page.sectionPlanVersion !== original.sectionPlanVersion
        || !page.sourcePageIds?.some((id) => sourceIds.has(id))) return false;
    } else if (page.sectionPlanVersion) return false;
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
  const numbered = prefix.match(new RegExp(`([一二两三四五六七八九十]|\\d{1,2})\\s*(?:个|种)?${group}[^，,。；;]{0,24}$`, 'u'));
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
  requiredStepLabels?: readonly string[];
  allowPartialDiagram?: boolean;
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
    ? /(?<!第)([一二两三四五六七八九十]|\d{1,2})\s*(?:个|条|项)\s*(?:基本|主要)?\s*(?:原则|建议|策略|要点|特征|特点)/gu
    : /(?<!第)([一二两三四五六七八九十]|\d{1,2})\s*个\s*(?:基本|主要)?\s*(?:流程(?:环节|阶段|步骤)?|环节|阶段|步骤)/gu;
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
  if (input.requireCompleteText || input.requiredStepLabels) {
    const requiredSteps = input.requiredStepLabels
      ? input.orderedSteps.filter((step) => input.requiredStepLabels!.includes(step.label)) : input.orderedSteps;
    const missing = missingSequenceLabels(text, requiredSteps);
    if (missing.length) problems.push(`${enumeration ? '遗漏教材条目' : '遗漏教材步骤'}：${missing.join('、')}`);
  }
  if (!enumeration) {
    for (const statement of groups.flatMap((group) => group.statements)
      .flatMap((value) => value.split(/[。！？!?；;\n]/u))) {
      if (!/(?:流程|步骤|环节)(?:分别|依次)?(?:是|为|包括|分为|由)|(?:首先|然后|随后|接着|依次)|[→⇒]/u.test(statement)) continue;
      const normalized = orderedStatementText(statement);
      const positions = input.orderedSteps.map((step, index) => ({ index,
        position: findSourceSequenceLabelPosition(normalized, step.label) }))
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
      if (!input.requiredStepLabels && !input.allowPartialDiagram && labels.some((label) => !shown.has(label))) problems.push(`辅助顺序图未完整保留教材的 ${labels.length} 个步骤`);
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
        .replace(/(?<!第)([一二两三四五六七八九十]|\d{1,2})\s*个\s*(?:教学设计|教学|设计)\s*(步骤|环节|阶段)/gu, '$1个$2')
        .replace(/(?<!第)([一二两三四五六七八九十]|\d{1,2})\s*步(?=流程|教学|设计)/gu, '$1个步骤'));
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
            sourceIndex, position: findSourceSequenceLabelPosition(normalized, step.label),
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
  const scoped = scopeSourceSequenceContracts(contracts, blueprint.sections.flatMap((section) => section.pages));
  const undeclared = blueprint.sections.flatMap((section, sectionIndex) => section.pages.flatMap((page, pageIndex) => {
    if (page.sourceSequenceUses === undefined && page.teachingBrief?.teachingPlan?.sourceSequenceUses === undefined) return [];
    const projection = projectTeachingPageContent(section, page);
    if (!projection.ownedNodes.some((node) => node.provenance === 'course-source')) return [];
    const text = [...projection.explanation, ...projection.reasoningSteps].join('\n');
    const usedIds = new Set(pageSourceSequenceUses(page).map((use) => use.resourceId));
    const signature = (source: FigureSequenceContract) => source.orderedSteps?.map((step) => sourceSequenceLabelKey(step.label)).sort().join('|');
    return contracts.filter((contract) => contract.coveragePolicy === 'authored-scope'
      && contract.knowledgePointIds.some((id) => page.knowledgePointIds.includes(id))
      && (contract.orderedSteps?.length ?? 0) >= 2
      && contract.orderedSteps!.every((step) => hasSourceSequenceLabel(text, step.label))
      && !contracts.some((chosen) => usedIds.has(chosen.resourceId) && signature(chosen) === signature(contract)))
      .map((contract) => ({ resourceId: contract.resourceId, pageId: page.outlineId ?? page.id,
        sectionIndex, pageIndex, detail: '实际原文解释已使用完整来源清单，须声明 sourceSequenceUses；可选任一真实采用的教材版本，来源元数据不能规避事实检查' }));
  }));
  return [...undeclared, ...scoped.flatMap((contract) => {
    if (!contract.required || !contract.orderedSteps?.length) return [];
    const candidates = blueprint.sections.flatMap((section, sectionIndex) =>
      section.pages.flatMap((page, pageIndex) => page.type === 'slide'
        && usesSourceSequence(page, contract)
        && (page.knowledgePointIds.some((id) => contract.knowledgePointIds.includes(id))
          || hasExplicitNativeSourceSequenceUse(page, contract, section.pptPlanningVersion))
        ? [{ section, sectionIndex, page, pageIndex }] : []));
    if (!candidates.length) return [{ resourceId: contract.resourceId, pageId: '',
      sectionIndex: -1, pageIndex: -1, detail: contract.scope === 'knowledge-point'
        ? '缺少承接教材完整步骤的知识讲解页' : '缺少承接教材原图完整步骤的知识讲解页' }];
    const firstTeachingPage = firstSequenceTeachingCandidate(candidates, (candidate) => candidate.page,
      (candidate) => blueprintSequenceContent(candidate.section, candidate.page), contract.orderedSteps, contract.resourceId);
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
      relatedSequences: scoped.filter((related) => related.required
        && matches.some(({ page, section }) => page.knowledgePointIds.some((id) => related.knowledgePointIds.includes(id))
          || hasExplicitNativeSourceSequenceUse(page, related, section.pptPlanningVersion))),
      requireCompleteText: true, requiredStepLabels: contract.requiredStepLabels }).map((detail) => ({
      resourceId: contract.resourceId, pageId: target.page.outlineId ?? target.page.id,
      sectionIndex: target.sectionIndex, pageIndex: target.pageIndex, detail,
      ...(/^(?:遗漏教材条目|遗漏教材步骤)：/u.test(detail) ? {
        missingCanonicalLabels: missingSequenceLabels(
          contentGroups.flatMap((group) => group.statements).join('\n'), contract.requiredStepLabels
            ? contract.orderedSteps!.filter((step) => contract.requiredStepLabels!.includes(step.label)) : contract.orderedSteps!),
      } : {}),
    }));
  })];
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
    // Selection reasons explain this page's media choice to the author. They
    // are neither spoken source assertions nor rendered teaching content.
    outline.visualIntent?.observationGoal,
    outline.visualIntent?.diagram?.annotation].filter((value): value is string => Boolean(value)),
  diagramLabels: outline.visualIntent?.diagram?.nodes.map((node) => node.label) },
  { statements: [outline.teachingBrief?.explanation,
    ...(outline.teachingBrief?.teachingPlan?.visibleContent ?? [])]
    .filter((value): value is string => Boolean(value)) }];
}

export function firstSourceSequenceTeachingOutline<T extends SceneOutline>(
  candidates: readonly T[], orderedSteps?: readonly { label: string }[], resourceId?: string,
): T | undefined {
  return firstSequenceTeachingCandidate(candidates, (outline) => outline, outlineSequenceContent, orderedSteps, resourceId);
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
        || page.caseObservation?.observableDifference
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
    const outline = firstSourceSequenceTeachingOutline(candidates, resource.orderedSteps, resource.id);
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
  const scoped = scopeSourceSequenceContracts(contracts, outlines);
  for (const contract of scoped.filter((item) => item.required && item.orderedSteps?.length)) {
    const pages = outlines.filter((page) => page.type === 'slide'
      && usesSourceSequence(page, contract)
      && page.generationPurpose === 'knowledge-teaching'
      && (page.knowledgePointIds?.some((id) => contract.knowledgePointIds.includes(id))
        || hasExplicitNativeSourceSequenceUse(page, contract)));
    if (!pages.length) throw new Error(`教材完整步骤 ${contract.resourceId} 缺少知识讲解页`);
    const contentGroups = pages.flatMap(outlineSequenceContent);
    const problems = inspectFigureSequence({ orderedSteps: contract.orderedSteps!, statements: [], contentGroups,
      sequenceSemantics: contract.sequenceSemantics,
      relatedSequences: [...scoped.filter((related) => related.required
        && pages.some((page) => page.knowledgePointIds?.some((id) => related.knowledgePointIds.includes(id))
          || hasExplicitNativeSourceSequenceUse(page, related))),
      ...relatedSequences], requireCompleteText: true, requiredStepLabels: contract.requiredStepLabels });
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

function withRequiredNeed(
  needs: readonly TeachingResourceNeed[] | undefined, resource: CourseTextbookFigureResource,
): TeachingResourceNeed[] {
  const matches = (need: TeachingResourceNeed) => need.kind === 'source-image'
    && (need.assetId === resource.id || Boolean(resource.assetId && need.assetId === resource.assetId));
  const prior = needs?.find(matches);
  return [...(needs ?? []).filter((need) => !matches(need)),
    prior ? { ...prior, assetId: resource.id, required: true } : requiredNeed(resource)];
}

/** Preserve authored media placement, including repeated observations and
 * multipart figures. A measured page's actual image choice outranks a later
 * search for a page containing the book's whole procedure. */
function authoredFigureTargets<T extends FigureUsePage>(
  pages: readonly T[], resource: CourseTextbookFigureResource,
  resources: readonly CourseTextbookFigureResource[],
): T[] {
  const ids = new Set([resource.id, ...(resource.assetId ? [resource.assetId] : [])]);
  const direct = pages.filter((page) => selectedFigureIds(page).some((id) => ids.has(id)));
  if (direct.length || !resource.groupKey) return direct;
  const groupIds = new Set(resources.filter((part) => part.groupKey === resource.groupKey)
    .flatMap((part) => [part.id, ...(part.assetId ? [part.assetId] : [])]));
  return pages.filter((page) => selectedFigureIds(page).some((id) => groupIds.has(id)));
}

/** Persist the same obligation in the source of every later outline rebuild. */
export function bindRequiredTextbookFiguresToBlueprint(
  blueprint: TeachingBlueprint,
  resources: readonly CourseTextbookFigureResource[],
  sourceSequences: readonly FigureSequenceContract[] = [],
  options: { reviewContent?: boolean } = {},
): TeachingBlueprint {
  const result = structuredClone(blueprint);
  const ownedPages = result.sections.flatMap((section) => section.pages.map((page) => ({ section, page })));
  const pages = ownedPages.map(({ page }) => page);
  const explicitScope = hasExplicitFigureScope(pages);
  for (const resource of resources.filter((candidate) => candidate.required)) {
    const candidates = ownedPages.filter(({ page }) => page.type === 'slide'
      && page.knowledgePointIds.some((id) => resource.knowledgePointIds.includes(id)));
    const targets = explicitScope
      ? authoredFigureTargets(pages.filter((page) => page.type === 'slide'), resource, resources)
      : [firstSequenceTeachingCandidate(candidates, (candidate) => candidate.page,
        (candidate) => blueprintSequenceContent(candidate.section, candidate.page), resource.orderedSteps, resource.id)?.page]
        .filter((page): page is TeachingBlueprintPage => Boolean(page));
    if (!targets.length) {
      if (options.reviewContent) throw new Error(`必用教材原图 ${resource.figureId} 没有可绑定的首次知识讲解页。`);
      continue;
    }
    for (const page of pages) {
      if (explicitScope && !targets.includes(page)) continue;
      if (targets.includes(page)) {
        page.resourceNeeds = withRequiredNeed(page.resourceNeeds, resource);
      } else {
        page.resourceNeeds = page.resourceNeeds?.filter((need) =>
          !(need.kind === 'source-image' && need.assetId === resource.id));
      }
      if (!targets.includes(page)) continue;
      if (page.teachingBrief) page.teachingBrief.resourceNeeds = withRequiredNeed(page.teachingBrief.resourceNeeds, resource);
      page.caseObservation = {
        ...page.caseObservation,
        kind: 'source-image', imageWouldHelp: true,
        subjects: [...new Set([...(page.caseObservation?.subjects ?? []), resource.description ?? resource.sourceTitle])],
        resourceIds: unique([...(page.caseObservation?.resourceIds ?? [])
          .map((id) => id === resource.assetId ? resource.id : id), resource.id]),
        observableDifference: page.caseObservation?.observableDifference || resource.description || '观察教材原图的关键结构。',
        reason: page.caseObservation?.reason || resource.description || `本知识点使用《${resource.sourceTitle}》的原图。`,
      };
    }
  }
  const sequenceIssues = options.reviewContent ? findBlueprintFigureSequenceIssues(result, [...resources.map((resource) => ({
    resourceId: resource.id, required: resource.required,
    knowledgePointIds: resource.knowledgePointIds, orderedSteps: resource.orderedSteps,
  })), ...sourceSequences]) : [];
  if (sequenceIssues.length) throw new Error(`教材原图步骤与教学蓝图不一致：${sequenceIssues.map((issue) => issue.detail).join('；')}`);
  return result;
}

function bindResource(
  outline: SceneOutline,
  resource: CourseTextbookFigureResource,
): SceneOutline {
  const native = outline.teachingBrief?.pptPlanningVersion === PPT_PAGE_PLANNING_VERSION;
  const existingRefs = outline.visualIntent?.resourceRefs ?? [];
  const isThisSource = (candidate: VisualResourceReference) => candidate.kind === 'source-image'
    && (candidate.resourceId === resource.id || candidate.resourceId === resource.assetId);
  const prior = existingRefs.find(isThisSource);
  const reference: VisualResourceReference = {
    kind: 'source-image',
    reason: resource.description ?? `Use the original figure from ${resource.sourceTitle}.`,
    ...(!native ? { observationGoal: resource.description } : {}),
    ...prior,
    resourceId: resource.id,
    required: true,
  };
  return {
    ...outline,
    suggestedImageIds: unique([...(outline.suggestedImageIds ?? [])
      .map((id) => id === resource.assetId ? resource.id : id), resource.id]),
    ...(outline.teachingBrief ? { teachingBrief: { ...outline.teachingBrief,
      resourceNeeds: withRequiredNeed(outline.teachingBrief.resourceNeeds, resource),
    } } : {}),
    visualIntent: {
      observationGoal: outline.visualIntent?.observationGoal
        || resource.description
        || `Observe the source figure from ${resource.sourceTitle}.`,
      ...outline.visualIntent,
      representation: representationWithRequiredSource(outline.visualIntent),
      resourceRefs: [
        ...existingRefs.filter((candidate) => !isThisSource(candidate)),
        reference,
      ],
      // Native pages already own the reason and observation contract. The
      // legacy default is not authored meaning and cannot be injected here
      // only to disappear on an otherwise unchanged teacher confirmation.
      ...(outline.visualIntent?.rationale ? { rationale: outline.visualIntent.rationale }
        : !native
          ? { rationale: 'The textbook directly associates this original figure with the knowledge point introduced here.' }
          : {}),
    },
  };
}

/**
 * Keep the actual authored image choices stable through compilation and
 * measured allocation. Legacy accepted plans retain their first-owner rule.
 */
export function bindRequiredTextbookFiguresToOutlines<T extends SceneOutline>(
  outlines: readonly T[],
  resources: readonly CourseTextbookFigureResource[],
  sourceSequences: readonly SequenceDefinition[] = [],
  options: { reviewContent?: boolean } = {},
): T[] {
  let result = outlines.map((outline) => ({ ...outline })) as T[];
  const explicitScope = hasExplicitFigureScope(result);
  for (const resource of resources.filter((candidate) => candidate.required)) {
    const knowledgePointIds = new Set(resource.knowledgePointIds);
    const candidates = result.filter((outline) => (
      outline.type === 'slide'
      && outline.generationPurpose === 'knowledge-teaching'
      && (outline.knowledgePointIds ?? []).some((id) => knowledgePointIds.has(id))
    ));
    const targets = explicitScope
      ? authoredFigureTargets(result.filter((page) => page.type === 'slide'), resource, resources)
      : [firstSourceSequenceTeachingOutline(candidates, resource.orderedSteps, resource.id)]
        .filter((page): page is T => Boolean(page));
    const targetIndices = new Set(targets.map((target) => result.indexOf(target)));
    if (!targetIndices.size) {
      if (options.reviewContent) throw new Error(`必用教材原图 ${resource.figureId} 没有可绑定的首次知识讲解页。`);
      continue;
    }

    result = result.map((outline, index) => {
      if (targetIndices.has(index)) return bindResource(outline, resource) as T;
      if (explicitScope) return outline;
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
  if (options.reviewContent) assertRequiredFigureSequencesInOutlines(result, resources, sourceSequences);
  return result;
}
