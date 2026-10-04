import { describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';
import { buildTtsTimingPlan } from '@/lib/openmaic/audio/tts-timing';
import {
  generateSceneContent,
  objectiveQuestionRequiresWrittenExplanation,
} from './scene-generator';

const outline: SceneOutline = {
  id: 'section-check',
  type: 'quiz',
  title: '第一节 · 节末小测',
  description: '检查学生能否解释抽样偏差',
  keyPoints: ['随机抽样减少选择偏差'],
  knowledgePointIds: ['kp-sampling'],
  assessmentUnitIds: ['unit-sampling'],
  assessmentUnitMap: [{ unitId: 'unit-sampling', knowledgePointIds: ['kp-sampling'] }],
  order: 1,
  quizConfig: {
    difficulty: 'medium',
    questionCount: 1,
    questionTypes: ['short_answer'],
    minShortAnswerQuestions: 1,
    maxShortAnswerQuestions: 1,
    coveragePolicy: 'section-synthesis',
  },
};

function expectAuthoredQuiz(result: Awaited<ReturnType<typeof generateSceneContent>>, authored: Array<{ question: string; analysis?: string }>) {
  const questions = result && 'questions' in result ? result.questions : [];
  expect(questions).toHaveLength(authored.length);
  expect(questions.map(({ question, analysis }) => ({ question, analysis })))
    .toEqual(authored.map(({ question, analysis }) => ({ question, analysis })));
}

describe('section short-answer quiz contract', () => {
  it('keeps spoken assessment scope and original sources without compatibility answer summaries', async () => {
    const stale = '兼容摘要错误地声称所有抽样结果都无偏';
    const original = '随机抽样减少人为选择产生的偏差，但样本仍可能存在随机误差。';
    const quiz: SceneOutline = { ...outline, teachingObjective: '说明抽样方法和误差的关系', description: stale, keyPoints: [stale],
      assessmentTargets: [{ unitId: 'unit-sampling', knowledgePointId: 'kp-sampling', unitTitle: stale, learningOutcome: stale }],
      teachingBrief: { schemaVersion: 1, manuscript: { sectionId: 'section', segmentIds: ['node'] },
        explanation: stale, examples: [stale], conditions: [stale], evidence: [{ sourceId: 'book', quote: original }], assessmentFocus: stale,
        understandingCriteria: { goals: [stale], answerEssentials: [stale], misconceptions: [stale], supportingUnitIds: [] },
        authoring: { nodes: [{ id: 'node', kind: 'concept', content: stale, prerequisiteNodeIds: [], provenance: 'derived' }], knowledge: [], examplePlans: [] } },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{ id: 'q1', type: 'short_answer', question: '随机抽样能否保证没有误差？',
      referenceAnswer: '不能，仍可能有随机误差', analysis: original, knowledgePointIds: ['kp-sampling'], points: 10 }]));
    await generateSceneContent(quiz, ai);
    const prompt = ai.mock.calls[0]![1];
    expect(prompt).toContain('说明抽样方法和误差的关系');
    expect(prompt).toContain(original);
    expect(prompt).not.toContain(stale);
    expect(prompt).not.toContain('answerEssentials');
    expect(prompt).not.toContain('teachingAuthoring');
    expect(prompt).toContain('what was actually taught');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('does not promote reference-mode compatibility goals or a generated lecture conclusion into an answer rule', async () => {
    const unsupported = '生成的兼容结论：凡是新任务都只能重新训练';
    const inventedExplanation = '生成的讲解总结：任务名称变化就必须重新训练';
    const sourceText = '可以复用已有模型处理新任务或新领域。是否调整取决于给定的应用要求。';
    const quiz: SceneOutline = { ...outline, teachingObjective: unsupported,
      description: unsupported, keyPoints: [unsupported],
      assessmentTargets: [{ unitId: 'unit-sampling', knowledgePointId: 'kp-sampling',
        unitTitle: unsupported, learningOutcome: unsupported }],
      teachingBrief: { schemaVersion: 1, explanation: unsupported, examples: [], conditions: [],
        evidence: [], assessmentFocus: unsupported,
        understandingCriteria: { goalSource: 'references', goals: [unsupported],
          answerEssentials: [unsupported], misconceptions: [unsupported], supportingUnitIds: ['unit-sampling'],
          basis: [{ id: 'application', goal: unsupported, operation: 'apply', answerRelation: 'conditional-application',
            nodeIds: ['use-model'], claimRefs: [{ knowledgePointId: 'kp-sampling', claimId: 'original' }],
            exampleRefs: [{ knowledgePointId: 'kp-sampling', exampleId: 'program' }] }] },
        authoring: { nodes: [{ id: 'use-model', kind: 'mechanism', content: inventedExplanation,
          knowledgePointIds: ['kp-sampling'], prerequisiteNodeIds: [], provenance: 'derived',
          claimRefs: [{ knowledgePointId: 'kp-sampling', claimId: 'original' }], quoteDuties: [], exampleIds: ['program'] }],
          examplePlans: [{ knowledgePointId: 'kp-sampling', mode: 'constructed', selectedExampleIds: ['program'],
            rationale: '展示明确接口下的应用' }],
          knowledge: [{ knowledgePointId: 'kp-sampling', authoring: {
            claims: [{ id: 'original', kind: 'textbook', text: sourceText, sources: [] }],
            examples: [{ id: 'program', kind: 'constructed', title: unsupported, purpose: unsupported,
              facts: [], explanation: inventedExplanation, objectAndTask: '使用只读取表格的程序统计观测记录',
              assumptions: ['该程序只接收数值表格'], actions: ['操作者按列名录入观测值，程序执行已给的统计规则'],
              outcome: '程序输出统计结果', claimIds: ['original'], sources: [] }], exampleCoverage: [],
          } }] } } };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{ id: 'q1', type: 'short_answer',
      question: '程序只接收数值表格。操作者为什么按列名整理观测值？', referenceAnswer: '满足该程序的输入接口',
      analysis: '这一要求来自题干中明确的程序接口。', knowledgePointIds: ['kp-sampling'], points: 10 }]));
    await generateSceneContent(quiz, ai);
    const [system, prompt] = ai.mock.calls[0]!;
    expect(prompt).not.toContain(unsupported);
    expect(prompt).not.toContain(inventedExplanation);
    expect(prompt).toContain('"operation":"apply"');
    expect(prompt).toContain('"goalSource":"references"');
    expect(prompt).toContain('"taughtNodes":');
    expect(prompt).not.toContain('"bodyRef":');
    expect(prompt).toContain(sourceText);
    expect(prompt).toContain('该程序只接收数值表格');
    expect(prompt).toContain('操作者按列名录入观测值');
    expect(system).toContain('A basis requiredConditions list records planned premises, not proof');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('keeps the three existing playback phases in one natural-voice budget without fixed sentence quotas', async () => {
    const quiz: SceneOutline = { ...outline, targetDurationSec: 22,
      timingPlan: buildTtsTimingPlan({ targetDurationSec: 10, activityTargetDurationSec: 22,
        studentActivitySec: 11, transitionSec: 1, pageKind: 'quiz', providerId: 'qwen-tts',
        modelId: 'qwen-audio-3.0-tts-plus', voiceId: 'longanlingxin', language: 'zh-CN' }),
      teachingBrief: { schemaVersion: 1, explanation: '实际解释', examples: [], conditions: [], evidence: [], assessmentFocus: '依据来源判断',
        authoring: { nodes: [], knowledge: [], examplePlans: [] } } };
    const phases = [{ type: 'text', phase: 'intro', content: '请独立作答。' },
      { type: 'text', phase: 'review-guidance', content: '解析出现后核对理由，再确认理解。' },
      { type: 'text', phase: 'handoff', content: '接着用这一认识解释抽样结果。' }];
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ questions: [{ id: 'q1', type: 'short_answer',
      question: '为何要按随机规则选人？', referenceAnswer: '减少人为选择偏差',
      analysis: '选择规则独立于便利程度。', knowledgePointIds: ['kp-sampling'], points: 10 }], phaseNarration: phases }));
    const result = await generateSceneContent(quiz, ai, { singlePassQuiz: true });
    expect(result && 'phaseNarration' in result ? result.phaseNarration : undefined).toEqual(phases);
    expect(ai).toHaveBeenCalledOnce();
    const [system, prompt] = ai.mock.calls[0]!;
    expect(prompt).toContain('"narrationDurationSec":10');
    expect(prompt).toContain('"reservedDurationSec":12');
    expect(prompt).toContain('"voiceId":"longanlingxin"');
    expect(prompt).toContain('"naturalSpeed":1');
    expect(prompt).not.toContain('各约20%');
    expect(prompt).not.toContain('衔接约60%');
    expect(system).not.toContain('two concise, connected spoken sentences');
    expect(system).not.toContain('two distinct spoken sentences');
    expect(system).not.toContain('three distinct moves');
    expect(system).toContain('without a fixed sentence count or paragraph ratio');
  });

  it.each(['page', 'directory'] as const)('bases the first answer design on %s premises instead of duplicate summaries', async (mode) => {
    const falseSummary = '同一单元的生成摘要不能成为无条件定律';
    const criterion = { id: 'criterion', goal: '依据指定接口判断输入能否处理', nodeIds: ['interface'],
      claimRefs: [{ knowledgePointId: 'kp-sampling', claimId: 'conditional' }], requiredConditions: ['指定程序的接口只接收数值表格'],
      answerRelation: 'conditional-application' as const };
    const quiz: SceneOutline = { ...outline, description: falseSummary, keyPoints: [falseSummary],
      teachingBrief: { schemaVersion: 1, explanation: falseSummary, examples: [], conditions: [falseSummary], evidence: [], assessmentFocus: falseSummary,
        understandingCriteria: { goals: [criterion.goal], answerEssentials: [falseSummary], misconceptions: [falseSummary],
          supportingUnitIds: ['unit-sampling'], basis: [criterion] },
        authoring: { nodes: [{ id: 'interface', kind: 'mechanism', provenance: 'derived', prerequisiteNodeIds: [],
          content: '在指定接口只接收数值表格的设定下，输入需符合表格格式。', knowledgePointIds: ['kp-sampling'],
          claimRefs: criterion.claimRefs, quoteDuties: [] }], examplePlans: [],
          knowledge: [{ knowledgePointId: 'kp-sampling', authoring: { claims: [{ id: 'conditional', kind: 'derived',
            text: '该程序接收符合接口的数值表格。', logicalConditions: ['指定程序的接口只接收数值表格'], teachingScope: '本课的输入形式', sources: [] }],
            examples: [], exampleCoverage: [] } }] } } };
    const teachingAuthoringKnowledge = quiz.teachingBrief!.authoring!.knowledge.map((point) => ({
      id: point.knowledgePointId, authoring: point.authoring,
    }));
    if (mode === 'directory') quiz.teachingBrief!.authoring!.knowledge = [];
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{ id: 'q1', type: 'short_answer',
      question: '指定程序的接口只接收数值表格，为什么要把观测记录按该格式整理？', referenceAnswer: '使输入符合该接口',
      commentPrompt: '根据题干给定的接口约束解释即可。', analysis: '必要性由这个程序的接口约束产生。', points: 10, knowledgePointIds: ['kp-sampling'] }]));
    await generateSceneContent(quiz, ai, mode === 'directory' ? {
      sourceKnowledgePoints: [{ id: 'kp-sampling', evidenceItemIds: [] }], teachingAuthoringKnowledge,
    } : {});
    const [system, prompt] = ai.mock.calls[0]!;
    expect(prompt).not.toContain(falseSummary);
    expect(prompt).not.toContain('answerEssentials');
    expect(prompt).not.toContain('"misconceptions":');
    expect(prompt).toContain('"requiredConditions":["指定程序的接口只接收数值表格"]');
    expect(prompt).toContain('"logicalConditions":["指定程序的接口只接收数值表格"]');
    expect(prompt).toContain('"claimId":"conditional"');
    expect(prompt).toContain('"answerRelation":"conditional-application"');
    expect(system).toContain('Insufficient evidence for a proposition does not prove its opposite universally');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('gives the first quiz call complete original conditions separately from a stronger upstream summary', async () => {
    const passage = '简单而言，生成式人工智能的构建流程可分为预训练和迁移学习。微调一般仅需相对少量的新数据。';
    const sourceEvidence: CourseEvidenceSnapshot = { schemaVersion: 2, version: 1, fingerprint: 'original',
      createdAt: '2026-10-02', retrievalMode: 'hybrid', selections: [], mappings: [], warnings: [],
      items: [{ id: 'evidence', kind: 'source-block', title: '构建流程', content: '检索摘要',
        source: { textbookId: 'book', textbookTitle: '教材', revisionId: 'revision', revisionVersion: 1,
          sectionPath: ['构建流程'], sourceBlockId: 'original-block', quote: passage } }] };
    const stronger = '通用基础模型不能直接用于任何具体任务。';
    const quiz: SceneOutline = { ...outline, description: stronger, keyPoints: [stronger],
      teachingBrief: { schemaVersion: 1, explanation: stronger, examples: [], conditions: [], evidence: [], assessmentFocus: stronger,
        authoring: { nodes: [], examplePlans: [], knowledge: [{ knowledgePointId: 'kp-sampling', authoring: {
          claims: [{ id: 'summary', kind: 'derived', text: stronger, sources: [], conditions: '只针对所讲的微调流程情境' }],
          examples: [], exampleCoverage: [],
        } }] } } };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ questions: [{ id: 'q1', type: 'short_answer',
      question: '在所讲的构建流程中，为什么微调通常只需相对少量的新数据？', answer: ['复用预训练形成的能力'],
      analysis: '已有能力可复用，因此一般只需针对任务适配。', knowledgePointIds: ['kp-sampling'], points: 10 }],
      phaseNarration: [{ type: 'text', phase: 'intro', content: '来检验一下刚才的理解。' },
        { type: 'text', phase: 'review-guidance', content: '请对照具体条件查看解析。' },
        { type: 'text', phase: 'handoff', content: '带着这一认识继续学习。' }],
    }));
    await generateSceneContent(quiz, ai,
      { sourceEvidence, sourceKnowledgePoints: [{ id: 'kp-sampling', evidenceItemIds: ['evidence'] }], singlePassQuiz: true });
    const [system, prompt] = ai.mock.calls[0]!;
    expect(prompt).toContain(passage);
    expect(prompt).toContain('"kind":"derived"');
    expect(prompt).not.toContain('只针对所讲的微调流程情境');
    expect(quiz.teachingBrief!.authoring!.knowledge[0].authoring.claims[0].conditions).toBe('只针对所讲的微调流程情境');
    expect(system).toContain('A common or recommended path cannot make an alternative universally wrong');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('carries a comparative answer basis and its full qualified source without an exclusive summary rule', async () => {
    const passage = '在所述查询任务中，方法甲更适合查找局部记录，方法乙更适合汇总全部记录，两种方法可以配合使用。';
    const unsupported = '推荐甲就说明乙不能完成这类任务';
    const binding = { evidenceItemId: 'comparison-evidence', sourceBlockIds: ['comparison-block'],
      textbookId: 'book', revisionId: 'revision', quote: passage };
    const sourceEvidence: CourseEvidenceSnapshot = { schemaVersion: 2, version: 1, fingerprint: 'comparison-source',
      createdAt: '2026-10-02', retrievalMode: 'hybrid', selections: [], mappings: [], warnings: [],
      items: [{ id: binding.evidenceItemId, kind: 'source-block', title: '方法的侧重', content: '检索目录',
        source: { textbookId: 'book', textbookTitle: '教材', revisionId: 'revision', revisionVersion: 1,
          sectionPath: ['方法的侧重'], sourceBlockId: 'comparison-block', quote: passage } }] };
    const basis = { id: 'comparison', goal: '根据给定目标比较方法的适用侧重', nodeIds: ['compare'],
      claimRefs: [{ knowledgePointId: 'kp-choice', claimId: 'source' }], answerRelation: 'comparative-fit' as const };
    const quiz: SceneOutline = { ...outline, description: unsupported, keyPoints: [unsupported],
      knowledgePointIds: ['kp-choice'], assessmentUnitMap: [{ unitId: 'unit-choice', knowledgePointIds: ['kp-choice'] }],
      quizConfig: { ...outline.quizConfig!, questionTypes: ['single'], minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0 },
      teachingBrief: { schemaVersion: 1, explanation: unsupported, examples: [], conditions: [], evidence: [], assessmentFocus: unsupported,
        understandingCriteria: { goals: [basis.goal], answerEssentials: [unsupported], misconceptions: [unsupported],
          supportingUnitIds: ['unit-choice'], basis: [basis] },
        authoring: { nodes: [{ id: 'compare', kind: 'relation', content: '比较时先辨认要查局部记录还是汇总全部记录，再选择更贴合目标的方法。',
          prerequisiteNodeIds: [], knowledgePointIds: ['kp-choice'], provenance: 'derived', claimRefs: basis.claimRefs, quoteDuties: [] }],
          examplePlans: [], knowledge: [{ knowledgePointId: 'kp-choice', authoring: { claims: [{ id: 'source', kind: 'textbook',
            text: passage, sources: [binding] }], examples: [], exampleCoverage: [] } }] } } };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{ id: 'q1', type: 'single',
      question: '需要查找限定范围内的记录，按所述方法侧重，哪种选择更贴合这一目标？',
      options: [{ label: '方法甲', value: 'A' }, { label: '方法乙', value: 'B' }], answer: ['A'],
      analysis: '按给定比较，甲更贴合局部查找目标；乙还可配合承担汇总，不据此排除乙在其他条件下的应用。',
      knowledgePointIds: ['kp-choice'], points: 10 }]));
    const result = await generateSceneContent(quiz, ai, { sourceEvidence });
    const [system, prompt] = ai.mock.calls[0]!;
    expect(prompt).toContain('"answerRelation":"comparative-fit"');
    expect(prompt).toContain(passage);
    expect(prompt).not.toContain(unsupported);
    expect(system).toContain('a relatively better fit does not mean other methods cannot work');
    expect(result && 'questions' in result ? result.questions[0].answer : null).toEqual(['A']);
    expect(ai).toHaveBeenCalledOnce();
  });

  it('distinguishes a selection stem about reasons from an added written response', () => {
    expect(objectiveQuestionRequiresWrittenExplanation(
      '请从下列选项中选择最能说明这种现象原因的一项。',
    )).toBe(false);
    expect(objectiveQuestionRequiresWrittenExplanation(
      'Which option best explains why the observation changed?',
    )).toBe(false);
    expect(objectiveQuestionRequiresWrittenExplanation(
      '请选择一项，并简要说明你的理由。',
    )).toBe(true);
    expect(objectiveQuestionRequiresWrittenExplanation(
      'Choose one option and justify your answer.',
    )).toBe(true);
  });

  it('accepts an objective item whose selected option explains a reason', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      quizConfig: {
        difficulty: 'medium', questionCount: 1,
        questionTypes: ['single'], questionTypePlan: ['single'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{
      id: 'q1', type: 'single', format: 'single_choice',
      question: '请从下列选项中选择最能说明抽样偏差产生原因的一项。',
      options: [
        { label: '样本选择依赖了研究者的便利条件', value: 'A' },
        { label: '总体中的每个成员都有随机入样机会', value: 'B' },
      ],
      answer: ['A'], analysis: 'A 使入样机会取决于便利条件。',
      knowledgePointIds: ['kp-sampling'], points: 10,
    }]));

    const result = await generateSceneContent(adaptive, ai);
    const questions = result && 'questions' in result ? result.questions : [];
    expect(questions[0]?.format).toBe('single_choice');
    expect(ai.mock.calls[0][1]).toContain('responseMode is selection_only');
    expect(ai.mock.calls[0][1]).toContain('Put shared facts in the stem');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('adapts a planned true-false item with an open assessment verb to selection-only evidence', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      keyPoints: ['能写出一个开放问题并分解为可探究的子问题'],
      quizConfig: {
        difficulty: 'medium', questionCount: 1,
        questionTypes: ['true_false'], questionTypePlan: ['true_false'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{
      id: 'q1', type: 'single', format: 'true_false',
      question: '“怎样让校园垃圾分类更准确”没有固定答案，并可拆成资料调查与对照实验两个子问题，因此是可探究的开放问题。',
      answer: true, analysis: '该候选问题同时满足开放性与可分解性。',
      knowledgePointIds: ['kp-sampling'], points: 10,
    }]));

    const result = await generateSceneContent(adaptive, ai);
    const questions = result && 'questions' in result ? result.questions : [];
    expect(questions[0]?.format).toBe('true_false');
    expect(ai.mock.calls[0][1]).toContain('Present one complete candidate conclusion as the proposition');
    expect(ai.mock.calls[0][1]).toContain('The learner only marks true or false');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('retains a written-explanation stem for final teacher review without a second call', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      quizConfig: {
        difficulty: 'medium', questionCount: 1,
        questionTypes: ['single'], questionTypePlan: ['single'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{
      id: 'q1', type: 'single', format: 'single_choice',
      question: '请选择能减少抽样偏差的一项，并简要说明你的理由。',
      options: [
        { label: '随机抽取不同年级的学号', value: 'A' },
        { label: '只询问最先离场的学生', value: 'B' },
      ],
      answer: ['A'], analysis: 'A 减少人为选择。',
      knowledgePointIds: ['kp-sampling'], points: 10,
    }]));

    expectAuthoredQuiz(await generateSceneContent(adaptive, ai), JSON.parse(await ai.mock.results[0]!.value));
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('prompts for short answers and retains the authored response type for teacher review', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{
      id: 'q1',
      type: 'single',
      question: '哪一种方法能减少选择偏差？',
      options: [{ label: '随机抽样', value: 'A' }, { label: '方便抽样', value: 'B' }],
      answer: ['A'],
      analysis: '随机抽样使总体成员有公平的入样机会。',
      knowledgePointIds: ['kp-sampling'],
      points: 10,
    }]));

    const result = await generateSceneContent(outline, ai);
    expect(ai.mock.calls[0][1]).toContain('every generated question must use type="short_answer"');
    expect(ai.mock.calls[0][1]).toContain('single comprehensive short-answer question');
    expect(result && 'questions' in result ? result.questions : []).toHaveLength(1);
    expect(result && 'questions' in result ? result.questions[0] : {}).toMatchObject({
      type: 'single', answer: ['A'], options: [{ label: '随机抽样', value: 'A' }, { label: '方便抽样', value: 'B' }],
    });
    expect(result && 'questions' in result ? result.questions[0]?.knowledgePointIds : []).toEqual(['kp-sampling']);
    expect(result && 'questions' in result ? result.questions[0]?.teachingUnitIds : []).toEqual(['unit-sampling']);
  });

  it('retains an authored open response without another model call', async () => {
    const adaptive = {
      ...outline,
      quizConfig: {
        difficulty: 'medium' as const,
        questionCount: 2,
        questionTypes: ['single' as const, 'true_false' as const, 'fill_blank' as const, 'matching' as const],
        minShortAnswerQuestions: 0,
        maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis' as const,
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      {
        id: 'q1', type: 'short_answer', format: 'short_answer', question: '解释随机抽样。', analysis: '公平入样。',
        knowledgePointIds: ['kp-sampling'], points: 10,
      },
      {
        id: 'q2', type: 'single', question: '哪项属于随机抽样？',
        options: [{ label: '随机抽取学号', value: 'A' }, { label: '只问前排', value: 'B' }],
        answer: ['A'], analysis: '随机抽取学号让成员有公平机会。', knowledgePointIds: ['kp-sampling'], points: 10,
      },
      ]));
    expectAuthoredQuiz(await generateSceneContent(adaptive, ai), JSON.parse(await ai.mock.results[0]!.value));
    expect(ai.mock.calls[0][1]).toContain('use at least 0 and at most 0');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('requires the complete normal-mode question set to cover every section knowledge point', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      knowledgePointIds: ['kp-role', 'kp-leak'],
      assessmentUnitIds: ['unit-role', 'unit-leak'],
      assessmentUnitMap: [
        { unitId: 'unit-role', knowledgePointIds: ['kp-role'] },
        { unitId: 'unit-leak', knowledgePointIds: ['kp-leak'] },
      ],
      quizConfig: {
        difficulty: 'medium' as const,
        questionCount: 2,
        questionTypes: ['single' as const, 'true_false' as const, 'fill_blank' as const, 'matching' as const],
        minShortAnswerQuestions: 0,
        maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis' as const,
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      { id: 'q1', type: 'single', question: '哪一组数据用于学习参数？', options: [{ label: '训练集', value: 'A' }, { label: '测试集', value: 'B' }], answer: ['A'], analysis: '训练集用于学习参数。', knowledgePointIds: ['kp-role'], points: 10 },
      { id: 'q2', type: 'true_false', format: 'true_false', question: '测试数据参与调参会造成数据泄漏。', answer: true, analysis: '独立测试信息不能进入调参。', knowledgePointIds: ['kp-leak'], points: 10 },
    ]));

    const result = await generateSceneContent(adaptive, ai);
    const questions = result && 'questions' in result ? result.questions : [];
    expect(ai.mock.calls[0][1]).toContain('cover every allowed knowledgePointId at least once');
    expect(new Set(questions.flatMap((question) => question.knowledgePointIds ?? []))).toEqual(new Set(['kp-role', 'kp-leak']));
    expect(questions.filter((question) => question.format === 'short_answer' || question.format === 'scenario_task')).toHaveLength(0);
  });

  it('accepts direct knowledge checks and passes the actual learner response time', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      plannedTiming: { role: 'assessment', narrationSec: 13, learnerActivitySec: 36, transitionSec: 2 },
      targetDurationSec: 51,
      keyPoints: ['判断测试集的职责', '识别测试信息进入调参的后果'],
      quizConfig: {
        difficulty: 'medium', questionCount: 2,
        questionTypes: ['single', 'multiple', 'true_false'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      {
        id: 'q1', type: 'single', format: 'single_choice',
        question: '哪种做法能独立检验模型在新数据上的表现？',
        options: [
          { value: 'A', label: '训练时反复查看测试结果' },
          { value: 'B', label: '模型确定后用未参与调参的数据测试' },
          { value: 'C', label: '把测试样本加入训练集' },
        ],
        answer: ['B'],
        analysis: '测试集用于独立检验模型的泛化表现。', knowledgePointIds: ['kp-sampling'], points: 10,
      },
      {
        id: 'q2', type: 'true_false', format: 'true_false',
        question: '根据测试集的结果反复调参会破坏最终测试的独立性。',
        answer: true, analysis: '测试信息参与调参后就不能充当独立的最终评估。',
        knowledgePointIds: ['kp-sampling'], points: 10,
      },
    ]));

    const result = await generateSceneContent(adaptive, ai);
    const questions = result && 'questions' in result ? result.questions : [];
    expect(questions.map((question) => question.format)).toEqual(['single_choice', 'true_false']);
    expect(ai.mock.calls[0][1]).toContain('36 seconds for reading, thinking, and answering all 2 questions');
    expect(ai.mock.calls[0][1]).not.toContain('Response evidence contract (single)');
    expect(ai.mock.calls[0][0]).toContain('A basic concept, condition, or correspondence can be assessed directly');
    expect(ai.mock.calls[0][0]).toContain('A correct judgment about a situation must follow from facts actually stated in its stem');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('accepts discriminating choices for the page-20 teaching-method goals', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      title: '三种教学法的核心要素与适用场景 · 节末小测',
      description: '检查任务与知识融合、两级支架及教学法适用条件',
      keyPoints: [
        '判断任务是否必须调用目标知识；为学习难点选择由强到弱的支架，并依据学生独立表现撤除',
        '依据学习阶段和任务复杂度选择支架式或抛锚式，并判断情境是否真的成为锚',
      ],
      knowledgePointIds: ['kp-11', 'kp-12', 'kp-13'],
      assessmentUnitIds: ['unit-task', 'unit-scaffold', 'unit-anchor'],
      assessmentUnitMap: [
        { unitId: 'unit-task', knowledgePointIds: ['kp-11'] },
        { unitId: 'unit-scaffold', knowledgePointIds: ['kp-12'] },
        { unitId: 'unit-anchor', knowledgePointIds: ['kp-13'] },
      ],
      plannedTiming: { role: 'assessment', narrationSec: 13, learnerActivitySec: 36, transitionSec: 2 },
      targetDurationSec: 51,
      quizConfig: {
        difficulty: 'medium', questionCount: 2,
        questionTypes: ['single', 'multiple', 'true_false'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      {
        id: 'q1', type: 'multiple', format: 'multiple_choice',
        question: '学生要训练程序自动区分苹果和橘子。哪些做法符合任务驱动与支架式教学？（多选）',
        options: [
          { value: 'A', label: '删掉样本标注后程序仍能自动分类，说明标注不是必需知识' },
          { value: 'B', label: '先给标注与训练清单，再只保留方向提示' },
          { value: 'C', label: '教师先训练好模型，让学生照着运行' },
          { value: 'D', label: '学生不靠清单能独立标注和训练时撤除强支架' },
        ],
        answer: ['B', 'D'],
        analysis: '任务必须调用训练知识；支架只提供线索，并依独立表现逐步撤除。',
        knowledgePointIds: ['kp-11', 'kp-12'], points: 15,
      },
      {
        id: 'q2', type: 'single', format: 'single_choice',
        question: '学生已能独立完成图像采集、标注和训练，现需解决完整分类问题。哪项安排符合抛锚式？',
        options: [
          { value: 'A', label: '细化每个步骤，再让学生重复单项操作' },
          { value: 'B', label: '用真实分类问题决定学习内容、活动和评价' },
          { value: 'C', label: '先播放趣味视频，其余教学照原计划进行' },
        ],
        answer: ['B'],
        analysis: '先看学习阶段与任务复杂度；真正的锚会决定教学内容与活动，单纯视频导入不会。',
        knowledgePointIds: ['kp-13'], points: 10,
      },
    ]));

    const result = await generateSceneContent(adaptive, ai);
    const questions = result && 'questions' in result ? result.questions : [];
    expect(questions.map((question) => question.format)).toEqual(['multiple_choice', 'single_choice']);
    expect(questions[0]?.teachingUnitIds).toEqual(['unit-task', 'unit-scaffold']);
    expect(new Set(questions.flatMap((question) => question.knowledgePointIds ?? [])))
      .toEqual(new Set(['kp-11', 'kp-12', 'kp-13']));
    expect(ai.mock.calls[0][1]).toContain('36 seconds for reading, thinking, and answering all 2 questions');
    expect(ai.mock.calls[0][1]).toContain('single, multiple, true_false only');
    expect(ai.mock.calls[0][1]).not.toContain('matching only');
    expect(ai.mock.calls[0][1]).not.toContain('question 1 must use type=');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('retains a runtime-supported matching first draft for teacher review', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      quizConfig: {
        difficulty: 'medium', questionCount: 1,
        questionTypes: ['single', 'matching', 'true_false'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{
      id: 'q1', type: 'matching', format: 'matching', question: '匹配数据集与职责。',
      pairs: [{ left: '训练集', right: '学习参数' }, { left: '测试集', right: '独立评估' }],
      analysis: '训练与测试承担不同职责。', knowledgePointIds: ['kp-sampling'], points: 10,
    }]));

    expectAuthoredQuiz(await generateSceneContent(adaptive, ai), JSON.parse(await ai.mock.results[0]!.value));
    expect(ai.mock.calls[0][1]).not.toContain('matching only');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('follows the compiled ordered question plan instead of treating fill-blank as an optional format', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      keyPoints: [
        '第 1 题综合考查：识别训练数据的职责',
        '第 2 题综合考查：填空补全独立测试的作用',
      ],
      quizConfig: {
        difficulty: 'medium',
        questionCount: 2,
        questionTypes: ['single', 'fill_blank'],
        questionTypePlan: ['single', 'fill_blank'],
        minShortAnswerQuestions: 0,
        maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      {
        id: 'q1', type: 'single', question: '哪一组数据用于学习参数？',
        options: [{ label: '训练集', value: 'A' }, { label: '测试集', value: 'B' }],
        answer: ['A'], analysis: '训练集用于学习参数。', knowledgePointIds: ['kp-sampling'], points: 10,
      },
      {
        id: 'q2', type: 'fill_blank', format: 'fill_blank', question: '测试集用于____模型在新数据上的表现。',
        analysis: '应填独立检验。', knowledgePointIds: ['kp-sampling'], points: 10,
      },
    ]));

    const result = await generateSceneContent(adaptive, ai);
    const questions = result && 'questions' in result ? result.questions : [];
    expect(ai.mock.calls[0][1]).toContain('question 1 must use type="single"; question 2 must use type="fill_blank"');
    expect(ai.mock.calls[0][1]).toContain('Each numbered Test Point maps to the same-numbered question');
    expect(questions.map((question) => question.format)).toEqual(['single_choice', 'fill_blank']);
  });

  it('retains the authored format when it differs from the planning preference', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      keyPoints: ['第 1 题综合考查：识别职责', '第 2 题综合考查：填空补全作用'],
      quizConfig: {
        difficulty: 'medium', questionCount: 2,
        questionTypes: ['single', 'fill_blank'],
        questionTypePlan: ['single', 'fill_blank'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      { id: 'q1', type: 'single', question: '训练集用于什么？', options: [{ label: '学习参数', value: 'A' }, { label: '最终评分', value: 'B' }], answer: ['A'], analysis: '学习参数。', knowledgePointIds: ['kp-sampling'], points: 10 },
      { id: 'q2', type: 'single', question: '测试集用于什么？', options: [{ label: '独立检验', value: 'A' }, { label: '反复调参', value: 'B' }], answer: ['A'], analysis: '独立检验。', knowledgePointIds: ['kp-sampling'], points: 10 },
    ]));

    expectAuthoredQuiz(await generateSceneContent(adaptive, ai), JSON.parse(await ai.mock.results[0]!.value));
  });

  it('retains an incomplete fill-blank stem for teacher review without a correction call', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      quizConfig: {
        difficulty: 'medium', questionCount: 2,
        questionTypes: ['fill_blank', 'single'],
        questionTypePlan: ['fill_blank', 'single'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
        { id: 'q1', type: 'fill_blank', format: 'fill_blank', question: '解释随机抽样为什么公平。', analysis: '公平入样。', knowledgePointIds: ['kp-sampling'], points: 10 },
        { id: 'q2', type: 'single', question: '哪项属于随机抽样？', options: [{ label: '随机抽取学号', value: 'A' }, { label: '只问前排', value: 'B' }], answer: ['A'], analysis: '公平入样。', knowledgePointIds: ['kp-sampling'], points: 10 },
      ]));

    expectAuthoredQuiz(await generateSceneContent(adaptive, ai), JSON.parse(await ai.mock.results[0]!.value));
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('retains a draft without knowledge attribution rather than fabricating it', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      knowledgePointIds: ['kp-role', 'kp-leak'],
      assessmentUnitIds: ['unit-role', 'unit-leak'],
      assessmentUnitMap: [
        { unitId: 'unit-role', knowledgePointIds: ['kp-role'] },
        { unitId: 'unit-leak', knowledgePointIds: ['kp-leak'] },
      ],
      quizConfig: {
        difficulty: 'medium', questionCount: 2,
        questionTypes: ['single', 'true_false'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const first = [
      { id: 'q1', type: 'single', question: '哪项正确？', options: [{ label: '训练数据学习参数', value: 'A' }, { label: '测试数据学习参数', value: 'B' }], answer: ['A'], analysis: '训练集用于学习参数。', points: 10 },
      { id: 'q2', type: 'true_false', format: 'true_false', question: '测试集用于独立评估。', answer: true, analysis: '正确。', knowledgePointIds: ['kp-role'], points: 10 },
    ];
    const ai = vi.fn().mockResolvedValue(JSON.stringify(first));

    expectAuthoredQuiz(await generateSceneContent(adaptive, ai), JSON.parse(await ai.mock.results[0]!.value));
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('rejects an incomplete quiz result so the affected page can be retried', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify([]));
    await expect(generateSceneContent(outline, ai)).rejects.toThrow('nonempty array');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('retains authored questions with incomplete coverage for final teacher review', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      knowledgePointIds: ['kp-role', 'kp-leak'],
      quizConfig: {
        difficulty: 'medium', questionCount: 2,
        questionTypes: ['single', 'true_false', 'fill_blank', 'matching'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      { id: 'q1', type: 'true_false', format: 'true_false', question: '训练集用于学习参数。', answer: true, analysis: '正确。', knowledgePointIds: ['kp-role'], points: 10 },
      { id: 'q2', type: 'true_false', format: 'true_false', question: '测试集用于独立评估。', answer: true, analysis: '正确。', knowledgePointIds: ['kp-role'], points: 10 },
    ]));

    expectAuthoredQuiz(await generateSceneContent(adaptive, ai), JSON.parse(await ai.mock.results[0]!.value));
  });

  it('covers each adaptive teaching-unit target once and keeps matching objective', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      knowledgePointIds: ['kp-role', 'kp-leak'],
      assessmentUnitIds: ['unit-role', 'unit-leak'],
      assessmentUnitMap: [
        { unitId: 'unit-role', knowledgePointIds: ['kp-role'] },
        { unitId: 'unit-leak', knowledgePointIds: ['kp-leak'] },
      ],
      assessmentTargets: [
        { unitId: 'unit-role', knowledgePointId: 'kp-role', unitTitle: '数据角色', learningOutcome: '区分训练与测试' },
        { unitId: 'unit-leak', knowledgePointId: 'kp-leak', unitTitle: '数据泄漏', learningOutcome: '识别泄漏' },
      ],
      quizConfig: {
        difficulty: 'medium',
        questionCount: 2,
        questionTypes: ['single', 'matching', 'true_false'],
        questionTypePlan: ['matching', 'true_false'],
        maxShortAnswerQuestions: 0,
        coveragePolicy: 'each-target',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      {
        id: 'q-leak', type: 'single', format: 'true_false', question: '测试数据参与调参会造成泄漏。',
        answer: true, analysis: '测试信息进入训练会高估泛化效果。',
        teachingUnitIds: ['unit-leak'], knowledgePointIds: ['kp-leak'], points: 10,
      },
      {
        id: 'q-role', type: 'matching', format: 'matching', question: '匹配数据角色与用途。',
        pairs: [
          { left: '训练集', right: '学习参数' },
          { left: '测试集', right: '独立评估' },
        ],
        analysis: '两个集合承担不同职责。',
        teachingUnitIds: ['unit-role'], knowledgePointIds: ['kp-role'], points: 10,
      },
    ]));

    const result = await generateSceneContent(adaptive, ai);
    const questions = result && 'questions' in result ? result.questions : [];
    expect(ai.mock.calls[0][1]).toContain('question 1 must use type="matching"; question 2 must use type="true_false"');
    expect(questions.map((question) => [question.teachingUnitIds, question.knowledgePointIds])).toEqual([
      [['unit-leak'], ['kp-leak']],
      [['unit-role'], ['kp-role']],
    ]);
    expect(questions[1]).toMatchObject({ id: 'q-role', type: 'matching', format: 'matching' });
  });

  it('keeps author content with empty analysis and repeated labels while assigning usable question ids', async () => {
    const qualityOutline: SceneOutline = {
      ...outline,
      quizConfig: {
        difficulty: 'medium',
        questionCount: 2,
        questionTypes: ['single', 'multiple'],
        minShortAnswerQuestions: 0,
        maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const invalid = [
      {
        id: 'q1', type: 'single', format: 'single_choice', question: '哪种抽样更合理？',
        options: [{ label: '随机抽样', value: 'A' }, { label: ' 随机抽样 ', value: 'B' }],
        answer: ['A'], analysis: ' ', knowledgePointIds: ['kp-sampling'], points: 10,
      },
      {
        id: 'q1', type: 'multiple', format: 'multiple_choice', question: '哪些做法正确？',
        options: [{ label: '随机抽取', value: 'A' }, { label: '分层抽取', value: 'B' }],
        answer: ['A', 'B'], analysis: '两种做法都正确。', knowledgePointIds: ['kp-sampling'], points: 10,
      },
    ];
    const ai = vi.fn().mockResolvedValue(JSON.stringify(invalid));

    expectAuthoredQuiz(await generateSceneContent(qualityOutline, ai), JSON.parse(await ai.mock.results[0]!.value));
    expect(ai).toHaveBeenCalledTimes(1);
    expect(ai.mock.calls[0][0]).toContain('There is no later model review or rewrite');
    expect(ai.mock.calls[0][0]).toContain('private design card');
    expect(ai.mock.calls[0][0]).toContain('about one third longer than the shortest');
    expect(ai.mock.calls[0][0]).toContain('Do not make a distractor wrong merely by inserting');
  });

  it('keeps all first-draft options without a distractor-count rejection', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      quizConfig: {
        difficulty: 'medium', questionCount: 1,
        questionTypes: ['single', 'multiple', 'true_false'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{
      id: 'q1', type: 'multiple', format: 'multiple_choice',
      question: '哪些抽样方式能减少选择偏差？',
      options: [
        { value: 'A', label: '随机抽取不同年级的学号' },
        { value: 'B', label: '按各年级人数比例随机抽取' },
        { value: 'C', label: '从完整名单随机抽取学号' },
        { value: 'D', label: '只询问最先离场的学生' },
      ],
      answer: ['A', 'B', 'C'], analysis: '前三项都使用随机抽样，最后一项是便利抽样。',
      knowledgePointIds: ['kp-sampling'], points: 10,
    }]));

    expectAuthoredQuiz(await generateSceneContent(adaptive, ai), JSON.parse(await ai.mock.results[0]!.value));
    expect(ai.mock.calls[0][0]).toContain('at least two plausible incorrect alternatives');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('keeps empty analysis for teacher review without inventing feedback or retrying', async () => {
    const missingAnalysis = JSON.stringify([{
      id: 'q1', type: 'short_answer', format: 'short_answer', question: '解释随机抽样如何减少选择偏差。',
      analysis: ' ', knowledgePointIds: ['kp-sampling'], points: 10,
    }]);
    const ai = vi.fn().mockResolvedValue(missingAnalysis);

    expectAuthoredQuiz(await generateSceneContent(outline, ai), JSON.parse(await ai.mock.results[0]!.value));
    expect(ai).toHaveBeenCalledTimes(1);
  });
});
