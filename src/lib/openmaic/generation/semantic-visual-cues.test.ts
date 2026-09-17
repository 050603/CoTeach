import { describe, expect, it, vi } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import type { Action } from '@openmaic/lib/types/action';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { generateSceneActions } from './scene-generator';
import {
  buildSlideTargetInventory,
  calibrateGeneratedVisualCues,
} from './semantic-visual-cues';

const outline: SceneOutline = {
  id: 'semantic-page', type: 'slide', title: '学段与项目化学习',
  description: '比较不同学段并介绍 PBL。', keyPoints: ['小学低代码', 'PBL'], order: 0,
};

const elements = [
  {
    id: 'stage-table', type: 'table', left: 50, top: 100, width: 600, height: 280,
    outline: {}, colWidths: [0.25, 0.75], cellMinHeight: 40,
    data: [
      [
        { id: 'header-stage', colspan: 1, rowspan: 1, text: '学段' },
        { id: 'header-form', colspan: 1, rowspan: 1, text: '适配内容形态' },
      ],
      [
        { id: 'primary-stage', colspan: 1, rowspan: 2, text: '小学' },
        { id: 'primary-form', colspan: 1, rowspan: 1, text: '<b>图形化编程、机器人体验等低代码</b>' },
      ],
      [{ id: 'middle-form', colspan: 1, rowspan: 1, text: '中学：理解智能系统机制' }],
    ],
  },
  {
    id: 'pbl-title', type: 'text', left: 690, top: 120, width: 250, height: 100,
    content: '<p>项目式学习 <span>PBL</span>，也常缩写为 <strong>P</strong><em>BL</em></p>',
    defaultFontName: 'Microsoft YaHei', defaultColor: '#111111',
  },
] as PPTElement[];

type RuntimeCue = Extract<Action, { type: 'spotlight' | 'laser' }> & {
  necessity?: string;
  omissionRisk?: string;
};

function speech(id: string, text: string): Action {
  return { id, type: 'speech', text };
}

function cue(
  id: string,
  speechId: string,
  elementId: string,
  overrides: Partial<RuntimeCue> = {},
): Action {
  return {
    id,
    type: 'spotlight',
    elementId,
    speechId,
    endSpeechId: speechId,
    necessity: 'essential',
    omissionRisk: `省略 ${elementId} 会造成视觉歧义`,
    ...overrides,
  } as Action;
}

function visualActions(actions: readonly Action[]): RuntimeCue[] {
  return actions.filter((action): action is RuntimeCue => (
    action.type === 'spotlight' || action.type === 'laser'
  ));
}

function calibrate(actions: Action[], pageElements: PPTElement[] = elements): Action[] {
  return calibrateGeneratedVisualCues({ outline, elements: pageElements, actions });
}

describe('OpenMAIC interleaved visual cue calibration', () => {
  it('binds a cue to the next narration and drops an invalid target without fallback', () => {
    const narration = speech('s1', '小学采用低代码工具。');
    const result = calibrate([
      { id: 'bad', type: 'spotlight', elementId: 'missing' } as Action,
      {
        id: 'cell', type: 'spotlight', elementId: 'stage-table',
        selector: { cellId: 'primary-form' }, necessity: 'essential',
      } as Action,
      narration,
    ]);

    expect(result).toEqual([
      expect.objectContaining({
        id: 'cell', type: 'spotlight', speechId: 's1', endSpeechId: 's1',
        selector: { cellId: 'primary-form' },
      }),
      narration,
    ]);
  });

  it('publishes full text plus merged-cell row and column context', () => {
    const inventory = buildSlideTargetInventory(elements);
    const table = inventory.find((item) => item.elementId === 'stage-table');
    const primaryForm = table?.table?.rows[1].cells[1];

    expect(table?.visibleText).toContain('图形化编程、机器人体验等低代码');
    expect(primaryForm).toMatchObject({
      cellId: 'primary-form', rowIndex: 1, columnIndex: 1,
      rowHeader: '小学', columnHeader: '适配内容形态',
      rowContext: ['小学', '图形化编程、机器人体验等低代码'],
    });
    expect(primaryForm?.columnContext).toEqual([
      '适配内容形态', '图形化编程、机器人体验等低代码', '中学：理解智能系统机制',
    ]);
    expect(table?.table?.rows[2].cells[0]).toMatchObject({
      cellId: 'middle-form', columnIndex: 1, rowHeader: '小学', columnHeader: '适配内容形态',
    });
    expect(inventory.find((item) => item.elementId === 'pbl-title')?.visibleText)
      .toBe('项目式学习 PBL，也常缩写为 PBL');
  });

  it('derives multiple cue offsets from phrases in one unsplit narration paragraph', () => {
    const narration = speech(
      's1',
      '项目式学习常缩写成PBL。它的三个核心特征是成果导向、真实受众和跨学科整合。',
    );
    const result = calibrate([
      cue('pbl', 's1', 'pbl-title', {
        type: 'laser', selector: { quote: 'PBL' },
      }),
      cue('features', 's1', 'stage-table', {
        selector: { cellId: 'primary-form' },
        speechAnchor: { quote: '三个核心特征' },
      }),
      narration,
    ]);

    expect(result.filter((action) => action.type === 'speech')).toEqual([narration]);
    expect(visualActions(result)).toHaveLength(2);
    expect(visualActions(result)[1]).toMatchObject({
      id: 'features', speechId: 's1', speechOffsetMs: expect.any(Number),
    });
    expect(visualActions(result)[1].speechOffsetMs).toBeGreaterThan(0);
  });

  it('merges adjacent same-target spotlight intervals', () => {
    const s1 = speech('s1', '先观察小学学段。');
    const s2 = speech('s2', '再看内容形态。');
    const s3 = speech('s3', '归纳适配方式。');
    const result = calibrate([
      cue('c1', 's1', 'stage-table', { selector: { cellId: 'primary-form' } }),
      s1,
      cue('c2', 's2', 'stage-table', {
        selector: { cellId: 'primary-form' }, endSpeechId: 's3',
      }),
      s2,
      s3,
    ]);

    expect(visualActions(result)).toHaveLength(1);
    expect(visualActions(result)[0]).toMatchObject({ speechId: 's1', endSpeechId: 's3' });
    expect(result.filter((action) => action.type === 'speech')).toEqual([s1, s2, s3]);
  });

  it('caps the page at eight cues and lasers at two', () => {
    const pageElements = Array.from({ length: 10 }, (_unused, index) => ({
      id: `element-${index}`, type: 'text', left: index * 20, top: 50, width: 100, height: 40,
      content: `<p>目标${index}</p>`, defaultFontName: 'Microsoft YaHei', defaultColor: '#111111',
    })) as PPTElement[];
    const actions = Array.from({ length: 10 }, (_unused, index) => [
      cue(`c${index}`, `s${index}`, `element-${index}`, {
        type: index < 4 ? 'laser' : 'spotlight',
      }),
      speech(`s${index}`, `第${index + 1}部分，${'这是用于稳定时长估算的完整讲解内容。'.repeat(4)}`),
    ]).flat();
    const result = calibrate(actions, pageElements);

    expect(visualActions(result)).toHaveLength(8);
    expect(visualActions(result).filter((action) => action.type === 'laser')).toHaveLength(2);
    expect(result.filter((action) => action.type === 'speech')).toHaveLength(10);
  });

  it('enforces spacing and suppresses A-B-A target bounce', () => {
    const close = calibrate([
      cue('a', 's1', 'stage-table', { necessity: 'helpful' } as Partial<RuntimeCue>),
      speech('s1', '先看第一个目标。'),
      cue('b', 's2', 'pbl-title', { necessity: 'helpful' } as Partial<RuntimeCue>),
      speech('s2', '马上切换到另一个目标。'),
    ]);
    expect(visualActions(close)).toHaveLength(1);

    const longText = '这是一段足够长的讲解，用来确保相邻提示不会被十秒间隔提前移除。'.repeat(4);
    const bounced = calibrate([
      cue('a1', 'l1', 'stage-table'), speech('l1', longText),
      cue('b1', 'l2', 'pbl-title', { necessity: 'helpful' } as Partial<RuntimeCue>), speech('l2', longText),
      cue('a2', 'l3', 'stage-table'), speech('l3', longText),
    ]);
    expect(visualActions(bounced)).toHaveLength(1);
    expect(visualActions(bounced)[0]).toMatchObject({
      elementId: 'stage-table', speechId: 'l1', endSpeechId: 'l3',
    });
  });

  it('prefers a precise selector and verifies quote evidence inside a cell', () => {
    const narration = speech('s1', '小学采用低代码。');
    const result = calibrate([
      cue('whole', 's1', 'stage-table'),
      cue('cell', 's1', 'stage-table', { selector: { cellId: 'primary-form' } }),
      narration,
    ]);
    expect(visualActions(result)).toHaveLength(1);
    expect(visualActions(result)[0]).toMatchObject({ selector: { cellId: 'primary-form' } });

    const invalid = calibrate([
      cue('wrong', 's1', 'stage-table', {
        type: 'laser', selector: { cellId: 'header-stage', quote: '低代码' },
      }),
      narration,
    ]);
    expect(invalid).toEqual([narration]);
  });

  it('rejects an interval crossing a nonvisual playback boundary', () => {
    const before = speech('before', '先看页面。');
    const after = speech('after', '然后继续讲解。');
    const video = { id: 'video', type: 'play_video', elementId: 'video-1' } as Action;
    const result = calibrate([
      cue('range', 'before', 'pbl-title', { endSpeechId: 'after' }),
      before,
      video,
      after,
    ]);
    expect(result).toEqual([before, video, after]);
  });

  it('requires every target in a laser sweep to be verifiable', () => {
    const narration = speech('s1', '依次观察两个节点。');
    expect(calibrate([
      cue('path', 's1', 'pbl-title', {
        type: 'laser', waypoints: [{ elementId: 'missing' }],
      }),
      narration,
    ])).toEqual([narration]);
  });

  it('optimizes cues inside the original OpenMAIC interleaved action call', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      {
        type: 'action',
        name: 'laser',
        params: {
          elementId: 'pbl-title',
          selector: { quote: 'PBL', occurrence: 1 },
          necessity: 'essential',
          omissionRisk: '需要把缩写映射到页面文字',
        },
      },
      { type: 'text', content: 'PBL常缩写为PBL。' },
    ]));

    const result = await generateSceneActions(outline, { elements }, ai);

    expect(ai).toHaveBeenCalledTimes(1);
    expect(ai.mock.calls[0][0]).toContain('# Slide Action Generator');
    expect(ai.mock.calls[0][0]).toContain('Judge necessity before choosing a target or action');
    expect(ai.mock.calls[0][0]).toContain('speechAnchor');
    expect(result.map((action) => action.type)).toEqual(['laser', 'speech']);
    expect(visualActions(result)[0]).toMatchObject({
      selector: { quote: 'PBL', occurrence: 1 },
      speechId: expect.any(String),
    });
  });
});
