import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene, ScenePatch } from '@openmaic/lib/types/stage';

vi.mock('@openmaic/lib/store/stage', async () => {
  const { create } = await import('zustand');
  return {
    useStageStore: create<{
      scenes: Scene[];
      getSceneById: (id: string) => Scene | undefined;
      updateScene: (id: string, patch: ScenePatch) => void;
    }>((set, get) => ({
      scenes: [],
      getSceneById: (id) => get().scenes.find((scene) => scene.id === id),
      updateScene: (id, patch) =>
        set((state) => ({
          scenes: state.scenes.map((scene) =>
            scene.id === id ? ({ ...scene, ...patch } as Scene) : scene,
          ),
        })),
    })),
  };
});
vi.mock('@openmaic/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@openmaic/lib/audio/regenerate-speech-tts', () => ({
  audioExists: vi.fn(async () => false),
  audioObjectUrl: vi.fn(),
  discardSpeechAudio: vi.fn(async () => undefined),
  regenerateSpeechAudio: vi.fn(),
  resolveSpeechAudioId: () => 'audio',
  speechAudioId: () => 'audio',
}));
vi.mock('@openmaic/components/slide-renderer/components/element/ChartElement/Chart', () => ({
  Chart: ({ data, type }: { data: unknown; type: string }) => <output aria-label="图表数据预览">{JSON.stringify({ type, data })}</output>,
}));

import { useStageStore } from '@openmaic/lib/store/stage';
import { useSettingsStore } from '@openmaic/lib/store/settings';
import { ActionsBar } from './ActionsBar';
import { WhiteboardEditor } from './WhiteboardEditor';
import { appendWhiteboardBlock, whiteboardBlocks } from './whiteboard-edit';
import { resolveWhiteboardLine } from '@openmaic/lib/whiteboard/layout';

beforeEach(() => {
  useSettingsStore.setState({ ttsEnabled: false, selectedAgentIds: [] });
  useStageStore.setState({
    scenes: [
      {
        id: 'scene',
        type: 'slide',
        title: '观察与解释',
        actions: [{ id: 'intro', type: 'speech', text: '原有讲解' }],
        order: 0,
      } as Scene,
    ],
  });
  Element.prototype.scrollIntoView = vi.fn();
});

describe('teacher whiteboard authoring', () => {
  it('opens an editable board immediately, writes steps to the scene and reopens the same board', () => {
    render(<ActionsBar sceneId="scene" teacherPreparation />);
    fireEvent.click(screen.getByRole('button', { name: '添加白板' }));
    const dialog = screen.getByRole('dialog', { name: '编辑白板' });
    fireEvent.change(within(dialog).getByLabelText('板书内容'), {
      target: { value: '观察 → 证据 → 解释' },
    });
    fireEvent.change(within(dialog).getByLabelText('添加教学步骤'), {
      target: { value: 'speech' },
    });
    fireEvent.change(within(dialog).getByLabelText('AI 讲解内容'), {
      target: { value: '请先描述观察到的现象。' },
    });
    fireEvent.change(within(dialog).getByLabelText('添加教学步骤'), {
      target: { value: 'wb_draw_table' },
    });
    fireEvent.change(within(dialog).getByLabelText('第 1 行第 1 列'), {
      target: { value: '观察' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '完成编辑' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const actions = useStageStore.getState().getSceneById('scene')!.actions ?? [];
    expect(actions[0]).toMatchObject({ id: 'intro', text: '原有讲解' });
    const block = whiteboardBlocks(actions)[0];
    expect(block.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'wb_draw_text', content: '观察 → 证据 → 解释' }),
        expect.objectContaining({ type: 'speech', text: '请先描述观察到的现象。' }),
        expect.objectContaining({
          type: 'wb_draw_table',
          data: [
            ['观察', '观察与说明'],
            ['示例', '填写内容'],
          ],
        }),
      ]),
    );
    fireEvent.click(screen.getByRole('button', { name: '编辑白板内容与讲解' }));
    expect(screen.getByLabelText('板书内容')).toHaveValue('观察 → 证据 → 解释');
  });

  it('supports board undo/redo and preserves concurrent edits outside the board', () => {
    const scene = useStageStore.getState().getSceneById('scene')!;
    useStageStore
      .getState()
      .updateScene('scene', { actions: appendWhiteboardBlock(scene.actions ?? [], 'board') });
    render(<WhiteboardEditor sceneId="scene" boardId="board" onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('板书内容'), { target: { value: '新的板书' } });
    act(() => {
      const current = useStageStore.getState().getSceneById('scene')!;
      useStageStore
        .getState()
        .updateScene('scene', {
          actions: (current.actions ?? []).map((action) =>
            action.id === 'intro' ? { ...action, text: '并发修改的引言' } : action,
          ),
        });
    });
    fireEvent.click(screen.getByRole('button', { name: '撤销白板编辑' }));
    expect(screen.getByLabelText('板书内容')).toHaveValue('板书要点');
    fireEvent.click(screen.getByRole('button', { name: '重做白板编辑' }));
    expect(screen.getByLabelText('板书内容')).toHaveValue('新的板书');
    expect(useStageStore.getState().getSceneById('scene')!.actions?.[0]).toMatchObject({
      text: '并发修改的引言',
    });
  });

  it('sends a scoped teacher instruction to AI and does not send while AI is running', () => {
    const onEditWithAI = vi.fn();
    const onClose = vi.fn();
    const scene = useStageStore.getState().getSceneById('scene')!;
    useStageStore
      .getState()
      .updateScene('scene', { actions: appendWhiteboardBlock(scene.actions ?? [], 'board') });
    const view = render(
      <WhiteboardEditor
        sceneId="scene"
        boardId="board"
        onClose={onClose}
        onEditWithAI={onEditWithAI}
        aiRunning
      />,
    );
    fireEvent.change(screen.getByLabelText('白板 AI 修改要求'), {
      target: { value: '增加一张对比表格' },
    });
    expect(screen.getByRole('button', { name: /AI 正在编辑/ })).toBeDisabled();
    view.rerender(
      <WhiteboardEditor
        sceneId="scene"
        boardId="board"
        onClose={onClose}
        onEditWithAI={onEditWithAI}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '交给 AI 修改' }));
    expect(onEditWithAI).toHaveBeenCalledWith(expect.stringContaining('白板 ID：board'));
    expect(onEditWithAI).toHaveBeenCalledWith(expect.stringContaining('增加一张对比表格'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('edits chart data live and guards pie and scatter dimensions without dropping data', () => {
    render(<ActionsBar sceneId="scene" teacherPreparation />);
    fireEvent.click(screen.getByRole('button', { name: '添加白板' }));
    fireEvent.change(screen.getByLabelText('添加教学步骤'), { target: { value: 'wb_draw_chart' } });
    const chart = () => useStageStore.getState().getSceneById('scene')!.actions!.find((action) => action.type === 'wb_draw_chart')!;
    expect(within(screen.getByLabelText('图表类型')).getAllByRole('option')).toHaveLength(8);
    expect(screen.getByRole('option', { name: '饼图' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('数据项 1，系列 1 数值'), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText('数据项 1 名称'), { target: { value: '照明' } });
    expect(chart().data.series[0][0]).toBe(42);
    expect(screen.getByLabelText('图表数据预览')).toHaveTextContent('照明');
    expect(screen.getByLabelText('图表数据预览')).toHaveTextContent('42');
    fireEvent.click(screen.getByRole('button', { name: '添加数据项' }));
    fireEvent.click(screen.getByRole('button', { name: '添加系列' }));
    expect(chart().data.series).toHaveLength(3);
    expect(chart().data.series.every((series) => series.length === 4)).toBe(true);
    expect(screen.getByRole('option', { name: '散点图' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '删除末系列' }));
    fireEvent.change(screen.getByLabelText('图表类型'), { target: { value: 'scatter' } });
    expect(chart().data.series[0][0]).toBe(42);
    fireEvent.change(screen.getByLabelText('数据项 1，Y 数值'), { target: { value: '' } });
    expect(screen.getByLabelText('数据项 1，Y 数值')).toHaveValue(null);
    expect(chart().data.series[1][0]).toBe(10);
    fireEvent.change(screen.getByLabelText('数据项 1，Y 数值'), { target: { value: '-5' } });
    expect(chart().data.series[1][0]).toBe(-5);
    expect(screen.getByRole('button', { name: '添加系列' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除末系列' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('图表类型'), { target: { value: 'column' } });
    fireEvent.click(screen.getByRole('button', { name: '删除末系列' }));
    fireEvent.change(screen.getByLabelText('图表类型'), { target: { value: 'pie' } });
    expect(chart().chartType).toBe('pie');
    expect(chart().data.series).toHaveLength(1);
    expect(chart().data.series[0][0]).toBe(42);
    fireEvent.change(screen.getByLabelText('数据项 1，系列 1 数值'), { target: { value: '-1' } });
    expect(chart().data.series[0][0]).toBe(42);
  });

  it('moves future labels with their template node and edits anchored arrows with undoable deletion', () => {
    render(<ActionsBar sceneId="scene" teacherPreparation />);
    fireEvent.click(screen.getByRole('button', { name: '添加白板' }));
    fireEvent.change(screen.getByLabelText('以新页插入示例模板'), { target: { value: 'steps' } });
    const actions = () => useStageStore.getState().getSceneById('scene')!.actions!;
    const originalShape = actions().find((action) => action.type === 'wb_draw_shape')!;
    fireEvent.click(screen.getAllByRole('button', { name: /^步骤 \d+：图形$/ })[0]);
    fireEvent.change(screen.getByLabelText('左距 %'), { target: { value: '10' } });
    const shape = actions().find((action) => action.id === originalShape.id)!;
    const label = actions().find((action) => action.type === 'wb_draw_text' && action.groupId === originalShape.groupId)!;
    expect(shape).toMatchObject({ x: 100 });
    expect(label).toMatchObject({ x: 118 });
    const originalLine = actions().find((action) => action.type === 'wb_draw_line')!;
    expect(resolveWhiteboardLine(originalLine, actions()).startX).toBe(340);
    fireEvent.click(screen.getAllByRole('button', { name: /^步骤 \d+：连线与箭头$/ })[0]);
    expect(screen.getByLabelText('起点绑定')).toHaveValue(originalShape.elementId);
    fireEvent.change(screen.getByLabelText('起点连接位置'), { target: { value: 'bottom' } });
    fireEvent.change(screen.getByLabelText('箭头方向'), { target: { value: 'arrow|arrow' } });
    fireEvent.change(screen.getByLabelText('线条样式'), { target: { value: 'dashed' } });
    fireEvent.change(screen.getByLabelText('终点 X %'), { target: { value: '80' } });
    expect(actions().find((action) => action.id === originalLine.id)).toMatchObject({ startAnchor: { side: 'bottom' }, points: ['arrow', 'arrow'], style: 'dashed', endX: 800 });
    fireEvent.click(screen.getAllByRole('button', { name: /^步骤 \d+：图形$/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: '删除白板步骤' }));
    expect(actions().find((action) => action.id === originalLine.id)).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: '撤销白板编辑' }));
    expect(actions().find((action) => action.id === originalLine.id)).toBeDefined();
    expect(actions().find((action) => action.id === originalShape.id)).toMatchObject({ x: 100 });
  });

  it('keeps crowded content, adds pages explicitly and inserts editable formula steps', () => {
    const scene = useStageStore.getState().getSceneById('scene')!;
    const actions = appendWhiteboardBlock(scene.actions ?? [], 'board');
    actions.splice(actions.length - 1, 0, { id: 'full', type: 'wb_draw_shape', shape: 'rectangle', x: 0, y: 0, width: 1000, height: 562.5 });
    useStageStore.getState().updateScene('scene', { actions });
    render(<WhiteboardEditor sceneId="scene" boardId="board" onClose={vi.fn()} />);
    const steps = () => whiteboardBlocks(useStageStore.getState().getSceneById('scene')!.actions!)[0].steps;
    fireEvent.change(screen.getByLabelText('添加教学步骤'), { target: { value: 'wb_draw_chart' } });
    expect(steps().filter((action) => action.type === 'wb_clear')).toHaveLength(1);
    expect(steps().find((action) => action.id === 'full')).toBeDefined();
    expect(screen.getByText(/当前页空间有限/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '新建白板页' }));
    expect(steps().filter((action) => action.type === 'wb_clear')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('以新页插入示例模板'), { target: { value: 'derivation' } });
    expect(steps().filter((action) => action.type === 'wb_clear')).toHaveLength(3);
    fireEvent.click(screen.getAllByRole('button', { name: /^步骤 \d+：公式$/ })[0]);
    fireEvent.change(screen.getByLabelText('公式（LaTeX）'), { target: { value: '3x + 6 = 12' } });
    expect(steps().find((action) => action.type === 'wb_draw_latex')).toMatchObject({ latex: '3x + 6 = 12' });
    fireEvent.click(screen.getByRole('button', { name: '撤销白板编辑' }));
    expect(screen.getByLabelText('公式（LaTeX）')).toHaveValue('2x + 3 = 11');
  });

  it('repairs layout only on request and restores original positions with undo', () => {
    const scene = useStageStore.getState().getSceneById('scene')!;
    useStageStore.getState().updateScene('scene', { actions: appendWhiteboardBlock(scene.actions ?? [], 'board') });
    render(<WhiteboardEditor sceneId="scene" boardId="board" onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('上距 %'), { target: { value: '100' } });
    const text = () => useStageStore.getState().getSceneById('scene')!.actions!.find((action) => action.type === 'wb_draw_text')!;
    expect(text().y).toBe(562.5);
    expect(screen.getByText(/白板检查：/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '整理布局' }));
    expect(text().y + (text().height ?? 0)).toBeLessThanOrEqual(562.5);
    fireEvent.click(screen.getByRole('button', { name: '撤销白板编辑' }));
    expect(text().y).toBe(562.5);
  });
});

describe('teacher laser route authoring', () => {
  it('shows every laser stop and saves an added timed waypoint through the route dialog', () => {
    useStageStore.setState({ scenes: [{
      id: 'scene', stageId: 'stage', type: 'slide', title: '流程', order: 0,
      content: { type: 'slide', canvas: {
        id: 'canvas', viewportSize: 1000, viewportRatio: 0.5625,
        theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: 'Arial' },
        elements: [
          { id: 'diagram', type: 'shape', name: '图示' },
          { id: 'formula', type: 'shape', name: '公式' },
          { id: 'result', type: 'shape', name: '结果' },
        ],
      } },
      actions: [
        { id: 'path', type: 'laser', elementId: 'diagram', speechId: 'speech', speechOffsetMs: 0, waypoints: [{ elementId: 'formula', speechOffsetMs: 1200 }] },
        { id: 'speech', type: 'speech', text: '先看图示，再看公式，最后得到结果。' },
      ],
    } as unknown as Scene] });

    render(<ActionsBar sceneId="scene" teacherPreparation />);
    expect(screen.getByText('激光滑动 · 2 个目标')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '编辑路径与触发' }));
    const dialog = screen.getByRole('dialog', { name: '编辑激光路径' });
    expect(within(dialog).getByLabelText('激光滑动顺序')).toHaveTextContent('图示');
    expect(within(dialog).getByLabelText('激光滑动顺序')).toHaveTextContent('公式');
    fireEvent.click(within(dialog).getByRole('button', { name: '添加途经元素' }));
    expect(within(dialog).getByLabelText('激光滑动顺序')).toHaveTextContent('结果');
    fireEvent.click(within(dialog).getByRole('button', { name: '应用路径' }));

    const actions = useStageStore.getState().getSceneById('scene')!.actions ?? [];
    expect(actions[0]).toMatchObject({
      type: 'laser', elementId: 'diagram',
      waypoints: [{ elementId: 'formula', speechOffsetMs: 1200 }, { elementId: 'result', speechOffsetMs: 2400 }],
    });
    expect(screen.getByText('激光滑动 · 3 个目标')).toBeInTheDocument();
  });
});
