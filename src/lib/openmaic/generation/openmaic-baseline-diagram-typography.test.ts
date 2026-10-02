import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '../types/generation';

const mocks = vi.hoisted(() => ({ teaching: vi.fn(), projection: vi.fn(), visual: vi.fn(), infographic: vi.fn(), original: vi.fn() }));
vi.mock('./teaching-visual-scene', () => ({ usesTeachingVisualScene: () => true, generateTeachingVisualScene: mocks.teaching }));
vi.mock('./teaching-visual-compiler', () => ({ compileTeachingVisualScene: mocks.visual }));
vi.mock('./slide-visual-projection', async (original) => ({ ...await original<object>(),
  usesSlideVisualProjection: () => true, generateSlideVisualProjection: mocks.projection }));
vi.mock('./slide-infographic-layout', () => ({ compileSlideInfographic: mocks.infographic, compileOriginalSlideDraft: mocks.original }));

import { generateOpenMaicBaselineContent } from './openmaic-baseline';
import { TEACHING_VISUAL_THEME as T } from './teaching-visual-theme';

const outline: SceneOutline = { id: 'page', title: '判断撤除时机', description: '保留必要条件', type: 'slide', order: 0,
  audience: 'student', generationPurpose: 'knowledge-teaching', keyPoints: ['能独立完成时才逐个撤除支持'],
  visualIntent: { representation: 'native-diagram', observationGoal: '观察条件', diagram: { topology: 'branch',
    nodes: [{ id: 'condition', label: '能独立完成吗' }, { id: 'withdraw', label: '逐个撤除支持' }],
    edges: [{ from: 'condition', to: 'withdraw', label: '能独立完成' }] } } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.teaching.mockImplementation(async (_outline, call) => {
    await call('single teaching scene request', 'source catalog');
    return { diagnostics: [], scene: { schemaVersion: 1, designVersion: 'teaching-visual-v2', pages: [{
      id: outline.id, title: outline.title, focus: '判断支持的撤除条件', components: [{ id: 'condition', kind: 'text', role: 'primary',
        nodes: [{ id: 'condition-fact', text: outline.keyPoints[0], sourceContentIds: ['adopted-content-1'] }] }],
    }] } };
  });
  mocks.projection.mockImplementation(async (_outline, call) => {
    await call('single legacy projection request', 'source catalog');
    return { diagnostics: [], projection: { schemaVersion: 1, layoutVersion: 'teaching-infographic-v1', verified: true,
      items: [{ id: 'content', text: outline.keyPoints[0], sourceContentIds: ['source'] }], elementIdsBySource: {} } };
  });
  mocks.visual.mockResolvedValue(null);
  mocks.infographic.mockResolvedValue(null);
  mocks.original.mockResolvedValue({ elements: [{ id: 'original-native', type: 'text', left: 50, top: 50, width: 800, height: 80,
    rotate: 0, defaultFontName: 'Noto Sans SC', defaultColor: '#334155', content: '<p>能独立完成时才逐个撤除支持</p>' }],
    qualityDiagnostics: ['Original diagram retained with honest capacity diagnostics'] });
});

describe('teaching graph fallback adapter typography', () => {
  it('explicitly applies the teaching minimum once without a second authoring call', async () => {
    const call = vi.fn().mockResolvedValue('single source-grounded response');
    const result = await generateOpenMaicBaselineContent(outline, call, { visualProjection: true, teachingVisual: true,
      componentAuthoring: true, textMeasure: () => ({ naturalWidth: 100, height: 40, lines: [] }) });
    expect(call).toHaveBeenCalledTimes(1);
    expect(mocks.original).toHaveBeenCalledTimes(1);
    expect(mocks.original.mock.calls[0][2]).toMatchObject({ bodyFontSize: T.body, fitImagesToPage: true,
      diagramTypography: { nodeFontSize: T.body, edgeFontSize: T.minimum } });
    expect(T.minimum).toBeGreaterThanOrEqual(18);
    expect(result).toHaveProperty('qualityDiagnostics', expect.arrayContaining(['Original diagram retained with honest capacity diagnostics']));
  });

  it('preserves the exact legacy default contract when teaching visual is not enabled', async () => {
    const call = vi.fn().mockResolvedValue('single legacy response');
    await generateOpenMaicBaselineContent(outline, call, { visualProjection: true, componentAuthoring: true,
      textMeasure: () => ({ naturalWidth: 100, height: 40, lines: [] }) });
    expect(call).toHaveBeenCalledTimes(1);
    const options = mocks.original.mock.calls[0][2];
    expect(options).not.toHaveProperty('diagramTypography');
    expect(options).not.toHaveProperty('bodyFontSize');
    expect(options).not.toHaveProperty('fitImagesToPage');
    expect(mocks.teaching).not.toHaveBeenCalled();
  });
});
