import type { KnowledgeLectureBoardNote } from '@/lib/session/types';

export const EXPLANATION_VERSION = 'knowledge-question-lecture-v3';

/** A lesson resource, independent of the student's answer and private conversation. */
export type KnowledgeLectureExplanation = {
  id: string;
  questionFingerprint: string;
  text: string;
  boardNotes: KnowledgeLectureBoardNote[];
  audioUrl?: string;
  audioDurationSec?: number;
  source: 'prepared' | 'reference';
};
