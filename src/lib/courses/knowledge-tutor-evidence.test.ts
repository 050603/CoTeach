import { describe, expect, it } from 'vitest';
import type { CourseContent } from '@/lib/session/types';
import { authoredQuestionFingerprint, knowledgeTutorEvidence, tutorEvidencePrompt } from './knowledge-tutor-evidence';
const content = {
  knowledgePoints: [{ id: 'kp', name: '概念', sourceId: 'source', evidenceItemIds: ['adopted'] }],
  courseEvidence: { version: 2, fingerprint: 'revision-fingerprint', mappings: [{ sourceKnowledgePointId: 'source', evidenceItemIds: ['available', 'adopted'] }],
    items: [{ id: 'adopted', content: '实际原文', source: { revisionId: 'revision', revisionVersion: 3, textbookTitle: '教材' }, completeSourceBlocks: [{ sourceBlockId: 'block', content: '完整上下文' }] }, { id: 'available', content: '未采用', source: {} }] },
  teachingBlueprint: { sections: [{ units: [{ id: 'unit', knowledgePointIds: ['kp'], evidenceQuotes: ['作者精确引用'] }] }] },
} as unknown as CourseContent;
describe('tutor adopted evidence', () => {
  it('includes actual source, immutable revision and complete source blocks, excluding merely available evidence', () => {
    const evidence = knowledgeTutorEvidence(content, ['kp']);
    expect(evidence.items.map(item => item.id)).toEqual(['adopted']);
    expect(evidence.items[0].completeSourceBlocks?.[0].content).toBe('完整上下文');
    expect(tutorEvidencePrompt(evidence)).toContain('revision-fingerprint');
    expect(tutorEvidencePrompt(evidence)).toContain('实际原文');
    expect(evidence.authoredQuotes[0].quotes).toEqual(['作者精确引用']);
  });
  it('treats an explicit empty adoption as empty instead of inheriting candidate mappings', () => {
    const evidence = knowledgeTutorEvidence({ ...content, knowledgePoints: [{ ...content.knowledgePoints[0], evidenceItemIds: [] }] }, ['kp']);
    expect(evidence.items).toEqual([]);
  });
  it('changes submission fingerprint when adopted source or correct answer changes', () => {
    const question = { id: 'q', type: 'single' as const, question: '选择', answer: ['A'] };
    const evidence = knowledgeTutorEvidence(content, ['kp']);
    const key = authoredQuestionFingerprint(question, evidence);
    expect(authoredQuestionFingerprint({ ...question, answer: ['B'] }, evidence)).not.toBe(key);
    expect(authoredQuestionFingerprint(question, { ...evidence, version: 3 })).not.toBe(key);
    expect(tutorEvidencePrompt(undefined)).toContain('不声称引自教材');
  });
});
