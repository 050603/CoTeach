import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './build-agent';

describe('agent redraw boundaries', () => {
  it('treats knowledge-teaching redraw as PPT-only and reserves narration changes for explicit teacher requests', () => {
    const prompt = buildSystemPrompt({ id: 'scene', title: '概念' });
    expect(prompt).toContain('this updates only the PPT');
    expect(prompt).toContain('only when the teacher explicitly requests narration changes');
    expect(prompt).toContain('must not trigger a narration tool call');
    expect(prompt).toContain('Other slide types retain content-and-narration regeneration');
    expect(prompt).not.toContain('rebuilds the slide and its actions wholesale');
  });
});
