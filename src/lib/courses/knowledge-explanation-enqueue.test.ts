// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { Course } from '@/lib/session/types';
vi.mock('./knowledge-explanation-types', () => ({ EXPLANATION_VERSION: 'question-lecture-test' }));
import { enqueueKnowledgeExplanationWarmup } from './knowledge-explanation-enqueue';

const write = vi.fn();
const tx = { $executeRaw: write } as unknown as Prisma.TransactionClient;
const course = (): Course => ({ id: 'course', version: 1, aiLearningClassroomId: 'classroom', content: {
  knowledgePoints: [{ id: 'kp', name: '概念' }],
  knowledgeLectureSections: [{ id: 'section', quizOutlineId: 'quiz', knowledgePointIds: ['kp'] }],
  teacherReviewVersion: { classroomRevision: 2 },
} } as Course);
beforeEach(() => { vi.resetAllMocks(); write.mockResolvedValue(1); });

describe('question lecture warmup receipt identity', () => {
  it('deduplicates saves, publication and classroom start by resources rather than course or request versions', async () => {
    const original = course();
    const renamed: Course = { ...original, version: 456, name: '仅修改标题' };
    await enqueueKnowledgeExplanationWarmup(tx, original, 'template-version:one');
    await enqueueKnowledgeExplanationWarmup(tx, renamed, 'template-version:two');
    await enqueueKnowledgeExplanationWarmup(tx, { ...original, id: 'instance' }, 'classroom-instance:instance');
    expect(new Set(write.mock.calls.map(call => call[1])).size).toBe(1);
    expect(JSON.parse(write.mock.calls[0][3])).toMatchObject({ version: 'question-lecture-test', classroomRevision: 2 });
    expect(write.mock.calls.every(call => call[0].join('').includes('ON CONFLICT (id) DO NOTHING'))).toBe(true);
  });

  it('issues a distinct job for a changed source, knowledge point or classroom revision', async () => {
    const original = course();
    await enqueueKnowledgeExplanationWarmup(tx, original);
    await enqueueKnowledgeExplanationWarmup(tx, { ...original, content: { ...original.content,
      knowledgePoints: [{ ...original.content.knowledgePoints[0], name: '另一个概念' }],
    } });
    await enqueueKnowledgeExplanationWarmup(tx, { ...original, content: { ...original.content,
      courseEvidence: { version: 1, fingerprint: 'new-source', items: [], mappings: [] } as unknown as NonNullable<Course['content']['courseEvidence']>,
    } });
    await enqueueKnowledgeExplanationWarmup(tx, { ...original, content: { ...original.content,
      teacherReviewVersion: { ...original.content.teacherReviewVersion!, classroomRevision: 3 },
    } });
    expect(new Set(write.mock.calls.map(call => call[1])).size).toBe(4);
  });

  it('keeps the serialized adopted evidence independent from later caller mutations', async () => {
    const original = course();
    await enqueueKnowledgeExplanationWarmup(tx, original);
    original.content.knowledgePoints[0].name = '后来修改';
    expect(JSON.parse(write.mock.calls[0][3]).knowledgePoints[0].name).toBe('概念');
  });

  it('does not queue courses without both classroom resources and lecture sections', async () => {
    const original = course();
    await enqueueKnowledgeExplanationWarmup(tx, { ...original, aiLearningClassroomId: undefined });
    await enqueueKnowledgeExplanationWarmup(tx, { ...original, content: { ...original.content, knowledgeLectureSections: [] } });
    expect(write).not.toHaveBeenCalled();
  });
});
