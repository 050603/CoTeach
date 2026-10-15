'use client';

import { useCallback, useEffect, useId, useReducer, useRef } from 'react';
import { ArrowRight } from 'lucide-react';
import { useKnowledgeLectureQuizAttempts } from '@/components/openmaic-bridge/knowledge-lecture-quiz-lock';
import { useI18n } from '@openmaic/lib/hooks/use-i18n';
import { useStageStore } from '@openmaic/lib/store';
import type { Scene } from '@openmaic/lib/types/stage';
import { summarizeScenes, type SubmissionReader } from '@openmaic/lib/classroom/complete-summary';
import { readSubmittedState } from '@openmaic/lib/quiz/persistence';
import type { QuestionResult } from '@openmaic/lib/quiz/grading';
import styles from './classroom-complete.module.css';

function CompletionMark() {
  return (
    <div className={styles.mark} aria-hidden="true">
      <svg viewBox="0 0 200 200" fill="none">
        <circle cx="100" cy="100" r="72" className={styles.pulse} />
        <circle cx="100" cy="100" r="84" className={styles.halo} />
        <circle cx="100" cy="100" r="76" pathLength="1" className={styles.rim} />
        <g className={styles.seal}>
          <circle cx="100" cy="100" r="61" className={styles.disc} />
          <path d="M73 101L92 120L128 81" pathLength="1" className={styles.checkmark} />
        </g>
        <g className={styles.sparks}>
          <circle cx="30" cy="40" r="3" />
          <circle cx="165" cy="35" r="3" />
          <circle cx="174" cy="150" r="3" />
          <circle cx="32" cy="158" r="3" />
        </g>
      </svg>
    </div>
  );
}

interface ClassroomCompletePageProps {
  readonly scenes: Scene[];
  readonly title: string;
  readonly onReviewScene?: (sceneId: string) => void;
  readonly readSubmission?: SubmissionReader;
}

export function ClassroomCompletePage({ scenes, title, onReviewScene, readSubmission = readSubmittedState }: ClassroomCompletePageProps) {
  const { t } = useI18n();
  const headingId = useId();
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const serverResults = useRef(new Map<string, { reader: SubmissionReader; results: QuestionResult[] }>());

  useEffect(() => {
    const onGraded = (event: Event) => {
      const detail = (event as CustomEvent<{ sceneId?: string; results?: QuestionResult[] }>).detail;
      if (!detail?.sceneId || !scenes.some((scene) => scene.id === detail.sceneId)) return;
      if (Array.isArray(detail.results)) serverResults.current.set(detail.sceneId, { reader: readSubmission, results: detail.results });
      refresh();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || scenes.some((scene) =>
        event.key === `quizAnswers:${scene.id}` || event.key === `quizResults:${scene.id}`)) refresh();
    };
    window.addEventListener('openpbl:knowledge-lecture-server-graded', onGraded);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('openpbl:knowledge-lecture-server-graded', onGraded);
      window.removeEventListener('storage', onStorage);
    };
  }, [scenes, readSubmission]);

  const { quiz, assessment } = summarizeScenes(scenes, (sceneId) => {
    const saved = readSubmission(sceneId);
    const latest = serverResults.current.get(sceneId);
    // A refreshed provider supersedes events received against an older snapshot.
    return latest?.reader === readSubmission
      ? { kind: 'reviewing', answers: saved?.answers ?? {}, results: latest.results } : saved;
  });
  const fullyGraded = quiz?.pct !== undefined;
  const reviewLabel = assessment?.unsubmittedCount ? 'continueQuiz'
    : !fullyGraded ? 'reviewAnswers' : assessment?.reviewCount ? 'reviewMistakes' : 'reviewQuiz';
  const guidance = assessment?.unsubmittedCount ? 'unfinishedGuidance'
    : !fullyGraded ? 'pendingGuidance' : assessment?.reviewCount ? 'mistakesGuidance' : 'allCorrectGuidance';

  return (
    <section className={styles.page} aria-labelledby={headingId}>
      <span className="sr-only" role="status">{t('classroomComplete.announcement')}</span>
      <div className={styles.content}>
        {scenes.length > 0 && <CompletionMark />}
        <header className={styles.copy}>
          <h2 id={headingId}>{t(`classroomComplete.${scenes.length ? 'headline' : 'emptyHeadline'}`)}</h2>
          {title && <p className={styles.courseTitle}>{title}</p>}
          {scenes.length === 0 && <p className={styles.emptyDescription}>{t('classroomComplete.emptyDescription')}</p>}
        </header>

        {assessment && (
          <div className={styles.recap} role="group" aria-label={t('classroomComplete.quizReview')} aria-live="polite" aria-atomic="true">
            <dl className={styles.stats}>
              <div>
                <dt>{t('classroomComplete.submittedLabel')}</dt>
                <dd>{t('classroomComplete.submittedQuestions', { count: assessment.submittedCount, total: assessment.questionCount })}</dd>
              </div>
              <div>
                <dt>{t('classroomComplete.correctLabel')}</dt>
                <dd>{t('classroomComplete.questionCount', { count: assessment.correctCount })}</dd>
              </div>
              <div>
                <dt>{t(`classroomComplete.${fullyGraded ? 'scoreLabel' : assessment.pendingCount ? 'pendingLabel' : 'unsubmittedLabel'}`)}</dt>
                <dd>{fullyGraded && quiz
                  ? t('classroomComplete.scorePoints', { score: quiz.score, total: quiz.total })
                  : t('classroomComplete.questionCount', { count: assessment.pendingCount || assessment.unsubmittedCount })}</dd>
              </div>
            </dl>
            <p className={styles.guidance}>{t(`classroomComplete.${guidance}`)}</p>
          </div>
        )}

        {onReviewScene && scenes.length > 0 && (
          <nav className={styles.actions}>
            {assessment && (
              <button type="button" className={styles.primaryAction} onClick={() => onReviewScene(assessment.reviewSceneId)}>
                {t(`classroomComplete.${reviewLabel}`)}<ArrowRight size={18} aria-hidden="true" />
              </button>
            )}
            <button type="button" className={assessment ? styles.secondaryAction : styles.primaryAction} onClick={() => onReviewScene(scenes[0].id)}>
              {t('classroomComplete.reviewCourse')}{!assessment && <ArrowRight size={18} aria-hidden="true" />}
            </button>
          </nav>
        )}
      </div>
    </section>
  );
}

export function ClassroomCompletePageConnected({ onReviewScene }: { readonly onReviewScene?: (sceneId: string) => void }) {
  const stage = useStageStore((state) => state.stage);
  const scenes = useStageStore((state) => state.scenes);
  const attempts = useKnowledgeLectureQuizAttempts();
  const readSubmission = useCallback<SubmissionReader>((sceneId) => {
    const scene = scenes.find((item) => item.id === sceneId);
    const attempt = (scene?.outlineId ? attempts.get(scene.outlineId) : undefined) ?? attempts.get(sceneId);
    if (!attempt) return readSubmittedState(sceneId);
    return {
      kind: 'reviewing',
      answers: Object.fromEntries(attempt.questions.map((question) => [question.questionId, question.rawAnswer ?? question.answer ?? ''])),
      results: attempt.questions.map((question) => ({
        questionId: question.questionId,
        correct: question.correct,
        status: question.gradingStatus === 'pending' || question.gradingStatus === 'failed' ? 'pending' : 'graded',
        earned: question.earned,
      })),
    };
  }, [attempts, scenes]);
  return <ClassroomCompletePage scenes={scenes} title={stage?.name ?? ''} onReviewScene={onReviewScene} readSubmission={readSubmission} />;
}
