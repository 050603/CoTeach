import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import {
  appendWhiteboardBlock,
  chartTypeIssue,
  deleteBoardStep,
  editBoardStep,
  hasEditableChartData,
  makeBoardStep,
  moveWhiteboardBlock,
  removeWhiteboardBlock,
  placeBoardStep,
  resizeBoardChartData,
  replaceWhiteboardSteps,
  visibleBoardDraws,
  whiteboardBlocks,
  type BoardChart,
} from './whiteboard-edit';
import { setFreshAudioById } from './actions-edit';
import { whiteboardTextHtml } from '@openmaic/lib/action/whiteboard-text';

describe('whiteboard teaching segments', () => {
  const intro: Action = { id: 'intro', type: 'speech', text: '引言' };
  const discussion: Action = { id: 'discussion', type: 'discussion', topic: '讨论' };

  it('keeps narration and drawings together while moving/deleting a board before discussion', () => {
    let actions = appendWhiteboardBlock([intro, discussion], 'board');
    const steps = [
      ...whiteboardBlocks(actions)[0].steps,
      makeBoardStep('speech', 'explain'),
      makeBoardStep('wb_draw_image', 'diagram'),
    ];
    actions = replaceWhiteboardSteps(actions, 'board', steps);
    const moved = moveWhiteboardBlock(actions, 'board', -1);
    expect(moved[0]).toMatchObject({ id: 'board', type: 'wb_open' });
    expect(whiteboardBlocks(moved)[0].steps).toEqual(steps);
    expect(moved.slice(-2)).toEqual([intro, discussion]);
    expect(moveWhiteboardBlock(actions, 'board', 1)).toBe(actions);
    expect(removeWhiteboardBlock(moved, 'board')).toEqual([intro, discussion]);
  });

  it('previews retained content, explicit erasing and clears in teaching order', () => {
    const text = makeBoardStep('wb_draw_text', 'text');
    const image = makeBoardStep('wb_draw_image', 'image');
    const table = makeBoardStep('wb_draw_table', 'table');
    const prefix: Action[] = [
      text,
      { id: 'close', type: 'wb_close' },
      { id: 'open', type: 'wb_open' },
      image,
    ];
    expect(visibleBoardDraws(prefix)).toEqual([text, image]);
    expect(
      visibleBoardDraws([
        ...prefix,
        { id: 'delete', type: 'wb_delete', elementId: 'element-text' },
      ]),
    ).toEqual([image]);
    expect(visibleBoardDraws([...prefix, { id: 'clear', type: 'wb_clear' }, table])).toEqual([
      table,
    ]);
  });

  it('does not attach stale synthesized audio and replaces an old published clip', () => {
    const actions: Action[] = [
      { id: 'voice', type: 'speech', text: '已修改', audioUrl: '/old.mp3' },
    ];
    expect(setFreshAudioById(actions, 'voice', 'new-clip', '旧文本')).toBe(actions);
    expect(setFreshAudioById(actions, 'voice', 'new-clip', '已修改')[0]).toEqual({
      id: 'voice',
      type: 'speech',
      text: '已修改',
      audioId: 'new-clip',
    });
  });

  it('preserves multiple written lines and literal math symbols during real playback', () => {
    expect(whiteboardTextHtml('第一步：a < b\n第二步：b > c', 32)).toBe(
      '<p style="font-size: 32px;">第一步：a &lt; b<br/>第二步：b &gt; c</p>',
    );
    expect(whiteboardTextHtml('<p><strong>已有富文本</strong></p>', 32)).toBe(
      '<p><strong>已有富文本</strong></p>',
    );
  });

  it('keeps chart matrix dimensions valid and rejects switches that would hide series', () => {
    const chart = makeBoardStep('wb_draw_chart', 'chart') as BoardChart;
    expect(chartTypeIssue(chart, 'pie')).toContain('一个系列');
    expect(chartTypeIssue(chart, 'scatter')).toBeNull();
    const enlarged = resizeBoardChartData(chart, 4, 3);
    expect(enlarged.labels).toHaveLength(4);
    expect(enlarged.legends).toHaveLength(3);
    expect(enlarged.series).toEqual([[12, 18, 24, 0], [10, 16, 21, 0], [0, 0, 0, 0]]);
    expect(chartTypeIssue({ ...chart, data: enlarged }, 'scatter')).toContain('两个');
    expect(resizeBoardChartData({ ...chart, chartType: 'scatter' }, 2, 1).series).toHaveLength(2);
    expect(resizeBoardChartData({ ...chart, chartType: 'radar' }, 1, 1).labels).toHaveLength(3);
    const pie = { ...chart, chartType: 'pie' as const, data: resizeBoardChartData(chart, 3, 1) };
    expect(chartTypeIssue(pie, 'pie')).toBeNull();
    expect(resizeBoardChartData(pie, 0, 4).series).toEqual([[12]]);
    expect(chartTypeIssue({ ...pie, data: { ...pie.data, series: [[0, 0, 0]] } }, 'pie')).toContain('正数');
    expect(hasEditableChartData({ ...chart, data: { ...chart.data, series: [[NaN]] } })).toBe(false);
  });

  it('places new content in free space and never clears a crowded page', () => {
    const full: Action = { id: 'full', type: 'wb_draw_shape', x: 0, y: 0, width: 1000, height: 562.5, shape: 'rectangle' };
    const crowded = placeBoardStep('wb_draw_chart', 'new-chart', [full]);
    expect(crowded.crowded).toBe(true);
    expect(crowded.action).toMatchObject({ type: 'wb_draw_chart' });
    expect(full).toMatchObject({ x: 0, y: 0 });
    const placed = placeBoardStep('wb_draw_chart', 'fresh', [full, { id: 'page', type: 'wb_clear' }]);
    expect(placed.crowded).toBe(false);
    expect(placed.action).toMatchObject({ x: 60, y: 60 });
  });

  it('moves the full template group within its page and cascades anchored connector deletion', () => {
    const shape: Action = { id: 'shape', elementId: 'node', type: 'wb_draw_shape', groupId: 'g', x: 50, y: 150, width: 200, height: 100, shape: 'rectangle' };
    const label: Action = { id: 'label', type: 'wb_draw_text', groupId: 'g', x: 70, y: 180, width: 160, height: 40, content: '观察' };
    const line: Action = { id: 'line', type: 'wb_draw_line', startX: 250, startY: 200, endX: 350, endY: 200, startAnchor: { elementId: 'node', side: 'right' } };
    const laterLabel = { ...label, id: 'later' };
    const actions: Action[] = [shape, label, line, { id: 'next-page', type: 'wb_clear' }, laterLabel];
    const moved = editBoardStep(actions, 'shape', (action) => ({ ...action, x: 90 } as Action));
    expect(moved[0]).toMatchObject({ x: 90 });
    expect(moved[1]).toMatchObject({ x: 110, y: 180 });
    expect(moved[2]).toBe(line);
    expect(moved[4]).toBe(laterLabel);
    expect(deleteBoardStep(actions, 'shape').map((action) => action.id)).toEqual(['label', 'next-page', 'later']);
    expect(visibleBoardDraws([shape, label, line, { id: 'delete', type: 'wb_delete', elementId: 'shape' }])).toEqual([label]);
    const redrawn = { ...shape, id: 'redraw', x: 100 };
    expect(visibleBoardDraws([shape, label, redrawn])).toEqual([redrawn, label]);
  });
});
