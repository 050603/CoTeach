import type { SceneOutline } from '@/lib/openmaic/types/generation';
import type { KnowledgePoint } from '@/lib/session/types';
import type { CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';
import type { FigureSequenceContract } from '@/lib/textbook/course-visual-binding';

export type SourceGroundingKnowledgePoint = Pick<KnowledgePoint, 'id' | 'evidenceItemIds' | 'sourceId' | 'sourceKnowledgePointIds'>;

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
  if (!definition || (definition[2] === '即是' && !definition[1]!.startsWith('所谓'))
    || /\d{4}\s*年|指出|认为|提出|建议/u.test(definition[1]!)) return undefined;
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
  const pointsById = new Map((input.sourceKnowledgePoints ?? []).map((point) => [point.id, point]));
  const evidenceIds = new Set([...knowledgeIds].flatMap((id) => {
    const adoptedIds = pointsById.get(id)?.evidenceItemIds;
    // An explicit empty adoption is a real teacher decision. Retrieval mappings
    // are only a compatibility fallback for points without an adoption field.
    if (adoptedIds !== undefined) return adoptedIds;
    const point = pointsById.get(id);
    const sourceIds = new Set([id, point?.sourceId, ...(point?.sourceKnowledgePointIds ?? [])]);
    return (input.sourceEvidence?.mappings ?? [])
      .filter((mapping) => sourceIds.has(mapping.sourceKnowledgePointId) && mapping.status !== 'none')
      .flatMap((mapping) => mapping.evidenceItemIds);
  }));
  const primaryRevisionId = input.sourceEvidence?.selections.find((selection) => selection.primary)?.revisionId;
  const originalSources = (input.sourceEvidence?.items ?? []).filter((item) => evidenceIds.has(item.id))
    .map((item) => {
      const passages = [...(item.completeSourceBlocks ?? []).map((block) => ({
        sourceBlockId: block.sourceBlockId, text: block.content,
      })),
      ...(item.source.quote?.trim() ? [{ sourceBlockId: item.source.sourceBlockId, text: item.source.quote }] : []),
      ...(item.kind === 'source-block' && item.content.trim()
        ? [{ sourceBlockId: item.source.sourceBlockId, text: item.content }] : [])];
      return { evidenceId: item.id, textbookTitle: item.source.textbookTitle,
        revisionId: item.source.revisionId, primary: item.source.revisionId === primaryRevisionId,
        sectionPath: item.source.sectionPath,
        passages: [...new Map(passages.map((passage) => [passage.text.trim(), passage])).values()],
        originalSequences: [...(item.figureSequences ?? []), ...(item.sourceSequences ?? [])]
          .map((sequence) => ({ steps: sequence.steps.map((step) => ({ label: step.label,
            ...(step.excerpt ? { explanation: step.excerpt } : {}) })) })),
      };
    }).filter((source) => source.passages.length || source.originalSequences.length)
    .sort((left, right) => Number(right.primary) - Number(left.primary));
  const originalText = originalSources.flatMap((source) => source.passages.map((passage) => passage.text)).join('\n');
  const originalQuotes = [...new Set((outline.teachingBrief?.evidence ?? []).map((item) => item.quote.trim())
    .filter((quote) => Boolean(quote) && (!input.sourceEvidence || originalText.includes(quote))))];
  const definitionSources = originalSources.some((source) => source.primary && source.passages.length)
    ? originalSources.filter((source) => source.primary) : originalSources;
  const sourceDefinitions = [...new Map(originalQuotes.flatMap((quote) => {
    const sentence = originalDefinitionSentence(quote);
    if (!sentence) return [];
    return definitionSources.filter((source) => source.passages.some((passage) => passage.text.includes(quote)))
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
    && contract.knowledgePointIds.some((id) => knowledgeIds.has(id)))
    .map((contract) => ({ id: contract.resourceId, semantics: contract.sequenceSemantics ?? 'ordered-steps',
      steps: (contract.orderedSteps ?? []).map((step) => {
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
        passages: passages.map(({ text, ...passage }) => ({ ...passage, textRef: intern(text) })),
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
