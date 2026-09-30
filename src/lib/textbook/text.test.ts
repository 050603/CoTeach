import { describe, expect, it } from 'vitest';
import { buildRetrievalChunks } from './text';
import type { ParsedTextbookBlock } from './types';

describe('textbook retrieval chunk source boundaries', () => {
  it('keeps bounded search text but references a complete numbered unit', () => {
    const contents = ['引入'.repeat(10), '1. 选择项目', '说明'.repeat(20),
      '2. 制定计划', '说明'.repeat(20), '3. 活动探究', '说明'.repeat(20),
      '4. 制作作品', '说明'.repeat(20), '5. 成果交流', '说明'.repeat(20),
      '6. 活动评价', '说明'.repeat(20)];
    const blocks: ParsedTextbookBlock[] = contents.map((content, position) => ({
      key: `b-${position}`, sectionKey: 's', type: 'PARAGRAPH', position,
      content, metadata: {},
    }));
    const chunks = buildRetrievalChunks(blocks, [{
      key: 's', parentKey: null, title: '项目式教学', path: '项目式教学',
      kind: 'SECTION', level: 1, position: 0,
    }], { targetCharacters: 65, maximumCharacters: 90 });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.content.length <= 90)).toBe(true);
    const firstStage = chunks.find((chunk) => chunk.content.includes('选择项目'))!;
    expect(firstStage.sourceBlockKeys).toContain('b-11');
    const lastStage = chunks.find((chunk) => chunk.content.includes('活动评价'))!;
    expect(lastStage.sourceBlockKeys).toContain('b-1');
  });
});
