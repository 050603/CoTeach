import { describe, expect, it } from 'vitest';

import {
  areDocumentCommentIssuesEquivalent,
  buildBatchProactiveDocumentCommentPrompts,
  buildProactiveDocumentCommentPrompts,
  documentParagraphVersionFingerprint,
  isReviewableDocumentParagraph,
  normalizeBatchProactiveDocumentComments,
  normalizeBatchProactiveDocumentReview,
  normalizeDocumentCommentReply,
  normalizeProactiveDocumentComment,
} from './document-comment-policy';
import { documentAiCommentStatus } from './document-comment-types';

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
    expect(areDocumentCommentIssuesEquivalent(
      { issueType: '数据矛盾', targetText: '所有人都支持', issueKey: '样本支持人数', evidenceQuote: '5 人支持' },
      { issueType: '数据矛盾', targetText: '全部同学都支持', issueKey: '样本支持人数', evidenceQuote: '5 人支持' },
    )).toBe(true);
    expect(areDocumentCommentIssuesEquivalent(
      { issueType: '数据矛盾', targetText: '所有人都支持', issueKey: '样本支持人数', evidenceQuote: '5 人支持' },
      { issueType: '数据矛盾', targetText: '全部同学都支持', issueKey: '另一项抽样结论', evidenceQuote: '5 人支持' },
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
      severity: 'critical',
      needsInterventionNow: true,
      issueType: '数据矛盾',
      quotedText: '所有同学都支持',
      evidenceSource: 'document',
      evidenceQuote: '8 人中 5 人支持',
      impact: '会夸大项目结论适用的人群范围',
      comment: '观察：这里写“所有同学都支持”，但记录是 8 人中 5 人支持。影响：这会夸大结论范围。建议：先核对调查人数，再确定措辞',
    })).toEqual({
      shouldComment: true,
      comment: '这里写“所有同学都支持”，但记录是 8 人中 5 人支持。这会夸大结论范围。先核对调查人数，再确定措辞。',
      issueType: '数据矛盾',
      quotedText: '所有同学都支持',
      severity: 'critical',
      evidenceSource: 'document',
      evidenceQuote: '8 人中 5 人支持',
      impact: '会夸大项目结论适用的人群范围',
    });
  });

  it('requires evidence and urgency, and preserves independent critical problems in one batch', () => {
    const candidates = [
      { candidateId: 'p-1', blockIndex: 0, targetText: '调查记录显示 8 人中 5 人支持。我们写所有同学都支持。' },
      { candidateId: 'p-2', blockIndex: 1, targetText: '方案预算是 50 元，但执行表写 500 元。' },
    ];
    const prompts = buildBatchProactiveDocumentCommentPrompts({
      course,
      studentId: 'student-1',
      stageKey: 'make',
      documentText: candidates.map((candidate) => candidate.targetText).join('\n'),
      candidates,
      reviewFocus: 'comprehensive',
    });
    expect(prompts.system).toContain('不能只检查最后一段');
    expect(prompts.system).toContain('同一个 candidateId 可有多条记录');
    expect(prompts.system).toContain('不要按数量配额截断');
    expect(prompts.system).toContain('只有关键问题才主动批注');
    expect(prompts.system).toContain('一般错别字');
    expect(prompts.system).toContain('quotedText');
    expect(prompts.user).toContain('p-1');
    expect(prompts.user).toContain('p-2');

    expect(normalizeBatchProactiveDocumentComments({ comments: [
      { candidateId: 'p-1', severity: 'critical', needsInterventionNow: true, issueType: '数据矛盾', issueKey: '支持人数', quotedText: '所有同学都支持', evidenceSource: 'document', evidenceQuote: '8 人中 5 人支持', impact: '结论会夸大样本的支持范围', comment: '这里说所有同学都支持，但记录是 8 人中 5 人支持。可以先核对人数，再决定结论的范围。' },
      { candidateId: 'p-2', severity: 'critical', needsInterventionNow: true, issueType: '数据矛盾', issueKey: '预算金额', quotedText: '执行表写 500 元', evidenceSource: 'document', evidenceQuote: '方案预算是 50 元', impact: '执行时可能按错误金额采购', comment: '执行表写 500 元，但方案预算是 50 元。可以先核对原始预算，再统一这两处金额。' },
      { candidateId: 'p-1', severity: 'style', needsInterventionNow: false, issueType: '表达建议', quotedText: '我们写所有同学都支持', evidenceSource: 'document', evidenceQuote: '我们写所有同学都支持', impact: '句子还能表达得更简洁', comment: '这一句可以更简洁，可以试着删掉主语。' },
      { candidateId: 'p-2', severity: 'critical', needsInterventionNow: true, issueType: '数据矛盾', quotedText: '并不存在的原文', evidenceSource: 'document', evidenceQuote: '方案预算是 50 元', impact: '执行时可能按错误金额采购', comment: '这条不应采用。' },
      { candidateId: 'unknown', severity: 'critical', needsInterventionNow: true, issueType: '数据矛盾', quotedText: '原文', evidenceSource: 'document', evidenceQuote: '方案预算是 50 元', impact: '执行时可能按错误金额采购', comment: '不应采用的越界批注内容。' },
    ] }, candidates, { documentText: candidates.map((candidate) => candidate.targetText).join('\n') })).toEqual([
      { candidateId: 'p-1', issueType: '数据矛盾', issueKey: '支持人数', quotedText: '所有同学都支持', severity: 'critical', evidenceSource: 'document', evidenceQuote: '8 人中 5 人支持', impact: '结论会夸大样本的支持范围', comment: '这里说所有同学都支持，但记录是 8 人中 5 人支持。可以先核对人数，再决定结论的范围。' },
      { candidateId: 'p-2', issueType: '数据矛盾', issueKey: '预算金额', quotedText: '执行表写 500 元', severity: 'critical', evidenceSource: 'document', evidenceQuote: '方案预算是 50 元', impact: '执行时可能按错误金额采购', comment: '执行表写 500 元，但方案预算是 50 元。可以先核对原始预算，再统一这两处金额。' },
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
    expect(prompts.system).toContain('结论与已有数据矛盾');
    expect(prompts.system).toContain('课程硬性约束');
  });

  it('combines language and reasoning checks into one batch model request', () => {
    const prompts = buildBatchProactiveDocumentCommentPrompts({
      course,
      studentId: 'student-1',
      stageKey: 'make',
      documentText: '我们讨论决定了选择这个方案，因为它肯定最好。',
      candidates: [{ candidateId: 'p-1', blockIndex: 0, targetText: '我们讨论决定了选择这个方案，因为它肯定最好。' }],
      reviewFocus: 'comprehensive',
    });
    expect(prompts.system).toContain('数字、单位、对象');
    expect(prompts.system).toContain('关键推理不能成立');
    expect(prompts.user).toContain('后台主动介入');
  });

  it('allows detailed language feedback only when the student requests a check', () => {
    const candidate = { candidateId: 'p-1', blockIndex: 0, targetText: '本项目的执行过程可以进一步清楚地说明。' };
    const prompt = buildBatchProactiveDocumentCommentPrompts({
      course, studentId: 'student-1', stageKey: 'make', documentText: candidate.targetText,
      candidates: [candidate], reviewFocus: 'language', reviewMode: 'on-demand',
    });
    expect(prompt.system).toContain('学生主动要求检查文稿');
    expect(prompt.system).not.toContain('只有关键问题才主动批注');
    const suggestion = {
      candidateId: 'p-1', severity: 'improvement', needsInterventionNow: false,
      issueType: '表达建议', quotedText: '进一步清楚地说明',
      evidenceSource: 'document', evidenceQuote: '本项目的执行过程可以进一步清楚地说明',
      impact: '这句话读起来略显重复，可以更简洁',
      comment: '这里的修饰语有些重复，可以保留更准确的一种说法。',
    };
    expect(normalizeBatchProactiveDocumentComments({ comments: [suggestion] }, [candidate]))
      .toEqual([]);
    expect(normalizeBatchProactiveDocumentComments({ comments: [suggestion] }, [candidate], {
      reviewMode: 'on-demand',
    })).toHaveLength(1);
  });

  it('rejects unsupported categories, unverified evidence, and noncritical suggestions', () => {
    const candidate = { candidateId: 'p-1', blockIndex: 0, targetText: '我们据此确定全部同学都支持。' };
    const valid = {
      candidateId: 'p-1', severity: 'critical', needsInterventionNow: true,
      issueType: '数据矛盾', issueKey: '支持人数', quotedText: '全部同学都支持',
      evidenceSource: 'document', evidenceQuote: '8 人中 5 人支持',
      impact: '会把局部调查写成全体结论',
      comment: '这里把 5 人支持写成全部同学都支持，会夸大结论范围。先核对人数，再决定怎样表述。',
    };
    const output = normalizeBatchProactiveDocumentComments({ comments: [
      { ...valid, severity: 'improvement' },
      { ...valid, needsInterventionNow: false },
      { ...valid, issueType: '表达建议' },
      { ...valid, evidenceQuote: '并不存在的数据' },
      { ...valid, quotedText: '全校同学都支持' },
      { ...valid, evidenceSource: 'course', evidenceQuote: '必须进行随机抽样' },
      valid,
    ] }, [candidate], { documentText: `${candidate.targetText}\n8 人中 5 人支持` });
    expect(output).toHaveLength(1);
    expect(output[0]?.comment).toContain('先核对人数');
  });

  it('requires independent evidence for contradictions and core reasoning', () => {
    const candidate = { candidateId: 'p-1', blockIndex: 0, targetText: '我们确定所有同学都支持该方案。' };
    const common = {
      candidateId: 'p-1', severity: 'critical', needsInterventionNow: true,
      issueType: '数据矛盾', quotedText: '所有同学都支持该方案',
      evidenceSource: 'document', impact: '会夸大调查结论的适用范围',
      comment: '这里把支持范围写成全部同学。可以先核对调查记录，再确定措辞。',
    };
    expect(normalizeBatchProactiveDocumentComments({ comments: [
      { ...common, evidenceQuote: '所有同学都支持该方案' },
    ] }, [candidate])).toEqual([]);
    expect(normalizeBatchProactiveDocumentComments({ comments: [
      { ...common, evidenceQuote: '记录显示 8 人中 5 人支持' },
    ] }, [candidate], {
      documentText: `${candidate.targetText}\n记录显示 8 人中 5 人支持。`,
    })).toHaveLength(1);
    expect(normalizeProactiveDocumentComment({
      ...common, shouldComment: true, evidenceQuote: common.quotedText,
    }, { targetText: candidate.targetText, documentText: candidate.targetText }))
      .toEqual({ shouldComment: false, comment: '' });
  });

  it('includes context around changed paragraphs near the end of long documents', () => {
    const marker = '调查记录显示八人中五人支持，而总结写成了全体支持。';
    const documentText = `${'项目背景与过程。'.repeat(5_000)}\n${marker}\n后续材料。`;
    const prompt = buildBatchProactiveDocumentCommentPrompts({
      course, studentId: 'student-1', stageKey: 'make', documentText,
      candidates: [{ candidateId: 'p-last', blockIndex: 100, targetText: marker }],
      reviewFocus: 'reasoning',
    });
    const context = prompt.user.split('【正在制作的完整成果上下文】')[1]
      ?.split('【本轮需要检查的候选段落】')[0];
    expect(context).toContain(marker);
    expect(context).toContain('其余内容未显示');
  });

  it('keeps all independent critical issues without an arbitrary per-paragraph cap', () => {
    const pieces = Array.from({ length: 12 }, (_, index) => `第${index + 1}项写错了`);
    const candidate = { candidateId: 'p-1', blockIndex: 0, targetText: pieces.join('；') };
    const evidence = pieces.map((_, index) => `原始记录第${index + 1}项另有数值`);
    const result = normalizeBatchProactiveDocumentComments({
      comments: pieces.map((piece, index) => ({
        candidateId: candidate.candidateId,
        severity: 'critical',
        needsInterventionNow: true,
        issueType: '数据矛盾',
        issueKey: `第${index + 1}项`,
        quotedText: piece,
        evidenceSource: 'document',
        evidenceQuote: evidence[index],
        impact: `第${index + 1}项会让预算计算结果错误`,
        comment: `${piece}会影响预算。可以核对对应原始记录。`,
      })),
    }, [candidate], { documentText: `${candidate.targetText}\n${evidence.join('；')}` });
    expect(result).toHaveLength(12);
  });

  it('merges the same root cause across paragraphs and preserves both anchors', () => {
    const candidates = [
      { candidateId: 'p-1', blockIndex: 0, targetText: '第一部分说全部同学支持。' },
      { candidateId: 'p-2', blockIndex: 1, targetText: '总结再次说所有同学都支持。' },
    ];
    const common = {
      severity: 'critical', needsInterventionNow: true, issueType: '数据矛盾',
      issueKey: '调查支持人数', evidenceSource: 'document', evidenceQuote: '8 人中 5 人支持',
      impact: '会把局部支持错误写成全体支持',
      comment: '这里将多数支持写成全体支持。可以核对人数后再确定结论范围。',
    };
    const output = normalizeBatchProactiveDocumentComments({ comments: [
      { ...common, candidateId: 'p-1', quotedText: '全部同学支持' },
      { ...common, candidateId: 'p-2', quotedText: '所有同学都支持' },
    ] }, candidates, { documentText: `${candidates.map((candidate) => candidate.targetText).join('\n')}\n8 人中 5 人支持` });
    expect(output).toHaveLength(1);
    expect(output[0]?.relatedAnchors).toEqual([{ candidateId: 'p-2', quotedText: '所有同学都支持' }]);
  });

  it('checkpoints only candidates explicitly completed by the model', () => {
    const candidates = [
      { candidateId: 'p-1', blockIndex: 0, targetText: '第一段内容。' },
      { candidateId: 'p-2', blockIndex: 1, targetText: '第二段内容。' },
    ];
    expect(normalizeBatchProactiveDocumentReview({
      checkedCandidateIds: ['p-1', 'unknown'], complete: true, comments: [],
    }, candidates)).toEqual({
      comments: [], reviewedCandidateIds: ['p-1'], complete: false,
    });
    expect(normalizeBatchProactiveDocumentReview({
      checkedCandidateIds: ['p-1', 'p-2'], complete: true, comments: [],
    }, candidates)).toEqual({
      comments: [], reviewedCandidateIds: ['p-1', 'p-2'], complete: true,
    });
    expect(normalizeBatchProactiveDocumentReview({
      checkedCandidateIds: ['p-1', 'p-2'], complete: false, comments: [],
    }, candidates)).toEqual({
      comments: [], reviewedCandidateIds: [], complete: false,
    });
    expect(normalizeBatchProactiveDocumentReview({ comments: [] }, candidates))
      .toEqual({ comments: [], reviewedCandidateIds: [], complete: false });
    expect(normalizeBatchProactiveDocumentReview({
      checkedCandidateIds: ['p-1'], complete: false,
      comments: [{
        candidateId: 'p-2', severity: 'critical', needsInterventionNow: true,
        issueType: '关键单位', quotedText: '第二段内容',
        evidenceSource: 'document', evidenceQuote: '第二段内容',
        impact: '会改变第二段的关键含义',
        comment: '第二段的关键单位需要再核对一次。',
      }],
    }, candidates)).toEqual({
      comments: [], reviewedCandidateIds: ['p-1'], complete: false,
    });
  });

  it('keeps read and resolution separate for old and new comments', () => {
    const base = {
      id: 'thread-1', blockIndex: 0, targetText: '原文', comments: [],
      createdAt: '2026-09-25T00:00:00.000Z', readAt: '2026-09-25T00:01:00.000Z',
    };
    expect(documentAiCommentStatus(base)).toBe('open');
    expect(documentAiCommentStatus({ ...base, status: 'deferred' })).toBe('deferred');
    expect(documentAiCommentStatus({ ...base, status: 'invalidated' })).toBe('invalidated');
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
