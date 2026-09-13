import { describe, expect, it } from 'vitest';
import { validateAction } from '@openmaic/dsl';
import { auditWhiteboardContent } from '@openmaic/lib/whiteboard/quality';
import { auditWhiteboardLayout } from '@openmaic/lib/whiteboard/layout';
import { createWhiteboardTemplate, whiteboardTemplates } from './whiteboard-templates';

describe('editable whiteboard teaching examples', () => {
  it.each(whiteboardTemplates)('%s contains valid, readable draws and explanations on an explicit new page', (kind) => {
    let id = 0;
    const actions = createWhiteboardTemplate(kind, () => `template-${id++}`);
    expect(actions[0].type).toBe('wb_clear');
    expect(actions.filter((action) => action.type === 'wb_clear')).toHaveLength(1);
    expect(actions[1]).toMatchObject({ type: 'wb_draw_text', content: expect.stringContaining('示例，可修改') });
    expect(new Set(actions.map((action) => action.id)).size).toBe(actions.length);
    expect(actions.filter((action) => action.type === 'speech').length).toBeGreaterThanOrEqual(3);
    expect(actions.flatMap((action) => {
      const result = validateAction(action);
      return result.valid ? [] : result.errors;
    })).toEqual([]);
    expect(auditWhiteboardContent(actions)).toEqual([]);
    expect(auditWhiteboardLayout(actions)).toEqual([]);
  });

  it('uses matching source values for the comparison chart and table', () => {
    const actions = createWhiteboardTemplate('comparison');
    const chart = actions.find((action) => action.type === 'wb_draw_chart')!;
    const table = actions.find((action) => action.type === 'wb_draw_table')!;
    expect(table.data[0]).toEqual(['项目', ...chart.data.legends]);
    expect(table.data.slice(1)).toEqual(chart.data.labels.map((label, index) => [label, ...chart.data.series.map((series) => String(series[index]))]));
  });

  it('binds flow arrows to grouped nodes and interleaves every formula with its own speech', () => {
    const steps = createWhiteboardTemplate('steps');
    const nodes = steps.filter((action) => action.type === 'wb_draw_shape');
    expect(nodes).toHaveLength(3);
    for (const node of nodes) expect(steps.find((action) => action.type === 'wb_draw_text' && action.groupId === node.groupId)).toBeDefined();
    const lines = steps.filter((action) => action.type === 'wb_draw_line');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ startAnchor: { elementId: nodes[0].elementId, side: 'right' }, endAnchor: { elementId: nodes[1].elementId, side: 'left' } });
    const derivation = createWhiteboardTemplate('derivation');
    const formulas = derivation.filter((action) => action.type === 'wb_draw_latex');
    expect(formulas).toHaveLength(3);
    expect(formulas.at(-1)?.latex).toContain('\\frac');
    for (const formula of formulas) expect(derivation[derivation.indexOf(formula) + 1]).toMatchObject({ type: 'speech', text: expect.any(String) });
  });
});
