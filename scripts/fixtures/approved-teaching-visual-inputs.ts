import type { DiagramPlan } from '@openmaic/generation';
import type { SceneOutline } from '../../src/lib/openmaic/types/generation';
import { createTeachingVisualBenchmarkCases, type FrozenSlideSample, type VisualBenchmarkOutline } from './teaching-visual-samples';

/** These inputs contain teaching responsibility and real topology, never a
 * handwritten TeachingVisualScene or native PPT elements. Model output is the
 * only candidate for the new production visual authoring path. */
export type ApprovedVisualInput = {
  id: string;
  kind: 'process' | 'state-change';
  sample: boolean;
  outline: VisualBenchmarkOutline;
  checks: string[];
  source: { kind: 'course-snapshot' | 'fixed-benchmark'; title: string; reference: string; note: string };
};

function fixed(id: string, title: string, points: string[], diagram: DiagramPlan | undefined, checks: string[]): ApprovedVisualInput {
  const english = /^[A-Za-z]/u.test(title);
  const outline: VisualBenchmarkOutline = {
    id, title, type: 'slide', order: 0, description: points.join('\n'), teachingObjective: points.join('\n'), keyPoints: points,
    audience: 'student', generationPurpose: 'knowledge-teaching', targetDurationSec: 60, estimatedDuration: 60,
    courseLanguageDirective: english ? 'Use English for learner-facing text. Preserve every condition and the supplied directed relationships.'
      : '使用简体中文，保留全部条件和实际有向关系。',
    teachingBrief: { schemaVersion: 1, explanation: points.join('\n'), examples: [], conditions: [], assessmentFocus: '',
      evidence: points.map((quote) => ({ sourceId: `fixed-benchmark:${id}`, quote })),
      teachingPlan: { purpose: points.join('\n'), priorKnowledge: '', newContent: points.join('\n'), learnerQuestion: '',
        reasoningSteps: points, takeaway: points.join('; '), visibleContent: points, presentationContent: points,
        presentationItems: points.map((text) => ({ role: 'key-point', text, nodeIds: [] })), narrationFocus: points },
    },
    ...(diagram ? { visualIntent: { observationGoal: points.join('\n'), representation: 'native-diagram' as const, diagram } } : {}),
  };
  return { id, kind: diagram ? 'process' : 'state-change', sample: true, outline, checks,
    source: { kind: 'fixed-benchmark', title, reference: 'scripts/fixtures/approved-teaching-visual-inputs.ts',
      note: '固定验证示例，非教材原文；完整原输入独立保存。只给教学责任与真实关系，未给手工场景或元素。' } };
}

export function createApprovedVisualInputs(original: SceneOutline, samples: FrozenSlideSample[], snapshotReference: string): ApprovedVisualInput[] {
  const frozen = createTeachingVisualBenchmarkCases(samples, original, snapshotReference);
  const selected = ['state-01-scaffolding', 'state-02-total', 'state-03-invariant', 'process-03-investigation'];
  const cases: ApprovedVisualInput[] = [{ id: 'original-page-19', kind: 'process', sample: false, outline: structuredClone(original),
    checks: ['实际完整第19页，不把手工两页短句回填原资料', '完整五环节、独立探索支持渐退', '评价主体与内容分开', '暂时/渐消/独立完成撤离、逐个非一次性、按学情调整', '可拆页但计划总97秒，讲稿/音频不生成'],
    source: { kind: 'course-snapshot', title: original.title, reference: snapshotReference,
      note: '完整原19大纲、真实教材证据与原5节点4边；实际生产模型规划，不采用手工样稿元素；不改变原课。' } }];
  for (const id of selected) {
    const input = frozen.find((item) => item.id === id)!;
    cases.push({ id: input.id, kind: input.kind as 'process' | 'state-change', sample: true, outline: structuredClone(input.outline),
      checks: id === 'state-01-scaffolding' ? ['支持状态形成一个主体', '定性、非固定发展阶段', '否定条件独立醒目']
        : id === 'state-02-total' ? ['英文状态长标签可读', '0→3→4→8与每次输入真实对应', '状态不是支持/能力百分比']
          : id === 'state-03-invariant' ? ['英文循环前后不变量', '初始化/保持/终止不混同', '真实回边不穿文字']
            : ['中文长说明', '假设→测量→评价→下一轮验证', '真实下一轮回路不形成伪相邻关系'],
      source: { ...input.source, note: input.source.note + ' 仅复用原教学输入，原手工scene未传给生成器。' } });
  }
  cases.push(fixed('approved-long-english', 'From observations to a qualified conclusion', [
    'Define an observable claim and state which possible observations would support or contradict it.',
    'Record the measurement procedure and keep the comparison conditions consistent before collecting observations.',
    'Compare the recorded observations with the claim and explain both supporting and conflicting evidence.',
    'State a conclusion limited to the observed conditions; an association alone does not establish causation.',
  ], { topology: 'sequence', nodes: [
    { id: 'claim', label: 'Define an observable and falsifiable claim' },
    { id: 'measure', label: 'Record measurements under comparable conditions' },
    { id: 'compare', label: 'Compare supporting and conflicting observations' },
    { id: 'conclude', label: 'State a conclusion within the observed scope' },
  ], edges: [{ from: 'claim', to: 'measure' }, { from: 'measure', to: 'compare' }, { from: 'compare', to: 'conclude' }] },
  ['英文长核心标签不产生孤词或细字', '主路径清楚，四对象不能变成密集正文', '保留结论范围与非因果条件']));
  cases.push(fixed('approved-branch-english', 'Guard a division before evaluating the result', [
    'Read numerator a and divisor b, then test whether b equals 0 before evaluating a / b.',
    'If b equals 0, raise a division error and stop; do not evaluate a / b on this branch.',
    'If b is not 0, evaluate a / b and return that result.',
    'The two outcomes are alternative branches from the guard; there is no transition from the error outcome to the returned result.',
  ], { topology: 'branch', nodes: [{ id: 'input', label: 'Read a and b' }, { id: 'guard', label: 'Is b equal to 0?' },
    { id: 'error', label: 'Raise error and stop' }, { id: 'result', label: 'Evaluate a / b and return' }],
  edges: [{ from: 'input', to: 'guard' }, { from: 'guard', to: 'error', label: 'b = 0' }, { from: 'guard', to: 'result', label: 'b ≠ 0' }] },
  ['两条带真实条件的分支', '不能把error和return串联', '箭头端点/条件标注不穿字']));
  cases.push(fixed('approved-cycle-english', 'Repair a failure and verify the same scope', [
    'Reproduce the failure with the smallest relevant input and retain the observed failure.',
    'Inspect actual and expected values to locate the first incorrect state, then fix its cause.',
    'Rerun the same failing check after the fix. If it still fails, return to inspection within the same repair scope.',
    'If the failing check passes, check related regressions and finish only when those checks also pass.',
  ], { topology: 'cycle', nodes: [{ id: 'reproduce', label: 'Reproduce the relevant failure' }, { id: 'inspect', label: 'Inspect the first incorrect state' },
    { id: 'fix', label: 'Fix the cause and rerun the check' }, { id: 'finish', label: 'Check related regressions and finish' }],
  edges: [{ from: 'reproduce', to: 'inspect' }, { from: 'inspect', to: 'fix' }, { from: 'fix', to: 'inspect', label: 'Still fails' },
    { from: 'fix', to: 'finish', label: 'Failing check passes' }] },
  ['英文长标签与条件', '真实回边fix→inspect', '不能虚构finish→reproduce的循环', '路径与节点文字互不覆盖']));
  if (cases.length !== 8) throw new Error('认可风格首批验证应包含完整原19和7个边界案例');
  return cases;
}
