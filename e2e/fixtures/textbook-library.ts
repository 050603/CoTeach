import type { TextbookDetailPayload } from '../../src/app/teacher/textbooks/textbook-view-types';

export const textbookId = 'e2e-digital-textbook';
export const textbookTitle = '人工智能基础与教学实践';
export const firstChapter = '第一章 人工智能：从基本原理到课堂中的实践与反思';
export const firstSection = '1.1 理解智能与学习';
export const conceptName = (index: number) => `知识点 ${String(index + 1).padStart(4, '0')}`;

export function textbookFixture(count = 300): TextbookDetailPayload {
  const roots = Math.min(12, Math.ceil(count / 25));
  const sections = Array.from({ length: roots }, (_, index) => [
    { id: `chapter-${index}`, title: index === 0 ? firstChapter : `第${index + 1}章 教学实践与知识探索`, position: index * 2, level: 1 },
    { id: `section-${index}`, parentId: `chapter-${index}`, title: index === 0 ? firstSection : `${index + 1}.1 应用与探索`, position: index * 2 + 1, level: 2 },
  ]).flat();
  const concepts = Array.from({ length: count }, (_, index) => ({
    id: `concept-${index}`, name: conceptName(index), sectionId: `section-${Math.floor(index * roots / count)}`,
    kind: 'CONCEPT', explanation: `这是${conceptName(index)}的教材解释，通过真实教学情境理解概念并建立与其他知识的联系。`,
    aliases: index === 0 ? ['智能基础'] : [], sourceBlockIds: [`block-${index}`],
    evidence: [{ sourceBlockId: `block-${index}`, quote: `原文证据 ${index + 1}：学习是通过经验调整行为与认识的过程。` }],
  }));
  return {
    textbook: { id: textbookId, title: textbookTitle, author: '数字教材研究组', updatedAt: '2026-09-22T00:00:00.000Z', currentRevision: { id: 'revision-ready', version: 2, status: 'READY', progress: 1 } },
    revision: { id: 'revision-ready', version: 2, status: 'READY', progress: 1 }, sections, concepts,
    sourceBlocks: concepts.map((concept, index) => ({ id: `block-${index}`, sectionId: concept.sectionId, position: index, blockType: index % 9 === 8 ? 'LIST_ITEM' : 'PARAGRAPH', content: `原文证据 ${index + 1}：学习是通过经验调整行为与认识的过程。教学中，我们可以通过观察、比较与实践逐步掌握这一知识。` })),
    relations: Array.from({ length: Math.min(12000, count * 4) }, (_, index) => ({
      id: `relation-${index}`, sourceConceptId: `concept-${index % count}`, targetConceptId: `concept-${(index % count + [1, 7, 29, 257][Math.floor(index / count)]) % count}`,
      relationType: ['prerequisite', 'related', 'application', 'comparison'][Math.floor(index / count)], origin: index % 5 === 0 ? 'INFERRED' : 'TEXTBOOK', inferred: index % 5 === 0,
    })),
    examples: [{ id: 'example-1', conceptId: 'concept-0', title: '课堂中的智能分类', content: '比较不同教学任务，观察分类标准如何影响学习结果。' }], figures: [],
  };
}
