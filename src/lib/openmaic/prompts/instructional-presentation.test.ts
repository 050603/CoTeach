import { describe, expect, it } from 'vitest';
import { buildPrompt, loadSnippet, PROMPT_IDS } from './index';

describe('instructional presentation prompt contract', () => {
  it('requires substantive PPT evidence instead of directory-style labels', () => {
    const prompt = buildPrompt(PROMPT_IDS.SLIDE_CONTENT, {
      canvas_width: 1000,
      canvas_height: 562.5,
      title: 'A lesson page',
      description: 'Explain a concept with evidence.',
      keyPoints: '1. Concept\n2. Evidence',
      teacherContext: '',
      pblContext: '',
      timingBudget: 'Target: 120 seconds',
      visualDirection: 'Use the Cobalt & Teal course visual system.',
      assignedImages: 'No images',
      languageDirective: 'Use English',
    });

    expect(prompt?.system).toContain('does **not** mean title-only, keyword-only, or directory-style');
    expect(prompt?.system).toContain('exact evidence');
    expect(prompt?.system).toContain('durable summary');
    expect(prompt?.system).toContain('hard to understand by listening alone');
    expect(prompt?.system).toContain('one clear visual hierarchy');
    expect(prompt?.system).toContain('restrained course-wide palette');
    expect(prompt?.system).toContain('one strong visual idea');
    expect(prompt?.system).toContain('Choose the representation from the teaching need');
    expect(prompt?.system).toContain('Use a table when learners need to compare shared dimensions');
    expect(prompt?.system).toContain('Use a chart only when complete supplied data');
    expect(prompt?.system).toContain('There is no format-variety quota');
    expect(prompt?.system).toContain('pedagogical preference rather than a fixed template');
    expect(prompt?.system).toContain('OpenMAIC baseline geometry contract');
    expect(prompt?.system).toContain("OpenMAIC's 75% safe-utilization rule");
    expect(prompt?.system).toContain('left x=60, width=430; right x=510, width=430');
    expect(prompt?.system).toContain('connector label must fit entirely in the gutter');
    expect(prompt?.system).toContain('20px internal padding on all sides');
    expect(prompt?.system).toContain('concept_text');
    expect(prompt?.system).toContain('No isolated 5–15px decorative lines');
    expect(prompt?.system).toContain('make the material to inspect and the changed condition visible before showing a complete classification');
    expect(prompt?.system).toContain('A setting label alone is not a worked case');
  });

  it('keeps quiz scope separate from answer authority and discourages worked-example replay', () => {
    const prompt = buildPrompt(PROMPT_IDS.QUIZ_CONTENT, {
      title: '概念辨析', description: '独立判断', keyPoints: '判断主要功能',
      knowledgePointIds: 'kp-1', questionCount: 1, difficulty: 'medium', questionTypes: 'single',
      assessmentTargets: '[]', pblContext: 'completed narration and source boundaries', languageDirective: '使用简体中文',
    });
    expect(prompt?.system).toContain('completed narration limits what may be assessed');
    expect(prompt?.system).toContain('authoritative source evidence');
    expect(prompt?.system).toContain('fresh compact situation');
    expect(prompt?.system).toContain("Do not copy the worked example's objects, exact statements, changed condition");
    expect(prompt?.system).toContain('not sufficient definitions or universal decision rules');
    expect(prompt?.system).toContain('There is no later model review or rewrite');
    expect(prompt?.system).toContain('private design card');
    expect(prompt?.system).toContain('answer-blind check');
    expect(prompt?.user).toContain('This request has one model-generation pass');
  });

  it('gives slide action generation a cross-discipline whiteboard decision and tools', () => {
    const prompt = buildPrompt(PROMPT_IDS.SLIDE_ACTIONS, {
      title: 'A lesson page',
      keyPoints: '1. Analyze the relationship',
      description: 'Students need to see the reasoning unfold.',
      elements: '- id: "summary", type: "text", Content summary: "Conclusion"',
      courseContext: '',
      agents: '',
      userProfile: '',
      pblContext: '',
      timingBudget: 'Target: 180 seconds',
      languageDirective: 'Use English',
    });

    expect(prompt?.system).toContain('instructional intent and the learner\'s need to see');
    expect(prompt?.system).toContain('wb_open');
    expect(prompt?.system).toContain('wb_draw_text');
    expect(prompt?.system).toContain('wb_draw_latex');
    expect(prompt?.system).toContain('Close and return to PPT');
    expect(prompt?.system).toContain('Do not use the whiteboard merely to copy the slide');
    expect(prompt?.system).toContain('choose a visual tool before adding more speech');
    expect(prompt?.system).toContain('not a fixed alternation quota');
    expect(prompt?.system).toContain('Adjacent segments may jointly establish');
    expect(prompt?.system).toContain('Warmth comes from recognizing a plausible difficulty');
    expect(prompt?.system).not.toContain('5-10 objects');
    expect(prompt?.system).not.toContain('**Summary**: Brief recap');
    expect(prompt?.system).toContain('Every generated page, scene, chapter, activity, quiz, and system operation');
    expect(prompt?.system).toContain('NEVER call a later page, chapter, activity, or operation');
    expect(prompt?.system).toContain('下节课');
    expect(prompt?.system).toContain('later in this lesson');
    expect(prompt?.system).toContain('Do not end every page with a course-level teaser or promise');
  });

  it('biases the live teacher toward tools when prose would stay abstract', () => {
    const prompt = buildPrompt(PROMPT_IDS.AGENT_SYSTEM_WB_TEACHER, {});

    expect(prompt?.system).toContain('tool-use checkpoint');
    expect(prompt?.system).toContain('The decision depends on comprehension, not sentence count');
    expect(prompt?.system).toContain('Do not merely say that you could draw it');
  });

  it('keeps the shared decision policy semantic instead of hard-coding the motivating example', () => {
    const policy = loadSnippet('instructional-presentation-policy');

    expect(policy).toContain('sequence, transformation, difference, annotation');
    expect(policy).toContain('not from subject-specific trigger words');
    expect(policy).not.toMatch(/\bNLP\b|punctuation|question mark|exclamation mark/i);
  });
});
