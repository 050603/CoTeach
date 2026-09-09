import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import {
  applyPlannedTeachingToolActions,
  ensureTeachingToolPlans,
  findMissingRequiredTeachingTools,
  formatTeachingToolPlanForPrompt,
  hasUsableInteractiveSurface,
  normalizeTeachingToolPlan,
  summarizeActualTeachingTools,
} from './teaching-tool-plan';

function slide(patch: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id: 'scene-1',
    type: 'slide',
    title: '图像分类流程',
    description: '逐步解释数据、特征与模型之间的关系',
    keyPoints: ['输入标注图像', '提取可区分特征', '模型输出类别'],
    order: 0,
    audience: 'student',
    generationPurpose: 'knowledge-teaching',
    ...patch,
  };
}

describe('teaching tool plan', () => {
  it('does not infer a whiteboard from broad outline language', () => {
    const [planned] = ensureTeachingToolPlans([slide()]);
    expect(planned.teachingToolPlan).toBeUndefined();
  });

  it('removes inherited tool contracts from non-teaching scenes', () => {
    const quiz = slide({
      type: 'quiz',
      teachingToolPlan: [{
        id: 'inherited-board',
        tool: 'whiteboard',
        trigger: '作答前',
        purpose: '展示提示',
        content: ['提示内容'],
        required: true,
      }],
    });

    expect(ensureTeachingToolPlans([quiz])[0].teachingToolPlan).toBeUndefined();
    expect(findMissingRequiredTeachingTools(quiz, {
      sceneType: 'quiz',
      content: { type: 'quiz', questions: [] },
      actions: [{ id: 'speech', type: 'speech', text: '请开始作答。' }],
    })).toEqual([]);
  });

  it('preserves and sanitizes a model-authored tool plan', () => {
    const plan = normalizeTeachingToolPlan([{
      tool: 'whiteboard',
      trigger: '讲到卷积核移动时',
      purpose: '保留局部计算过程',
      content: ['输入窗口', '逐元素相乘', '求和得到特征值'],
      required: true,
    }]);
    expect(plan).toHaveLength(1);
    expect(formatTeachingToolPlanForPrompt(slide({ teachingToolPlan: plan }))).toContain('求和得到特征值');
  });

  it('does not fabricate whiteboard content when a required plan is missing actions', () => {
    const planned = slide({
      teachingToolPlan: [{
        id: 'wb-plan',
        tool: 'whiteboard',
        trigger: '推导分类边界时',
        purpose: '保留逐步推导过程',
        content: ['样本坐标', '决策边界'],
        required: true,
      }],
    });
    const actions: Action[] = [{ id: 'speech-1', type: 'speech', text: '我们逐步看这条处理链。' }];
    const result = applyPlannedTeachingToolActions(planned, actions);
    expect(result).toEqual(actions);
  });

  it('does not fabricate a widget action when generation omitted it', () => {
    const result = applyPlannedTeachingToolActions({
      teachingToolPlan: [{
        id: 'widget-plan',
        tool: 'interactive-widget',
        trigger: '完成讲解后',
        purpose: '引导学生操作',
        content: ['尝试调整参数并观察结果'],
        required: true,
      }],
    }, [{ id: 'speech', type: 'speech', text: '请开始操作。' }]);

    expect(result).toEqual([{ id: 'speech', type: 'speech', text: '请开始操作。' }]);
  });

  it('reports the actual page trigger and visible whiteboard content', () => {
    const actions: Action[] = [
      { id: 'speech-1', type: 'speech', text: '现在把三个步骤画出来。' },
      { id: 'open', type: 'wb_open' },
      { id: 'draw-1', type: 'wb_draw_text', content: '数据 → 特征 → 分类', x: 20, y: 20 },
    ];
    expect(summarizeActualTeachingTools(actions)).toEqual([{
      tool: 'whiteboard',
      actionCount: 2,
      trigger: '现在把三个步骤画出来。',
      content: ['数据 → 特征 → 分类'],
    }]);
  });

  it('accepts a generated interactive surface as the planned widget itself', () => {
    const planned = {
      teachingToolPlan: [{
        id: 'widget-plan',
        tool: 'interactive-widget' as const,
        trigger: '完成讲解后',
        purpose: '引导学生操作',
        content: ['输入提示词并比较结果'],
        required: true,
      }],
    };
    const evidence = {
      sceneType: 'interactive',
      content: {
        type: 'interactive',
        url: '',
        html: '<!doctype html><html><body><label>提示词<input id="prompt"></label><button>生成</button><script>document.querySelector("button")</script></body></html>',
      },
      actions: [{ id: 'speech', type: 'speech' as const, text: '请开始操作。' }],
    };

    expect(hasUsableInteractiveSurface(evidence)).toBe(true);
    expect(findMissingRequiredTeachingTools(planned, evidence)).toEqual([]);
  });

  it('rejects an empty interactive shell and lifecycle-only whiteboard actions', () => {
    expect(findMissingRequiredTeachingTools({
      teachingToolPlan: [
        {
          id: 'widget-plan',
          tool: 'interactive-widget',
          trigger: '开始练习时',
          purpose: '让学生操作',
          content: ['输入内容'],
          required: true,
        },
        {
          id: 'whiteboard-plan',
          tool: 'whiteboard',
          trigger: '开始推导时',
          purpose: '展示推导',
          content: ['关键步骤'],
          required: true,
        },
      ],
    }, {
      sceneType: 'interactive',
      content: { type: 'interactive', url: '', html: '<html><body></body></html>' },
      actions: [{ id: 'open', type: 'wb_open' }],
    })).toEqual(['interactive-widget', 'whiteboard']);
  });
});
