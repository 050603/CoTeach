'use client';

import { memo, useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence, MotionConfig, useReducedMotion } from 'motion/react';
import {
  CheckCircle2,
  XCircle,
  LockKeyhole,
  ChevronRight,
  Check,
  BookOpenText,
  ClipboardCheck,
  Loader2,
  MessageCircleQuestion,
  ArrowRight,
  GripVertical,
} from 'lucide-react';
import { cn } from '@openmaic/lib/utils';
import { useI18n } from '@openmaic/lib/hooks/use-i18n';
import type { QuizQuestion } from '@openmaic/lib/types/stage';
import { useDraftCache } from '@openmaic/lib/hooks/use-draft-cache';
import { SpeechButton } from '@openmaic/components/audio/speech-button';
import { gradeChoiceQuestions, isShortAnswer, type QuestionResult } from '@openmaic/lib/quiz/grading';
import { renderQuizMathText } from '@openmaic/lib/quiz/math-text';
import {
  draftKey,
  readSubmittedState,
  writeSubmittedAnswers,
  writeSubmittedResults,
  type SubmittedState,
} from '@openmaic/lib/quiz/persistence';
import { dispatchPlaybackActivityComplete } from '@openmaic/lib/playback/activity-events';
import { gradeShortAnswerQuestion } from './quiz-grade-client';
import { useLockedKnowledgeLectureAttempt } from '@/components/openmaic-bridge/knowledge-lecture-quiz-lock';

// ─── Types ──────────────────────────────────────────────────────────────────

type Phase = 'not_started' | 'answering' | 'grading' | 'reviewing';

interface QuizViewProps {
  readonly questions: QuizQuestion[];
  readonly sceneId: string;
  readonly quizOutlineId?: string;
}

export const KNOWLEDGE_LECTURE_QUIZ_REVIEWED_EVENT = 'openpbl:knowledge-lecture-quiz-reviewed';
export const KNOWLEDGE_LECTURE_EXPLAIN_EVENT = 'openpbl:knowledge-lecture-explain-question';

const QuizMathText = memo(function QuizMathText({
  text,
  className,
  allowDisplayMode = false,
}: {
  text: string;
  className?: string;
  allowDisplayMode?: boolean;
}) {
  const segments = useMemo(() => renderQuizMathText(text), [text]);
  if (segments.length === 1 && segments[0].type === 'text') {
    return <span className={className}>{segments[0].value}</span>;
  }

  return (
    <span className={className}>
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return <span key={index}>{segment.value}</span>;
        }

        return (
          <span
            key={index}
            className={cn(
              allowDisplayMode && segment.displayMode
                ? 'block my-1 overflow-x-auto [&_.katex-display]:!my-0'
                : 'inline-block align-baseline [&_.katex-display]:!my-0',
            )}
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        );
      })}
    </span>
  );
});

const MATCH_DRAG_MIME = 'application/x-openpbl-match';

function startMatchingDrag(event: React.DragEvent<HTMLElement>, rightId: string) {
  event.dataTransfer.setData(MATCH_DRAG_MIME, rightId);
  event.dataTransfer.effectAllowed = 'move';
  if (typeof event.dataTransfer.setDragImage !== 'function') return;

  const source = event.currentTarget;
  const bounds = source.getBoundingClientRect();
  const preview = source.cloneNode(true) as HTMLElement;
  Object.assign(preview.style, {
    position: 'fixed',
    left: '-10000px',
    top: '-10000px',
    width: `${Math.max(160, bounds.width)}px`,
    margin: '0',
    opacity: '1',
    background: 'var(--pbl-surface)',
    border: '1px solid var(--pbl-student)',
    borderRadius: '10px',
    color: 'var(--pbl-text)',
  });
  preview.setAttribute('aria-hidden', 'true');
  document.body.appendChild(preview);
  event.dataTransfer.setDragImage(preview, 24, Math.max(12, bounds.height / 2));
  window.setTimeout(() => preview.remove(), 0);
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function QuizCover({
  questionCount,
  totalPoints,
  onStart,
}: {
  questionCount: number;
  totalPoints: number;
  onStart: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto px-5 py-8 sm:px-8">
      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="flex w-full max-w-xl flex-col items-center text-center"
      >
        <span className="grid size-14 place-items-center rounded-[14px] border border-[var(--pbl-student-border)] bg-[var(--pbl-student-soft)] text-[var(--pbl-student)]">
          <ClipboardCheck className="size-7" aria-hidden="true" />
        </span>
        <h3 className="mt-5 text-2xl font-semibold text-[var(--pbl-text-strong)]">{t('quiz.title')}</h3>
        <p className="mt-2 max-w-md text-sm leading-6 text-[var(--pbl-text-muted)]">{t('quiz.subtitle')}</p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 border-y border-[var(--pbl-border)] py-4 text-sm text-[var(--pbl-text-muted)]">
          <div className="flex items-center gap-2">
            <BookOpenText className="size-4 text-[var(--pbl-student)]" aria-hidden="true" />
            <span>{questionCount} {t('quiz.questionsCount')}</span>
          </div>
          <div className="flex items-center gap-2">
            <ClipboardCheck className="size-4 text-[var(--pbl-student)]" aria-hidden="true" />
            <span>{t('quiz.totalPrefix')} {totalPoints} {t('quiz.pointsSuffix')}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={onStart}
          className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-[10px] bg-[var(--pbl-student)] px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--pbl-student-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pbl-student)] focus-visible:ring-offset-2"
        >
          {t('quiz.startQuiz')}
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
        <p className="mt-3 text-xs text-[var(--pbl-text-subtle)]">提交后将进入逐题回顾，本小节仅可作答一次。</p>
      </motion.div>
    </div>
  );
}

function SingleChoiceQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
  onExplain,
}: {
  question: QuizQuestion;
  index: number;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  result?: QuestionResult;
  onExplain?: () => void;
}) {
  const isReview = !!result;

  return (
    <QuestionCard question={question} index={index} result={result} onExplain={onExplain}>
      <div className="grid gap-2">
        {question.options?.map((opt) => {
          const selected = value === opt.value;
          const isCorrectOpt = isReview && question.answer?.includes(opt.value);
          const isWrong = isReview && selected && result?.status === 'incorrect';

          return (
            <button
              key={opt.value}
              type="button"
              disabled={disabled}
              aria-pressed={!isReview ? selected : undefined}
              onClick={() => !disabled && onChange(opt.value)}
              className={cn(
                'flex min-h-11 items-center gap-3 rounded-[10px] border px-4 py-3 text-left text-sm leading-6 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pbl-student)] focus-visible:ring-inset',
                !isReview &&
                  !selected &&
                  'border-[var(--pbl-border)] bg-[var(--pbl-surface)] text-[var(--pbl-text)] hover:border-[var(--pbl-student-border)] hover:bg-[var(--pbl-student-soft)]',
                !isReview &&
                  selected &&
                  'border-[var(--pbl-student)] bg-[var(--pbl-student-soft)] text-[var(--pbl-text-strong)]',
                isReview &&
                  isCorrectOpt &&
                  'border-[var(--pbl-success-border)] bg-[var(--pbl-success-soft)] text-[var(--pbl-text)]',
                isReview &&
                  isWrong &&
                  !isCorrectOpt &&
                  'border-[var(--pbl-danger-border)] bg-[var(--pbl-danger-soft)] text-[var(--pbl-text)]',
                isReview &&
                  !isCorrectOpt &&
                  !selected &&
                  'border-[var(--pbl-border-soft)] bg-[var(--pbl-surface)] text-[var(--pbl-text-muted)]',
                disabled && !isReview && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                  !isReview &&
                    !selected &&
                    'bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-muted)]',
                  !isReview && selected && 'bg-[var(--pbl-student)] text-white',
                  isReview && isCorrectOpt && 'bg-[var(--pbl-success)] text-white',
                  isReview && isWrong && !isCorrectOpt && 'bg-[var(--pbl-danger)] text-white',
                  isReview &&
                    !isCorrectOpt &&
                    !selected &&
                    'bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-subtle)]',
                )}
              >
                {opt.value}
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 break-words',
                )}
              >
                <QuizMathText text={opt.label} />
              </span>
              {isReview && isCorrectOpt && <span className="shrink-0 text-xs font-semibold text-[var(--pbl-success)]">正确答案</span>}
              {isReview && isWrong && !isCorrectOpt && (
                <span className="shrink-0 text-xs font-semibold text-[var(--pbl-danger)]">你的选择</span>
              )}
            </button>
          );
        })}
      </div>
    </QuestionCard>
  );
}

function MultipleChoiceQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
  onExplain,
}: {
  question: QuizQuestion;
  index: number;
  value?: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  result?: QuestionResult;
  onExplain?: () => void;
}) {
  const isReview = !!result;
  const selected = value ?? [];

  const toggle = (optValue: string) => {
    if (disabled) return;
    if (selected.includes(optValue)) {
      onChange(selected.filter((v) => v !== optValue));
    } else {
      onChange([...selected, optValue]);
    }
  };

  const { t } = useI18n();

  return (
    <QuestionCard question={question} index={index} result={result} onExplain={onExplain}>
      {!isReview && (
        <p className="mb-2 text-xs text-[var(--pbl-text-muted)]">
          {t('quiz.multipleChoiceHint')}
        </p>
      )}
      <div className="grid gap-2">
        {question.options?.map((opt) => {
          const isSelected = selected.includes(opt.value);
          const isCorrectOpt = isReview && question.answer?.includes(opt.value);
          const isWrong = isReview && isSelected && !isCorrectOpt;

          return (
            <button
              key={opt.value}
              type="button"
              disabled={disabled}
              aria-pressed={!isReview ? isSelected : undefined}
              onClick={() => toggle(opt.value)}
              className={cn(
                'flex min-h-11 items-center gap-3 rounded-[10px] border px-4 py-3 text-left text-sm leading-6 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pbl-student)] focus-visible:ring-inset',
                !isReview &&
                  !isSelected &&
                  'border-[var(--pbl-border)] bg-[var(--pbl-surface)] text-[var(--pbl-text)] hover:border-[var(--pbl-student-border)] hover:bg-[var(--pbl-student-soft)]',
                !isReview &&
                  isSelected &&
                  'border-[var(--pbl-student)] bg-[var(--pbl-student-soft)] text-[var(--pbl-text-strong)]',
                isReview &&
                  isCorrectOpt &&
                  'border-[var(--pbl-success-border)] bg-[var(--pbl-success-soft)] text-[var(--pbl-text)]',
                isReview && isWrong && 'border-[var(--pbl-danger-border)] bg-[var(--pbl-danger-soft)] text-[var(--pbl-text)]',
                isReview &&
                  !isCorrectOpt &&
                  !isSelected &&
                  'border-[var(--pbl-border-soft)] bg-[var(--pbl-surface)] text-[var(--pbl-text-muted)]',
                disabled && !isReview && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-[6px] text-xs font-semibold transition-colors',
                  !isReview &&
                    !isSelected &&
                    'bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-muted)]',
                  !isReview && isSelected && 'bg-[var(--pbl-student)] text-white',
                  isReview && isCorrectOpt && 'bg-[var(--pbl-success)] text-white',
                  isReview && isWrong && 'bg-[var(--pbl-danger)] text-white',
                  isReview &&
                    !isCorrectOpt &&
                    !isSelected &&
                    'bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-subtle)]',
                )}
              >
                {!isReview && isSelected ? <Check className="w-3.5 h-3.5" /> : opt.value}
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 break-words',
                )}
              >
                <QuizMathText text={opt.label} />
              </span>
              {isReview && isCorrectOpt && <span className="shrink-0 text-xs font-semibold text-[var(--pbl-success)]">正确答案</span>}
              {isReview && isWrong && <span className="shrink-0 text-xs font-semibold text-[var(--pbl-danger)]">你的选择</span>}
            </button>
          );
        })}
      </div>
    </QuestionCard>
  );
}

function MatchingQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
  onExplain,
}: {
  question: QuizQuestion;
  index: number;
  value?: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  result?: QuestionResult;
  onExplain?: () => void;
}) {
  const [selectedRightId, setSelectedRightId] = useState<string>();
  const pairs = question.matchingPairs ?? [];
  const selected = value ?? [];
  const relationMap = new Map(selected.flatMap((relation) => {
    const separator = relation.indexOf(':');
    return separator > 0 ? [[relation.slice(0, separator), relation.slice(separator + 1)] as const] : [];
  }));
  const rightById = new Map(pairs.map((pair) => [pair.rightId, pair.right]));
  const shuffledRight = pairs.length > 1 ? [...pairs.slice(1), pairs[0]!] : pairs;
  const correct = new Set(question.answer ?? []);
  const review = Boolean(result);

  const assign = (leftId: string, rightId: string) => {
    if (disabled) return;
    const next = selected.filter((relation) => {
      const separator = relation.indexOf(':');
      const currentLeft = relation.slice(0, separator);
      const currentRight = relation.slice(separator + 1);
      return currentLeft !== leftId && currentRight !== rightId;
    });
    onChange([...next, `${leftId}:${rightId}`]);
    setSelectedRightId(undefined);
  };

  const unassign = (rightId: string) => {
    if (disabled) return;
    onChange(selected.filter((relation) => relation.slice(relation.indexOf(':') + 1) !== rightId));
    setSelectedRightId(undefined);
  };

  return (
    <QuestionCard question={question} index={index} result={result} onExplain={onExplain}>
      {!review && (
        <p className="mb-3 text-xs leading-5 text-[var(--pbl-text-muted)]">
          拖动右侧卡片到对应项，也可以依次点击右侧卡片和左侧目标。
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-[1.35fr_1fr]">
        <div className="space-y-2">
          {pairs.map((pair) => {
            const rightId = relationMap.get(pair.leftId);
            const relation = rightId ? `${pair.leftId}:${rightId}` : '';
            const isCorrect = review && correct.has(relation);
            const isWrong = review && Boolean(rightId) && !isCorrect;
            return (
              <div
                key={pair.leftId}
                role="button"
                tabIndex={disabled ? -1 : 0}
                aria-label={`匹配到 ${pair.left}`}
                onClick={() => selectedRightId && assign(pair.leftId, selectedRightId)}
                onKeyDown={(event) => {
                  if ((event.key === 'Enter' || event.key === ' ') && selectedRightId) {
                    event.preventDefault();
                    assign(pair.leftId, selectedRightId);
                  }
                }}
                onDragOver={(event) => {
                  if (!disabled) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const draggedRightId = event.dataTransfer.getData(MATCH_DRAG_MIME);
                  if (draggedRightId) assign(pair.leftId, draggedRightId);
                }}
                className={cn(
                  'grid min-h-11 w-full grid-cols-1 items-center gap-2 rounded-[10px] border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pbl-student)] focus-visible:ring-inset sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-3',
                  !review && 'border-[var(--pbl-border)] bg-[var(--pbl-surface)] hover:border-[var(--pbl-student-border)]',
                  !review && selectedRightId && 'border-dashed border-[var(--pbl-student)] bg-[var(--pbl-student-soft)]',
                  isCorrect && 'border-[var(--pbl-success-border)] bg-[var(--pbl-success-soft)]',
                  isWrong && 'border-[var(--pbl-danger-border)] bg-[var(--pbl-danger-soft)]',
                )}
              >
                <span className="font-medium text-[var(--pbl-text-strong)]">{pair.left}</span>
                {rightId && !review ? (
                  <div
                    draggable={!disabled}
                    aria-label={`移动匹配项 ${rightById.get(rightId)}`}
                    onClick={(event) => event.stopPropagation()}
                    onDragStart={(event) => startMatchingDrag(event, rightId)}
                    className="flex min-h-11 cursor-grab select-none items-center gap-2 rounded-[8px] border border-[var(--pbl-student-border)] bg-[var(--pbl-surface)] px-3 py-2 text-[var(--pbl-student)] active:cursor-grabbing"
                  >
                    <GripVertical className="size-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1">{rightById.get(rightId)}</span>
                  </div>
                ) : (
                  <span className={cn(
                    'min-h-11 rounded-[8px] border border-dashed border-[var(--pbl-border-strong)] px-3 py-2 text-[var(--pbl-text-muted)]',
                    rightId && 'border-solid border-[var(--pbl-border)] bg-[var(--pbl-surface)]',
                  )}>
                    <span className="block">{rightId ? rightById.get(rightId) : '放置匹配项'}</span>
                    {isCorrect && <span className="mt-1 block text-xs font-semibold text-[var(--pbl-success)]">匹配正确</span>}
                    {isWrong && <span className="mt-1 block text-xs font-semibold text-[var(--pbl-danger)]">正确匹配：{pair.right}</span>}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {!review && (
          <div
            aria-label="待选匹配项"
            onDragOver={(event) => {
              if (!disabled) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              const draggedRightId = event.dataTransfer.getData(MATCH_DRAG_MIME);
              if (draggedRightId) unassign(draggedRightId);
            }}
            className="min-h-24 space-y-2 rounded-[10px] border border-dashed border-[var(--pbl-student-border)] bg-[var(--pbl-student-soft)] p-2"
          >
            <p className="px-1 text-[11px] font-semibold text-[var(--pbl-student)]">待选项</p>
            {shuffledRight.filter((pair) => ![...relationMap.values()].includes(pair.rightId)).map((pair) => {
              return (
                <button
                  key={pair.rightId}
                  type="button"
                  draggable={!disabled}
                  aria-pressed={selectedRightId === pair.rightId}
                  aria-label={`选择匹配项 ${pair.right}`}
                  onClick={() => !disabled && setSelectedRightId(pair.rightId)}
                  onDragStart={(event) => startMatchingDrag(event, pair.rightId)}
                  className={cn(
                    'flex min-h-11 w-full cursor-grab select-none items-center gap-2 rounded-[8px] border px-3 py-2 text-left text-sm transition-colors active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pbl-student)] focus-visible:ring-inset',
                    selectedRightId === pair.rightId
                      ? 'border-[var(--pbl-student)] bg-[var(--pbl-surface)] text-[var(--pbl-student)]'
                      : 'border-[var(--pbl-border)] bg-[var(--pbl-surface)] text-[var(--pbl-text)] hover:border-[var(--pbl-student)]',
                  )}
                >
                  <GripVertical className="size-4 shrink-0 text-[var(--pbl-text-subtle)]" aria-hidden="true" />
                  <span className="break-words">{pair.right}</span>
                </button>
              );
            })}
            {relationMap.size === pairs.length && (
              <p className="px-2 py-3 text-center text-xs text-[var(--pbl-text-muted)]">所有卡片已放置</p>
            )}
          </div>
        )}
      </div>
    </QuestionCard>
  );
}

function ShortAnswerQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
  onExplain,
}: {
  question: QuizQuestion;
  index: number;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  result?: QuestionResult;
  onExplain?: () => void;
}) {
  const isReview = !!result;
  const { t } = useI18n();
  // Ref to track latest value for voice transcription append
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  return (
    <QuestionCard question={question} index={index} result={result} onExplain={onExplain}>
      {!isReview ? (
        <div className="relative">
          {question.format === 'fill_blank' ? (
            <input
              value={value ?? ''}
              onChange={(e) => onChange(e.target.value)}
              disabled={disabled}
              placeholder="填写关键概念或关系"
              className="h-14 w-full rounded-[10px] border border-[var(--pbl-border-strong)] bg-[var(--pbl-surface)] py-2 pl-14 pr-24 text-sm text-[var(--pbl-text)] transition-colors placeholder:text-[var(--pbl-text-subtle)] focus:border-[var(--pbl-student)] focus:outline-none focus:ring-2 focus:ring-[var(--pbl-student-border)] disabled:bg-[var(--pbl-surface-soft)] disabled:text-[var(--pbl-text-muted)]"
            />
          ) : (
            <textarea
              value={value ?? ''}
              onChange={(e) => onChange(e.target.value)}
              disabled={disabled}
              placeholder={question.format === 'scenario_task' ? '写出你的判断、依据和解决思路' : t('quiz.inputPlaceholder')}
              className="min-h-28 w-full resize-y rounded-[10px] border border-[var(--pbl-border-strong)] bg-[var(--pbl-surface)] p-3 pb-14 text-sm leading-6 text-[var(--pbl-text)] transition-colors placeholder:text-[var(--pbl-text-subtle)] focus:border-[var(--pbl-student)] focus:outline-none focus:ring-2 focus:ring-[var(--pbl-student-border)] disabled:bg-[var(--pbl-surface-soft)] disabled:text-[var(--pbl-text-muted)]"
            />
          )}
          <SpeechButton
            size="sm"
            disabled={disabled}
            className="absolute bottom-1.5 left-1.5 min-h-11 min-w-11"
            onTranscription={(text) => {
              const cur = valueRef.current ?? '';
              onChange(cur + (cur ? ' ' : '') + text);
            }}
          />
          <span className="absolute bottom-3 right-3 text-xs text-[var(--pbl-text-subtle)]">
            {(value ?? '').length} {t('quiz.charCount')}
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-[10px] border border-[var(--pbl-border)] bg-[var(--pbl-surface-soft)] p-3 text-sm leading-6 text-[var(--pbl-text)]">
            <p className="mb-1 text-xs text-[var(--pbl-text-muted)]">{t('quiz.yourAnswer')}</p>
            {value ? (
              <QuizMathText text={value} />
            ) : (
              <span className="italic text-[var(--pbl-text-subtle)]">
                {t('quiz.notAnswered')}
              </span>
            )}
          </div>
          {result.aiComment && (
            <div className="flex items-start gap-2 rounded-[8px] border border-[var(--pbl-ai-border)] bg-[var(--pbl-ai-soft)] px-3 py-2">
              <div>
                <p className="mb-0.5 text-xs font-semibold text-[var(--pbl-ai)]">
                  {t('quiz.aiComment')}
                </p>
                <p className="text-xs leading-5 text-[var(--pbl-text-muted)]">
                  <QuizMathText text={result.aiComment} />
                </p>
              </div>
              <span className="ml-auto shrink-0 text-xs font-bold text-[var(--pbl-ai)]">
                {result.earned}/{question.points ?? 1}
                {t('quiz.pointsSuffix')}
              </span>
            </div>
          )}
        </div>
      )}
    </QuestionCard>
  );
}

function QuestionCard({
  question,
  index,
  result,
  children,
  onExplain,
}: {
  question: QuizQuestion;
  index: number;
  result?: QuestionResult;
  children: React.ReactNode;
  onExplain?: () => void;
}) {
  const { t } = useI18n();
  const isReview = !!result;
  const pts = question.points ?? 1;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      className={cn(
        'relative overflow-hidden rounded-[14px] border bg-[var(--pbl-surface)] p-4 sm:p-5',
        !isReview && 'border-[var(--pbl-border)]',
        isReview &&
          result.status === 'correct' &&
          'border-[var(--pbl-success-border)]',
        isReview &&
          result.status === 'incorrect' &&
          'border-[var(--pbl-danger-border)]',
      )}
    >
      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-[8px] text-xs font-bold',
              !isReview &&
                'bg-[var(--pbl-student-soft)] text-[var(--pbl-student)]',
              isReview &&
                result.status === 'correct' &&
                'bg-[var(--pbl-success-soft)] text-[var(--pbl-success)]',
              isReview &&
                result.status === 'incorrect' &&
                'bg-[var(--pbl-danger-soft)] text-[var(--pbl-danger)]',
            )}
          >
            {index + 1}
          </span>
          <div className="min-w-0">
            <div className="break-words text-[15px] font-medium leading-7 text-[var(--pbl-text-strong)]">
              <QuizMathText text={question.question} allowDisplayMode />
            </div>
            <p className="mt-1 text-xs text-[var(--pbl-text-muted)]">
              {question.format === 'matching'
                ? '拖拽匹配题'
                : question.format === 'true_false'
                ? '判断题'
                : question.format === 'fill_blank'
                  ? '填空题'
                  : question.format === 'scenario_task'
                    ? '情境任务'
                    : question.type === 'single'
                ? t('quiz.singleChoice')
                : question.type === 'multiple'
                  ? t('quiz.multipleChoice')
                  : t('quiz.shortAnswer')}
              {' · '}
              {pts} {t('quiz.pointsSuffix')}
            </p>
          </div>
        </div>
        {isReview && (
          <div className={cn(
            'ml-2 inline-flex min-h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-semibold',
            result.status === 'correct'
              ? 'bg-[var(--pbl-success-soft)] text-[var(--pbl-success)]'
              : 'bg-[var(--pbl-danger-soft)] text-[var(--pbl-danger)]',
          )}>
            {result.status === 'correct' ? <CheckCircle2 className="size-3.5" aria-hidden="true" /> : <XCircle className="size-3.5" aria-hidden="true" />}
            {result.status === 'correct' ? '回答正确' : '需要复习'}
          </div>
        )}
      </div>

      {/* Body */}
      {children}

      {/* Analysis (review only) */}
      {isReview && (question.analysis || onExplain) && (
        <div className="mt-4 rounded-[10px] border border-[var(--pbl-ai-border)] bg-[var(--pbl-ai-soft)] p-3 text-xs leading-6 text-[var(--pbl-text)]">
          <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
            <div className="min-w-0">
              {question.analysis ? (
                <><span className="mr-1 font-bold text-[var(--pbl-ai)]">{t('quiz.analysis')}</span><QuizMathText text={question.analysis} allowDisplayMode /></>
              ) : (
                <span className="text-[var(--pbl-text-muted)]">需要进一步梳理这道题？</span>
              )}
            </div>
            {onExplain ? (
              <button className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-[8px] border border-[var(--pbl-ai-border)] bg-[var(--pbl-surface)] px-3 font-semibold text-[var(--pbl-ai)] transition-colors hover:bg-[var(--pbl-ai-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pbl-ai)] focus-visible:ring-inset" onClick={onExplain} type="button">
                <MessageCircleQuestion className="size-3.5" />助教讲解
              </button>
            ) : null}
          </div>
        </div>
      )}
    </motion.div>
  );
}

function ScoreBanner({
  score,
  total,
  results,
}: {
  score: number;
  total: number;
  results: QuestionResult[];
}) {
  const { t } = useI18n();
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const correctCount = results.filter((r) => r.status === 'correct').length;
  const incorrectCount = results.filter((r) => r.status === 'incorrect').length;

  const summary = pct >= 80 ? t('quiz.excellent') : pct >= 60 ? t('quiz.keepGoing') : t('quiz.needsReview');

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="rounded-[14px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-5 sm:p-6"
    >
      <div className="flex items-center justify-between gap-5">
        <div>
          <p className="text-sm font-semibold text-[var(--pbl-student)]">{summary}</p>
          <div className="mt-1 flex items-baseline gap-1 text-[var(--pbl-text-strong)]">
            <span className="text-4xl font-bold">{score}</span>
            <span className="text-lg text-[var(--pbl-text-muted)]">/ {total}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-xs">
            <span className="flex items-center gap-1 text-[var(--pbl-success)]">
              <CheckCircle2 className="size-3.5" aria-hidden="true" /> {correctCount} {t('quiz.correct')}
            </span>
            <span className="flex items-center gap-1 text-[var(--pbl-danger)]">
              <XCircle className="size-3.5" aria-hidden="true" /> {incorrectCount} {t('quiz.incorrect')}
            </span>
          </div>
        </div>

        {/* Percentage ring */}
        <div className="relative size-20 shrink-0" aria-label={`${pct}%`} role="img">
          <svg className="size-20 -rotate-90" viewBox="0 0 80 80" aria-hidden="true">
            <circle
              cx="40"
              cy="40"
              r="34"
              fill="none"
              stroke="var(--pbl-border)"
              strokeWidth="6"
            />
            <motion.circle
              cx="40"
              cy="40"
              r="34"
              fill="none"
              stroke="var(--pbl-student)"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 34}`}
              initial={{ strokeDashoffset: 2 * Math.PI * 34 }}
              animate={{ strokeDashoffset: 2 * Math.PI * 34 * (1 - pct / 100) }}
              transition={{ duration: 1, ease: 'easeOut', delay: 0.3 }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-lg font-bold text-[var(--pbl-text-strong)]">{pct}%</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

function isQuestionAnswered(question: QuizQuestion, answer: string | string[] | undefined): boolean {
  if (!answer) return false;
  if (!Array.isArray(answer)) return answer.trim().length > 0;
  if (question.format !== 'matching') return answer.length > 0;

  const expectedLeftIds = new Set((question.matchingPairs ?? []).map((pair) => pair.leftId));
  const answeredLeftIds = new Set(answer.map((relation) => relation.split(':', 1)[0]).filter(Boolean));
  return expectedLeftIds.size >= 2
    && expectedLeftIds.size === answeredLeftIds.size
    && [...expectedLeftIds].every((id) => answeredLeftIds.has(id));
}

export function QuizView({ questions, sceneId, quizOutlineId }: QuizViewProps) {
  const { t, locale } = useI18n();
  const prefersReducedMotion = useReducedMotion();
  const lockedAttempt = useLockedKnowledgeLectureAttempt(sceneId, quizOutlineId);
  const lockedSubmitted = useMemo<SubmittedState>(() => {
    if (!lockedAttempt) return null;
    const reviews = new Map(lockedAttempt.questions.map((question) => [question.questionId, question]));
    const restoredAnswers = Object.fromEntries(questions.map((question) => {
      const answer = reviews.get(question.id)?.answer ?? '';
      return [question.id, question.type === 'multiple' || question.type === 'matching'
        ? answer.split('、').filter(Boolean)
        : answer];
    }));
    return {
      kind: 'reviewing',
      answers: restoredAnswers,
      results: lockedAttempt.questions.map((question) => {
        const correct = question.correct ?? (question.points > 0 && question.earned / question.points >= 0.8);
        return {
          questionId: question.questionId,
          correct,
          status: correct ? 'correct' as const : 'incorrect' as const,
          earned: question.earned,
          aiComment: question.feedback,
        };
      }),
    };
  }, [lockedAttempt, questions]);

  // Rehydrate submitted state from localStorage on first mount. Runs once.
  const [initialSubmitted] = useState<SubmittedState>(() => lockedSubmitted ?? readSubmittedState(sceneId));

  const [phase, setPhase] = useState<Phase>(() => {
    if (initialSubmitted?.kind === 'reviewing') return 'reviewing';
    if (initialSubmitted?.kind === 'answering') return 'answering';
    return 'not_started';
  });
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(
    () => initialSubmitted?.answers ?? {},
  );
  const [results, setResults] = useState<QuestionResult[]>(() =>
    initialSubmitted?.kind === 'reviewing' ? initialSubmitted.results : [],
  );
  const [reviewReleased, setReviewReleased] = useState(false);

  // Draft cache for quiz answers, keyed by sceneId to isolate across classrooms
  const {
    cachedValue: cachedAnswers,
    updateCache: updateAnswersCache,
    clearCache: clearAnswersCache,
  } = useDraftCache<Record<string, string | string[]>>({
    key: draftKey(sceneId),
  });

  // Restore cached draft answers (only when there is no submitted state).
  const [prevCachedAnswers, setPrevCachedAnswers] = useState(cachedAnswers);
  if (cachedAnswers !== prevCachedAnswers) {
    setPrevCachedAnswers(cachedAnswers);
    if (
      !initialSubmitted &&
      cachedAnswers &&
      Object.keys(cachedAnswers).length > 0 &&
      phase === 'not_started'
    ) {
      setAnswers(cachedAnswers);
      setPhase('answering');
    }
  }

  const totalPoints = useMemo(
    () => questions.reduce((sum, q) => sum + (q.points ?? 1), 0),
    [questions],
  );

  const answeredCount = useMemo(
    () => questions.filter((question) => isQuestionAnswered(question, answers[question.id])).length,
    [questions, answers],
  );
  const allAnswered = answeredCount === questions.length && questions.length > 0;
  const remainingCount = questions.length - answeredCount;

  const handleSetAnswer = useCallback(
    (questionId: string, value: string | string[]) => {
      setAnswers((prev) => {
        const next = { ...prev, [questionId]: value };
        updateAnswersCache(next);
        return next;
      });
    },
    [updateAnswersCache],
  );

  const handleSubmit = useCallback(() => {
    setPhase('grading');
    clearAnswersCache();
    writeSubmittedAnswers(sceneId, answers);
  }, [clearAnswersCache, answers, sceneId]);

  // When entering grading phase, grade choice questions locally + call API for short-answer
  useEffect(() => {
    if (phase !== 'grading') return;
    let cancelled = false;

    (async () => {
      // 1. Grade choice questions locally (instant)
      const choiceResults = gradeChoiceQuestions(questions, answers);

      // 2. Grade short-answer questions via AI API (parallel)
      const shortAnswerQs = questions.filter(isShortAnswer);
      const aiResults = await Promise.all(
        shortAnswerQs.map((q) =>
          gradeShortAnswerQuestion(q, (answers[q.id] as string) ?? '', locale),
        ),
      );

      if (cancelled) return;

      // 3. Merge results in original question order
      const allResultsMap = new Map<string, QuestionResult>();
      for (const r of [...choiceResults, ...aiResults]) {
        allResultsMap.set(r.questionId, r);
      }
      const ordered = questions.map((q) => allResultsMap.get(q.id)!).filter(Boolean);

      setResults(ordered);
      setPhase('reviewing');
      writeSubmittedResults(sceneId, ordered);
    })();

    return () => {
      cancelled = true;
    };
  }, [phase, questions, answers, locale, sceneId]);

  const hasIncorrectAnswer = useMemo(
    () => results.some((result) => result.status === 'incorrect'),
    [results],
  );

  // Publishing results must never release the quiz gate. Perfect submissions
  // and restored reviews also remain here until explicit learner confirmation.
  useEffect(() => {
    if (phase !== 'reviewing') return;
    window.dispatchEvent(new CustomEvent(KNOWLEDGE_LECTURE_QUIZ_REVIEWED_EVENT, {
      detail: { sceneId },
    }));
  }, [phase, sceneId]);

  const handleExplain = useCallback((questionId: string) => {
    window.dispatchEvent(new CustomEvent(KNOWLEDGE_LECTURE_EXPLAIN_EVENT, {
      detail: { sceneId, questionId },
    }));
  }, [sceneId]);

  const handleContinueAfterReview = useCallback(() => {
    dispatchPlaybackActivityComplete({ sceneId, purpose: 'quiz' });
    setReviewReleased(true);
  }, [sceneId]);

  const earnedScore = useMemo(() => results.reduce((sum, r) => sum + r.earned, 0), [results]);

  const resultMap = useMemo(() => {
    const map: Record<string, QuestionResult> = {};
    results.forEach((r) => {
      map[r.questionId] = r;
    });
    return map;
  }, [results]);

  return (
    <MotionConfig reducedMotion={prefersReducedMotion ? 'always' : 'user'}>
      <div className="flex h-full w-full flex-col overflow-hidden bg-[var(--pbl-bg)] text-[var(--pbl-text)]">
        <AnimatePresence mode="wait">
          {phase === 'not_started' && (
            <motion.div
              key="cover"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="min-h-0 flex-1"
            >
              <QuizCover
                questionCount={questions.length}
                totalPoints={totalPoints}
                onStart={() => setPhase('answering')}
              />
            </motion.div>
          )}

          {phase === 'answering' && (
            <motion.div
              key="answering"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <header className="shrink-0 border-b border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-4 py-3 sm:px-6">
                <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <ClipboardCheck className="size-4 shrink-0 text-[var(--pbl-student)]" aria-hidden="true" />
                      <h3 className="truncate text-sm font-semibold text-[var(--pbl-text-strong)]">{t('quiz.answering')}</h3>
                    </div>
                    <p className="mt-1 text-xs text-[var(--pbl-text-muted)]" aria-live="polite">
                      已完成 {answeredCount} / {questions.length}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs font-medium text-[var(--pbl-text-muted)]">
                    {remainingCount > 0 ? `还剩 ${remainingCount} 题` : '已全部完成'}
                  </span>
                </div>
                <div className="mx-auto mt-3 h-1 max-w-4xl overflow-hidden rounded-full bg-[var(--pbl-surface-soft)]" aria-hidden="true">
                  <div
                    className="h-full rounded-full bg-[var(--pbl-student)] transition-[width] duration-200 motion-reduce:transition-none"
                    style={{ width: `${questions.length > 0 ? (answeredCount / questions.length) * 100 : 0}%` }}
                  />
                </div>
              </header>

              <main className="flex-1 overflow-y-auto">
                <div className="mx-auto max-w-4xl space-y-4 px-3 py-4 sm:px-6 sm:py-6">
                  {questions.map((q, i) => {
                    if (q.format === 'matching') {
                      return (
                        <MatchingQuestion
                          key={q.id}
                          question={q}
                          index={i}
                          value={answers[q.id] as string[] | undefined}
                          onChange={(v) => handleSetAnswer(q.id, v)}
                        />
                      );
                    }
                    if (q.type === 'single') {
                      return (
                        <SingleChoiceQuestion
                          key={q.id}
                          question={q}
                          index={i}
                          value={answers[q.id] as string | undefined}
                          onChange={(v) => handleSetAnswer(q.id, v)}
                        />
                      );
                    }
                    if (q.type === 'multiple') {
                      return (
                        <MultipleChoiceQuestion
                          key={q.id}
                          question={q}
                          index={i}
                          value={answers[q.id] as string[] | undefined}
                          onChange={(v) => handleSetAnswer(q.id, v)}
                        />
                      );
                    }
                    return (
                      <ShortAnswerQuestion
                        key={q.id}
                        question={q}
                        index={i}
                        value={answers[q.id] as string | undefined}
                        onChange={(v) => handleSetAnswer(q.id, v)}
                      />
                    );
                  })}
                </div>
              </main>

              <footer className="shrink-0 border-t border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-4 py-3 sm:px-6">
                <div className="mx-auto flex max-w-4xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs leading-5 text-[var(--pbl-text-muted)]" aria-live="polite">
                    {allAnswered ? '所有题目均已作答，请检查后提交。' : `完成剩余 ${remainingCount} 题后即可提交。`}
                  </p>
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={!allAnswered}
                    className={cn(
                      'inline-flex min-h-11 items-center justify-center rounded-[10px] px-5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pbl-student)] focus-visible:ring-offset-2',
                      allAnswered
                        ? 'bg-[var(--pbl-student)] text-white hover:bg-[var(--pbl-student-hover)]'
                        : 'cursor-not-allowed bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-subtle)]',
                    )}
                  >
                    {t('quiz.submitAnswers')}
                  </button>
                </div>
              </footer>
            </motion.div>
          )}

          {phase === 'grading' && (
            <motion.div
              key="grading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-1 flex-col items-center justify-center gap-4 px-6"
              role="status"
              aria-live="polite"
            >
              <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }}>
                <Loader2 className="size-9 text-[var(--pbl-student)]" aria-hidden="true" />
              </motion.div>
              <div className="text-center">
                <p className="text-base font-semibold text-[var(--pbl-text-strong)]">正在批阅</p>
                <p className="mt-1 text-sm text-[var(--pbl-text-muted)]">{t('quiz.aiGradingWait')}</p>
              </div>
            </motion.div>
          )}

          {phase === 'reviewing' && (
            <motion.div
              key="reviewing"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <header className="shrink-0 border-b border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-4 py-3 sm:px-6">
                <div className="mx-auto flex max-w-4xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="size-4 text-[var(--pbl-success)]" aria-hidden="true" />
                    <h3 className="text-sm font-semibold text-[var(--pbl-text-strong)]">{t('quiz.quizReport')}</h3>
                  </div>
                  <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--pbl-text-muted)]">
                    <LockKeyhole className="size-3.5" aria-hidden="true" />
                    本小节测验仅可作答一次
                  </span>
                </div>
              </header>

              <main className="flex-1 overflow-y-auto">
                <div className="mx-auto max-w-4xl space-y-4 px-3 py-4 sm:px-6 sm:py-6">
                  <ScoreBanner score={earnedScore} total={totalPoints} results={results} />

                  {questions.map((q, i) => {
                    const r = resultMap[q.id];
                    if (q.format === 'matching') {
                      return (
                        <MatchingQuestion
                          key={q.id}
                          question={q}
                          index={i}
                          value={answers[q.id] as string[] | undefined}
                          onChange={() => {}}
                          disabled
                          result={r}
                          onExplain={() => handleExplain(q.id)}
                        />
                      );
                    }
                    if (q.type === 'single') {
                      return (
                        <SingleChoiceQuestion
                          key={q.id}
                          question={q}
                          index={i}
                          value={answers[q.id] as string | undefined}
                          onChange={() => {}}
                          disabled
                          result={r}
                          onExplain={() => handleExplain(q.id)}
                        />
                      );
                    }
                    if (q.type === 'multiple') {
                      return (
                        <MultipleChoiceQuestion
                          key={q.id}
                          question={q}
                          index={i}
                          value={answers[q.id] as string[] | undefined}
                          onChange={() => {}}
                          disabled
                          result={r}
                          onExplain={() => handleExplain(q.id)}
                        />
                      );
                    }
                    return (
                      <ShortAnswerQuestion
                        key={q.id}
                        question={q}
                        index={i}
                        value={answers[q.id] as string | undefined}
                        onChange={() => {}}
                        disabled
                        result={r}
                        onExplain={() => handleExplain(q.id)}
                      />
                    );
                  })}
                </div>
              </main>

              <footer className="shrink-0 border-t border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-4 py-3 sm:px-6">
                <div className="mx-auto flex max-w-4xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[var(--pbl-text-strong)]">完成查看后，再继续课程</p>
                    <p className="mt-1 text-xs leading-5 text-[var(--pbl-text-muted)]">
                      {hasIncorrectAnswer
                        ? '请查看错题解析，需要时打开助教讲解。确认理解后课程才会继续。'
                        : '请确认本次小测结果，确认理解后课程才会继续。'}
                    </p>
                  </div>
                  <button
                    className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-[10px] bg-[var(--pbl-student)] px-5 text-sm font-semibold text-white transition-colors hover:bg-[var(--pbl-student-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pbl-student)] focus-visible:ring-offset-2 disabled:cursor-default disabled:bg-[var(--pbl-success)]"
                    disabled={reviewReleased}
                    onClick={handleContinueAfterReview}
                    type="button"
                  >
                    {reviewReleased ? <CheckCircle2 className="size-4" aria-hidden="true" /> : null}
                    {reviewReleased ? '已确认理解' : '我已经理解，可以继续'}
                    {!reviewReleased ? <ArrowRight className="size-4" aria-hidden="true" /> : null}
                  </button>
                </div>
              </footer>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
