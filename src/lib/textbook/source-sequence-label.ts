/** Source labels are finite spellings, not free-form semantic aliases. */
export function compactSourceSequenceText(value: string): string {
  return value.normalize('NFKC').replace(/[\s，。！？、；：,.!?;:'“”‘’()（）【】\[\]《》<>—_-]+/gu, '');
}

export function sourceSequenceLabelKey(value: string): string {
  const quotedAction = value.trim().match(/^进行\s*[“「『"‘']([^“”「」『』"‘']+)[”」』"’']$/u);
  const full = compactSourceSequenceText(quotedAction?.[1] ?? value);
  // A diagram may put the structural word “阶段” in its heading instead of
  // repeating it on every node. Keep the complete, specific stage name;
  // short generic actions and other meaningful suffixes have no such alias.
  return full.match(/^(.{4,})阶段$/u)?.[1] ?? full;
}

/** Locate the first licensed spelling in compact text coordinates. A method
 * name containing a quoted action does not supply that action's short label. */
export function findSourceSequenceLabelPosition(text: string, label: string): number {
  const normalized = compactSourceSequenceText(text);
  const full = compactSourceSequenceText(label);
  const fullPosition = normalized.indexOf(full);
  const short = sourceSequenceLabelKey(label);
  if (short === full) return fullPosition;
  for (let start = normalized.indexOf(short); start >= 0; start = normalized.indexOf(short, start + 1)) {
    if (!/^[式型法]/u.test(normalized.slice(start + short.length))) {
      return fullPosition < 0 ? start : Math.min(fullPosition, start);
    }
  }
  return fullPosition;
}

export function hasSourceSequenceLabel(text: string, label: string): boolean {
  return findSourceSequenceLabelPosition(text, label) >= 0;
}
