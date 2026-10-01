import { describe, expect, it } from 'vitest';
import { buildKnowledgeGraphPrompt, deduplicateKnowledgePromptSources } from './prompts';
import type { CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';

describe('lossless knowledge prompt source references', () => {
  it('plans from teacher goals and learner needs while allowing different textbook paths and explanations', () => {
    const evidence: CourseEvidenceSnapshot = {
      schemaVersion: 2, version: 1, fingerprint: 'different-book-paths', createdAt: '2026-10-01',
      retrievalMode: 'hybrid', warnings: [],
      mappings: [{ sourceKnowledgePointId: 'classification', sourceKnowledgePointName: '分类依据',
        status: 'direct', evidenceItemIds: ['main-explanation', 'alternative-explanation'],
        rationale: '两种合理的概念与实例展开路径' }],
      selections: [{ revisionId: 'main', primary: true, sectionIds: [] },
        { revisionId: 'alternative', primary: false, sectionIds: [] }],
      items: [
        { id: 'main-explanation', kind: 'source-block', title: '先解释概念', content: '主教材先建立概念，再展示分类实例。',
          source: { textbookId: 'main-book', textbookTitle: '主教材', revisionId: 'main', revisionVersion: 1,
            sectionPath: ['概念到应用'], sectionPosition: 1, sourceBlockPosition: 10 } },
        { id: 'alternative-explanation', kind: 'source-block', title: '先比较熟悉实例', content: '另一教材先比较实例，再概括共同概念。',
          source: { textbookId: 'alternative-book', textbookTitle: '另一教材', revisionId: 'alternative', revisionVersion: 1,
            sectionPath: ['实例到概念'], sectionPosition: 1, sourceBlockPosition: 10 } },
      ],
    };
    const prompt = buildKnowledgeGraphPrompt({ name: '分类与解释', subject: '信息技术', grade: '初中',
      hours: 1, summary: '依据熟悉实例概括分类概念', drivingQuestion: '怎样说明分类依据？',
      learnerProfile: { priorKnowledge: '学生能描述生活中的分类实例。' },
      learningObjectives: ['依据熟悉实例说明分类依据'], stages: [] }, { textbookEvidence: evidence });

    expect(prompt.user).toContain('教师确认的课程目标、学习者已有经验');
    expect(prompt.user).toContain('比较、选择或综合主教材与辅助教材的权威解释和样例');
    expect(prompt.user).toContain('knowledgePoints 的数组顺序表达本课实际计划');
    expect(prompt.user).toContain('引用某个具体真实流程时保留其内部步骤关系');
    expect(prompt.user).toContain('主教材先建立概念，再展示分类实例。');
    expect(prompt.user).toContain('另一教材先比较实例，再概括共同概念。');
    expect(prompt.user).not.toContain('辅助教材只补充解释');
    expect(prompt.user).not.toContain('按教材首次实际解释知识的先后');
    expect(prompt.user).not.toContain('"teachingOrderAdjustments": [');
  });

  it('retains the same goal and learner based quality planning when no textbook is supplied', () => {
    const prompt = buildKnowledgeGraphPrompt({ name: '分类与解释', subject: '信息技术', grade: '初中',
      hours: 1, summary: '建立分类依据', drivingQuestion: '怎样说明分类依据？',
      learningObjectives: ['解释分类依据'], stages: [] });
    expect(prompt.user).toContain('依据本课目标、学情与理解关系决定分组');
    expect(prompt.user).toContain('真正必要的知识依赖在图中说明');
    expect(prompt.user).toContain('未上传；不要因此降低知识结构质量');
    expect(prompt.user).not.toContain('主教材首次实际解释知识的先后');
  });

  it('gives the first author separate complete lists with their adopted evidence identities', () => {
    const source = { textbookId: 'book', textbookTitle: '主教材', revisionId: 'revision',
      revisionVersion: 1, sectionPath: ['设计原则'] };
    const evidence: CourseEvidenceSnapshot = {
      schemaVersion: 2, version: 1, fingerprint: 'source-lists', createdAt: '2026-10-01',
      retrievalMode: 'hybrid', warnings: [], selections: [],
      mappings: [{ sourceKnowledgePointId: 'required', sourceKnowledgePointName: '设计原则',
        status: 'direct', evidenceItemIds: ['ev-1', 'ev-2', 'ev-3'], rationale: '直接解释' }],
      items: [
        { id: 'ev-1', kind: 'source-block', title: '原则', content: '应遵循以下原则。', source,
          sourceSequences: [{ anchorSourceBlockId: 'principles', kind: 'ordered-steps',
            steps: [{ label: '使抽象内容与学生思维过程直观可视', sourceBlockId: 'p1' },
              { label: '保留目标、资源和互动过程的动态生成性', sourceBlockId: 'p2' }] }] },
        { id: 'ev-2', kind: 'source-block', title: '同一列表的另一片段', content: '具体解释。', source,
          sourceSequences: [{ anchorSourceBlockId: 'principles', kind: 'ordered-steps',
            steps: [{ label: '使抽象内容与学生思维过程直观可视', sourceBlockId: 'p1' },
              { label: '保留目标、资源和互动过程的动态生成性', sourceBlockId: 'p2' }] }] },
        { id: 'ev-3', kind: 'source-block', title: '实施步骤', content: '先后实施。',
          source: { ...source, sectionPath: ['实施步骤'] },
          sourceSequences: [{ anchorSourceBlockId: 'procedure', kind: 'ordered-steps',
            steps: [{ label: '确定问题', sourceBlockId: 's1' }, { label: '验证结果', sourceBlockId: 's2' }] }] },
      ],
    };
    const { user } = buildKnowledgeGraphPrompt({ name: '设计课', subject: '教育', grade: '大学',
      hours: 1, summary: '', drivingQuestion: '', stages: [] }, { textbookEvidence: evidence });
    const catalog = JSON.parse(user.split('教材列表索引')[1]!.split('\n\n')[1]!) as Array<{
      resourceId: string; evidenceItemIds: string[]; orderedLabels: string[];
      sequenceSemantics: string; itemCount: number;
    }>;
    expect(catalog).toHaveLength(2);
    expect(catalog[0]).toMatchObject({ resourceId: 'source-sequence:principles',
      evidenceItemIds: ['ev-1', 'ev-2'], sequenceSemantics: 'enumerated-items', itemCount: 2,
      orderedLabels: evidence.items[0]!.sourceSequences![0]!.steps.map((step) => step.label) });
    expect(catalog[1]).toMatchObject({ resourceId: 'source-sequence:procedure',
      evidenceItemIds: ['ev-3'], sequenceSemantics: 'ordered-steps', itemCount: 2 });
    expect(user).toContain('只有明确讲解某个完整框架时才按对应原始列表保留全部事实和必要条件');
    expect(user).toContain('完整条目正文和限定条件仍通过 evidenceItemIds');
  });

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
