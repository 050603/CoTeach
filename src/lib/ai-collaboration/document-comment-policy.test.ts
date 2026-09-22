import { describe, expect, it } from 'vitest';

import {
  areDocumentCommentIssuesEquivalent,
  buildBatchProactiveDocumentCommentPrompts,
  buildProactiveDocumentCommentPrompts,
  documentParagraphVersionFingerprint,
  isReviewableDocumentParagraph,
  normalizeBatchProactiveDocumentComments,
  normalizeDocumentCommentReply,
  normalizeProactiveDocumentComment,
} from './document-comment-policy';

const course = {
  id: 'course-1',
  name: '校园新闻项目',
  currentStageIndex: 0,
  stages: [{ key: 'make', label: '制作', description: '完成新闻作品' }],
  students: [],
  groups: [],
  content: { knowledgePoints: [], evaluationPlan: { dimensions: [] } },
} as never;

describe('document comment collaboration policy', () => {
  it('uses content rather than transient Plate IDs to identify a reviewed paragraph version', () => {
    expect(documentParagraphVersionFingerprint('  我们选择这个方案。\n因为成本更低。  '))
      .toBe(documentParagraphVersionFingerprint('我们选择这个方案。 因为成本更低。'));
    expect(documentParagraphVersionFingerprint('我们选择这个方案，因为成本更低。'))
      .not.toBe(documentParagraphVersionFingerprint('我们选择这个方案，因为效果更好。'));
  });

  it('reviews short meaningful sentences instead of requiring a 40-character paragraph', () => {
    expect(isReviewableDocumentParagraph('我们讨论决定了选择这个方案。')).toBe(true);
    expect(isReviewableDocumentParagraph('项目背景')).toBe(false);
    expect(isReviewableDocumentParagraph('……！？')).toBe(false);
  });

  it('recognizes the same issue when the model changes its label or quoted range', () => {
    expect(areDocumentCommentIssuesEquivalent(
      { issueType: '时间表达冗余', targetText: '在今天上午的早晨' },
      { issueType: '重复表达', targetText: '今天上午的早晨' },
    )).toBe(true);
    expect(areDocumentCommentIssuesEquivalent(
      { issueType: '时间表达冗余', targetText: '在今天上午的早晨' },
      { issueType: '事实核验', targetText: '今天上午的早晨' },
    )).toBe(false);
  });

  it('frames proactive intervention as a paragraph-specific artifact discussion', () => {
    const prompts = buildProactiveDocumentCommentPrompts({
      course,
      studentId: 'student-1',
      stageKey: 'make',
      documentText: '完整文档',
      targetText: '我们选择这个方案，因为它最好。',
    });
    expect(prompts.system).toContain('具体段落');
    expect(prompts.system).toContain('不是伴学提醒');
    expect(prompts.system).toContain('宁可不介入');
    expect(prompts.system).toContain('不得使用“观察：”');
    expect(prompts.system).toContain('真实组员');
    expect(prompts.system).toContain('只能问一个');
    expect(prompts.system).toContain('同伴商量');
    expect(prompts.user).toContain('我们选择这个方案');
  });

  it('turns a labeled proactive report into a natural teammate comment', () => {
    expect(normalizeProactiveDocumentComment({
      shouldComment: true,
      comment: '观察：这里说“最好”，但没有说明比较标准。影响：读者无法判断这个结论是否可靠。提问：你们比较的是效果、成本还是实施难度',
    })).toEqual({
      shouldComment: true,
      comment: '这里说“最好”，但没有说明比较标准。读者无法判断这个结论是否可靠。你们比较的是效果、成本还是实施难度？',
    });
  });

  it('checks every stable paragraph in one batch and keeps all useful comments', () => {
    const candidates = [
      { candidateId: 'p-1', blockIndex: 0, targetText: '第一段存在没有来源的事实描述，需要进一步核验具体出处。' },
      { candidateId: 'p-2', blockIndex: 1, targetText: '第二段使用“最好”描述方案，但没有说明比较所依据的标准。' },
    ];
    const prompts = buildBatchProactiveDocumentCommentPrompts({
      course,
      studentId: 'student-1',
      stageKey: 'make',
      documentText: '第一段完整内容。第二段完整内容。',
      candidates,
      reviewFocus: 'language',
    });
    expect(prompts.system).toContain('不能只检查最后一段');
    expect(prompts.system).toContain('同一个 candidateId 返回多条记录');
    expect(prompts.system).toContain('动宾');
    expect(prompts.system).toContain('就应当介入');
    expect(prompts.system).toContain('quotedText');
    expect(prompts.user).toContain('p-1');
    expect(prompts.user).toContain('p-2');

    expect(normalizeBatchProactiveDocumentComments({ comments: [
      { candidateId: 'p-1', issueType: '事实核验', quotedText: '没有来源的事实描述', comment: '这条事实还没有来源，我们要不要先找到能核验它的原始记录？' },
      { candidateId: 'p-1', issueType: '表达冗余', quotedText: '进一步核验具体出处', comment: '“进一步”和“具体”叠在这里有些拖沓，可以保留真正需要表达的一层意思。' },
      { candidateId: 'p-2', issueType: '比较标准不明', quotedText: '“最好”', comment: '“最好”是指成本更低，还是实际效果更好？' },
      { candidateId: 'p-2', issueType: '错误引用', quotedText: '并不存在的原文', comment: '这条不应采用。' },
      { candidateId: 'unknown', issueType: '越界', quotedText: '原文', comment: '不应采用的越界批注内容。' },
    ] }, candidates)).toEqual([
      { candidateId: 'p-1', issueType: '事实核验', quotedText: '没有来源的事实描述', comment: '这条事实还没有来源，我们要不要先找到能核验它的原始记录？' },
      { candidateId: 'p-1', issueType: '表达冗余', quotedText: '进一步核验具体出处', comment: '“进一步”和“具体”叠在这里有些拖沓，可以保留真正需要表达的一层意思。' },
      { candidateId: 'p-2', issueType: '比较标准不明', quotedText: '“最好”', comment: '“最好”是指成本更低，还是实际效果更好？' },
    ]);
  });

  it('gives reasoning review its own evidence and project checklist', () => {
    const prompts = buildBatchProactiveDocumentCommentPrompts({
      course,
      studentId: 'student-1',
      stageKey: 'make',
      documentText: '完整文档',
      candidates: [{ candidateId: 'p-1', blockIndex: 0, targetText: '一次测试已经证明方案适合所有同学。' }],
      reviewFocus: 'reasoning',
    });
    expect(prompts.system).toContain('以偏概全');
    expect(prompts.system).toContain('项目目标');
  });

  it('rejects empty proactive comments and bounds replies', () => {
    expect(normalizeProactiveDocumentComment({ shouldComment: true, comment: '' }))
      .toEqual({ shouldComment: false, comment: '' });
    expect(normalizeDocumentCommentReply({ message: '  围绕这段继续讨论。  ' }))
      .toEqual({ kind: 'discussion', message: '围绕这段继续讨论。' });
  });

  it('accepts an exact local deletion but rejects an ambiguous target', () => {
    expect(normalizeDocumentCommentReply({
      kind: 'edit-suggestion',
      message: '可以，我先把删除标记放到正文中，由你确认。',
      suggestion: {
        operation: 'replace',
        title: '删除无关句子',
        targetText: '这句话与当前论证无关。',
        replacement: '',
        reason: '它没有为当前结论提供依据。',
      },
    }, '核心依据。这句话与当前论证无关。下一段依据。')).toEqual({
      kind: 'edit-suggestion',
      message: '它没有为当前结论提供依据。',
      suggestion: {
        operation: 'replace',
        title: '删除无关句子',
        targetText: '这句话与当前论证无关。',
        replacement: '',
        reason: '它没有为当前结论提供依据。',
      },
    });
    expect(normalizeDocumentCommentReply({
      kind: 'edit-suggestion',
      message: '准备删除。',
      suggestion: {
        targetText: '重复句。',
        replacement: '',
      },
    }, '重复句。中间内容。重复句。')).toEqual({
      kind: 'discussion',
      message: '准备删除。',
    });
  });

  it('replaces punctuation-only edit reasons with a useful confirmation reason', () => {
    expect(normalizeDocumentCommentReply({
      kind: 'edit-suggestion',
      message: '。',
      suggestion: {
        targetText: '原句。',
        replacement: '',
        reason: '。',
      },
    }, '前文。原句。后文。')).toEqual({
      kind: 'edit-suggestion',
      message: '这项调整可以让当前内容更清楚，同时保持学生对正文的最终决定权。',
      suggestion: {
        operation: 'replace',
        title: '删除内容建议',
        targetText: '原句。',
        replacement: '',
        reason: '这项调整可以让当前内容更清楚，同时保持学生对正文的最终决定权。',
      },
    });
  });
});
