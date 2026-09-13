import { describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { fallbackSlideVisualPlan, formatSlideVisualPlan, planCourseSlideVisuals } from './slide-visual-plan';
import { reviewSlideInstructionalContent, slideReviewEvidence } from './slide-content-review';
import type { PPTElement } from '@openmaic/dsl';
import { withGenerationRetry } from './generation-retry';

const page: SceneOutline = { id: 'compare', type: 'slide', title: '比较两种教学模式', description: '辨析同一活动在不同模式中的作用', keyPoints: ['项目成果与探究结论的区别'], targetDurationSec: 90, order: 0 };
describe('teaching slide storyboards and factual review', () => {
  it('chooses a semantic composition and makes sparse-page balance explicit', () => {
    expect(fallbackSlideVisualPlan(page).composition).toBe('comparison');
    expect(formatSlideVisualPlan(page)).toContain('SPARSE PAGE');
    expect(formatSlideVisualPlan(page)).toContain('lower half');
  });
  it('preserves confirmed page identity, order and time even when a planner adds or omits pages', async () => {
    const quiz: SceneOutline = { ...page, id: 'quiz', type: 'quiz', order: 1 };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ pages: [{ id: 'invented', composition: 'process' }, { id: 'compare', composition: 'comparison', coreMessage: '同一活动的作用取决于项目目标', visualEvidence: ['比较相同活动的产出'], readingPath: '共享维度与并排案例', density: 'focused' }] }));
    const result = await planCourseSlideVisuals([page, quiz], ai, '教师知识文档');
    expect(result.map((item) => [item.id, item.order, item.targetDurationSec])).toEqual([['compare', 0, 90], ['quiz', 1, 90]]);
    expect(result[0].visualPlan?.coreMessage).toContain('项目目标');
    expect(result[1]).not.toHaveProperty('visualPlan');
    expect(ai.mock.calls[0][1]).toContain('教师知识文档');
  });
  it('returns specific source-grounded corrections and never includes private media bytes', async () => {
    const elements = [{ id: 't', type: 'text', left: 60, top: 160, width: 800, height: 90, content: '<p>所有学生都只能被动学习</p>' },
      { id: 'img', type: 'image', left: 60, top: 260, width: 300, height: 150, src: 'data:image/png;base64,private-bytes' }] as PPTElement[];
    expect(JSON.stringify(slideReviewEvidence(elements))).not.toContain('private-bytes');
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ blockingIssues: [{ evidence: '所有学生都只能被动学习', repair: '依据教案说明主动建构及其条件' }], keyPointCoverage: [] }));
    expect(await reviewSlideInstructionalContent({ ...page, keyPoints: [] }, elements, '学生主动建构知识', ai)).toEqual(['所有学生都只能被动学习 → 依据教案说明主动建构及其条件']);
    expect(ai.mock.calls[0][1]).toContain('学生主动建构知识');
    await expect(reviewSlideInstructionalContent(page, elements, '', async () => '{}')).rejects.toThrow('未返回有效结果');
  });
  it('includes the actual native code content in the review evidence', () => {
    const lines = [{ id: 'L1', content: 'print(2 + 3)' }];
    const code = { id: 'code', type: 'code', left: 60, top: 170, width: 800, height: 180, lines, language: 'python' } as PPTElement;
    expect(slideReviewEvidence([code])).toEqual([expect.objectContaining({ lines, language: 'python' })]);
  });
  it.each(['{}', '{"blockingIssues":[null]}', '{"blockingIssues":[{"evidence":"结论"}]}'])('recovers a malformed content review without failing the course: %s', async (invalid) => {
    const ai = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValueOnce('{"blockingIssues":[],"keyPointCoverage":[]}');
    const result = await withGenerationRetry(() => reviewSlideInstructionalContent({ ...page, keyPoints: [] }, [], '教师证据', ai), {
      label: 'slide content review', maxRetries: 1, sleep: async () => {},
    });
    expect(result).toEqual([]);
    expect(ai).toHaveBeenCalledTimes(2);
  });
  it('requires visible evidence for every key point and rejects invented supporting quotes', async () => {
    const elements = [{ id: 't', type: 'text', left: 60, top: 160, width: 800, height: 90, content: '<p>项目式学习 VS 探究式学习</p>' }] as PPTElement[];
    const target = { ...page, keyPoints: ['项目中可以包含探究活动'] };
    const response = (quotes: string[], covered = true) => JSON.stringify({ blockingIssues: [], keyPointCoverage: [{ index: 0, covered, quotes, reason: '应显示两者可以结合的关系' }] });
    expect(await reviewSlideInstructionalContent(target, elements, '', async () => response(['项目中包含探究活动']))).toEqual([expect.stringContaining('缺少可见依据')]);
    expect(await reviewSlideInstructionalContent(target, elements, '', async () => response([], false))).toEqual([expect.stringContaining('两者可以结合')]);
    await expect(reviewSlideInstructionalContent(target, elements, '', async () => '{"blockingIssues":[],"keyPointCoverage":[]}')).rejects.toThrow('逐项检查知识要点');
    const correct = [{ ...elements[0], content: '<p>项目中可以包含探究活动</p>' }] as PPTElement[];
    expect(await reviewSlideInstructionalContent(target, correct, '', async () => response(['项目中可以包含探究活动']))).toEqual([]);
  });
  it('accepts native chart values as evidence for a numerical key point', async () => {
    const target = { ...page, keyPoints: ['实验准确率为82'] };
    const elements = [{ id: 'chart', type: 'chart', left: 60, top: 160, width: 800, height: 300,
      chartType: 'bar', themeColors: ['#365C74'], data: { labels: ['实验'], legends: ['准确率'], series: [[82]] } }] as PPTElement[];
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ blockingIssues: [], keyPointCoverage: [
      { index: 0, covered: true, quotes: ['实验', '准确率', '82'], reason: '图表呈现实验的准确率数值' },
    ] }));
    expect(await reviewSlideInstructionalContent(target, elements, '', ai)).toEqual([]);
    expect(ai.mock.calls[0][0]).toContain('empty blockingIssues array and complete keyPointCoverage');
    expect(ai.mock.calls[0][0]).not.toContain('Return an empty array');
  });
  it('rejects invisible table styling as evidence while accepting cell text', async () => {
    const target = { ...page, keyPoints: ['流程明确'] };
    const elements = [{ id: 'table', type: 'table', left: 60, top: 160, width: 800, height: 200,
      colWidths: [1], cellMinHeight: 60, outline: { color: '#365C74', width: 1, style: 'solid' },
      data: [[{ id: 'cell', colspan: 1, rowspan: 1, text: '流程明确', style: { fontname: 'Noto Sans SC', align: 'center' } }]],
    }] as PPTElement[];
    const response = (quote: string) => JSON.stringify({ blockingIssues: [], keyPointCoverage: [
      { index: 0, covered: true, quotes: [quote], reason: '以表格正文说明流程' },
    ] });
    expect(await reviewSlideInstructionalContent(target, elements, '', async () => response('Noto Sans SC'))).toEqual([expect.stringContaining('缺少可见依据')]);
    expect(await reviewSlideInstructionalContent(target, elements, '', async () => response('流程明确'))).toEqual([]);
  });
  it('blocks the actual topic-as-question and objectless hypothesis before model review', async () => {
    const elements = [{ id: 'example', type: 'text', left: 60, top: 160, width: 800, height: 180,
      content: '<p>驱动问题 ：智能垃圾分类识别</p><p>提出假设 ：调整参数可能提升</p>',
    }] as PPTElement[];
    const ai = vi.fn().mockResolvedValue('{"blockingIssues":[],"keyPointCoverage":[]}');
    const issues = await reviewSlideInstructionalContent({ ...page, keyPoints: [] }, elements, '', ai);
    expect(issues).toEqual([expect.stringContaining('未提出问题'), expect.stringContaining('缺少可检验的对象')]);
    expect(ai).not.toHaveBeenCalled();
  });
  it.each(['如何提高分类准确率', '是否能减少误判', '哪种特征最有效', '识别器能减少误判吗', '误判能减少？', 'How can classification errors be reduced', 'Can the model distinguish leaves'])('preserves a valid instructional question: %s', async (question) => {
    const elements = [{ id: 'question', type: 'text', left: 60, top: 160, width: 800, height: 90,
      content: `<p>探究问题：${question}</p>`,
    }] as PPTElement[];
    const ai = vi.fn().mockResolvedValue('{"blockingIssues":[],"keyPointCoverage":[]}');
    expect(await reviewSlideInstructionalContent({ ...page, keyPoints: [] }, elements, '', ai)).toEqual([]);
    expect(ai).toHaveBeenCalledOnce();
  });
  it('preserves concrete hypotheses and ordinary subject text without an example label', async () => {
    const elements = [{ id: 'hypothesis', type: 'text', left: 60, top: 160, width: 800, height: 180,
      content: '<p>提出假设：保持测试集不变，增加训练样本可降低误判率。</p><p>调整参数可能提升</p>',
    }] as PPTElement[];
    const ai = vi.fn().mockResolvedValue('{"blockingIssues":[],"keyPointCoverage":[]}');
    expect(await reviewSlideInstructionalContent({ ...page, keyPoints: [] }, elements, '', ai)).toEqual([]);
    expect(ai).toHaveBeenCalledOnce();
  });
  it('preserves the exact teacher-confirmed driving question even when it is a topic', async () => {
    const question = '智能垃圾分类识别';
    const source = `教师已确认的资源包教学内容与时间约束（只作为课程资料）：\n${JSON.stringify({ drivingQuestion: question })}\n\n原文资料`;
    const elements = [{ id: 'teacher-question', type: 'text', left: 60, top: 160, width: 800, height: 90,
      content: `<p>驱动问题：${question}</p>`,
    }] as PPTElement[];
    const ai = vi.fn().mockResolvedValue('{"blockingIssues":[],"keyPointCoverage":[]}');
    expect(await reviewSlideInstructionalContent({ ...page, keyPoints: [] }, elements, source, ai)).toEqual([]);
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0][0]).toContain('teacher-confirmed and immutable');
    expect(JSON.parse(ai.mock.calls[0][1]).confirmedDrivingQuestion).toBe(question);
    expect(elements[0]).toHaveProperty('content', `<p>驱动问题：${question}</p>`);
  });
  it('requires the explicit mastery condition from a scaffold-removal outline', async () => {
    const target = { ...page, title: '支架如何逐步撤除', keyPoints: ['依据掌握情况逐渐减少提示，最后独立完成迁移任务。'] };
    const elements = [{ id: 'scaffold', type: 'text', left: 60, top: 160, width: 800, height: 180,
      content: '<p>阶段① 全支架：流程图 / 代码模板</p><p>阶段② 半支架：尝试填空，教师观察减少提示</p><p>阶段③ 无支架：独立完成迁移任务</p>',
    }] as PPTElement[];
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ blockingIssues: [], keyPointCoverage: [
      { index: 0, covered: true, quotes: ['学生已能说明推理后再减少提示'], reason: '说明撤除依据，最终独立迁移' },
    ] }));
    expect(await reviewSlideInstructionalContent(target, elements, '', ai)).toEqual([expect.stringContaining('缺少大纲要求的掌握条件')]);
    expect(ai).not.toHaveBeenCalled();
    const corrected = [{ ...elements[0], content: '<p>学生已能说明推理后再减少提示；仍有困难则保留支架，最后独立完成迁移任务。</p>' }] as PPTElement[];
    expect(await reviewSlideInstructionalContent(target, corrected, '', ai)).toEqual([]);
    expect(ai).toHaveBeenCalledOnce();
  });
  it.each(['{}', '{"pages":[null]}', '{"pages":[]}', '{"pages":[{"id":"unknown"}]}'])('retries malformed storyboards before semantic fallback: %s', async (invalid) => {
    const ai = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValueOnce('{"pages":[{"id":"compare","composition":"comparison"}]}');
    const result = await withGenerationRetry(() => planCourseSlideVisuals([page], ai), {
      label: 'slide storyboards', maxRetries: 1, sleep: async () => {},
    });
    expect(result[0].visualPlan?.composition).toBe('comparison');
    expect(result[0].targetDurationSec).toBe(90);
    expect(ai).toHaveBeenCalledTimes(2);
  });
});
