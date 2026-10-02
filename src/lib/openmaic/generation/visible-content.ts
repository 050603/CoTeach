/** Browser-safe visible teaching claims; no measurement or source I/O. */
export function normalizeVisibleClaim(value: string): string {
  return value.trim().toLowerCase()
    .replace(/(?:是指|指的是|意为|意味着)/g, '是')
    .replace(/(?:能够|可以|可用于|用来)/g, '可')
    .replace(/(?:以及|和|与)/g, '与')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function criticalParts(value: string): string[] {
  return [...value.matchAll(/(?:仅当|只有|必须|不得|不能|不包括|不|无|除非|至少|至多|如果|若|则|当|前提|条件|例外|并且|同时|需要|需|应|包含|包括|\d+(?:\.\d+)?%?)/g)]
    .map(([part]) => part).sort();
}

export function visibleClaimBigrams(value: string): Set<string> {
  const chars = [...value];
  return new Set(chars.length < 2 ? chars : chars.slice(1).map((char, index) => `${chars[index]}${char}`));
}

/** Conservative semantic repetition check: distinct conditions and quantities never collapse. */
export function equivalentVisibleClaim(left: string, right: string): boolean {
  const a = normalizeVisibleClaim(left), b = normalizeVisibleClaim(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (criticalParts(left).join('|') !== criticalParts(right).join('|')) return false;
  if (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))
    && Math.max(a.length, b.length) <= Math.min(a.length, b.length) * 1.2) return true;
  const aa = visibleClaimBigrams(a), bb = visibleClaimBigrams(b);
  const shared = [...aa].filter((part) => bb.has(part)).length;
  return Math.min(a.length, b.length) >= 8 && 2 * shared / (aa.size + bb.size) >= 0.76;
}

export type CanonicalVisibleContentInput = {
  /** Complete definitions, conditions, conclusions and other non-negotiable wording. */
  required?: readonly string[];
  /** Previously adopted on-screen content. */
  inherited?: readonly string[];
  /** Final design or enhancement suggestions. */
  proposed?: readonly string[];
};

/** Preserve full required claims while removing equivalent restatements and bare labels. */
export function canonicalVisibleContent(input: CanonicalVisibleContentInput): string[] {
  const result: Array<{ text: string; required: boolean }> = [];
  const append = (value: string, required: boolean) => {
    const text = value.trim();
    if (!text) return;
    const normalized = normalizeVisibleClaim(text);
    const contained = result.find((item) => normalizeVisibleClaim(item.text).includes(normalized)
      && normalized.length >= 4);
    if (contained) return;
    const superseded = result.findIndex((item) => !item.required && normalized.includes(normalizeVisibleClaim(item.text))
      && normalizeVisibleClaim(item.text).length >= 4);
    if (superseded >= 0) { result[superseded] = { text, required }; return; }
    const same = result.findIndex((item) => equivalentVisibleClaim(item.text, text));
    if (same < 0) { result.push({ text, required }); return; }
    const prior = result[same]!;
    if (prior.required) return;
    // A complete later statement replaces a concise label or paraphrase, at
    // the original reading position. A mandatory definition is never replaced.
    if (required || normalizeVisibleClaim(text).length > normalizeVisibleClaim(prior.text).length) {
      result[same] = { text, required };
    }
  };
  for (const text of input.required ?? []) append(text, true);
  for (const text of input.inherited ?? []) append(text, false);
  for (const text of input.proposed ?? []) append(text, false);
  return result.map((item) => item.text);
}

