/** Numbered steps immediately following a figure caption belong to that
 * figure even when a retrieval chunk ends midway through the list. */
export const SOURCE_SEQUENCE_POLICY_VERSION = 2;

export type FigureSequenceBlock = {
  id: string;
  position: number;
  blockType: string;
  content: string;
};

export type FigureSequenceStep = {
  label: string;
  sourceBlockId: string;
  excerpt?: string;
  excerptBlockId?: string;
};

export type OrderedSourceSequence = {
  anchorSourceBlockId: string;
  steps: FigureSequenceStep[];
};

function numberedHeading(value: string): {
  number: number; label: string; marker: 'decimal' | 'parenthesized' | 'closing-parenthesis'; excerpt?: string;
} | null {
  const match = /^(?:[(（]([\d０-９]{1,2})[)）]|([\d０-９]{1,2})([.．、)）]))\s*(.+)$/u.exec(value.trim());
  if (!match) return null;
  const separator = match[4]!.search(/[：:。；;]/u);
  const label = (separator < 0 ? match[4]! : match[4]!.slice(0, separator)).trim();
  if (label.length < 2 || label.length > 40) return null;
  const excerpt = separator < 0 ? undefined : match[4]!.slice(separator + 1).trim();
  return { number: Number((match[1] ?? match[2])!.normalize('NFKC')), label,
    marker: match[1] ? 'parenthesized' : /[)）]/u.test(match[3]!) ? 'closing-parenthesis' : 'decimal',
    ...(excerpt ? { excerpt } : {}) };
}

export function extractFigureSequence(blocks: readonly FigureSequenceBlock[]): FigureSequenceStep[] {
  const steps: FigureSequenceStep[] = [];
  let prefaceBlocks = 0;
  let marker: ReturnType<typeof numberedHeading> = null;
  let insideNestedList = false;
  for (const block of [...blocks].sort((left, right) => left.position - right.position)) {
    const text = block.content.trim();
    const heading = numberedHeading(text);
    if (block.blockType === "CAPTION" || block.blockType === "TITLE"
      || (block.blockType === "HEADING" && !heading)) break;
    if (heading) {
      if (marker && heading.marker !== marker.marker) {
        // A decimal parent list can contain (1)/(2) advice under each stage.
        // Those child numbers are neither the parent's next stage nor an
        // invitation to merge the next decimal stage into the child list.
        if (marker.marker !== 'decimal' || heading.marker === 'decimal') break;
        insideNestedList = true;
        continue;
      }
      if (heading.number !== steps.length + 1) break;
      marker ??= heading;
      insideNestedList = false;
      steps.push({ label: heading.label, sourceBlockId: block.id,
        ...(heading.excerpt ? { excerpt: heading.excerpt, excerptBlockId: block.id } : {}) });
      continue;
    }
    if (!steps.length) {
      prefaceBlocks += 1;
      if (prefaceBlocks > 2) break;
      continue;
    }
    const last = steps[steps.length - 1]!;
    if (!insideNestedList && !last.excerpt && text && block.blockType === "PARAGRAPH") {
      last.excerpt = text;
      last.excerptBlockId = block.id;
    }
  }
  return steps.length >= 2 ? steps : [];
}

/** Enumerations are source facts, regardless of the search chunk that found them. */
export function extractOrderedSourceSequences(blocks: readonly FigureSequenceBlock[]): OrderedSourceSequence[] {
  const ordered = [...blocks].sort((left, right) => left.position - right.position);
  const result: OrderedSourceSequence[] = [];
  for (const [index, block] of ordered.entries()) {
    if (numberedHeading(block.content)?.number !== 1) continue;
    const steps = extractFigureSequence(ordered.slice(index));
    if (steps.length >= 2) result.push({ anchorSourceBlockId: block.id, steps });
  }
  return result;
}
