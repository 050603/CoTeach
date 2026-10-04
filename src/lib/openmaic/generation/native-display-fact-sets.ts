import type { PPTElement, SlideContentBinding } from '@openmaic/dsl';
import { extractVisibleElementText, isValidSlideVisualTarget } from './semantic-visual-cues';
import { buildSlideSemanticGroups } from './slide-semantic-hierarchy';

/** A narrow, page-owned factual list, independent of visual grouping. */
export interface NativeDisplayFactSet {
  sourceContentId: string;
  terms: string[];
  /** Finite licensed spellings, including the original term. No synonym search. */
  acceptedForms?: Record<string, string[]>;
}

export interface NativeDisplayFactItem {
  id: string;
  text: string;
  sourceContentIds: readonly string[];
}

type NativeFactContent = {
  elements: readonly PPTElement[];
  displayItems?: readonly NativeDisplayFactItem[];
  contentBindings?: readonly SlideContentBinding[];
};

const declarationVerb = /包括|包含|涵盖|分为|分成|设有|设计|创设|准备|提供|配置|采集|测量|记录|评价|评估|考察|关注|考虑|需要|由/gu;
const openList = /例如|比如|譬如|举例|不限于|任选|任意选择|可选|其中|部分|若干|一些|其他|其它|至少|最多|至多|不少于|不超过|等[^、，,；;。！？!?]{0,12}$/u;
const sentenceLike = /[:：，,；;。！？!?]|(?:支持|帮助|促进|用于|通过|围绕|需要|包括|包含|设计|创设|提供|实现|完成|必须|应当|能够|可以|从而|因为|所以|或者)/u;
const roleName = /^(?:学习|教学|实验|研究|训练|生产)(活动|资源|环境|材料|工具|任务|设备|步骤|数据|成果)$/u;
const compact = (text: string) => text.normalize('NFKC').replace(/\s+/gu, '');

function shortList(payload: string): string[] | undefined {
  if (!payload.includes('、') || openList.test(payload) || /[或]/u.test(payload)) return;
  const parts = payload.trim().replace(/^[“「『"]|[”」』"]$/gu, '').split('、');
  const last = parts.at(-1)!;
  const conjunction = [...last.matchAll(/以及|和|与|及/gu)].at(-1);
  if (conjunction) {
    const left = last.slice(0, conjunction.index).trim();
    const right = last.slice(conjunction.index! + conjunction[0].length).trim();
    // A conjunction inside a short proper name is ambiguous. Do not guess.
    if ([...left].length < 2 || [...right].length < 2) return;
    parts.splice(parts.length - 1, 1, left, right);
  }
  const terms = parts.map((part) => part.trim().replace(/^[“「『"]|[”」』"]$/gu, '').trim());
  if (terms.length < 2 || terms.length > 12 || new Set(terms).size !== terms.length
    || terms.some((term) => !term || [...term].length > 24 || sentenceLike.test(term)
      || !/^[\p{L}\p{N}][\p{L}\p{N}\s·+\-]*$/u.test(term))) return;
  return terms;
}

function contract(sourceContentId: string, terms: string[]): NativeDisplayFactSet {
  const acceptedForms: Record<string, string[]> = {};
  for (const term of terms) {
    const short = roleName.exec(term)?.[1];
    // Distinct modified roles cannot both be satisfied by their shared noun.
    if (short && !terms.some((other) => other !== term && compact(other).endsWith(short))) {
      acceptedForms[term] = [term, short];
    }
  }
  return { sourceContentId, terms, ...(Object.keys(acceptedForms).length ? { acceptedForms } : {}) };
}

/** Only adopted text supplies duties. Uncounted complete object lists are
 * accepted only after an explicit declaration verb or as a simple colon list.
 * This intentionally does not claim to parse arbitrary prose or all facts. */
export function buildNativeDisplayFactSets(sources: readonly { id: string; text: string }[]): NativeDisplayFactSet[] {
  const result: NativeDisplayFactSet[] = [];
  const seen = new Set<string>();
  const semanticGroups = buildSlideSemanticGroups(sources);
  for (const source of sources) for (const sentence of source.text.split(/[。！？!?；;\n]/u)) {
    if (!sentence.includes('、') || openList.test(sentence)) continue;
    const colon = sentence.indexOf('：') >= 0 ? sentence.indexOf('：') : sentence.indexOf(':');
    const body = colon >= 0 ? sentence.slice(colon + 1).trim() : sentence.trim();
    const simple = colon >= 0 ? shortList(body) : undefined;
    const lists = simple ? [simple] : body.split(/[，,]/u).flatMap((clause) => {
      const separator = clause.indexOf('、');
      if (separator < 0) return [];
      const declaration = [...clause.slice(0, separator).matchAll(declarationVerb)].at(-1);
      if (!declaration) return [];
      let payload = clause.slice(declaration.index! + declaration[0].length).trim();
      if (declaration[0] === '由') {
        if (!/(?:组成|构成)$/u.test(payload)) return [];
        payload = payload.replace(/(?:组成|构成)$/u, '');
      }
      const terms = shortList(payload);
      return terms ? [terms] : [];
    });
    for (const terms of lists) {
      // Counted groups already aggregate actual member slots across their
      // licensed explanation sources. Do not force their overview to repeat
      // every name through an additional single-source prose contract.
      if (semanticGroups.some((group) => group.sourceContentIds.includes(source.id)
        && group.members.length === terms.length && group.members.every((member) => terms.includes(member.label)))) continue;
      const key = JSON.stringify([source.id, terms]);
      if (!seen.has(key)) { seen.add(key); result.push(contract(source.id, terms)); }
    }
  }
  return result;
}

function hasTerm(text: string, term: string): boolean {
  const expected = compact(term);
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (/^[A-Za-z0-9+\-]+$/u.test(expected)) {
    return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'u').test(text.normalize('NFKC'));
  }
  return compact(text).includes(expected);
}

function missingTerms(text: string, set: NativeDisplayFactSet): string[] {
  return set.terms.filter((term) => !(set.acceptedForms?.[term] ?? [term]).some((form) => hasTerm(text, form)));
}

/** Raw prose coverage is a quality diagnosis, never a source identity error. */
export function nativeDisplayFactItemIssues(items: readonly NativeDisplayFactItem[], sets: readonly NativeDisplayFactSet[]): string[] {
  return [...new Set(sets.flatMap((set) => {
    const text = items.filter((item) => item.sourceContentIds.includes(set.sourceContentId)).map((item) => item.text).join('\n');
    return missingTerms(text, set).map((term) => `Native display fact: ${set.sourceContentId} omits required term ${term} in its display prose`);
  }))];
}

function visibleElement(element: PPTElement): boolean {
  return element.type !== 'line' && [element.left, element.top, element.width, element.height].every(Number.isFinite)
    && element.width > 0 && element.height > 0 && element.left >= 0 && element.top >= 0
    && element.left + element.width <= 1000.5 && element.top + element.height <= 563
    && (!('opacity' in element) || element.opacity !== 0);
}

function visibleSlotText(element: PPTElement, binding: SlideContentBinding): string {
  let actual = element;
  if (element.type === 'table' && binding.selector) {
    const selector = binding.selector;
    if ('cellId' in selector) {
      const cell = element.data.flat().find((candidate) => candidate.id === selector.cellId);
      if (!cell) return '';
      actual = { ...element, data: [[cell]] };
    } else if ('rowIndex' in selector) {
      const row = element.data[selector.rowIndex];
      if (!row) return '';
      actual = { ...element, data: [row] };
    }
  }
  const html = actual.type === 'text' ? actual.content : actual.type === 'shape' ? actual.text?.content ?? ''
    : actual.type === 'table' ? actual.data.flat().map((cell) => cell.text).join('\n') : '';
  if (/(?:display\s*:\s*none|visibility\s*:\s*hidden|(?:opacity|font-size)\s*:\s*0(?:px|[;"\s])|color\s*:\s*transparent)/iu.test(html)) return '';
  const text = extractVisibleElementText(actual);
  // The selector was validated against the original actual target first.
  return binding.selector?.quote ? binding.selector.quote : text;
}

/** Check only body bindings owned by corresponding display items. A caption,
 * metadata label or another source's occurrence cannot supply a missing fact. */
export function nativeDisplayFactVisualIssues(content: NativeFactContent, sets: readonly NativeDisplayFactSet[]): string[] {
  const elements = new Map(content.elements.map((element) => [element.id, element]));
  const issues: string[] = [];
  for (const set of sets) {
    const itemIds = new Set((content.displayItems ?? []).filter((item) => item.sourceContentIds.includes(set.sourceContentId)).map((item) => item.id));
    const text = (content.contentBindings ?? []).filter((binding) => itemIds.has(binding.sourceContentId)).flatMap((binding) => {
      const element = elements.get(binding.elementId);
      if (!element || !['text', 'shape', 'table'].includes(element.type) || !visibleElement(element)
        || !isValidSlideVisualTarget(content.elements, binding)) return [];
      return [visibleSlotText(element, binding)];
    }).join('\n');
    for (const term of missingTerms(text, set)) issues.push(`Native display fact: ${set.sourceContentId} omits required term ${term} in its actual bound body slots`);
  }
  return [...new Set(issues)];
}
