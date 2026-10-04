import type { CourseEvidenceItem, CourseEvidenceSnapshot, CourseEvidenceSource } from '@/lib/textbook/course-evidence-types';
import { normalizeTextbookText } from '@/lib/textbook/text';

/** Identity is bound from immutable evidence, never from a model's book label. */
export type AuthoringSourceBinding = {
  evidenceItemId: string;
  sourceBlockIds: string[];
  quote?: string;
  textbookId?: string;
  revisionId?: string;
};

export type AuthoringClaimRef = { knowledgePointId: string; claimId: string };
export type AuthoringExampleRef = { knowledgePointId: string; exampleId: string };
/** Selected immutable text; a model never supplies its words or version. */
export type AuthoringExcerptRef = { evidenceItemId: string; sourceBlockId: string; excerptId: string };
export type AuthoringQuotationRole = 'definition' | 'strict-condition' | 'normative-statement';
/** A duty belongs to one selected original span, never to a whole mixed claim. */
export type AuthoringAuthoritativeExcerpt = {
  excerptRef: AuthoringExcerptRef;
  role: AuthoringQuotationRole;
};
export type AuthoringQuoteRef = AuthoringClaimRef & { excerptRef: AuthoringExcerptRef };

/** A reading records a real source address and a teaching decision, not a
 * second description of what the book supposedly concludes. */
export type AuthoringSourceFinding = {
  excerptRefs: AuthoringExcerptRef[];
  kind: 'case' | 'application';
  disposition: 'candidate' | 'outside-scope';
  exampleIds: string[];
  claimIds: string[];
  role: 'difficulty' | 'illustration' | 'procedure' | 'application' | 'comparison';
};
export type AuthoringSourceReading = {
  blockRef: AuthoringExcerptRef;
  findings: AuthoringSourceFinding[];
};

/** A planned ability addresses real assertions without pre-writing its answer. */
export type AuthoringLearningTask = {
  claimIds: string[];
  operation: 'identify' | 'explain' | 'compare' | 'apply';
};

/** A case element illustrates part of an existing assertion; its short phrase
 * is an address within the full assertion, never a new independent conclusion. */
export type AuthoringExampleCorrespondence = {
  claimId: string;
  claimPhrase: string;
  caseElement: {
    field: 'objectAndTask' | 'assumptions' | 'actions' | 'outcome' | 'facts';
    index?: number;
  };
};

export type KnowledgeAuthoringClaim = {
  id: string;
  kind: 'textbook' | 'derived';
  text: string;
  sources: AuthoringSourceBinding[];
  excerptRefs?: AuthoringExcerptRef[];
  /** Ordinary explanations remain factual sources without a reading duty. */
  authoritativeExcerpts?: AuthoringAuthoritativeExcerpt[];
  /** Preconditions of the assertion, distinct from what this lesson covers. */
  logicalConditions?: string[];
  teachingScope?: string;
  /** Local claim IDs supporting this derived explanation, not source labels. */
  basisClaimIds?: string[];
  /** Legacy prose; never automatically interpreted as logical preconditions. */
  conditions?: string;
};

export type KnowledgeAuthoringExample = {
  id: string;
  kind: 'textbook' | 'constructed';
  title: string;
  purpose: string;
  /** Complete case facts, separate from the generated interpretation below. */
  facts: string[];
  factRefs?: AuthoringExcerptRef[];
  /** Saved legacy prose; new authoring may omit it before normalization. */
  explanation: string;
  objectAndTask?: string;
  assumptions?: string[];
  actions?: string[];
  outcome?: string;
  conceptMapping?: string;
  correspondences?: AuthoringExampleCorrespondence[];
  /** Local claims illustrated by this concrete case. */
  claimIds?: string[];
  form?: 'everyday' | 'domain' | 'analogy';
  limitations?: string;
  sources: AuthoringSourceBinding[];
};

export type KnowledgeAuthoring = {
  /** Explicit even without a textbook; absent on saved earlier contracts. */
  readingContract?: 'source-blocks-v1';
  claims: KnowledgeAuthoringClaim[];
  /** Optional for saved drafts; new authoring selects references and an action,
   * rather than a free summary, conclusion or answer-shaped mastery sentence. */
  learningTasks?: AuthoringLearningTask[];
  examples: KnowledgeAuthoringExample[];
  exampleCoverage: Array<{
    textbookId: string;
    revisionId: string;
    status: 'complete' | 'partial';
    evidenceItemIds: string[];
    /** Full original blocks read in this same knowledge-authoring call. */
    sourceReadings?: AuthoringSourceReading[];
  }>;
  /** Structural/source gaps only; never a semantic pass or a generation gate. */
  diagnostics?: string[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : [];
}

function validLocalClaimIds(
  raw: unknown, available: ReadonlySet<string>, owner: string, diagnostics: string[], selfId?: string,
): string[] {
  return strings(raw).filter((id) => {
    if (available.has(id) && id !== selfId) return true;
    diagnostics.push(`${owner}引用了不存在或不能自证的本知识点陈述：${id}`);
    return false;
  });
}

function comparableQuotation(value: string): string {
  return normalizeTextbookText(value).replace(/[“”]/gu, '"').replace(/[‘’]/gu, "'");
}

/** Resolve typography-only variations back to the unchanged original span.
 * Keep punctuation, words and numbers: 3.5, 35 and a negated condition differ. */
function originalQuotation(source: string, quote: string): string | undefined {
  if (source.includes(quote)) return quote;
  let comparable = '';
  const starts: number[] = [], ends: number[] = [];
  let offset = 0;
  for (const character of source) {
    const end = offset + character.length;
    for (const normalized of character.normalize('NFKC').replace(/[“”]/gu, '"').replace(/[‘’]/gu, "'")) {
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(normalized)) continue;
      const value = /\s/u.test(normalized) ? ' ' : normalized;
      if (value === ' ' && comparable.endsWith(' ')) ends[ends.length - 1] = end;
      else {
        comparable += value;
        // Record UTF-16 offsets, including any compatibility expansion.
        for (let index = 0; index < value.length; index++) { starts.push(offset); ends.push(end); }
      }
    }
    offset = end;
  }
  const needle = comparableQuotation(quote);
  const index = needle ? comparable.indexOf(needle) : -1;
  return index >= 0 ? source.slice(starts[index], ends[index + needle.length - 1]) : undefined;
}

export type AuthoringEvidenceBlock = { id: string; content: string; source: CourseEvidenceSource; position?: number };

/** Shared original-only view: generated item.content is never a source. */
export function authoringEvidenceBlocks(item: CourseEvidenceItem): readonly AuthoringEvidenceBlock[] {
  const blocks = new Map<string, AuthoringEvidenceBlock>();
  if (item.source.sourceBlockId && item.source.quote) blocks.set(item.source.sourceBlockId, {
    id: item.source.sourceBlockId, content: item.source.quote,
    source: item.source, position: item.source.sourceBlockPosition,
  });
  for (const block of item.completeSourceBlocks ?? []) {
    const source = block.source ?? item.source;
    // An authoring view may contain parent context; its own source wins.
    if (source.revisionId !== item.source.revisionId || source.textbookId !== item.source.textbookId) continue;
    blocks.set(block.sourceBlockId, { id: block.sourceBlockId, content: block.content,
      source, position: source.sourceBlockPosition });
  }
  return [...blocks.values()].sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
}

type AuthoringExcerpt = { excerptId: string; start: number; end: number; text: string };
export type AuthoringExcerptCatalog = {
  evidenceItems: Array<{ evidenceItemId: string; textbookId: string; revisionId: string;
    blocks: Array<{ sourceBlockId: string; wholeBlockExcerptId: string; excerptIds: string[] }> }>;
  sourceBlocks: Array<{ sourceBlockId: string; source: CourseEvidenceSource; excerpts: AuthoringExcerpt[] }>;
};

function excerptIdentity(content: string, start: number, end: number): string {
  // Independent accumulators keep IDs compact and synchronous for browser-safe
  // prompt construction. Offsets and real block/version identity also bind it.
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (let index = start; index < end; index++) {
    const code = content.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${start}:${end}:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function blockExcerpts(content: string): AuthoringExcerpt[] {
  if (!content.trim()) return [];
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  // Do not split commas, semicolons, list numbers, decimal points or negations.
  // Every character is retained; complete numbered lists may select the block.
  for (const boundary of content.matchAll(/[。！？]+[”’」』"']*|\r?\n+/gu)) {
    const end = boundary.index + boundary[0].length;
    if (content.slice(start, end).trim()) spans.push({ start, end });
    start = end;
  }
  if (content.slice(start).trim()) spans.push({ start, end: content.length });
  const whole = { start: 0, end: content.length };
  return [...new Map([whole, ...spans].map((span) => {
    const excerpt = { ...span, excerptId: excerptIdentity(content, span.start, span.end),
      text: content.slice(span.start, span.end) };
    return [excerpt.excerptId, excerpt] as const;
  })).values()];
}

/** The whole source is already in the evidence context. List its exact selector
 * plus sentence options without copying that full body once more per evidence. */
export function buildAuthoringExcerptCatalog(evidence?: CourseEvidenceSnapshot): AuthoringExcerptCatalog {
  const referenced = new Set(evidence?.mappings.flatMap((mapping) => mapping.evidenceItemIds));
  const items = (evidence?.items ?? []).filter((item) => !evidence?.mappings.length || referenced.has(item.id));
  const sourceBlocks = new Map<string, { sourceBlockId: string; source: CourseEvidenceSource;
    excerpts: Map<string, AuthoringExcerpt> }>();
  const evidenceItems = items.map((item) => ({ evidenceItemId: item.id,
    textbookId: item.source.textbookId, revisionId: item.source.revisionId,
    blocks: authoringEvidenceBlocks(item).flatMap((block) => {
      const excerpts = blockExcerpts(block.content);
      if (!excerpts.length) return [];
      const key = JSON.stringify([block.source.textbookId, block.source.revisionId, block.id]);
      const entry = sourceBlocks.get(key) ?? { sourceBlockId: block.id,
        source: { ...block.source, quote: undefined }, excerpts: new Map<string, AuthoringExcerpt>() };
      // The complete block is addressed by wholeBlockExcerptId and readable in
      // the existing evidence context. A one-sentence block still needs text.
      for (const excerpt of excerpts.slice(excerpts.length === 1 ? 0 : 1)) entry.excerpts.set(excerpt.excerptId, excerpt);
      sourceBlocks.set(key, entry);
      return [{ sourceBlockId: block.id, wholeBlockExcerptId: excerpts[0]!.excerptId,
        excerptIds: excerpts.map((excerpt) => excerpt.excerptId) }];
    }) }));
  return { evidenceItems, sourceBlocks: [...sourceBlocks.values()].map((block) => ({
    sourceBlockId: block.sourceBlockId, source: block.source, excerpts: [...block.excerpts.values()],
  })) };
}

function resolveExcerptRefs(raw: unknown, evidence: CourseEvidenceSnapshot | undefined,
  allowedEvidenceIds: readonly string[] | undefined, diagnostics: string[]): {
    refs: AuthoringExcerptRef[]; texts: string[]; sources: AuthoringSourceBinding[];
    requestedIndices: number[]; complete: boolean;
  } {
  const items = new Map((evidence?.items ?? []).map((item) => [item.id, item]));
  const allowed = allowedEvidenceIds ? new Set(allowedEvidenceIds) : undefined;
  const refs: AuthoringExcerptRef[] = [], texts: string[] = [], sources: AuthoringSourceBinding[] = [];
  const requestedIndices: number[] = [];
  const requested = Array.isArray(raw) ? raw : [];
  for (const [index, value] of requested.entries()) {
    const supplied = record(value);
    const evidenceItemId = text(supplied.evidenceItemId), sourceBlockId = text(supplied.sourceBlockId),
      excerptId = text(supplied.excerptId);
    const item = items.get(evidenceItemId);
    const block = item && (!allowed || allowed.has(evidenceItemId))
      ? authoringEvidenceBlocks(item).find((candidate) => candidate.id === sourceBlockId) : undefined;
    const excerpt = block && blockExcerpts(block.content).find((candidate) => candidate.excerptId === excerptId);
    if (!item || !block || !excerpt) {
      diagnostics.push(`原文片段引用不存在、版本不符或不属于当前知识点：${evidenceItemId}/${sourceBlockId}/${excerptId}`);
      continue;
    }
    refs.push({ evidenceItemId, sourceBlockId, excerptId });
    requestedIndices.push(index);
    texts.push(excerpt.text);
    sources.push({ evidenceItemId, sourceBlockIds: [sourceBlockId], quote: excerpt.text,
      textbookId: block.source.textbookId, revisionId: block.source.revisionId });
  }
  return { refs, texts, sources, requestedIndices,
    complete: requested.length > 0 && refs.length === requested.length };
}

function sameExcerptRef(left: AuthoringExcerptRef, right: AuthoringExcerptRef): boolean {
  return left.evidenceItemId === right.evidenceItemId && left.sourceBlockId === right.sourceBlockId
    && left.excerptId === right.excerptId;
}

function normalizeSourceReadings(
  raw: unknown, evidence: CourseEvidenceSnapshot | undefined, relevantEvidenceIds: readonly string[],
  revisionId: string, claims: readonly KnowledgeAuthoringClaim[], examples: readonly KnowledgeAuthoringExample[],
  diagnostics: string[],
): { readings: AuthoringSourceReading[]; recordedBlockIds: Set<string> } {
  const items = new Map((evidence?.items ?? []).map((item) => [item.id, item]));
  const claimIds = new Set(claims.map((claim) => claim.id));
  const exampleById = new Map(examples.map((example) => [example.id, example]));
  const byBlock = new Map<string, AuthoringSourceReading>();
  const recordedBlockIds = new Set<string>();
  const span = (ref: AuthoringExcerptRef) => {
    const item = items.get(ref.evidenceItemId);
    const block = item && authoringEvidenceBlocks(item).find((block) => block.id === ref.sourceBlockId);
    const excerpt = block && blockExcerpts(block.content).find((entry) => entry.excerptId === ref.excerptId);
    return block && excerpt ? { block, excerpt } : undefined;
  };
  for (const value of Array.isArray(raw) ? raw : []) {
    const reading = record(value);
    const selected = resolveExcerptRefs([reading.blockRef], evidence, relevantEvidenceIds, diagnostics);
    const ref = selected.refs[0], item = ref && items.get(ref.evidenceItemId);
    const block = ref && item && authoringEvidenceBlocks(item).find((block) => block.id === ref.sourceBlockId);
    if (!selected.complete || !ref || !block || block.source.revisionId !== revisionId
      || ref.excerptId !== blockExcerpts(block.content)[0]?.excerptId) {
      diagnostics.push(`教材版本“${revisionId}”的案例阅读记录未选择合法完整原文块，不将句段阅读当作整段已读。`);
      continue;
    }
    if (!Array.isArray(reading.findings)) {
      diagnostics.push(`原文块“${ref.sourceBlockId}”缺少具体案例或应用的阅读记录，不自动认定已读完。`);
      continue;
    }
    const findings: AuthoringSourceFinding[] = [];
    let addressesComplete = true;
    for (const rawFinding of reading.findings) {
      const finding = record(rawFinding), kind = finding.kind, disposition = finding.disposition, role = finding.role;
      if ((kind !== 'case' && kind !== 'application')
        || (disposition !== 'candidate' && disposition !== 'outside-scope')
        || (role !== 'difficulty' && role !== 'illustration' && role !== 'procedure'
          && role !== 'application' && role !== 'comparison')) {
        diagnostics.push(`原文块“${ref.sourceBlockId}”的案例阅读记录缺少有效类型、取舍或教学作用。`);
        addressesComplete = false;
        continue;
      }
      const located = resolveExcerptRefs(finding.excerptRefs, evidence, relevantEvidenceIds, diagnostics);
      if (!located.complete || !located.refs.some((candidate) => candidate.sourceBlockId === ref.sourceBlockId)
        || located.sources.some((source) => source.revisionId !== revisionId)) {
        diagnostics.push(`原文块“${ref.sourceBlockId}”的案例阅读结果未绑定本段及同一教材版本的真实片段。`);
        addressesComplete = false;
        continue;
      }
      const selectedExamples = strings(finding.exampleIds).filter((id) => {
        const example = exampleById.get(id);
        const boundHere = example?.factRefs?.some((factRef) => located.refs.some((candidate) => {
          const fact = span(factRef), found = span(candidate);
          return fact && found && fact.block.id === found.block.id
            && fact.block.source.textbookId === found.block.source.textbookId
            && fact.block.source.revisionId === found.block.source.revisionId
            && fact.excerpt.start < found.excerpt.end && found.excerpt.start < fact.excerpt.end;
        })) ?? example?.sources.some((source) => source.revisionId === revisionId && source.quote
          && located.sources.some((found) => found.sourceBlockIds.some((id) => source.sourceBlockIds.includes(id))
            && found.quote && (found.quote.includes(source.quote!) || source.quote!.includes(found.quote))));
        if (example?.kind === 'textbook' && boundHere) return true;
        diagnostics.push(`原文块“${ref.sourceBlockId}”的阅读结果引用了未绑定对应教材事实的案例：${id}`);
        addressesComplete = false;
        return false;
      });
      if (disposition === 'candidate' && !selectedExamples.length) {
        diagnostics.push(`原文块“${ref.sourceBlockId}”记录了教材候选但未绑定有效案例，保留缺漏诊断，不自动补写。`);
        addressesComplete = false;
      }
      const selectedClaims = validLocalClaimIds(finding.claimIds, claimIds,
        `原文块“${ref.sourceBlockId}”的阅读作用`, diagnostics);
      if (selectedClaims.length !== strings(finding.claimIds).length) addressesComplete = false;
      findings.push({ excerptRefs: located.refs, kind, disposition, exampleIds: selectedExamples,
        claimIds: selectedClaims, role });
    }
    const previous = byBlock.get(ref.sourceBlockId);
    const combined = [...(previous?.findings ?? []), ...findings];
    byBlock.set(ref.sourceBlockId, { blockRef: previous?.blockRef ?? ref,
      findings: [...new Map(combined.map((finding) => [JSON.stringify(finding), finding])).values()] });
    if (addressesComplete) recordedBlockIds.add(ref.sourceBlockId);
  }
  return { readings: [...byBlock.values()], recordedBlockIds };
}

function normalizeAuthoritativeExcerpts(
  raw: unknown, claim: Pick<KnowledgeAuthoringClaim, 'id' | 'kind' | 'excerptRefs'>,
  diagnostics: string[],
): AuthoringAuthoritativeExcerpt[] {
  const eligible: AuthoringAuthoritativeExcerpt[] = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const entry = record(value), supplied = record(entry.excerptRef);
    const role = entry.role;
    if (role !== 'definition' && role !== 'strict-condition' && role !== 'normative-statement') {
      diagnostics.push(`陈述“${claim.id}”未选择有效逐字引用职责，普通说明不自动成为朗读任务。`);
      continue;
    }
    const requested = { evidenceItemId: text(supplied.evidenceItemId), sourceBlockId: text(supplied.sourceBlockId),
      excerptId: text(supplied.excerptId) };
    const owned = claim.excerptRefs?.find((ref) => sameExcerptRef(ref, requested));
    if (claim.kind !== 'textbook' || !owned) {
      diagnostics.push(`陈述“${claim.id}”的逐字引用片段不属于本条已绑定教材原文，不将附近说明或派生解释升级为引用职责。`);
      continue;
    }
    const existing = eligible.find((entry) => sameExcerptRef(entry.excerptRef, owned));
    if (existing) {
      if (existing.role !== role) diagnostics.push(`陈述“${claim.id}”的同一原文片段声明了不同引用职责，保留首次职责。`);
      continue;
    }
    eligible.push({ excerptRef: owned, role });
  }
  return eligible;
}

/** Compile an eligible selection into its actual quote, with original version
 * and block identity. A caller still checks the owning point/claim IDs. */
export function resolveAuthoringAuthoritativeExcerpt(
  claim: KnowledgeAuthoringClaim, excerptRef: AuthoringExcerptRef,
  evidence?: CourseEvidenceSnapshot, allowedEvidenceIds?: readonly string[],
): { excerptRef: AuthoringExcerptRef; role: AuthoringQuotationRole; source: AuthoringSourceBinding } | undefined {
  if (claim.kind !== 'textbook' || !claim.excerptRefs?.some((ref) => sameExcerptRef(ref, excerptRef))) return undefined;
  const eligible = claim.authoritativeExcerpts?.find((entry) => sameExcerptRef(entry.excerptRef, excerptRef));
  if (!eligible || (eligible.role !== 'definition' && eligible.role !== 'strict-condition'
    && eligible.role !== 'normative-statement')) return undefined;
  const selected = resolveExcerptRefs([excerptRef], evidence, allowedEvidenceIds, []);
  const source = selected.sources[0];
  if (!selected.complete || !source || !claim.sources.some((binding) => binding.evidenceItemId === source.evidenceItemId
    && binding.sourceBlockIds.includes(excerptRef.sourceBlockId) && binding.textbookId === source.textbookId
    && binding.revisionId === source.revisionId && binding.quote === source.quote)) return undefined;
  return { excerptRef: selected.refs[0]!, role: eligible.role, source };
}

function normalizeExampleCorrespondences(
  raw: unknown,
  rawExample: Record<string, unknown>,
  example: KnowledgeAuthoringExample,
  claims: readonly KnowledgeAuthoringClaim[],
  diagnostics: string[],
  selectedFactIndices?: readonly number[],
): AuthoringExampleCorrespondence[] {
  const result: AuthoringExampleCorrespondence[] = [];
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  for (const value of Array.isArray(raw) ? raw : []) {
    const supplied = record(value);
    const claimId = text(supplied.claimId);
    const claim = byId.get(claimId);
    const phrase = text(supplied.claimPhrase);
    const claimPhrase = claim && phrase ? originalQuotation(claim.text, phrase) : undefined;
    const element = record(supplied.caseElement);
    const field = text(element.field);
    let caseElement: AuthoringExampleCorrespondence['caseElement'] | undefined;
    if ((field === 'objectAndTask' || field === 'outcome') && element.index === undefined
      && text(example[field])) {
      caseElement = { field };
    } else if (field === 'facts' || field === 'assumptions' || field === 'actions') {
      const index = element.index;
      if (typeof index === 'number' && Number.isInteger(index) && index >= 0) {
        let normalizedIndex = -1;
        if (field === 'facts' && selectedFactIndices) {
          // A rejected selector must not silently address the next valid fact.
          normalizedIndex = selectedFactIndices.indexOf(index);
        } else {
          const values = rawExample[field];
          if (Array.isArray(values) && index < values.length && text(values[index])) {
            normalizedIndex = field === 'assumptions'
              ? example.assumptions!.indexOf(text(values[index]))
              : values.slice(0, index).filter((item) => text(item)).length;
          }
        }
        if (normalizedIndex >= 0 && text(example[field]?.[normalizedIndex])) {
          caseElement = { field, index: normalizedIndex };
        }
      }
    }
    if (!claimPhrase || !caseElement) {
      diagnostics.push(`案例“${example.id}”的对应关系未指向本知识点真实陈述短语及实际情境元素：${claimId || '未填写陈述编号'}/${field || '未填写字段'}`);
      continue;
    }
    result.push({ claimId, claimPhrase, caseElement });
  }
  return [...new Map(result.map((item) => [JSON.stringify(item), item])).values()];
}

function bindSources(
  raw: unknown,
  evidence?: CourseEvidenceSnapshot,
  allowedEvidenceIds?: readonly string[],
  diagnostics?: string[],
): AuthoringSourceBinding[] {
  const items = new Map((evidence?.items ?? []).map((item) => [item.id, item]));
  const allowed = allowedEvidenceIds ? new Set(allowedEvidenceIds) : undefined;
  const result: AuthoringSourceBinding[] = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const supplied = record(value);
    const evidenceItemId = text(supplied.evidenceItemId);
    const item = items.get(evidenceItemId);
    if (!item || (allowed && !allowed.has(evidenceItemId))) {
      diagnostics?.push(`来源引用不存在或不属于当前知识点：${evidenceItemId || '未填写证据编号'}`);
      continue;
    }
    const blocks = authoringEvidenceBlocks(item);
    const ids = strings(supplied.sourceBlockIds);
    if (!ids.length || ids.some((id) => !blocks.some((block) => block.id === id))) {
      diagnostics?.push(`来源引用未绑定可读取的完整原文块：${evidenceItemId}`);
      continue;
    }
    const adopted = blocks.filter((block) => ids.includes(block.id));
    const requestedQuote = text(supplied.quote);
    const quote = requestedQuote ? originalQuotation(adopted.map((block) => block.content).join('\n'), requestedQuote) : undefined;
    if (requestedQuote && !quote) {
      diagnostics?.push(`来源引用片段不在绑定原文中：${evidenceItemId}`);
      continue;
    }
    result.push({ evidenceItemId, sourceBlockIds: adopted.map((block) => block.id),
      ...(quote ? { quote } : {}), textbookId: item.source.textbookId, revisionId: item.source.revisionId });
  }
  return [...new Map(result.map((binding) => [JSON.stringify(binding), binding])).values()];
}

/** Only checks real source identities/quotes. It never judges a teaching choice. */
export function normalizeAuthoringSourceBindings(
  raw: unknown,
  evidence?: CourseEvidenceSnapshot,
  allowedEvidenceIds?: readonly string[],
): AuthoringSourceBinding[] {
  return bindSources(raw, evidence, allowedEvidenceIds);
}

/** A substring must not discard a leading negation or cut a word/number.
 * This verifies quoted text boundaries, not the semantic force of a claim. */
export function authoringSourceContainsText(
  value: string, sources: readonly AuthoringSourceBinding[], evidence?: CourseEvidenceSnapshot,
): boolean {
  const needle = comparableQuotation(value);
  if (!needle) return false;
  return sources.some((binding) => {
    if (!binding.quote || !comparableQuotation(binding.quote).includes(needle)) return false;
    const item = evidence?.items.find((item) => item.id === binding.evidenceItemId);
    if (!item) return false;
    const original = comparableQuotation(authoringEvidenceBlocks(item)
      .filter((block) => binding.sourceBlockIds.includes(block.id)).map((block) => block.content).join('\n'));
    for (let index = original.indexOf(needle); index >= 0; index = original.indexOf(needle, index + 1)) {
      const preceding = original.slice(0, index).trimEnd().at(-1);
      const following = original.slice(index + needle.length).trimStart()[0];
      if ((!preceding || !/[\p{L}\p{N}]/u.test(preceding))
        && (!following || !/[\p{L}\p{N}]/u.test(following) || /[。！？.!?；;]$/u.test(needle))) return true;
    }
    return false;
  });
}

/** Expand selected original spans, preserving legacy prose without another request. */
export function normalizeKnowledgeAuthoring(
  raw: unknown,
  evidence?: CourseEvidenceSnapshot,
  allowedEvidenceIds?: readonly string[],
  options?: { readingContract?: 'source-blocks-v1' },
): KnowledgeAuthoring | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const supplied = record(raw);
  const readingContract = options?.readingContract ?? (supplied.readingContract === 'source-blocks-v1'
    ? supplied.readingContract : undefined);
  const diagnostics = strings(supplied.diagnostics);
  const claimIds = new Set<string>();
  const claims = (Array.isArray(supplied.claims) ? supplied.claims : []).flatMap<KnowledgeAuthoringClaim>((value, index) => {
    const claim = record(value);
    const selected = Object.hasOwn(claim, 'excerptRefs')
      ? resolveExcerptRefs(claim.excerptRefs, evidence, allowedEvidenceIds, diagnostics) : undefined;
    const claimText = selected ? selected.texts.join('\n') : text(claim.text);
    if (!claimText) return [];
    let id = text(claim.id) || `claim-${index + 1}`;
    if (claimIds.has(id)) {
      diagnostics.push(`来源陈述编号重复：${id}`);
      const requestedId = id;
      let suffix = 2;
      while (claimIds.has(id)) id = `${requestedId}-${suffix++}`;
    }
    claimIds.add(id);
    const sources = selected?.sources ?? bindSources(claim.sources, evidence, allowedEvidenceIds, diagnostics);
    const isTextbook = claim.kind === 'textbook' && (selected?.complete
      ?? authoringSourceContainsText(claimText, sources, evidence));
    if (selected && text(claim.text) && text(claim.text) !== claimText.trim()) {
      diagnostics.push(`陈述“${id}”提供了复写正文，以所选不可变原文片段为准。`);
    }
    if (claim.kind === 'textbook' && !isTextbook) {
      diagnostics.push(`陈述“${id}”未绑定对应的教材原文表述，保留为生成解释。`);
    }
    const normalized: KnowledgeAuthoringClaim = { id, kind: isTextbook ? 'textbook' as const : 'derived' as const,
      text: claimText, sources,
      ...(selected ? { excerptRefs: selected.refs } : {}),
      ...(Array.isArray(claim.logicalConditions) ? { logicalConditions: strings(claim.logicalConditions) } : {}),
      ...(text(claim.teachingScope) ? { teachingScope: text(claim.teachingScope) } : {}),
      ...(Array.isArray(claim.basisClaimIds) ? { basisClaimIds: strings(claim.basisClaimIds) } : {}),
      ...(text(claim.conditions) ? { conditions: text(claim.conditions) } : {}) };
    if (readingContract) {
      // Older contracts retain their saved scope prose. New factual assertions
      // use actual source text and learning-task references, not another answer.
      if (normalized.teachingScope || normalized.conditions) {
        diagnostics.push(`陈述“${id}”的生成范围或自由条件说明不作为新合同的依据，保留完整原句与能力动作。`);
      }
      delete normalized.teachingScope;
      delete normalized.conditions;
    }
    if (Array.isArray(claim.authoritativeExcerpts) || readingContract) {
      if (readingContract && claim.kind === 'textbook' && !Array.isArray(claim.authoritativeExcerpts)) {
        diagnostics.push(`陈述“${id}”未声明片段引用职责，保留教材事实，不回退为默认逐字朗读。`);
      }
      normalized.authoritativeExcerpts = normalizeAuthoritativeExcerpts(claim.authoritativeExcerpts, normalized, diagnostics);
      // This v7 field distinguishes modern requests from saved older contracts.
      // Only original spans may acquire textbook-condition identity; a missing
      // citation is retained as a diagnostic, never a semantic repair request.
      if (text(claim.conditions)) {
        delete normalized.conditions;
        diagnostics.push(`陈述“${id}”的旧式自由条件说明不作为新版条件依据，保留完整陈述与来源。`);
      }
      if (isTextbook) {
        normalized.logicalConditions = (normalized.logicalConditions ?? []).flatMap((condition) => {
          const original = originalQuotation(claimText, condition);
          if (original) return [original];
          diagnostics.push(`陈述“${id}”的条件未绑定所选原文片段，不将生成概括当作教材必要条件：${condition}`);
          return [];
        });
      }
    }
    return [normalized];
  });
  for (const claim of claims) if (claim.basisClaimIds !== undefined) {
    claim.basisClaimIds = validLocalClaimIds(claim.basisClaimIds, claimIds,
      `陈述“${claim.id}”的依据`, diagnostics, claim.id);
  }
  const learningTasks = Array.isArray(supplied.learningTasks)
    ? supplied.learningTasks.flatMap<AuthoringLearningTask>((value, index) => {
      const task = record(value);
      const operation = task.operation;
      if (operation !== 'identify' && operation !== 'explain' && operation !== 'compare' && operation !== 'apply') {
        diagnostics.push(`学习任务${index + 1}未选择有效能力动作，不将自由概括作为能力依据。`);
        return [];
      }
      const references = validLocalClaimIds(task.claimIds, claimIds,
        `学习任务“${operation}”`, diagnostics);
      if (!references.length) diagnostics.push(`学习任务“${operation}”未绑定本知识点的真实陈述，保留能力意图与来源缺口。`);
      return [{ claimIds: references, operation }];
    }) : undefined;
  const exampleIds = new Set<string>();
  const examples = (Array.isArray(supplied.examples) ? supplied.examples : []).flatMap<KnowledgeAuthoringExample>((value, index) => {
    const example = record(value);
    const selected = Object.hasOwn(example, 'factRefs')
      ? resolveExcerptRefs(example.factRefs, evidence, allowedEvidenceIds, diagnostics) : undefined;
    const authoredFacts = Array.isArray(example.facts) ? example.facts.map(text).filter(Boolean) : [];
    const facts = selected?.texts ?? authoredFacts;
    if (!text(example.title) && !facts.length && !text(example.objectAndTask)) return [];
    let id = text(example.id) || `example-${index + 1}`;
    if (exampleIds.has(id)) {
      diagnostics.push(`案例编号重复：${id}`);
      const requestedId = id;
      let suffix = 2;
      while (exampleIds.has(id)) id = `${requestedId}-${suffix++}`;
    }
    exampleIds.add(id);
    const sources = selected?.sources ?? bindSources(example.sources, evidence, allowedEvidenceIds, diagnostics);
    const versions = new Set(sources.map((source) => JSON.stringify([source.textbookId, source.revisionId])));
    const isTextbook = example.kind === 'textbook' && facts.length > 0
      && (selected?.complete ?? facts.every((fact) => authoringSourceContainsText(fact, sources, evidence)))
      && (!selected || versions.size === 1);
    if (selected && versions.size > 1) {
      diagnostics.push(`案例“${id}”选中了不同教材版本的事实，不作为同一件教材事件。`);
    }
    if (selected && authoredFacts.length && JSON.stringify(authoredFacts) !== JSON.stringify(facts.map((fact) => fact.trim()))) {
      diagnostics.push(`案例“${id}”提供了复写事实，以逐项所选不可变原文为准。`);
    }
    if (example.kind === 'textbook' && !isTextbook) {
      diagnostics.push(`案例“${id}”的事件事实未逐项绑定对应教材原文，保留为自编情境，不冒充教材案例。`);
    }
    const normalized: KnowledgeAuthoringExample = { id, kind: isTextbook ? 'textbook' as const : 'constructed' as const,
      title: text(example.title), purpose: text(example.purpose), facts,
      ...(selected ? { factRefs: selected.refs } : {}),
      explanation: text(example.explanation), sources,
      ...(text(example.objectAndTask) ? { objectAndTask: text(example.objectAndTask) } : {}),
      ...(Array.isArray(example.assumptions) ? { assumptions: strings(example.assumptions) } : {}),
      ...(Array.isArray(example.actions) ? { actions: example.actions.map(text).filter(Boolean) } : {}),
      ...(text(example.outcome) ? { outcome: text(example.outcome) } : {}),
      ...(text(example.conceptMapping) ? { conceptMapping: text(example.conceptMapping) } : {}),
      ...(Array.isArray(example.claimIds) ? { claimIds: validLocalClaimIds(example.claimIds,
        claimIds, `案例“${id}”`, diagnostics) } : {}),
      ...(example.form === 'everyday' || example.form === 'domain' || example.form === 'analogy'
        ? { form: example.form } : {}),
      ...(text(example.limitations) ? { limitations: text(example.limitations) } : {}) };
    if (Array.isArray(example.correspondences)) {
      normalized.correspondences = normalizeExampleCorrespondences(example.correspondences,
        example, normalized, claims, diagnostics, selected?.requestedIndices);
    }
    return [normalized];
  });
  const itemById = new Map((evidence?.items ?? []).map((item) => [item.id, item]));
  const allowed = allowedEvidenceIds ? new Set(allowedEvidenceIds) : undefined;
  const coverageByRevision = new Map<string, KnowledgeAuthoring['exampleCoverage'][number]>();
  for (const value of Array.isArray(supplied.exampleCoverage) ? supplied.exampleCoverage : []) {
    const coverage = record(value);
    const revisionId = text(coverage.revisionId);
    const evidenceItemIds = strings(coverage.evidenceItemIds).filter((id) =>
      itemById.get(id)?.source.revisionId === revisionId && (!allowed || allowed.has(id)));
    const relevantIds = allowedEvidenceIds?.filter((id) => itemById.get(id)?.source.revisionId === revisionId)
      ?? evidenceItemIds;
    const items = relevantIds.map((id) => itemById.get(id)!).filter(Boolean);
    if (!items.length) continue;
    const reading = readingContract
      ? normalizeSourceReadings(coverage.sourceReadings, evidence, relevantIds, revisionId, claims, examples, diagnostics)
      : undefined;
    // Related full blocks can belong to a different section of this same book.
    // Check their own real identity, rather than treating one retrieved item as
    // evidence that every attached paragraph has been read for cases.
    const relevantBlockIds = new Set(items.flatMap((item) => authoringEvidenceBlocks(item)
      .filter((block) => block.content.trim()).map((block) => block.id)));
    const missingBlocks = reading ? [...relevantBlockIds].filter((id) => !reading.recordedBlockIds.has(id)) : [];
    if (readingContract && !relevantBlockIds.size) {
      diagnostics.push(`教材版本“${revisionId}”没有可验证的完整原文块，索引概括不能代替案例阅读记录。`);
    }
    if (missingBlocks.length) {
      diagnostics.push(`教材版本“${revisionId}”尚缺完整原文块的案例阅读记录：${missingBlocks.join('、')}；保留来源与候选，不自动认定教材没有案例。`);
    }
    const complete = coverage.status === 'complete' && relevantIds.every((id) => evidenceItemIds.includes(id))
      && items.every((item) => item.sourceContext?.status === 'complete') && !missingBlocks.length
      && (!readingContract || relevantBlockIds.size > 0);
    if (coverage.status === 'complete' && !complete) {
      diagnostics.push(`教材版本“${revisionId}”的相关正文尚未完整绑定，不能认定已穷尽教材案例。`);
    }
    coverageByRevision.set(revisionId, { textbookId: items[0]!.source.textbookId, revisionId,
      status: complete ? 'complete' : 'partial', evidenceItemIds,
      ...(reading ? { sourceReadings: reading.readings } : {}) });
  }
  for (const id of allowedEvidenceIds ?? []) {
    const item = itemById.get(id);
    if (!item || coverageByRevision.has(item.source.revisionId)) continue;
    coverageByRevision.set(item.source.revisionId, { textbookId: item.source.textbookId,
      revisionId: item.source.revisionId, status: 'partial', evidenceItemIds: allowedEvidenceIds!.filter((candidate) =>
        itemById.get(candidate)?.source.revisionId === item.source.revisionId),
      ...(readingContract ? { sourceReadings: [] } : {}) });
    if (readingContract) {
      const missingBlocks = [...new Set(allowedEvidenceIds!.flatMap((id) => {
        const related = itemById.get(id);
        return related?.source.revisionId === item.source.revisionId
          ? authoringEvidenceBlocks(related).filter((block) => block.content.trim()).map((block) => block.id) : [];
      }))];
      diagnostics.push(missingBlocks.length
        ? `教材版本“${item.source.revisionId}”尚缺完整原文块的案例阅读记录：${missingBlocks.join('、')}；保留来源与候选，不自动认定教材没有案例。`
        : `教材版本“${item.source.revisionId}”没有可验证的完整原文块，索引概括不能代替案例阅读记录。`);
    }
  }
  return { ...(readingContract ? { readingContract } : {}), claims,
    ...(learningTasks ? { learningTasks } : {}), examples, exampleCoverage: [...coverageByRevision.values()],
    ...(diagnostics.length ? { diagnostics: [...new Set(diagnostics)] } : {}) };
}
