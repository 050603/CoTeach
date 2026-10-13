import { describe, expect, it } from 'vitest';
import type { Scene } from '@openmaic/lib/types/stage';
import { assignCourseQuizPoints, rebalanceSectionQuiz } from './course-scoring';

const scenes = [1, 2, 2, 2, 2, 3].map((count, index) => ({
  id: `scene-${index}`, outlineId: `quiz-${index}`, type: 'quiz',
  knowledgePointIds: Array.from({ length: count }, (_, point) => `kp-${index}-${point}`),
  content: { type: 'quiz', questions: [0, 1, 2].map((point) => ({
    id: `q${point}`, type: 'single', question: '判断知识', points: 10, answer: ['A'],
  })) },
})) as Scene[];
describe('course quiz budget', () => {
  it('retains a teacher\'s in-progress criterion edits rather than replacing them with fallback guidance', () => {
    const rubric = { version: 1 as const, criteria: [{ id: 'specific', description: '概念', weight: 100, fullCredit: '', noCredit: '错误概念' }] };
    const edited = rebalanceSectionQuiz({ type: 'quiz', scoring: { policy: 'course-100-v1', courseTotal: 100, sectionPoints: 8 },
      questions: [{ id: 'q', type: 'short_answer', question: '概念____', scoringRubric: rubric }] });
    expect(edited.questions[0].scoringRubric).toBe(rubric);
    expect(edited.questions[0].points).toBe(8);
  });
  it('preserves the section budget after a teacher adds or changes a question', () => {
    const section = assignCourseQuizPoints(scenes)[0].content;
    if (section.type !== 'quiz') throw new Error('Expected quiz');
    const edited = rebalanceSectionQuiz({ ...section, questions: [...section.questions,
      { id: 'new', type: 'single', question: '新题', points: 100 }] });
    expect(edited.questions.reduce((sum, question) => sum + question.points!, 0)).toBe(8);
    expect(edited.questions.every((question) => question.points! > 0 && question.scoringPolicy === 'course-100-v1')).toBe(true);
  });
  it('assigns exactly 100 points to all questions and keeps each section below 100', () => {
    const next = assignCourseQuizPoints(scenes);
    const budgets = next.map((scene) => scene.content.type === 'quiz' ? scene.content.scoring!.sectionPoints : 0);
    expect(budgets).toEqual([8, 17, 17, 17, 16, 25]);
    expect(budgets.reduce((sum, value) => sum + value, 0)).toBe(100);
    next.forEach((scene) => {
      if (scene.content.type !== 'quiz') throw new Error('Expected quiz');
      expect(scene.content.questions.reduce((sum, question) => sum + question.points!, 0)).toBe(scene.content.scoring!.sectionPoints);
      expect(scene.content.questions.every((question) => Number.isInteger(question.points) && question.points! > 0)).toBe(true);
    });
    expect(scenes[0].content.type === 'quiz' && scenes[0].content.questions[0].points).toBe(10);
  });
  it('keeps a section budget fixed when another question is added, and is idempotent', () => {
    const edited = structuredClone(scenes);
    if (edited[0].content.type === 'quiz') edited[0].content.questions.push({ id: 'extra', type: 'single', question: '补充', answer: ['A'] });
    const next = assignCourseQuizPoints(edited);
    expect(next[0].content.type === 'quiz' && next[0].content.scoring!.sectionPoints).toBe(8);
    expect(assignCourseQuizPoints(next)).toEqual(next);
  });
  it('allocates trial sections their share of the complete course', () => {
    const planned = scenes.map((scene) => ({ outlineId: scene.outlineId!, knowledgePointIds: scene.knowledgePointIds }));
    const next = assignCourseQuizPoints([scenes[0]], planned);
    expect(next[0].content.type === 'quiz' && next[0].content.scoring!.sectionPoints).toBe(8);
  });
  it('preserves non-quiz pages and uses subpoints if positive integer points cannot fit', () => {
    const slide = { id: 'slide', type: 'slide', content: { type: 'slide', elements: [] } } as unknown as Scene;
    expect(assignCourseQuizPoints([slide, ...scenes])[0]).toBe(slide);
    const many = Array.from({ length: 101 }, (_, index) => ({ ...scenes[0], id: `s${index}`, outlineId: `q${index}` }));
    const next = assignCourseQuizPoints(many);
    const sum = next.reduce((total, scene) => total + (scene.content.type === 'quiz' ? scene.content.questions.reduce((sum, question) => sum + question.points!, 0) : 0), 0);
    expect(sum).toBeCloseTo(100, 8);
  });
});
