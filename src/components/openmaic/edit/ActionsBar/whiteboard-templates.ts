import type { Action } from '@openmaic/lib/types/action';
import { clientUUID } from '@/lib/uuid';

export type WhiteboardTemplate = 'comparison' | 'steps' | 'derivation';
export const whiteboardTemplates: Array<[WhiteboardTemplate, string]> = [
  ['comparison', '数据对比'], ['steps', '步骤演示'], ['derivation', '公式推导'],
];

/** Each explicitly chosen template starts a new page; every draw and speech stays editable. */
export function createWhiteboardTemplate(kind: WhiteboardTemplate, nextId = clientUUID): Action[] {
  const titleId = nextId();
  const actions: Action[] = [
    { id: nextId(), type: 'wb_clear' },
    { id: titleId, type: 'wb_draw_text', elementId: `element-${titleId}`, x: 60, y: 32, width: 880, height: 68, fontSize: 30, color: '#27272a', content: `${whiteboardTemplates.find(([key]) => key === kind)?.[1]}（示例，可修改）` },
  ];
  const speak = (text: string) => actions.push({ id: nextId(), type: 'speech', text });
  if (kind === 'comparison') {
    speak('这是可修改的数据对比示例。先看三个项目，再比较两种方案。请把示例数据换成课堂中的真实数据。');
    const chartId = nextId();
    const data = { labels: ['项目 A', '项目 B', '项目 C'], legends: ['方案一', '方案二'], series: [[12, 18, 24], [10, 16, 21]] };
    actions.push({ id: chartId, type: 'wb_draw_chart', elementId: `element-${chartId}`, chartType: 'column', x: 60, y: 130, width: 520, height: 330, data, themeColors: ['#7c3aed', '#0d9488'] });
    const tableId = nextId();
    actions.push({ id: tableId, type: 'wb_draw_table', elementId: `element-${tableId}`, x: 630, y: 150, width: 310, height: 220, data: [['项目', ...data.legends], ...data.labels.map((label, row) => [label, ...data.series.map((series) => String(series[row]))])], theme: { color: '#7c3aed' } });
    speak('逐项比较同一项目的两根柱子。哪一项的差距最大？这些差距说明了什么？');
    const noteId = nextId();
    actions.push({ id: noteId, type: 'wb_draw_text', elementId: `element-${noteId}`, x: 630, y: 400, width: 310, height: 90, fontSize: 22, color: '#3f3f46', content: '比较方案间差距\n用数据支持结论' });
    speak('请用一个具体数值支持你的结论，再说明还需要收集什么证据。');
  } else if (kind === 'steps') {
    speak('这是可修改的步骤演示示例。我们将依次完成观察、比较和解释。');
    const nodeIds = Array.from({ length: 3 }, () => nextId());
    for (const [index, label] of ['观察', '比较', '解释'].entries()) {
      const groupId = `group-${nodeIds[index]}`;
      const x = 65 + index * 300;
      actions.push({ id: nodeIds[index], type: 'wb_draw_shape', elementId: `element-${nodeIds[index]}`, groupId, shape: 'rectangle', x, y: 175, width: 240, height: 120, fillColor: '#ede9fe' });
      const textId = nextId();
      actions.push({ id: textId, type: 'wb_draw_text', elementId: `element-${textId}`, groupId, x: x + 18, y: 203, width: 204, height: 64, fontSize: 28, color: '#5b21b6', content: `${index + 1}. ${label}` });
      if (index > 0) {
        const lineId = nextId();
        actions.push({ id: lineId, type: 'wb_draw_line', elementId: `element-${lineId}`, startX: x - 60, startY: 235, endX: x, endY: 235, startAnchor: { elementId: `element-${nodeIds[index - 1]}`, side: 'right' }, endAnchor: { elementId: `element-${nodeIds[index]}`, side: 'left' }, width: 3, color: '#7c3aed', points: ['', 'arrow'] });
      }
      speak([
        '第一步，记录你直接观察到的事实，暂时不作判断。',
        '第二步，比较相同点与不同点，找出值得解释的变化。',
        '第三步，用观察和比较得到的证据支持你的解释。',
      ][index]);
    }
  } else {
    speak('这是可修改的一元一次方程推导示例。每一步公式和讲解都可以分别编辑。');
    for (const [index, [latex, explanation]] of [
      ['2x + 3 = 11', '先读原方程，目标是求出未知数 x。'],
      ['2x = 11 - 3 = 8', '等式两边同时减去三，保持两边相等。'],
      ['x = \\frac{8}{2} = 4', '等式两边同时除以二，得到 x 等于四。请代回原式检验。'],
    ].entries()) {
      const id = nextId();
      actions.push({ id, type: 'wb_draw_latex', elementId: `element-${id}`, x: 90, y: 125 + index * 125, width: 820, height: 90, color: '#3f3f46', latex });
      speak(explanation);
    }
  }
  return actions;
}
