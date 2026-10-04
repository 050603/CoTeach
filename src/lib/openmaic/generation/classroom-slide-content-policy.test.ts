import { describe, expect, it } from 'vitest';
import type { PPTTextElement } from '@openmaic/dsl';
import type { GeneratedSlideContent, PdfImage } from '../types/generation';
import { applyClassroomSlideAuthoringPolicy, applyClassroomSlideContentPolicy, retainNativeImageBindings } from './classroom-slide-content-policy';

const text = (id: string, content: string): PPTTextElement => ({ id, type: 'text', left: 60, top: 140,
  width: 400, height: 60, rotate: 0, defaultFontName: 'Noto Sans SC', defaultColor: '#334155', content });

describe('shared teacher and student classroom canvas', () => {
  it('omits explicit source and editorial blocks before measurement, preserving bound teaching facts and annotation', () => {
    const native = { displayItems: [{ id: 'fact', text: '来源：环境与个体相互作用', sourceContentIds: ['original'] }],
      elements: [text('source', '<p>来源：《原教材》，第12页</p>'), text('teacher', '<p>教师提示：此页口播两分钟</p>'),
        { ...text('fact', '<p></p>'), contentRef: 'fact' }, text('annotation', '<p>观察两条路径如何汇合。</p><p>图源：教材</p>'),
        text('tip', '<p>提示：条件不足时不能计算平均值。</p>')],
      components: [{ kind: 'textBox', text: '备课提示：等待学生回答', width: 400 },
        { kind: 'textBox', contentRef: 'fact', width: 400 }],
    };
    const facts = structuredClone(native.displayItems);
    applyClassroomSlideAuthoringPolicy(native);
    expect(native.elements.map((element) => element.id)).toEqual(['fact', 'annotation', 'tip']);
    expect(native.elements[1].content).toBe('<p>观察两条路径如何汇合。</p>');
    expect(native.components).toEqual([{ kind: 'textBox', contentRef: 'fact', width: 400 }]);
    expect(native.displayItems).toEqual(facts);
  });

  it('retains provenance catalog and image identity without a visible caption or changing assets', () => {
    const image: PdfImage = { id: 'actual-image', src: '/original-image.png', pageNumber: 12,
      sourceTitle: '真实教材', width: 1024, height: 768 };
    const canvas: GeneratedSlideContent = { background: { type: 'solid', color: '#FFFFFF' },
      elements: [{ id: 'placed', type: 'image', left: 500, top: 120, width: 320, height: 240, rotate: 0,
        fixedRatio: true, src: image.src }],
    };
    const before = structuredClone({ image, canvas });
    const bound = retainNativeImageBindings(canvas, [image]);
    expect(bound.elements).toEqual(canvas.elements);
    expect(bound.contentBindings).toEqual([{ sourceContentId: 'image:actual-image', elementId: 'placed' }]);
    expect({ image, canvas }).toEqual(before);
    expect(retainNativeImageBindings(bound, [image]).contentBindings).toEqual(bound.contentBindings);
  });

  it('suppresses compiled attribution bindings without suppressing a legitimate source-related fact or title', () => {
    const content: GeneratedSlideContent = { elements: [text('source', '<p>出处：原书</p>'),
      text('teacher', '<p>教师专用提示：此处停顿</p>'), text('fact', '<p>来源：环境与个体相互作用</p>'),
      { ...text('title', '<p>来源：信息的来源分类</p>'), textType: 'title' },
      text('explanation', '<p>条件满足时走同化路径，冲突时需要顺应。</p>')],
      displayItems: [{ id: 'actual-fact', text: '来源：环境与个体相互作用', sourceContentIds: ['adopted-content-1'] }],
      contentBindings: [{ sourceContentId: 'image:book:caption', elementId: 'source' },
        { sourceContentId: 'actual-fact', elementId: 'fact' }, { sourceContentId: 'diagram-annotation', elementId: 'explanation' }],
    };
    const before = structuredClone(content);
    const after = applyClassroomSlideContentPolicy(content);
    expect(after.elements.map((element) => element.id)).toEqual(['fact', 'title', 'explanation']);
    expect(after.contentBindings).toEqual(content.contentBindings!.slice(1));
    expect(after.displayItems).toEqual(content.displayItems);
    expect(content).toEqual(before);
    expect(applyClassroomSlideContentPolicy(after)).toEqual(after);
  });
});
