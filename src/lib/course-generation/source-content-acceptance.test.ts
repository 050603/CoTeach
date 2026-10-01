import { describe, expect, it } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import type { GeneratedSlideContent, SceneOutline } from '@/lib/openmaic/types/generation';
import type { FigureSequenceContract } from '@/lib/textbook/course-visual-binding';
import {
  findSourceContentIssues, findSectionSourceContentIssues, sourceSequenceSlideContent, sourceSequenceTeachingResponsibilities,
  restoreSourceContentCheckpoint, SOURCE_CONTENT_RECOVERY_POLICY,
  type SourceContentRecoveryCheckpoint,
} from './source-content-acceptance';

const labels = ['从贴近学生学习生活的应用场景入手，要注重培养学生使用生成式人工智能的能力',
  '在技术原理的讲授和项目任务的选择上，要依据学生的认知能力进行难度、复杂程度的调整',
  '在实践应用的同时，要引导学生进行道德伦理问题的思考'];
const contract: FigureSequenceContract = { resourceId: 'adopted-source', required: true,
  scope: 'knowledge-point', knowledgePointIds: ['kp-ai'], sequenceSemantics: 'enumerated-items',
  orderedSteps: labels.map((label) => ({ label })) };
const page = (id: string, clauses: string[]): SceneOutline => ({ id, type: 'slide', order: 0,
  title: '人工智能教学', description: '完整呈现已采用建议', keyPoints: clauses,
  generationPurpose: 'knowledge-teaching', lectureSectionId: 'ai-section', knowledgePointIds: ['kp-ai'] });
const textContent = (text: string): GeneratedSlideContent => ({ elements: [
  { id: 'body', type: 'text', content: text, left: 60, top: 145, width: 880, height: 330 },
] } as GeneratedSlideContent);
const tableContent = (clauses: string[]): GeneratedSlideContent => ({ elements: [
  { id: 'table', type: 'table', groupId: 'semantic-group', data: clauses.map((text) => [{ text }]) },
] } as unknown as GeneratedSlideContent);

describe('complete source content acceptance', () => {
  const anchoredLabels = ['创设情境', '进行“抛锚”', '自主探索', '拓展延伸', '讨论交流', '效果评价'];
  const anchoredContract: FigureSequenceContract = { ...contract, sequenceSemantics: 'ordered-steps',
    orderedSteps: anchoredLabels.map((label) => ({ label })) };
  const equivalentFlow = '流程包括创设情境→抛锚→自主探索→拓展延伸→讨论交流→效果评价。';

  it('accepts a source-derived quoted action abbreviation in visible content and actual speech', () => {
    const outline = page('anchored', anchoredLabels);
    expect(findSourceContentIssues([{ outline, content: textContent(equivalentFlow) }], [anchoredContract])).toEqual([]);
    const spoken = { outline, content: textContent('依据真实问题开展探究'), speech: [equivalentFlow] };
    expect(findSourceContentIssues([spoken], [anchoredContract])).toEqual([]);
    expect(findSectionSourceContentIssues([outline], [spoken], [anchoredContract])).toEqual([]);
  });

  it.each([
    ['missing item', equivalentFlow.replace('→抛锚', ''), '遗漏教材步骤'],
    ['wrong count', equivalentFlow.replace('流程包括', '流程有五个步骤，包括'), '写成 5 个环节'],
    ['wrong order', equivalentFlow.replace('创设情境→抛锚', '抛锚→创设情境'), '6 个步骤顺序'],
  ])('keeps the %s gate for both page content and speech', (_name, flow, issue) => {
    const outline = page('anchored', anchoredLabels);
    expect(findSourceContentIssues([{ outline, content: textContent(flow) }], [anchoredContract])[0]?.detail).toContain(issue);
    expect(findSourceContentIssues([{ outline, content: textContent('探究教学'), speech: [flow] }], [anchoredContract])[0]?.detail)
      .toContain(issue);
  });

  it('does not strip an actual action verb or a necessary condition from a source label', () => {
    for (const label of ['进行证据核验', '进行“抛锚”前必须确认真实情境']) {
      const strict = { ...anchoredContract, orderedSteps: [{ label: '创设情境' }, { label }] };
      const outline = page('strict', strict.orderedSteps.map((step) => step.label));
      const shortened = label === '进行证据核验' ? '证据核验' : '抛锚';
      expect(findSourceContentIssues([{ outline, content: textContent(`创设情境、${shortened}`) }], [strict])[0]?.missingCanonicalLabels)
        .toEqual([label]);
      expect(findSourceContentIssues([{ outline, content: textContent('探究教学'), speech: [`创设情境、${shortened}`] }], [strict])[0]?.missingCanonicalLabels)
        .toEqual([label]);
    }
  });

  it('extracts rendered native table and grouped shape text, without accepting source metadata', () => {
    const elements = [
      { id: 'title', type: 'text', content: '<p>标题&nbsp;&amp;&lt;条件&gt;</p>' },
      { id: 'shape', type: 'shape', groupId: 'g', text: { content: '<p>完整阶段</p>' } },
      { id: 'table', type: 'table', groupId: 'g', data: [[{ text: '<p>第一原句</p>' }, { text: ['第二原句', 3] }]] },
      { id: 'image', type: 'image', src: '/source.png', alt: '不能作为实际正文', sourceText: '不能作为实际正文' },
    ] as unknown as PPTElement[];
    expect(sourceSequenceSlideContent({ elements }, true)).toEqual({
      statements: ['标题 &<条件>', '完整阶段', '第一原句', '第二原句', '3'], diagramLabels: ['完整阶段'],
    });
  });

  it('accepts canonical clauses rendered in a native table, and rejects shortened cells', () => {
    const outline = page('source-page', labels);
    expect(findSourceContentIssues([{ outline, content: tableContent(labels) }], [contract])).toEqual([]);
    const shortened = tableContent(['熟悉场景，先使用', '按认知能力决定原理深浅', '实践中注意伦理']);
    expect(findSourceContentIssues([{ outline, content: shortened }], [contract])[0]?.missingCanonicalLabels).toEqual(labels);
    expect(findSourceContentIssues([{ outline, content: shortened, speech: labels }], [contract])).toEqual([]);
  });

  it('checks each adopted list across its actual teaching pages without demanding the whole list on every page', () => {
    const pages = [{ outline: page('first', labels.slice(0, 2)), content: textContent(labels.slice(0, 2).join('\n')) },
      { outline: page('second', labels.slice(2)), content: tableContent(labels.slice(2)) }];
    expect(findSourceContentIssues(pages, [contract])).toEqual([]);
  });

  it('includes actually rendered balanced continuation pages in source coverage', () => {
    const content = { ...textContent(labels[0]!), continuationPages: [tableContent(labels.slice(1))] };
    expect(findSourceContentIssues([{ outline: page('original', labels), content }], [contract])).toEqual([]);
  });

  it('assigns missing clauses to their original measured responsibility rather than an unrelated successful page', () => {
    const pages = [{ outline: page('first', [labels[0]!]), content: textContent('第一建议的缩写') },
      { outline: page('second', labels.slice(1)), content: textContent('其余建议的缩写') }];
    const issues = findSourceContentIssues(pages, [contract], { visibleOnly: true });
    expect(issues.map(({ repairOutlineId, missingCanonicalLabels }) => ({ repairOutlineId, missingCanonicalLabels })))
      .toEqual([{ repairOutlineId: 'first', missingCanonicalLabels: [labels[0]] },
        { repairOutlineId: 'second', missingCanonicalLabels: labels.slice(1) }]);
  });

  it('does not manufacture a screen obligation when a clause is absent from the canonical visible contract', () => {
    const outline = page('source-page', [labels[0]!]);
    expect(findSourceContentIssues([{ outline, content: textContent(labels[0]!) }], [contract], { visibleOnly: true })).toEqual([]);
    expect(findSourceContentIssues([{ outline, content: textContent(labels[0]!) }], [contract])).toHaveLength(1);
  });

  it('keeps full spoken source clauses out of an independently adopted display contract', () => {
    const outline: SceneOutline = { ...page('spoken-source', ['按学情安排任务，实践中讨论伦理']),
      teachingBrief: { schemaVersion: 1, explanation: labels.join('。'), examples: [], conditions: [], evidence: [],
        assessmentFocus: '', teachingPlan: { purpose: '认识课程设计建议', priorKnowledge: '',
          newContent: labels.join('。'), learnerQuestion: '', reasoningSteps: [], takeaway: '',
          visibleContent: labels, presentationContent: ['按学情安排任务，实践中讨论伦理'], narrationFocus: [] } } };
    const actual = { outline, content: textContent(outline.keyPoints[0]!), speech: labels };
    expect(findSourceContentIssues([actual], [contract], { visibleOnly: true })).toEqual([]);
    expect(findSourceContentIssues([actual], [contract])).toEqual([]);
    expect(findSourceContentIssues([{ ...actual, speech: labels.slice(0, 2) }], [contract])[0]?.missingCanonicalLabels)
      .toEqual([labels[2]]);
  });

  it('does not let narration satisfy an explicitly adopted visible process item', () => {
    const outline = page('visible-process', anchoredLabels);
    expect(findSourceContentIssues([{ outline, content: textContent('自主探索'), speech: [equivalentFlow] }],
      [anchoredContract], { visibleOnly: true })[0]?.missingCanonicalLabels).toContain('创设情境');
  });

  it('rejects an omitted ethical clause even when a different knowledge point already discussed ethics', () => {
    const target = { outline: page('ai-page', labels), content: textContent(labels.slice(0, 2).join('\n')) };
    const unrelated = { outline: { ...page('ethics-page', labels), knowledgePointIds: ['kp-ethics'] },
      content: textContent(labels[2]!) };
    expect(findSourceContentIssues([unrelated, target], [contract])[0]).toMatchObject({
      repairOutlineId: 'ai-page', missingCanonicalLabels: [labels[2]],
    });
  });

  it('accepts accurately condensed slides with complete authoritative spoken teaching', () => {
    const outline = page('ai-page', labels);
    const content = textContent(labels[0]!);
    expect(findSourceContentIssues([{ outline, content, speech: labels.slice(1) }], [contract])).toEqual([]);
    expect(findSectionSourceContentIssues([outline], [{ outline, content, speech: labels.slice(1) }], [contract])).toEqual([]);
  });

  it('checks only the original responsibility of a section when one adopted source list spans sections', () => {
    const first = page('first', labels.slice(0, 2));
    const second = { ...page('second', labels.slice(2)), lectureSectionId: 'later-section', order: 1 };
    expect(findSectionSourceContentIssues([first, second], [{ outline: first,
      content: textContent('概念要点'), speech: labels.slice(0, 2) }], [contract])).toEqual([]);
    expect(findSectionSourceContentIssues([first, second], [{ outline: second,
      content: textContent('实践要点'), speech: [] }], [contract])[0]?.missingCanonicalLabels).toEqual(labels.slice(2));
  });

  it('shares the original measured-page responsibility and keeps every unassigned source clause', () => {
    const first = page('first', [labels[0]!]);
    const continuation = { ...page('continued', [labels[1]!]), spatialParentId: first.id, order: 1 };
    const later = { ...page('later', [labels[2]!]), lectureSectionId: 'later-section', order: 2 };
    const responsibility = sourceSequenceTeachingResponsibilities([first, continuation, later], { ...contract, scope: 'single-page' });
    expect(responsibility.targets.map((outline) => outline.id)).toEqual([first.id, continuation.id]);
    expect(responsibility.owners.map(({ label, owner }) => ({ label, pageId: owner.id }))).toEqual([
      { label: labels[0], pageId: first.id }, { label: labels[1], pageId: continuation.id },
      { label: labels[2], pageId: first.id },
    ]);
    expect(findSectionSourceContentIssues([first, continuation, later], [{ outline: first,
      content: textContent(labels[0]!), speech: [] }], [{ ...contract, scope: 'single-page' }])
      .map(({ repairOutlineId, missingCanonicalLabels }) => ({ repairOutlineId, missingCanonicalLabels }))).toEqual([
        { repairOutlineId: continuation.id, missingCanonicalLabels: [labels[1]] },
        { repairOutlineId: first.id, missingCanonicalLabels: [labels[2]] },
      ]);
    expect(sourceSequenceTeachingResponsibilities([first, later], { ...contract, required: false }))
      .toEqual({ targets: [], owners: [] });
  });

  it('uses the same first complete procedure page for source authoring and actual content acceptance', () => {
    const overview = page('overview', ['理解记录核对的含义']);
    const procedure = { ...page('procedure', labels), order: 1,
      teachingBrief: { schemaVersion: 1 as const, explanation: labels.join('。'), examples: [],
        conditions: [], evidence: [], assessmentFocus: '' } };
    const singlePage = { ...contract, scope: 'single-page' as const };
    expect(sourceSequenceTeachingResponsibilities([overview, procedure], singlePage).targets)
      .toEqual([procedure]);
    const pages = [{ outline: overview, content: textContent('理解记录核对的含义') },
      { outline: procedure, content: textContent(labels.join('。')) }];
    expect(findSourceContentIssues(pages, [singlePage])).toEqual([]);
    expect(findSectionSourceContentIssues([overview, procedure], pages, [singlePage])).toEqual([]);
    pages[1]!.content = textContent(labels.slice(0, 2).join('。'));
    expect(findSourceContentIssues(pages, [singlePage])[0]?.missingCanonicalLabels).toEqual([labels[2]]);
    expect(findSectionSourceContentIssues([overview, procedure], pages, [singlePage])[0]?.missingCanonicalLabels)
      .toEqual([labels[2]]);
  });

  it('keeps separate source lists independent and ignores unadopted candidates', () => {
    const other = { ...contract, resourceId: 'other-list', orderedSteps: [{ label: '保留完整定义与条件' }, { label: '保留完整结论与边界' }] };
    const unadopted = { ...other, resourceId: 'candidate', required: false };
    const pages = [{ outline: page('ai-page', labels), content: tableContent(labels) }];
    expect(findSourceContentIssues(pages, [contract, unadopted])).toEqual([]);
    expect(findSourceContentIssues(pages, [contract, other]).map((issue) => issue.resourceId)).toEqual(['other-list']);
  });
});

describe('bounded source repair checkpoint identity', () => {
  const identity = { sectionId: 'ai-section', sourceFingerprint: 'source', inputFingerprint: 'request', modelFingerprint: 'teacher-model' };
  const checkpoint: SourceContentRecoveryCheckpoint = { schemaVersion: 1, planningPolicy: SOURCE_CONTENT_RECOVERY_POLICY,
    ...identity, attemptsStarted: 2, status: 'pending', issues: [{ resourceId: 'source', detail: '完整原句缺失',
      sectionId: identity.sectionId, repairOutlineId: 'ai-page', targetOutlineIds: ['ai-page'], missingCanonicalLabels: [labels[2]!] }],
    failedNarrationFingerprints: { 'ai-page': 'old-narration' }, originalFinalNarration: ['原小节结束的完整讲解'] };
  it('preserves consumed repair budget and old section bridge across a worker restart', () => {
    expect(restoreSourceContentCheckpoint(JSON.parse(JSON.stringify(checkpoint)), identity)).toEqual(checkpoint);
  });
  it('preserves spent old calls separately from the bounded insertion authoring budget', () => {
    const insertion: SourceContentRecoveryCheckpoint = { ...checkpoint, authoringMode: 'insertion-v1',
      insertionAttemptsStarted: 1 };
    const restored = restoreSourceContentCheckpoint(JSON.parse(JSON.stringify(insertion)), identity);
    expect(restored).toEqual(insertion);
    expect(restored?.attemptsStarted).toBe(2);
    expect(restored?.insertionAttemptsStarted).toBe(1);
    expect(restoreSourceContentCheckpoint({ ...insertion, insertionAttemptsStarted: 2, status: 'accepted' }, identity))
      .toMatchObject({ attemptsStarted: 2, insertionAttemptsStarted: 2, status: 'accepted' });
  });
  it.each([-1, 3, 1.5, '1', null])('rejects an unbounded or malformed insertion count %s', (insertionAttemptsStarted) => {
    expect(restoreSourceContentCheckpoint({ ...checkpoint, authoringMode: 'insertion-v1', insertionAttemptsStarted }, identity)).toBeNull();
  });
  it('rejects insertion budget without its grammar and unknown grammar names', () => {
    expect(restoreSourceContentCheckpoint({ ...checkpoint, insertionAttemptsStarted: 1 }, identity)).toBeNull();
    expect(restoreSourceContentCheckpoint({ ...checkpoint, authoringMode: 'rewrite-v2' }, identity)).toBeNull();
    expect(restoreSourceContentCheckpoint({ ...checkpoint, authoringMode: 'insertion-v1', insertionAttemptsStarted: 1 },
      { ...identity, sourceFingerprint: 'another-source' })).toBeNull();
  });
  it.each(['sectionId', 'sourceFingerprint', 'inputFingerprint', 'modelFingerprint'] as const)
    ('rejects a checkpoint for changed %s', (key) => {
      expect(restoreSourceContentCheckpoint(checkpoint, { ...identity, [key]: 'changed' })).toBeNull();
    });
  it.each([-1, 3, 1.5])('rejects malformed or unbounded repair count %s', (attemptsStarted) => {
    expect(restoreSourceContentCheckpoint({ ...checkpoint, attemptsStarted }, identity)).toBeNull();
  });
});
