import { describe, expect, it, vi } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import type { Action } from '@openmaic/lib/types/action';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { generateSceneActions } from './scene-generator';
import {
  buildSlideTargetInventory,
  calibrateGeneratedVisualCues,
  refineVisualCueDesign,
  recoverLegacyVisualCueAnchors,
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
  return {
    id,
    type: 'speech',
    text,
    speechAlignment: {
      version: 'test-v1',
      status: 'aligned',
      textHash: 'text',
      audioHash: 'audio',
      spans: Array.from(text, (character, index) => ({
        text: character,
        startChar: index,
        endChar: index + 1,
        startMs: index * 100,
        endMs: (index + 1) * 100,
      })),
    },
  };
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

  it('moves focus from an animal example to the definition inside one sentence', () => {
    const pageElements = [
      {
        id: 'animal-example', type: 'text', left: 60, top: 150, width: 420, height: 180,
        content: '<p>小鱼：牛是在地上吃草的大鱼<br>青蛙：牛是不会跳的大青蛙</p>',
        defaultFontName: 'Microsoft YaHei', defaultColor: '#111111',
      },
      {
        id: 'accommodation-definition', type: 'text', left: 540, top: 150, width: 400, height: 180,
        content: '<p>顺应：调整原有认知结构，形成新的认识</p>',
        defaultFontName: 'Microsoft YaHei', defaultColor: '#111111',
      },
    ] as PPTElement[];
    const text = '小鱼、青蛙看到牛时，会先用自己熟悉的样子去理解它，接着看顺应的定义：顺应是调整原有认知结构，形成新的认识。然后我们再思考它为什么必要。';
    const narration = speech('s1', text);
    const result = calibrate([
      cue('focus-example', 's1', 'animal-example', {
        speechAnchor: { quote: '小鱼、青蛙看到牛时' },
      }),
      cue('focus-definition', 's1', 'accommodation-definition', {
        speechAnchor: { quote: '顺应的定义' },
      }),
      narration,
    ], pageElements);

    const [exampleCue, definitionCue] = visualActions(result);
    expect(exampleCue).toMatchObject({
      id: 'focus-example', elementId: 'animal-example',
      speechAnchor: { quote: '小鱼、青蛙看到牛时' },
    });
    expect(definitionCue).toMatchObject({
      id: 'focus-definition', elementId: 'accommodation-definition',
      speechAnchor: { quote: '顺应的定义' },
    });
    expect(exampleCue.endSpeechOffsetMs).toBe(definitionCue.speechOffsetMs);
    expect(definitionCue.endSpeechOffsetMs).toBe((text.indexOf('。') + 1) * 100);
  });

  it('uses forced-alignment timestamps instead of proportional text duration', () => {
    const text = '先说明前提。然后观察三个核心特征。';
    const narration = speech('s1', text);
    const result = calibrate([
      cue('features', 's1', 'stage-table', {
        selector: { cellId: 'primary-form' },
        speechAnchor: { quote: '三个核心特征' },
      }),
      narration,
    ]);
    expect(visualActions(result)[0].speechOffsetMs)
      .toBe(text.indexOf('三个核心特征') * 100);
    expect(visualActions(result)[0].endSpeechOffsetMs).toBe(text.length * 100);
  });

  it('preserves anchored intent until alignment is available, then calibrates it', () => {
    const narration = { id: 's1', type: 'speech' as const, text: '先说明，再观察目标。' };
    const result = calibrate([
      cue('target', 's1', 'pbl-title', { speechAnchor: { quote: '观察目标' } }),
      narration,
    ]);
    expect(visualActions(result)).toHaveLength(1);
    expect(visualActions(result)[0]).not.toHaveProperty('speechOffsetMs');
    const aligned = calibrate(result.map((action) => action.type === 'speech'
      ? speech(action.id, action.text) : action));
    expect(visualActions(aligned)).toHaveLength(1);
    expect(visualActions(aligned)[0]).toMatchObject({ id: 'target', speechOffsetMs: narration.text.indexOf('观察目标') * 100 });
  });

  it('drops a cue whose explicit end anchor is stale instead of guessing an end', () => {
    const narration = speech('s1', '先观察PBL，再解释它的特征。');
    const result = calibrate([
      cue('stale-end', 's1', 'pbl-title', {
        speechAnchor: { quote: '观察PBL' },
        endSpeechAnchor: { quote: '不存在的结束语' },
      }),
      narration,
    ]);

    expect(visualActions(result)).toEqual([]);
    expect(result).toEqual([narration]);
  });

  it('assigns independent aligned offsets to laser waypoints', () => {
    const text = '先看PBL，再看小学，最后看低代码。';
    const narration = speech('s1', text);
    const result = calibrate([
      cue('path', 's1', 'pbl-title', {
        type: 'laser',
        speechAnchor: { quote: 'PBL' },
        waypoints: [{
          elementId: 'stage-table',
          selector: { cellId: 'primary-stage' },
          speechAnchor: { quote: '小学' },
        }, {
          elementId: 'stage-table',
          selector: { cellId: 'primary-form', quote: '低代码' },
          speechAnchor: { quote: '低代码' },
        }],
      }),
      narration,
    ]);
    const laser = visualActions(result)[0];
    expect(laser.type).toBe('laser');
    if (laser.type !== 'laser') throw new Error('expected laser');
    expect(laser.waypoints?.map((waypoint) => waypoint.speechOffsetMs)).toEqual([
      text.indexOf('小学') * 100,
      text.indexOf('低代码') * 100,
    ]);
  });

  it('uses separately timed spotlights for ordinary text comparisons', () => {
    const comparisonElements = [
      {
        id: 'first', type: 'text', left: 80, top: 180, width: 360, height: 80,
        content: '<p>第一种课堂结构</p>', defaultFontName: 'Microsoft YaHei', defaultColor: '#111111',
      },
      {
        id: 'second', type: 'text', left: 520, top: 180, width: 360, height: 80,
        content: '<p>第二种课堂结构</p>', defaultFontName: 'Microsoft YaHei', defaultColor: '#111111',
      },
    ] as PPTElement[];
    const result = refineVisualCueDesign({
      elements: comparisonElements,
      actions: [
        {
          id: 'comparison', type: 'laser', elementId: 'first', speechId: 's1',
          speechAnchor: { quote: '第一节' },
          waypoints: [{ elementId: 'second', speechAnchor: { quote: '第二节' } }],
        },
        speech('s1', '第一节由教师讲解；第二节由学生合作完成。'),
      ],
    });
    expect(visualActions(result)).toEqual([
      expect.objectContaining({ type: 'spotlight', elementId: 'first', speechAnchor: { quote: '第一节' } }),
      expect.objectContaining({ type: 'spotlight', elementId: 'second', speechAnchor: { quote: '第二节' } }),
    ]);
  });

  it('adds one whole-row spotlight for each table concept at its first explanation', () => {
    const table = {
      id: 'levels', type: 'table', left: 60, top: 180, width: 880, height: 180,
      outline: {}, colWidths: [0.2, 0.8], cellMinHeight: 40,
      data: [
        [
          { id: 'h1', colspan: 1, rowspan: 1, text: '层级' },
          { id: 'h2', colspan: 1, rowspan: 1, text: '定义与作用' },
        ],
        [
          { id: 'r1a', colspan: 1, rowspan: 1, text: '教学理论' },
          { id: 'r1b', colspan: 1, rowspan: 1, text: '回答普遍原则' },
        ],
        [
          { id: 'r2a', colspan: 1, rowspan: 1, text: '教学模式' },
          { id: 'r2b', colspan: 1, rowspan: 1, text: '形成固定结构' },
        ],
        [
          { id: 'r3a', colspan: 1, rowspan: 1, text: '教学方法' },
          { id: 'r3b', colspan: 1, rowspan: 1, text: '具体技巧手段' },
        ],
      ],
    } as PPTElement;
    const result = refineVisualCueDesign({
      elements: [table],
      actions: [
        { id: 'broad', type: 'spotlight', elementId: 'levels', speechId: 's2' },
        speech('s1', '教学理论最稳定。教学模式有固定结构。'),
        speech('s2', '教学方法最灵活。按标准归类时，教学理论、教学模式和教学方法要分开。'),
      ],
    });
    expect(visualActions(result).map((action) => action.selector)).toEqual([
      { rowIndex: 1 },
      { rowIndex: 2 },
      { rowIndex: 3 },
    ]);
    expect(visualActions(result).map((action) => action.speechId)).toEqual(['s1', 's1', 's2']);
  });

  it('synthesizes a timed laser path only for an explicit ordered process', () => {
    const processElements = ['教学理论', '教学模式', '教学方法'].map((label, index) => ({
      id: `step-${index + 1}`, type: 'text', left: 80 + index * 280, top: 300, width: 160, height: 50,
      content: `<p>${label}</p>`, defaultFontName: 'Microsoft YaHei', defaultColor: '#111111',
    })) as PPTElement[];
    const narration = speech('s1', '顺序是先定理论、再选模式、最后用方法。');
    const refined = refineVisualCueDesign({ elements: processElements, actions: [narration] });
    expect(visualActions(refined)).toEqual([
      expect.objectContaining({
        type: 'laser', elementId: 'step-1', speechAnchor: { quote: '理论', occurrence: 0 },
        waypoints: [
          expect.objectContaining({ elementId: 'step-2', speechAnchor: { quote: '模式', occurrence: 0 } }),
          expect.objectContaining({ elementId: 'step-3', speechAnchor: { quote: '方法', occurrence: 0 } }),
        ],
      }),
    ]);
  });

  it('recovers old cue anchors from fixed narration and actual target text', () => {
    const result = recoverLegacyVisualCueAnchors({
      elements,
      actions: [
        cue('path', 's1', 'pbl-title', {
          type: 'laser',
          selector: { quote: 'PBL' },
          speechAnchor: undefined,
          waypoints: [{
            elementId: 'stage-table',
            selector: { cellId: 'primary-stage' },
          }, {
            elementId: 'stage-table',
            selector: { cellId: 'primary-form', quote: '低代码' },
          }],
        }),
        speech('s1', '先看PBL，再看小学，最后看低代码。'),
      ],
    });
    expect(result.issues).toEqual([]);
    expect(visualActions(result.actions)[0]).toMatchObject({
      speechAnchor: { quote: 'PBL', occurrence: 0 },
      waypoints: [
        { speechAnchor: { quote: '小学', occurrence: 0 } },
        { speechAnchor: { quote: '低代码', occurrence: 0 } },
      ],
    });
  });

  it('removes an old cue when page evidence cannot map to the fixed script', () => {
    const narration = speech('s1', '这一段只讨论完全不同的内容。');
    const result = recoverLegacyVisualCueAnchors({
      elements,
      actions: [cue('stale', 's1', 'pbl-title'), narration],
    });
    expect(result.actions).toEqual([narration]);
    expect(result.issues[0]).toMatchObject({ actionId: 'stale', speechId: 's1' });
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

  it('does not extend an earlier spotlight across speech before a later anchored return', () => {
    const first = speech('s1', '先说明判断依据，再观察小学学段。');
    const second = speech('s2', '完成推理以后，再次回到小学学段。');
    const result = calibrate([
      cue('c1', 's1', 'stage-table', {
        selector: { cellId: 'primary-stage' }, speechAnchor: { quote: '观察小学学段' },
      }),
      first,
      cue('c2', 's2', 'stage-table', {
        selector: { cellId: 'primary-stage' }, speechAnchor: { quote: '再次回到小学学段' },
      }),
      second,
    ]);

    expect(visualActions(result)).toHaveLength(2);
    expect(visualActions(result)[1].speechOffsetMs).toBeGreaterThan(0);
  });

  it('keeps a later return to the same target inside one narration paragraph', () => {
    const narration = speech('s1', '第一次观察小学。先比较其他证据。再次观察小学。');
    const result = calibrate([
      cue('first', 's1', 'stage-table', {
        selector: { cellId: 'primary-stage' }, speechAnchor: { quote: '第一次观察小学' },
      }),
      cue('return', 's1', 'stage-table', {
        selector: { cellId: 'primary-stage' }, speechAnchor: { quote: '再次观察小学' },
      }),
      narration,
    ]);
    expect(visualActions(result).map((action) => action.id)).toEqual(['first', 'return']);
    expect(visualActions(result)[0].endSpeechOffsetMs)
      .toBeLessThan(visualActions(result)[1].speechOffsetMs ?? 0);
  });

  it('preserves the authored cue count while replacing text-covering lasers with frames', () => {
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

    expect(visualActions(result)).toHaveLength(10);
    expect(visualActions(result).filter((action) => action.type === 'laser')).toHaveLength(0);
    expect(visualActions(result).every((action) => action.type === 'spotlight')).toBe(true);
    expect(result.filter((action) => action.type === 'speech')).toHaveLength(10);
  });

  it('preserves close target changes and later returns to a prior object', () => {
    const close = calibrate([
      cue('a', 's1', 'stage-table', { necessity: 'helpful' } as Partial<RuntimeCue>),
      speech('s1', '先看第一个目标。'),
      cue('b', 's2', 'pbl-title', { necessity: 'helpful' } as Partial<RuntimeCue>),
      speech('s2', '马上切换到另一个目标。'),
    ]);
    expect(visualActions(close)).toHaveLength(2);

    const longText = '这是一段足够长的讲解，用来确保相邻提示不会被十秒间隔提前移除。'.repeat(4);
    const bounced = calibrate([
      cue('a1', 'l1', 'stage-table'), speech('l1', longText),
      cue('b1', 'l2', 'pbl-title', { necessity: 'helpful' } as Partial<RuntimeCue>), speech('l2', longText),
      cue('a2', 'l3', 'stage-table'), speech('l3', longText),
    ]);
    expect(visualActions(bounced)).toHaveLength(3);
    expect(visualActions(bounced).map((action) => action.elementId))
      .toEqual(['stage-table', 'pbl-title', 'stage-table']);
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
    expect(visualActions(invalid)).toEqual([
      expect.objectContaining({ type: 'spotlight', selector: { rowIndex: 1 } }),
    ]);
    expect(invalid.at(-1)).toEqual(narration);
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
    expect(result.map((action) => action.type)).toEqual(['spotlight', 'speech']);
    expect(visualActions(result)[0]).toMatchObject({
      type: 'spotlight',
      selector: { quote: 'PBL', occurrence: 1 },
      speechId: expect.any(String),
    });
  });
});
