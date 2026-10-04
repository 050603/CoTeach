import type { AuthoringSourceBinding } from './knowledge-authoring';

export type SpokenSourceBlock = {
  id: string;
  text: string;
  source: AuthoringSourceBinding;
  /** A complete adopted passage can be cited by its canonical ID without
   * pretending each constituent block contains the entire passage. */
  aliases?: string[];
};

export type SpokenSourceNormalization = {
  ref: string;
  resolvedCanonicalIds: string[];
};

const nonempty = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());

function requireIdentity(block: SpokenSourceBlock, ref: string): void {
  if (!nonempty(block.id) || !nonempty(block.text) || !nonempty(block.source.evidenceItemId)
    || !nonempty(block.source.textbookId) || !nonempty(block.source.revisionId)
    || !block.source.sourceBlockIds.length || block.source.sourceBlockIds.some((id) => !nonempty(id))) {
    throw new Error(`口播段落引用缺少完整原文身份：${ref}`);
  }
}

function immutableIdentity(block: SpokenSourceBlock): string {
  return JSON.stringify([block.source.textbookId, block.source.revisionId,
    block.source.sourceBlockIds, block.text]);
}

function scopeIdentity(block: SpokenSourceBlock): string {
  return JSON.stringify([block.source.textbookId, block.source.revisionId]);
}

function requireOnePassage(matches: readonly SpokenSourceBlock[], ref: string): void {
  matches.forEach((block) => requireIdentity(block, ref));
  if (new Set(matches.map(immutableIdentity)).size !== 1) {
    throw new Error(`口播段落引用存在歧义的原文：${ref}，需使用完整来源编号`);
  }
}

function bindings(matches: readonly SpokenSourceBlock[]): AuthoringSourceBinding[] {
  return [...new Map(matches.map((block) => [JSON.stringify(block.source), block.source])).values()];
}

/** Resolve only the adopted catalog. A misplaced wrapper can be corrected
 * when both its scope and the complete original passage are unambiguous. */
export function createSpokenSourceResolver(
  blocks: readonly SpokenSourceBlock[],
  onNormalization?: (event: SpokenSourceNormalization) => void,
): (ref: string) => AuthoringSourceBinding[] {
  const exact = new Map<string, SpokenSourceBlock[]>();
  const aliases = new Map<string, SpokenSourceBlock[]>();
  const wrappers = new Map<string, SpokenSourceBlock[]>();
  for (const block of blocks) {
    exact.set(block.id, [...(exact.get(block.id) ?? []), block]);
    wrappers.set(block.source.evidenceItemId, [...(wrappers.get(block.source.evidenceItemId) ?? []), block]);
    for (const id of block.aliases ?? block.source.sourceBlockIds) {
      aliases.set(id, [...(aliases.get(id) ?? []), block]);
    }
  }

  return (ref) => {
    const direct = exact.get(ref);
    if (direct) {
      requireOnePassage(direct, ref);
      return bindings(direct);
    }
    const bare = aliases.get(ref);
    if (bare) {
      requireOnePassage(bare, ref);
      return bindings(bare);
    }

    // Source and wrapper IDs may themselves contain colons. Match actual
    // adopted prefixes; never infer a wrapper by splitting an arbitrary ID.
    const prefixes = [...wrappers.keys()].filter((id) => nonempty(id) && ref.startsWith(`${id}:`));
    if (!prefixes.length) throw new Error(`口播段落引用未知原文：${ref}`);
    if (prefixes.length !== 1) throw new Error(`口播段落引用存在歧义的来源前缀：${ref}`);
    const prefix = prefixes[0]!;
    const owner = wrappers.get(prefix)!;
    owner.forEach((block) => requireIdentity(block, ref));
    const scopes = new Set(owner.map(scopeIdentity));
    if (scopes.size !== 1) throw new Error(`口播段落引用的来源前缀混合教材或版本：${ref}`);

    const suffix = ref.slice(prefix.length + 1);
    const matches = aliases.get(suffix);
    if (!matches?.length) throw new Error(`口播段落引用未知原文：${ref}`);
    // Inspect every adopted suffix match before comparing the wrapper scope.
    // Filtering first could conceal an identity conflict in another source.
    requireOnePassage(matches, ref);
    if (scopeIdentity(matches[0]!) !== scopeIdentity(owner[0]!)) {
      throw new Error(`口播段落引用的原文与来源前缀教材或版本不一致：${ref}`);
    }
    onNormalization?.({ ref, resolvedCanonicalIds: [...new Set(matches.map((block) => block.id))] });
    return bindings(matches);
  };
}
