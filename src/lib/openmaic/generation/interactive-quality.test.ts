import { describe, expect, it } from 'vitest';
import { auditInteractiveHtml } from './interactive-quality';

describe('interactive HTML quality audit', () => {
  it('rejects a clickable information page without a learning activity contract', () => {
    const result = auditInteractiveHtml(`
      <html><body>
        <article id="details">知识介绍</article>
        <button onclick="showDetails()">查看详情</button>
        <button onclick="next()">下一步</button>
      </body></html>
    `, 'diagram');

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('missing meaningful activity completion signal');
    expect(result.reasons).toContain(
      'only next/detail-style controls without learner manipulation or exploration state',
    );
  });

  it('accepts an activity that tracks exploration and reports completion and reset', () => {
    const result = auditInteractiveHtml(`
      <html><body>
        <input id="mass-slider" type="range" min="1" max="10" />
        <button id="reset">重置实验</button>
        <script>
          const observations = new Set();
          massSlider.addEventListener('input', compareOutcome);
          function finishComparison() { window.__maicActivity.complete(); }
          function resetExperiment() { observations.clear(); window.__maicActivity.reset(); }
        </script>
      </body></html>
    `, 'simulation');

    expect(result).toEqual({ passed: true, reasons: [] });
  });

  it('requires player lifecycle signals for procedural skills while leaving agency checks to their task contract', () => {
    expect(auditInteractiveHtml('<html></html>', 'procedural-skill')).toEqual({
      passed: false,
      reasons: [
        'missing meaningful activity completion signal',
        'missing full activity reset signal',
      ],
    });
    expect(auditInteractiveHtml(`
      <button>下一步</button>
      <script>
        function finishTask() { window.__maicActivity.complete(); }
        function restartTask() { window.__maicActivity.reset(); }
      </script>
    `, 'procedural-skill')).toEqual({ passed: true, reasons: [] });
  });
});
