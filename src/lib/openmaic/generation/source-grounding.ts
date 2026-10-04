import type { SceneOutline } from '@/lib/openmaic/types/generation';
import type { KnowledgePoint } from '@/lib/session/types';
import type { CourseEvidenceItem, CourseEvidenceSnapshot, CourseEvidenceSource } from '@/lib/textbook/course-evidence-types';
import type { FigureSequenceContract } from '@/lib/textbook/course-visual-binding';
import { hasExplicitNativeSourceSequenceUse, usesSourceSequence } from '@/lib/textbook/source-sequence-use';
import { authoringEvidenceBlocks, normalizeAuthoringSourceBindings, type AuthoringSourceBinding } from '@/lib/course-design/knowledge-authoring';
import { PPT_PAGE_PLANNING_VERSION } from '@/lib/course-design/ppt-page-planning-contract';

export type SourceGroundingKnowledgePoint = Pick<KnowledgePoint,
  'id' | 'evidenceItemIds' | 'sourceId' | 'sourceKnowledgePointIds' | 'authoring'>;

function adoptedWholePassage(item: CourseEvidenceItem): boolean {
  const ids = item.source.sourceBlockIds;
  return item.kind === 'source-block' && !item.completeSourceBlocks?.length && Boolean(item.content.trim())
    && Boolean(ids?.length && ids.every((id) => typeof id === 'string' && id.trim())
      && new Set(ids).size === ids.length);
}

/** Reopen only explicitly adopted lists under their immutable source identity.
 * A list excerpt is a readable source block even when retrieval saved only its
 * anchor. Whole adopted units remain separate from their constituent blocks. */
function nativeSourceCatalog(evidence: CourseEvidenceSnapshot | undefined, contracts: readonly FigureSequenceContract[],
  allowedIds: ReadonlySet<string>) {
  if (!evidence) return evidence;
  return { ...evidence, items: evidence.items.map((item) => {
    if (!allowedIds.has(item.id)) return item;
    const blocks = new Map(authoringEvidenceBlocks(item).map((block) => [block.id,
      { sourceBlockId: block.id, content: block.content, source: block.source ?? item.source }]));
    const sequences = [
      ...(item.sourceSequences ?? []).map((sequence) => ({ resourceId: `source-sequence:${sequence.anchorSourceBlockId}`, sequence })),
      ...(item.figureSequences ?? []).map((sequence) => ({ resourceId: `figure-sequence:${sequence.figureId}`, sequence })),
    ];
    for (const { resourceId, sequence } of sequences) {
      const contract = contracts.find((candidate) => candidate.resourceId === resourceId);
      if (!contract) continue;
      if (JSON.stringify(contract.orderedSteps?.map(({ label, sourceBlockId }) => [label, sourceBlockId]))
        !== JSON.stringify(sequence.steps.map(({ label, sourceBlockId }) => [label, sourceBlockId]))) {
        throw new Error(`页面教材序列与已采用原文身份冲突：${resourceId}`);
      }
      for (const step of sequence.steps) for (const block of [
        { sourceBlockId: step.sourceBlockId, content: step.label },
        ...(step.excerptBlockId && step.excerpt ? [{ sourceBlockId: step.excerptBlockId, content: step.excerpt }] : []),
      ]) if (!blocks.has(block.sourceBlockId)) blocks.set(block.sourceBlockId, { ...block, source: item.source });
    }
    return { ...item, completeSourceBlocks: [...blocks.values()] };
  }) };
}

function nativeSourceBindings(raw: readonly AuthoringSourceBinding[], evidence: CourseEvidenceSnapshot | undefined,
  catalog: CourseEvidenceSnapshot | undefined, allowedIds: readonly string[]): AuthoringSourceBinding[] {
  const result: AuthoringSourceBinding[] = [];
  for (const binding of raw) {
    const item = evidence?.items.find((candidate) => candidate.id === binding.evidenceItemId);
    if (!item || !allowedIds.includes(item.id)) continue;
    if (binding.textbookId !== item.source.textbookId || binding.revisionId !== item.source.revisionId) {
      throw new Error(`页面原文绑定与已采用教材或版本身份不一致：${item.id}`);
    }
    const ids = binding.sourceBlockIds;
    const whole = adoptedWholePassage(item) && ids.length === item.source.sourceBlockIds!.length
      && new Set(ids).size === ids.length && ids.every((id) => item.source.sourceBlockIds!.includes(id));
    if (whole && (!binding.quote || item.content.includes(binding.quote))) result.push(binding);
    else result.push(...normalizeAuthoringSourceBindings([binding], catalog, allowedIds));
  }
  return [...new Map(result.map((binding) => [JSON.stringify(binding), binding])).values()];
}

function definingSourceSentence(label: string, descriptions: readonly string[] | undefined): string | undefined {
  // A named characteristic is a heading, not a complete teaching claim.
  // Its defining sentence remains original source wording; subsequent source
  // reasoning stays available for the teacher's natural explanation and case.
  if (!/性$/u.test(label) || /(?:是|具有|注意|保持|确保|需要|要求|培养|提高|增强|坚持|遵循)/u.test(label)) return undefined;
  const description = descriptions?.[0];
  return description?.match(/^[\s\S]+?[。！？]/u)?.[0] ?? description;
}

function originalDefinitionSentence(quote: string): string | undefined {
  const sentence = quote.match(/^[\s\S]+?[。！？](?:[”’"」』])?/u)?.[0];
  if (!sentence) return undefined;
  // Recognize an explicit source definition, not a historical attribution or
  // recommendation. A contextual "在…中，" does not change its exact wording.
  const definition = sentence.match(/^(?:在[^，,。！？；;：:\n]+中[，,]\s*)?([^，,。！？；;：:\n]{1,80}?)[，,]?\s*(是一种|是指|指的是|被定义为|即是)\s*(?=[^。！？\s])/u);
  const namedMethodClaim = /^[^，,。！？；;：:\n]{1,80}[，,]\s*又称[^。！？]+[，,]\s*它(?:强调|主张)[^。！？]{8,}/u.test(sentence);
  if ((!definition && !namedMethodClaim) || (definition?.[2] === '即是' && !definition[1]!.startsWith('所谓'))
    || /\d{4}\s*年|指出|认为|提出|建议/u.test(definition?.[1] ?? sentence.split(/[，,]/u)[0]!)) return undefined;
  return sentence;
}

/** Resolve original adopted sources independently of slide text. Concept and
 * example retrieval summaries cannot masquerade as an original book passage. */
export function pageOriginalTeachingSources(outline: SceneOutline, input: {
  sourceEvidence?: CourseEvidenceSnapshot;
  sourceKnowledgePoints?: readonly SourceGroundingKnowledgePoint[];
  sourceSequenceContracts?: readonly FigureSequenceContract[];
}) {
  const knowledgeIds = new Set(outline.knowledgePointIds ?? []);
  const sourceKnowledgeIds = new Set([...knowledgeIds,
    ...(outline.teachingBrief?.understandingCriteria?.basis ?? []).flatMap((basis) => [
      ...basis.claimRefs.map((ref) => ref.knowledgePointId),
      ...(basis.exampleRefs ?? []).map((ref) => ref.knowledgePointId),
    ]),
    ...(outline.teachingBrief?.authoring?.basisNodes ?? []).flatMap((node) =>
      (node.claimRefs ?? []).map((ref) => ref.knowledgePointId)),
  ]);
  const pointsById = new Map((input.sourceKnowledgePoints ?? []).map((point) => [point.id, point]));
  const adoptedEvidenceIds = (id: string): string[] => {
    const adoptedIds = pointsById.get(id)?.evidenceItemIds;
    // An explicit empty adoption is a real teacher decision. Retrieval mappings
    // are only a compatibility fallback for points without an adoption field.
    if (adoptedIds !== undefined) return adoptedIds;
    const point = pointsById.get(id);
    const sourceIds = new Set([id, point?.sourceId, ...(point?.sourceKnowledgePointIds ?? [])]);
    const mappedIds = (input.sourceEvidence?.mappings ?? [])
      .filter((mapping) => sourceIds.has(mapping.sourceKnowledgePointId) && mapping.status !== 'none')
      .flatMap((mapping) => mapping.evidenceItemIds);
    if (mappedIds.length) return mappedIds;
    // A compiled page can carry adopted provenance without the older mapping
    // shape. Explicit adoption above still wins, including an empty adoption.
    const authoring = point?.authoring ?? outline.teachingBrief?.authoring?.knowledge
      .find((item) => item.knowledgePointId === id)?.authoring;
    return [...(authoring?.claims ?? []), ...(authoring?.examples ?? [])]
      .flatMap((item) => item.sources.map((binding) => binding.evidenceItemId));
  };
  const evidenceIds = new Set([...sourceKnowledgeIds].flatMap(adoptedEvidenceIds));
  const teachingBindings = outline.teachingBrief?.authoring?.nodes
    .flatMap((node) => [...(node.sourceBindings ?? []), ...(node.quoteDuties ?? []).map((duty) => duty.source)]);
  const basisBindings = outline.teachingBrief?.authoring?.basisNodes?.flatMap((node) => node.sourceBindings ?? []) ?? [];
  const explicitContracts = (input.sourceSequenceContracts ?? [])
    .filter((contract) => hasExplicitNativeSourceSequenceUse(outline, contract));
  const native = outline.teachingBrief?.pptPlanningVersion === PPT_PAGE_PLANNING_VERSION;
  const catalogEvidenceIds = new Set([...evidenceIds,
    ...explicitContracts.flatMap((contract) => contract.knowledgePointIds.flatMap(adoptedEvidenceIds))]);
  const sourceCatalog = native ? nativeSourceCatalog(input.sourceEvidence, explicitContracts, catalogEvidenceIds) : input.sourceEvidence;
  const rawBindings = [...(outline.teachingBrief?.sourceBindings ?? []), ...(teachingBindings ?? []), ...basisBindings];
  const resolveBindings = (allowedIds: readonly string[]) => native
    ? nativeSourceBindings(rawBindings, input.sourceEvidence, sourceCatalog, allowedIds)
    : normalizeAuthoringSourceBindings(rawBindings, input.sourceEvidence, allowedIds);
  if (explicitContracts.length) {
    const allowedIds = explicitContracts.flatMap((contract) => contract.knowledgePointIds.flatMap(adoptedEvidenceIds));
    const bindings = resolveBindings(allowedIds);
    for (const binding of bindings) {
      const item = input.sourceEvidence?.items.find((source) => source.id === binding.evidenceItemId);
      if (explicitContracts.some((contract) => item?.sourceSequences?.some((sequence) =>
        contract.resourceId === `source-sequence:${sequence.anchorSourceBlockId}`)
        || item?.figureSequences?.some((sequence) => contract.resourceId === `figure-sequence:${sequence.figureId}`))) {
        evidenceIds.add(binding.evidenceItemId);
      }
    }
  }
  const primaryRevisionId = input.sourceEvidence?.selections.find((selection) => selection.primary)?.revisionId;
  const originalSources = (input.sourceEvidence?.items ?? []).filter((item) => evidenceIds.has(item.id))
    .map((item) => {
      const originalBlocks = authoringEvidenceBlocks(sourceCatalog?.items.find((source) => source.id === item.id) ?? item);
      const blockLocations = new Map((item.completeSourceBlocks ?? []).map((block) => [block.sourceBlockId, block.source]));
      const passages: Array<{ sourceBlockId?: string; text: string; source?: CourseEvidenceSource }> = [
        ...originalBlocks.map((block) => ({
        sourceBlockId: block.id, text: block.content,
        ...(blockLocations.get(block.id) ? { source: blockLocations.get(block.id)! } : {}),
      })),
      // Historical evidence without block metadata remains readable. Modern
      // bindings and excerpt IDs always use the verified immutable blocks.
      ...(!item.source.sourceBlockId && item.source.quote?.trim()
        ? [{ text: item.source.quote }] : []),
      ...(item.kind === 'source-block' && item.content.trim()
        && !originalBlocks.length
        ? [{ sourceBlockId: item.source.sourceBlockId, text: item.content }] : []),
      ...(native && adoptedWholePassage(item) && !originalBlocks.some((block) => block.content === item.content)
        ? [{ text: item.content, source: item.source }] : [])];
      const uniquePassages = new Map<string, typeof passages[number]>();
      for (const passage of passages) {
        const key = JSON.stringify([passage.sourceBlockId, passage.text.trim()]);
        if (!uniquePassages.has(key)) uniquePassages.set(key, passage);
      }
      return { evidenceId: item.id, textbookTitle: item.source.textbookTitle,
        revisionId: item.source.revisionId, primary: item.source.revisionId === primaryRevisionId,
        sectionPath: item.source.sectionPath,
        passages: [...uniquePassages.values()],
        originalSequences: [...(item.figureSequences ?? []), ...(item.sourceSequences ?? [])]
          .map((sequence) => ({ steps: sequence.steps.map((step) => ({ label: step.label,
            ...(step.excerpt ? { explanation: step.excerpt } : {}) })) })),
      };
    }).filter((source) => source.passages.length || source.originalSequences.length)
    .sort((left, right) => Number(right.primary) - Number(left.primary));
  const originalText = originalSources.flatMap((source) => source.passages.map((passage) => passage.text)).join('\n');
  const nodeBindings = resolveBindings([...evidenceIds]);
  const verifiedQuotes = new Set(nodeBindings.flatMap((binding) => binding.quote ? [binding.quote] : []));
  const originalQuotes = [...new Set([
    ...(outline.teachingBrief?.evidence ?? []).map((item) => item.quote.trim()),
    ...nodeBindings.flatMap((binding) => binding.quote ? [binding.quote] : []),
  ]
    .filter((quote) => Boolean(quote) && (!input.sourceEvidence || verifiedQuotes.has(quote) || originalText.includes(quote))))];
  const definitionSources = originalSources;
  const sourceDefinitions = [...new Map(originalQuotes.flatMap((quote) => {
    const sentence = originalDefinitionSentence(quote);
    if (!sentence) return [];
    return definitionSources.filter((source) => source.passages.some((passage) => passage.text.includes(quote))
      || nodeBindings.some((binding) => binding.evidenceItemId === source.evidenceId && binding.quote === quote))
      .map((source) => [JSON.stringify([source.revisionId, sentence]), sentence] as const);
  })).entries()];
  const adoptedSequences = (input.sourceEvidence?.items ?? []).filter((item) => evidenceIds.has(item.id))
    .flatMap((item) => [
      ...(item.sourceSequences ?? []).map((sequence) => ({
        resourceId: `source-sequence:${sequence.anchorSourceBlockId}`, steps: sequence.steps,
      })),
      ...(item.figureSequences ?? []).map((sequence) => ({
        resourceId: `figure-sequence:${sequence.figureId}`, steps: sequence.steps,
      })),
    ]);
  const sameLabel = (value: string) => value.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
  const requiredSourceLists = (input.sourceSequenceContracts ?? []).filter((contract) => contract.required
    && usesSourceSequence(outline, contract)
    && (contract.knowledgePointIds.some((id) => knowledgeIds.has(id))
      || hasExplicitNativeSourceSequenceUse(outline, contract)))
    .map((contract) => ({ id: contract.resourceId, semantics: contract.sequenceSemantics ?? 'ordered-steps',
      steps: (contract.orderedSteps ?? []).filter((step) => !contract.requiredStepLabels
        || contract.requiredStepLabels.includes(step.label)).map((step) => {
        // A source heading alone is not its explanation. Keep the actual
        // adopted list and item identity when attaching the source mechanism;
        // a similarly named item in another list cannot supply that meaning.
        const sourceDescriptions = [...new Set(adoptedSequences
          .filter((sequence) => sequence.resourceId === contract.resourceId)
          .flatMap((sequence) => sequence.steps)
          .filter((original) => sameLabel(original.label) === sameLabel(step.label))
          .flatMap((original) => original.excerpt?.trim() ? [original.excerpt] : []))];
        return { label: step.label, ...(sourceDescriptions.length ? { sourceDescriptions } : {}) };
      }),
    }));
  // The model places short source descriptions inside its own explanation.
  // Expanding an explicitly authored reference prevents a second paraphrase
  // from changing rigorous wording; it never inserts an unrequested passage.
  const authoritativeAnchors: Array<{ id: string; text: string; sourceListId?: string;
    sourceLabel?: string; meaningSourceRef?: string; sourceDefinitionKey?: string }> = [
    ...requiredSourceLists.flatMap((list, listIndex) => list.steps.flatMap((step, stepIndex) => {
      const id = `source-list-${listIndex + 1}-item-${stepIndex + 1}`;
      const description = step.sourceDescriptions?.[0];
      const definingSentence = definingSourceSentence(step.label, step.sourceDescriptions);
      const claim = definingSentence ? `${step.label}。${definingSentence}` : step.label;
      // A source slot is an independently spoken claim. Close its sentence
      // before authoring so adjacent text cannot erase its grammatical boundary.
      const text = /[。！？.!?；;][”’"）)」』\]]*\s*$/u.test(claim) ? claim : `${claim}。`;
      return [{ id, text, sourceListId: list.id, sourceLabel: step.label,
        ...(description ? { meaningSourceRef: `${id}-meaning` } : {}) },
      ...(description ? [{ id: `${id}-meaning`, text: description }] : [])];
    })),
    ...originalQuotes.map((quote, index) => ({ id: `source-quote-${index + 1}`, text: quote })),
    ...sourceDefinitions.map(([sourceDefinitionKey, text], index) => ({
      id: `source-definition-${index + 1}`, text, sourceDefinitionKey,
    })),
  ];
  return { originalSources, originalQuotes, requiredSourceLists, authoritativeAnchors };
}

/** One request-local text/source catalog. IDs preserve provenance and page ownership;
 * identical strings are interned without discarding any original passage or condition. */
export function buildAuthoringSourceCatalog(sourcesByPage: ReadonlyMap<string, ReturnType<typeof pageOriginalTeachingSources>>) {
  const texts: Record<string, string> = {};
  const textIds = new Map<string, string>();
  const intern = (text: string) => {
    let id = textIds.get(text);
    if (!id) { id = `evidence-text-${textIds.size + 1}`; textIds.set(text, id); texts[id] = text; }
    return id;
  };
  const sources: Record<string, unknown> = {};
  const sourceIds = new Map<string, string>();
  const pages = new Map([...sourcesByPage].map(([pageId, page]) => [pageId, {
    originalSourceRefs: page.originalSources.map((source) => {
      const { passages, originalSequences, ...metadata } = source;
      const projected = { ...metadata,
        passages: passages.map(({ text, source: passageSource, ...passage }) => {
          const { quote, ...sourceLocation } = passageSource ?? {};
          return { ...passage, textRef: intern(text), ...(passageSource ? {
            source: { ...sourceLocation, ...(quote ? { quoteRef: intern(quote) } : {}) },
          } : {}) };
        }),
        originalSequences: originalSequences.map((sequence) => ({ steps: sequence.steps.map((step) => ({
          labelRef: intern(step.label), ...(step.explanation ? { explanationRef: intern(step.explanation) } : {}),
        })) })),
      };
      const identity = JSON.stringify(projected);
      let id = sourceIds.get(identity);
      if (!id) { id = `evidence-source-${sourceIds.size + 1}`; sourceIds.set(identity, id); sources[id] = projected; }
      return id;
    }),
    originalQuoteRefs: page.originalQuotes.map(intern),
    requiredSourceLists: page.requiredSourceLists.map((list) => ({ ...list,
      steps: list.steps.map((step) => ({ labelRef: intern(step.label),
        ...(step.sourceDescriptions ? { sourceDescriptionRefs: step.sourceDescriptions.map(intern) } : {}) })),
    })),
    authoritativeAnchors: page.authoritativeAnchors.map(({ text, sourceLabel, sourceDefinitionKey: _definitionIdentity, ...anchor }) => ({
      ...anchor, textRef: intern(text), ...(sourceLabel ? { sourceLabelRef: intern(sourceLabel) } : {}),
    })),
  }]));
  return { catalog: { texts, sources }, pages, intern };
}
