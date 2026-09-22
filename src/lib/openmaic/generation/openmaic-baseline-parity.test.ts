import { describe, expect, it, vi } from 'vitest';
import type { AICallFn } from './pipeline-types';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import {
  extractWidgetConfig,
  generateSceneActions,
  generateSceneContent,
  generateWidgetContent,
} from './scene-generator';

function interactiveOutline(overrides: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id: 'interactive-1',
    type: 'interactive',
    title: '系统关系图',
    description: '比较系统中的关键路径',
    keyPoints: ['根节点', '分支节点'],
    order: 0,
    widgetType: 'diagram',
    widgetOutline: { diagramType: 'hierarchy' },
    ...overrides,
  };
}

describe('current OpenMAIC generation baseline parity', () => {
  it('injects and validates the player completion/reset contract in the production interactive path', async () => {
    let capturedPrompt = '';
    const generated = await generateSceneContent(interactiveOutline(), async (_system, user) => {
      capturedPrompt = user;
      return `<html><body>
        <input id="choice" type="range" />
        <button data-activity-complete onclick="finish()">完成比较</button>
        <button data-activity-reset onclick="resetAll()">重置</button>
        <script>
          const observations = new Set();
          function finish() { observations.add('compared'); window.__maicActivity.complete(); }
          function resetAll() { observations.clear(); window.__maicActivity.reset(); }
        </script>
      </body></html>`;
    });

    expect(capturedPrompt).toContain('window.__maicActivity.complete()');
    expect(capturedPrompt).toContain('window.__maicActivity.reset()');
    expect(capturedPrompt).toContain('bounded safety timeout');
    expect(generated).toMatchObject({ html: expect.stringContaining('data-activity-complete') });
  });

  it('rejects a production interaction that cannot reset the player activity state', async () => {
    const generated = await generateSceneContent(interactiveOutline(), async () => `
      <html><body><input type="range" /><script>
        const observations = new Set();
        function finish() { window.__maicActivity.complete(); }
      </script></body></html>
    `);

    expect(generated).toBeNull();
  });

  it('audits a legacy interaction through the deterministic simulation fallback', async () => {
    const generated = await generateSceneContent(interactiveOutline({
      widgetType: undefined,
      widgetOutline: undefined,
      interactiveConfig: undefined,
    }), async () => `
      <html><body><input type="range" /><script>
        const observations = new Set();
        function finish() { window.__maicActivity.complete(); }
        function resetAll() { observations.clear(); window.__maicActivity.reset(); }
      </script></body></html>
    `);

    expect(generated).toMatchObject({ widgetType: 'simulation' });
  });

  it('forwards diagram count and prescribed-node constraints into generation', async () => {
    let capturedPrompt = '';
    const aiCall: AICallFn = async (system, user) => {
      capturedPrompt = `${system}\n${user}`;
      return '<html><body><script type="application/json" id="widget-config">{"nodes":[]}</script></body></html>';
    };

    await generateWidgetContent(interactiveOutline({
      widgetOutline: {
        diagramType: 'hierarchy',
        nodeCount: 3,
        nodes: [
          { id: 'root', label: 'Root' },
          { id: 'branch', label: 'Branch', parentId: 'root' },
        ],
      },
    }), aiCall);

    expect(capturedPrompt).toContain('Maximum node count: 3');
    expect(capturedPrompt).toContain('"id": "root"');
    expect(capturedPrompt).toContain('"parentId": "root"');
    expect(capturedPrompt).toContain('Do not add, remove, or replace prescribed nodes');
    expect(capturedPrompt).not.toContain('{{');
  });

  it('normalizes widget config objects and seeds a missing routed type', () => {
    const html = (json: string) =>
      `<script type="application/json" id="widget-config">${json}</script>`;

    expect(extractWidgetConfig(html('{"nodes":[]}'), 'diagram')).toEqual({
      type: 'diagram',
      nodes: [],
    });
    expect(extractWidgetConfig(html('[]'), 'diagram')).toBeUndefined();
  });

  it('feeds generated HTML selectors into the interactive action prompt', async () => {
    let capturedPrompt = '';
    await generateSceneActions(
      interactiveOutline({ widgetType: 'game', widgetOutline: { gameType: 'strategy' } }),
      {
        html: '<div id="game-root"><button id="start-btn">Start</button><div id="result-card" class="outcome"></div></div>',
        widgetType: 'game',
      },
      async (_system, user) => {
        capturedPrompt = user;
        return JSON.stringify([{ type: 'text', content: '点击开始查看结果。' }]);
      },
    );

    expect(capturedPrompt).toContain('Element Inventory');
    expect(capturedPrompt).toContain('#start-btn');
    expect(capturedPrompt).toContain('#result-card');
    expect(capturedPrompt).toContain('.outcome');
    expect(capturedPrompt).not.toContain('(no interactive elements detected)');
  });

  it('uses the DSL normalizer for malformed model-generated PPT elements', async () => {
    const first = {
      elements: [
        {
          type: 'line', left: 100, top: 80, width: 240, height: 0,
          start: null, end: null, points: null, style: null, color: null,
        },
        {
          type: 'text', left: 100, top: 100, width: 500, height: 80,
          content: '变量变化与结果之间的关系', defaultFontName: null, defaultColor: null,
        },
      ],
    };
    const repaired = { elements: first.elements.slice(0, 2) };
    const ai = vi.fn().mockResolvedValueOnce(JSON.stringify(first)).mockResolvedValueOnce(JSON.stringify(repaired));
    const content = await generateSceneContent({
      id: 'slide-1',
      type: 'slide',
      title: '变量关系',
      description: '显示变量关系',
      keyPoints: ['变量关系'],
      order: 0,
    }, ai);

    expect(content).not.toBeNull();
    if (!content || !('elements' in content)) throw new Error('expected slide content');
    expect(content.elements).toHaveLength(2);
    expect(content.elements[0]).toMatchObject({
      type: 'line',
      start: [0, 0],
      end: [240, 0],
      points: ['', ''],
      style: 'solid',
    });
    expect(ai).toHaveBeenCalledOnce();
  });
});
