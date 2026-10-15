import { describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '../types/generation';
import type { NarrationModuleOutput } from './action-binding-types';
import { compileManuscriptVisualActions, generateManuscriptVisualActions } from './manuscript-visual-actions';
import { calibrateGeneratedVisualCues } from './semantic-visual-cues';
import { findWhiteboardPlanIssues, normalizeTeachingToolPlan } from './teaching-tool-plan';
import { auditWhiteboardLayout } from '../whiteboard/layout';
import { normalizeWhiteboardActionLayout } from './whiteboard-layout';

const outline: SceneOutline = { id: 'analysis-page', type: 'slide', title: '分析框架',
  description: '展开总览页中未显示的分析依据', keyPoints: [], order: 0 };
const content = { elements: [] };
const text = '先分析学习者的兴趣。再分析内容。结合两者制定目标。强调目标的作用。最后返回幻灯片。';
const narration: NarrationModuleOutput = { pageId: outline.id, segments: [{ id: 'saved-speech',
  pageId: outline.id, text, semanticIds: ['analysis'] }] };
const at = (quote: string) => ({ speechId: 'saved-speech', speechAnchor: { quote, occurrence: 0 } });
const diagram = { panels: [{ key: 'analysis', kind: 'converge', nodes: [
  { key: 'learner', label: '学习者', role: 'source', icon: 'person', lines: [{ key: 'interest', text: '兴趣' }] },
  { key: 'content', label: '教学内容', role: 'source', icon: 'book' },
  { key: 'goal', label: '教学目标', role: 'focus', icon: 'target' },
], relations: [
  { key: 'learner-goal', from: 'learner', to: 'goal', kind: 'supports' },
  { key: 'content-goal', from: 'content', to: 'goal', kind: 'supports' },
] }] };
const whiteboard = () => ({ title: '分析依据', diagram: structuredClone(diagram), steps: [
  { reveal: ['learner', 'interest'], emphasize: ['interest'], ...at('先分析学习者') },
  { reveal: ['content'], emphasize: ['content'], ...at('再分析内容') },
  { reveal: ['goal', 'learner-goal', 'content-goal'], emphasize: ['goal'], ...at('结合两者制定目标') },
  { reveal: [], emphasize: ['goal'], ...at('强调目标的作用') },
], exit: at('最后返回幻灯片') });
const run = (board: unknown = whiteboard(), page = outline) => compileManuscriptVisualActions({
  outline: page, content, narration, output: { pageId: outline.id, cues: [], whiteboards: [board] },
});

describe('teacher diagram orchestration on saved speech', () => {
  it('reveals editable knowledge objects and their relationships without sentence-summary text', () => {
    const result = run();
    expect(result.issues).toEqual([]);
    expect(result.actions.filter((action) => action.type === 'speech')).toEqual([
      { id: 'saved-speech', type: 'speech', text },
    ]);
    const drawings = result.actions.filter((action) => action.type === 'wb_draw_text');
    expect(drawings.some((action) => action.content.includes('教学目标') && action.speechAnchor?.quote === '结合两者制定目标')).toBe(true);
    expect(drawings.some((action) => action.content.includes('教学内容') && action.speechAnchor?.quote === '先分析学习者')).toBe(false);
    expect(drawings.some((action) => action.speechAnchor?.quote === '强调目标的作用')).toBe(false);
    const links = result.actions.filter((action) => action.type === 'wb_draw_line' && action.endAnchor);
    expect(links).toHaveLength(2);
    expect(links.every((action) => 'speechAnchor' in action && action.speechAnchor?.quote === '结合两者制定目标')).toBe(true);
    expect(result.actions.some((action) => action.type === 'wb_draw_image' && action.src.startsWith('data:image/svg+xml'))).toBe(true);
    expect(drawings.every((action) => action.fontSize! >= 24)).toBe(true);
    expect(auditWhiteboardLayout(result.actions)).toEqual([]);
    expect(auditWhiteboardLayout(normalizeWhiteboardActionLayout(result.actions))).toEqual([]);
    const plans = normalizeTeachingToolPlan(result.teachingToolPlan);
    expect(plans[0]?.whiteboard?.diagram).toEqual(diagram);
    expect(findWhiteboardPlanIssues(plans[0], result.actions)).toEqual([]);
    expect(run().actions).toEqual(result.actions);
  });

  it('binds diagrams to the same real audio timeline as the preserved manuscript', () => {
    const result = run();
    const timed = result.actions.map((action) => action.type === 'speech' ? { ...action,
      audioDurationSec: text.length / 10,
      speechAlignment: { version: 'fixture', status: 'aligned' as const, textHash: 'text', audioHash: 'audio',
        spans: Array.from(text, (character, index) => ({ text: character, startChar: index,
          endChar: index + 1, startMs: index * 100, endMs: (index + 1) * 100 })) },
    } : action);
    const calibrated = calibrateGeneratedVisualCues({ outline, elements: [], actions: timed });
    const effects = calibrated.filter((action) => action.type.startsWith('wb_'));
    expect(effects.length).toBeGreaterThan(10);
    expect(effects.every((action) => 'speechOffsetMs' in action
      && action.speechOffsetMs === text.indexOf(action.speechAnchor!.quote) * 100)).toBe(true);
  });

  it('retains a missing diagram fact in the quality contract while keeping speech playable', () => {
    const accepted = whiteboard();
    const configured: SceneOutline = { ...outline, teachingToolPlan: [{ id: 'accepted-diagram', tool: 'whiteboard',
      trigger: '先分析学习者', purpose: '分析依据汇聚目标', content: ['学习者', '兴趣', '教学内容', '教学目标'],
      whiteboard: accepted as NonNullable<SceneOutline['teachingToolPlan']>[number]['whiteboard'], required: true }] };
    const incomplete = { ...whiteboard(), planId: 'accepted-diagram', steps: whiteboard().steps.slice(0, 2) };
    const result = run(incomplete, configured);
    expect(result.teachingToolPlan?.[0].whiteboard?.steps).toEqual(accepted.steps);
    expect(result.issues.some((issue) => issue.message.includes('教学目标') || issue.message.includes('goal'))).toBe(true);
    expect(result.actions.some((action) => action.type === 'speech' && action.text === text)).toBe(true);
  });

  it('does not interpret an invalid diagram as permission to fabricate legacy note text', () => {
    const broken = { ...whiteboard(), diagram: { panels: [{ kind: 'pie', nodes: [] }] } };
    const result = run(broken);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.actions.filter((action) => action.type.startsWith('wb_'))).toEqual([]);
    expect(result.actions).toContainEqual({ id: 'saved-speech', type: 'speech', text });
  });

  it('requests a source-grounded diagram at the actual model entry and forbids manuscript edits', async () => {
    const before = structuredClone(narration);
    const aiCall = vi.fn(async () => JSON.stringify({ pageId: outline.id, cues: [], whiteboards: [whiteboard()] }));
    const result = await generateManuscriptVisualActions({ outline, content, narration,
      teachingSourceContext: '教材采用内容：学习者和内容共同作为制定教学目标的依据。', aiCall });
    expect(result.issues).toEqual([]);
    expect(narration).toEqual(before);
    const [system, request] = aiCall.mock.calls[0] as unknown as [string, string];
    expect(system).toContain('MANUSCRIPT_VISUAL_ACTIONS_V3');
    expect(system).toContain('not to summarize every spoken sentence');
    expect(system).toContain('Every declared node, line and relation must be revealed');
    const input = JSON.parse(request);
    expect(input.sourceEvidence.adoptedOriginalSources).toContain('共同作为');
    expect(input.segments).toEqual([{ id: 'saved-speech', text }]);
  });
});
