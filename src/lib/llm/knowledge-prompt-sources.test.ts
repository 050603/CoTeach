import { describe, expect, it } from 'vitest';
import { deduplicateKnowledgePromptSources } from './prompts';

describe('lossless knowledge prompt source references', () => {
  it('stores identical original passages once and restores both prose and nested JSON without losing conditions', () => {
    const source = '教师要精心选择与学习主题紧密相关的真实且具有挑战性的事件或问题作为学习的中心，激发学生主动探究，不直接提供答案。\n学生须依据证据选择解决方法，并解释必要条件。';
    const qualified = `${source}仅当学生具备相关先修知识时采用，不能忽略这一前提。`;
    const summary = JSON.stringify({ items: [{ source }, { source }, { source: qualified }] });
    const original = `课程说明：${summary}\n原文：${source}\n再次采用：${source}\n额外条件：${qualified}`;
    const result = deduplicateKnowledgePromptSources(original, { summary, source, qualified });
    const [instructions, catalog, ...body] = result.split('\n\n');
    expect(instructions).toContain('所有事实、限定条件和来源身份均保留');
    const { sourceTexts } = JSON.parse(catalog!) as { sourceTexts: Record<string, string> };
    const restored = body.join('\n\n').replace(/⟦source-(text|json):(\d+)⟧/gu, (_match, kind, id) => {
      const text = sourceTexts[id]!;
      return kind === 'json' ? JSON.stringify(text).slice(1, -1) : text;
    });
    expect(restored).toBe(original);
    expect(Object.values(sourceTexts)).toContain(qualified);
    expect(result).not.toContain('undefined');
  });

  it('does not reinterpret reference-looking notation inside an original source', () => {
    const original = '原文含有 ⟦source-text:1⟧ 的示例，不是真正的模型来源引用。'.repeat(4);
    expect(deduplicateKnowledgePromptSources(original, original)).toBe(original);
  });
});
