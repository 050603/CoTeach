import { describe, expect, it, vi } from 'vitest';
import { generateKnowledgeStructureOnce } from './knowledge-structure-generation';
import type { GenerateInput } from './llm/types';
import { buildKnowledgeGraphPrompt } from './llm/prompts';
import type { CourseEvidenceSnapshot } from './textbook/course-evidence-types';

const input: GenerateInput = { name: '教学设计', subject: '人工智能教育', grade: '大学一年级', hours: 1,
  summary: '用教学设计理论指导课堂实践。', drivingQuestion: '如何让教学目标、活动和评价相互对应？',
  learningObjectives: ['能解释教学设计的流程'], stages: [] };
const valid = JSON.stringify({ knowledgePoints: [{ id: 'design', name: '教学设计',
  description: '通过目标、活动和评价的对应关系设计课程。', keyInfo: '先解释依据，再用于真实案例。',
  groupId: 'design-section', groupName: '教学设计' }], knowledgeGraph: { nodes: [], edges: [] } });
const malformed = '{"knowledgePoints":[{"id":"design","name":"教学设计"}';
const evidence: CourseEvidenceSnapshot = { schemaVersion: 2, version: 1, fingerprint: 'actual-three-steps',
  createdAt: '2026-09-30T00:00:00Z', retrievalMode: 'hybrid', warnings: [], mappings: [],
  selections: [{ revisionId: 'main', primary: true, sectionIds: [] }],
  items: [{ id: 'source-design', title: '教学设计流程', kind: 'concept', content: '目标、活动、评价。',
    source: { textbookId: 'book', textbookTitle: '教材', revisionId: 'main', revisionVersion: 1, sectionPath: ['教学设计'] },
    sourceSequences: [{ anchorSourceBlockId: 'steps', kind: 'ordered-steps',
      steps: ['确定目标', '设计活动', '评价效果'].map((label, index) => ({ label, sourceBlockId: `step-${index}` })) }] }],
};
const sourceDraft = (description: string) => JSON.stringify({ knowledgePoints: [
  { id: 'design', name: '教学设计', description, keyInfo: '将目标、活动和评价对应起来。', evidenceItemIds: ['source-design'] },
  { id: 'case', name: '已有教学案例', description: '分工不均会使学生觉得被忽视，并影响学习动力和信心。',
    keyInfo: '用真实课堂案例解释合理分工的因果关系。' },
], knowledgeGraph: { nodes: [], edges: [] } });

describe('knowledge structure keeps a single first draft', () => {
  it('provides source responsibilities once and derives the reverse mapping', () => {
    const prompt = buildKnowledgeGraphPrompt(input, { textbookEvidence: evidence, teacherKnowledgePoints: [
      { id: 'source-parent', name: '教学理论', description: '解释其基本含义', teachingRole: 'core-concept' },
      { id: 'source-child', name: '理论应用', description: '先有理论再作应用', teachingRole: 'detail-concept', parentKnowledgePointId: 'source-parent' },
    ] });
    expect(prompt.user).toContain('"teachingRole":"core-concept"');
    expect(prompt.user).toContain('"parentKnowledgePointId":"source-parent"');
    expect(prompt.user).toContain('不重复生成第二套映射');
    expect(prompt.user).toContain('"authoringContract": "knowledge-v1"');
  });

  it('persists complete rejected text and stops without a second model request', async () => {
    const events: string[] = [];
    const aiCall = vi.fn(async () => { events.push('request'); return malformed; });
    const onCandidate = vi.fn(async () => { events.push('save'); });
    const onRejected = vi.fn(async () => { events.push('reject'); });
    await expect(generateKnowledgeStructureOnce(input, {}, { aiCall, onCandidate, onRejected })).rejects.toThrow('JSON 无法解析');
    expect(events).toEqual(['request', 'save', 'reject']);
    expect(onRejected).toHaveBeenCalledWith({ rawResponse: malformed, attempt: 1, issues: [expect.stringContaining('JSON 无法解析')] });
    expect(aiCall).toHaveBeenCalledOnce();
  });

  it.each([valid, malformed])('validates a saved response without any new request: %s', async (initialResponse) => {
    const aiCall = vi.fn();
    const onCandidate = vi.fn();
    const result = generateKnowledgeStructureOnce(input, {}, { initialResponse, aiCall, onCandidate });
    if (initialResponse === valid) await expect(result).resolves.toMatchObject({ revisionCount: 0 });
    else await expect(result).rejects.toThrow('JSON 无法解析');
    expect(aiCall).not.toHaveBeenCalled();
    expect(onCandidate).not.toHaveBeenCalled();
  });

  it('retains the original complete-source gate and reports missing canonical facts', async () => {
    const wrong = sourceDraft('基本流程是确定目标、设计活动等环节。');
    const aiCall = vi.fn().mockResolvedValue(wrong);
    const onRejected = vi.fn();
    await expect(generateKnowledgeStructureOnce(input, { textbookEvidence: evidence }, { aiCall, onRejected })).rejects.toThrow('遗漏教材步骤：评价效果');
    expect(onRejected).toHaveBeenCalledWith(expect.objectContaining({ rawResponse: wrong }));
    expect(aiCall).toHaveBeenCalledOnce();
    const result = await generateKnowledgeStructureOnce(input, { textbookEvidence: evidence }, {
      initialResponse: sourceDraft('基本流程是确定目标、设计活动、评价效果。'), aiCall,
    });
    expect(result.knowledgePoints[1].description).toContain('分工不均会使学生觉得被忽视');
    expect(result.knowledgePoints[0].sourceSequenceReferences![0].orderedSteps).toHaveLength(3);
    expect(aiCall).toHaveBeenCalledOnce();
  });

  it('does not replay a completed model call when persistence fails', async () => {
    const aiCall = vi.fn().mockResolvedValue(valid);
    const onRejected = vi.fn();
    await expect(generateKnowledgeStructureOnce(input, {}, { aiCall, onRejected,
      onCandidate: async () => { throw new Error('checkpoint unavailable'); } })).rejects.toThrow('checkpoint unavailable');
    expect(aiCall).toHaveBeenCalledOnce();
    expect(onRejected).not.toHaveBeenCalled();
  });
});
