import { describe, expect, it, vi } from 'vitest';
import { createSpokenSourceResolver, type SpokenSourceBlock } from './spoken-source-bindings';

function block(wrapper: string, original: string, text = '同一版本的完整原文。'): SpokenSourceBlock {
  return { id: `${wrapper}:${original}`, text,
    source: { evidenceItemId: wrapper, sourceBlockIds: [original], textbookId: 'book', revisionId: 'r1' } };
}

function catalog(): SpokenSourceBlock[] {
  return [block('concept', 'definition', '概念的完整定义。'), block('process', 'step', '过程的完整原文。')];
}

describe('adopted spoken source bindings', () => {
  it('retains exact and safe bare bindings without normalization diagnostics or catalog mutation', () => {
    const source = catalog();
    const before = structuredClone(source);
    const diagnostic = vi.fn();
    const resolve = createSpokenSourceResolver(source, diagnostic);
    expect(resolve('process:step')).toEqual([source[1]!.source]);
    expect(resolve('step')).toEqual([source[1]!.source]);
    expect(diagnostic).not.toHaveBeenCalled();
    expect(source).toEqual(before);
  });

  it('corrects an adopted wrapper mismatch to the actual original owner and records the correction', () => {
    const source = catalog();
    const before = structuredClone(source);
    const diagnostic = vi.fn();
    const resolve = createSpokenSourceResolver(source, diagnostic);
    expect(resolve('concept:step')).toEqual([source[1]!.source]);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ ref: 'concept:step', resolvedCanonicalIds: ['process:step'] });
    expect(source).toEqual(before);
  });

  it('retains all adopted wrappers of the same immutable passage for bare and corrected references', () => {
    const source = [...catalog(), block('second-process', 'step', '过程的完整原文。')];
    const diagnostic = vi.fn();
    const resolve = createSpokenSourceResolver(source, diagnostic);
    expect(resolve('step')).toEqual([source[1]!.source, source[2]!.source]);
    expect(resolve('concept:step')).toEqual([source[1]!.source, source[2]!.source]);
    expect(resolve('process:step')).toEqual([source[1]!.source]);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ ref: 'concept:step',
      resolvedCanonicalIds: ['process:step', 'second-process:step'] });
  });

  it.each(['unknown:step', 'unadopted:step', 'concept:unknown', 'unknown', 'concept:'])
    ('rejects unknown or unadopted identities (%s) without a correction diagnostic', (ref) => {
      const diagnostic = vi.fn();
      expect(() => createSpokenSourceResolver(catalog(), diagnostic)(ref)).toThrow('未知原文');
      expect(diagnostic).not.toHaveBeenCalled();
    });

  it.each(['textbookId', 'revisionId'] as const)('rejects a correction across %s', (key) => {
    const source = catalog();
    source[1]!.source[key] = 'another';
    expect(() => createSpokenSourceResolver(source)('concept:step')).toThrow('教材或版本不一致');
    expect(createSpokenSourceResolver(source)('process:step')).toEqual([source[1]!.source]);
  });

  it.each(['textbookId', 'revisionId'] as const)('rejects a wrapper with mixed %s scope', (key) => {
    const source = [...catalog(), block('concept', 'other-definition')];
    source[2]!.source[key] = 'another';
    expect(() => createSpokenSourceResolver(source)('concept:step')).toThrow('混合教材或版本');
  });

  it.each(['textbookId', 'revisionId', 'text'] as const)
    ('rejects every conflicting suffix identity before restricting to the wrapper scope (%s)', (key) => {
      const conflict = block('other-process', 'step', '过程的完整原文。');
      if (key === 'text') conflict.text = '不同的真实原文。';
      else conflict.source[key] = 'another';
      const source = [...catalog(), conflict];
      const resolve = createSpokenSourceResolver(source);
      expect(() => resolve('concept:step')).toThrow('存在歧义');
      expect(() => resolve('step')).toThrow('存在歧义');
      expect(resolve('process:step')).toEqual([source[1]!.source]);
    });

  it.each(['textbookId', 'revisionId', 'evidenceItemId', 'sourceBlockIds', 'text'] as const)
    ('rejects incomplete immutable identities (%s)', (key) => {
      const source = catalog();
      if (key === 'text') source[1]!.text = ' ';
      else if (key === 'sourceBlockIds') source[1]!.source.sourceBlockIds = [];
      else source[1]!.source[key] = '';
      expect(() => createSpokenSourceResolver(source)('process:step')).toThrow('缺少完整原文身份');
    });

  it('rejects an incomplete prefix even when the requested suffix is a complete adopted passage', () => {
    const source = catalog();
    source[0]!.source.revisionId = undefined;
    expect(() => createSpokenSourceResolver(source)('concept:step')).toThrow('缺少完整原文身份');
  });

  it('does not discard an incomplete suffix match to accept another complete one', () => {
    const incomplete = block('other-process', 'step', '过程的完整原文。');
    incomplete.source.textbookId = undefined;
    expect(() => createSpokenSourceResolver([...catalog(), incomplete])('concept:step'))
      .toThrow('缺少完整原文身份');
  });

  it('uses the whole known prefix and whole original ID when either contains colons', () => {
    const source = [block('concept:adopted', 'definition'), block('process', 'step:sub-block')];
    const diagnostic = vi.fn();
    expect(createSpokenSourceResolver(source, diagnostic)('concept:adopted:step:sub-block')).toEqual([source[1]!.source]);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ ref: 'concept:adopted:step:sub-block',
      resolvedCanonicalIds: ['process:step:sub-block'] });
    expect(createSpokenSourceResolver(source)('step:sub-block')).toEqual([source[1]!.source]);
  });

  it('rejects ambiguous known prefixes instead of guessing how to split the colon', () => {
    const source = [block('concept', 'definition'), block('concept:adopted', 'other-definition'), block('process', 'step')];
    expect(() => createSpokenSourceResolver(source)('concept:adopted:step')).toThrow('歧义的来源前缀');
  });

  it('rejects conflicting duplicate canonical IDs instead of selecting the last catalog entry', () => {
    const source = [block('process', 'step', '原文一。'), block('process', 'step', '原文二。')];
    expect(() => createSpokenSourceResolver(source)('process:step')).toThrow('存在歧义');
  });
});
