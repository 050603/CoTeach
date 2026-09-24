import { describe, expect, it } from 'vitest';
import { buildPrompt, PROMPT_IDS } from './index';

describe('interactive-first outline strategy', () => {
  it.each([
    PROMPT_IDS.REQUIREMENTS_TO_OUTLINES,
    PROMPT_IDS.INTERACTIVE_OUTLINES,
    PROMPT_IDS.TASK_ENGINE_OUTLINES,
  ])('%s applies the shared instructional slide title contract', (promptId) => {
    const prompt = buildPrompt(promptId, {
      requirement: 'Teach instructional design',
      userProfile: '',
      pdfContent: 'None',
      availableImages: 'None',
      researchContext: 'None',
      teacherContext: '',
    });
    const combined = `${prompt?.system ?? ''}\n${prompt?.user ?? ''}`;

    expect(combined).toContain('Instructional Slide Title Contract');
    expect(combined).toContain('Use its standard, formal subject name as the title');
    expect(combined).not.toContain('{{snippet:slide-title-guidelines}}');
  });

  it('keeps standard mode dynamic instead of enforcing a widget or page-density formula', () => {
    const prompt = buildPrompt(PROMPT_IDS.REQUIREMENTS_TO_OUTLINES, {
      requirement: 'Teach a short concept course',
      userProfile: '',
      pdfContent: 'None',
      availableImages: 'None',
      researchContext: 'None',
      teacherContext: '',
    });
    const combined = `${prompt?.system ?? ''}\n${prompt?.user ?? ''}`;

    expect(combined).toContain('Do not use a fixed widget quota');
    expect(combined).toContain('there is no widget quota');
    expect(combined).toContain('no fixed slide-to-interaction cadence');
    expect(combined).toContain('smaller number of complete, coherent scenes');
    expect(combined).not.toContain('Limit to **1-2 interactive scenes per course**');
    expect(combined).not.toContain('typically 1-2 scenes per minute');
  });

  it('prefers meaningful learner action without a mechanical page cadence or widget quota', () => {
    const prompt = buildPrompt(PROMPT_IDS.INTERACTIVE_OUTLINES, {
      requirement: 'Teach a short concept course',
      userProfile: '',
      pdfContent: 'None',
      availableImages: 'None',
      researchContext: 'None',
      teacherContext: '',
    });
    const combined = `${prompt?.system ?? ''}\n${prompt?.user ?? ''}`;

    expect(combined).toContain('interactive-first');
    expect(combined).toContain('do not follow a fixed pages-per-interaction cadence');
    expect(combined).toContain('There are no widget-type quotas');
    expect(combined).toContain('not a repeating page formula');
    expect(combined).toContain('Interactions are ungraded learning environments');
    expect(combined).toContain('correctness judgment belongs in a `quiz` scene');
    expect(combined).not.toContain('mandatory explanation-practice cadence');
    expect(combined).not.toContain('After every one or two explanation slides');
    expect(combined).not.toContain('70% interactive scenes');
  });
});
