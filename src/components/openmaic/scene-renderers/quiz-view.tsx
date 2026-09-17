'use client';

import { memo, useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  PieChart,
  CheckCircle2,
  XCircle,
  LockKeyhole,
  ChevronRight,
  Check,
  BookOpenText,
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
    <div className="w-full h-full flex flex-col items-center justify-center gap-4 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-0 right-0 p-6 opacity-[0.03]">
        <PieChart className="w-52 h-52 text-violet-500" />
      </div>
      <div className="absolute bottom-0 left-0 p-6 opacity-[0.02]">
        <BookOpenText className="w-40 h-40 text-violet-500 rotate-12" />
      </div>

      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 20 }}
        className="w-16 h-16 bg-gradient-to-br from-violet-100 to-purple-50 dark:from-violet-900/50 dark:to-purple-900/30 rounded-2xl flex items-center justify-center shadow-lg shadow-violet-100 dark:shadow-violet-900/30 ring-1 ring-violet-200/50 dark:ring-violet-700/50"
      >
        <PieChart className="w-8 h-8 text-violet-500" />
      </motion.div>

      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1 }}
        className="text-center z-10"
      >
        <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100">{t('quiz.title')}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('quiz.subtitle')}</p>
      </motion.div>

      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="flex gap-5 text-sm z-10"
      >
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
          <div className="w-7 h-7 rounded-lg bg-violet-50 dark:bg-violet-900/30 flex items-center justify-center">
            <BookOpenText className="w-3.5 h-3.5 text-violet-500" />
          </div>
          <span>
            {questionCount} {t('quiz.questionsCount')}
          </span>
        </div>
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
          <div className="w-7 h-7 rounded-lg bg-violet-50 dark:bg-violet-900/30 flex items-center justify-center">
            <PieChart className="w-3.5 h-3.5 text-violet-500" />
          </div>
          <span>
            {t('quiz.totalPrefix')} {totalPoints} {t('quiz.pointsSuffix')}
          </span>
        </div>
      </motion.div>

      <motion.button
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.3 }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={onStart}
        className="mt-1 px-8 py-2.5 bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded-full font-medium shadow-lg shadow-violet-200/50 dark:shadow-violet-900/50 hover:shadow-violet-300/50 transition-shadow z-10 flex items-center gap-2"
      >
        {t('quiz.startQuiz')}
        <ChevronRight className="w-4 h-4" />
      </motion.button>
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
              disabled={disabled}
              onClick={() => !disabled && onChange(opt.value)}
              className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all text-sm',
                // Default state
                !isReview &&
                  !selected &&
                  'border-gray-200 dark:border-gray-600 hover:border-violet-200 dark:hover:border-violet-700 hover:bg-violet-50/50 dark:hover:bg-violet-900/30',
                !isReview &&
                  selected &&
                  'border-violet-400 bg-violet-50 dark:bg-violet-900/30 ring-1 ring-violet-200 dark:ring-violet-700',
                // Review states
                isReview &&
                  isCorrectOpt &&
                  'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30',
                isReview &&
                  isWrong &&
                  !isCorrectOpt &&
                  'border-red-300 bg-red-50 dark:bg-red-900/30',
                isReview &&
                  !isCorrectOpt &&
                  !selected &&
                  'border-gray-100 dark:border-gray-700 opacity-60',
                disabled && !isReview && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-colors',
                  !isReview &&
                    !selected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
                  !isReview && selected && 'bg-violet-500 text-white',
                  isReview && isCorrectOpt && 'bg-[var(--pbl-success)] text-white',
                  isReview && isWrong && !isCorrectOpt && 'bg-red-400 text-white',
                  isReview &&
                    !isCorrectOpt &&
                    !selected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500',
                )}
              >
                {opt.value}
              </span>
              <span
                className={cn(
                  'flex-1',
                  isReview && !isCorrectOpt && !selected && 'text-gray-400 dark:text-gray-500',
                )}
              >
                <QuizMathText text={opt.label} />
              </span>
              {isReview && isCorrectOpt && (
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
              )}
              {isReview && isWrong && !isCorrectOpt && (
                <XCircle className="w-5 h-5 text-red-400 shrink-0" />
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
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">
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
              disabled={disabled}
              onClick={() => toggle(opt.value)}
              className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all text-sm',
                !isReview &&
                  !isSelected &&
                  'border-gray-200 dark:border-gray-600 hover:border-violet-200 dark:hover:border-violet-700 hover:bg-violet-50/50 dark:hover:bg-violet-900/30',
                !isReview &&
                  isSelected &&
                  'border-violet-400 bg-violet-50 dark:bg-violet-900/30 ring-1 ring-violet-200 dark:ring-violet-700',
                isReview &&
                  isCorrectOpt &&
                  'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30',
                isReview && isWrong && 'border-red-300 bg-red-50 dark:bg-red-900/30',
                isReview &&
                  !isCorrectOpt &&
                  !isSelected &&
                  'border-gray-100 dark:border-gray-700 opacity-60',
                disabled && !isReview && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 transition-colors',
                  !isReview &&
                    !isSelected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
                  !isReview && isSelected && 'bg-violet-500 text-white',
                  isReview && isCorrectOpt && 'bg-[var(--pbl-success)] text-white',
                  isReview && isWrong && 'bg-red-400 text-white',
                  isReview &&
                    !isCorrectOpt &&
                    !isSelected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500',
                )}
              >
                {!isReview && isSelected ? <Check className="w-3.5 h-3.5" /> : opt.value}
              </span>
              <span
                className={cn(
                  'flex-1',
                  isReview && !isCorrectOpt && !isSelected && 'text-gray-400 dark:text-gray-500',
                )}
              >
                <QuizMathText text={opt.label} />
              </span>
              {isReview && isCorrectOpt && (
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
              )}
              {isReview && isWrong && <XCircle className="w-5 h-5 text-red-400 shrink-0" />}
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

  return (
    <QuestionCard question={question} index={index} result={result} onExplain={onExplain}>
      {!review && (
        <p className="mb-3 text-xs text-gray-400 dark:text-gray-500">
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
              <button
                key={pair.leftId}
                type="button"
                disabled={disabled}
                aria-label={`匹配到 ${pair.left}`}
                onClick={() => selectedRightId && assign(pair.leftId, selectedRightId)}
                onDragOver={(event) => {
                  if (!disabled) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const draggedRightId = event.dataTransfer.getData('application/x-openpbl-match');
                  if (draggedRightId) assign(pair.leftId, draggedRightId);
                }}
                className={cn(
                  'grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition',
                  !review && 'border-gray-200 hover:border-violet-300 hover:bg-violet-50/40 dark:border-gray-600 dark:hover:border-violet-700',
                  !review && selectedRightId && 'border-dashed border-violet-400 bg-violet-50/60 dark:bg-violet-900/20',
                  isCorrect && 'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30',
                  isWrong && 'border-red-300 bg-red-50 dark:bg-red-900/30',
                )}
              >
                <span className="font-medium text-gray-800 dark:text-gray-100">{pair.left}</span>
                <span className={cn(
                  'rounded-lg border border-dashed px-3 py-2 text-gray-500 dark:border-gray-600 dark:text-gray-300',
                  rightId && 'border-solid border-violet-200 bg-white dark:border-violet-700 dark:bg-gray-800',
                )}>
                  <span className="block">{rightId ? rightById.get(rightId) : '放置匹配项'}</span>
                  {isWrong && <span className="mt-1 block text-xs font-medium text-emerald-700 dark:text-emerald-300">正确：{pair.right}</span>}
                </span>
              </button>
            );
          })}
        </div>
        {!review && (
          <div className="space-y-2">
            {shuffledRight.map((pair) => {
              const used = [...relationMap.values()].includes(pair.rightId);
              return (
                <button
                  key={pair.rightId}
                  type="button"
                  draggable={!disabled}
                  aria-pressed={selectedRightId === pair.rightId}
                  aria-label={`选择匹配项 ${pair.right}`}
                  onClick={() => !disabled && setSelectedRightId(pair.rightId)}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/x-openpbl-match', pair.rightId);
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition',
                    selectedRightId === pair.rightId
                      ? 'border-violet-400 bg-violet-50 text-violet-800 ring-1 ring-violet-200 dark:bg-violet-900/30 dark:text-violet-200'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-violet-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200',
                    used && selectedRightId !== pair.rightId && 'opacity-50',
                  )}
                >
                  <GripVertical className="h-4 w-4 shrink-0 text-gray-400" />
                  <span>{pair.right}</span>
                </button>
              );
            })}
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
              className="w-full h-12 px-3 pr-24 rounded-xl border border-gray-200 dark:border-gray-600 text-sm focus:outline-none focus:border-violet-300 dark:focus:border-violet-600 focus:ring-2 focus:ring-violet-100 dark:focus:ring-violet-900/50 transition-all disabled:bg-gray-50 dark:disabled:bg-gray-800 disabled:text-gray-500 dark:bg-gray-800/50 dark:text-gray-200 dark:placeholder:text-gray-500"
            />
          ) : (
            <textarea
              value={value ?? ''}
              onChange={(e) => onChange(e.target.value)}
              disabled={disabled}
              placeholder={question.format === 'scenario_task' ? '写出你的判断、依据和解决思路' : t('quiz.inputPlaceholder')}
              className="w-full min-h-[100px] p-3 pb-10 rounded-xl border border-gray-200 dark:border-gray-600 text-sm resize-none focus:outline-none focus:border-violet-300 dark:focus:border-violet-600 focus:ring-2 focus:ring-violet-100 dark:focus:ring-violet-900/50 transition-all disabled:bg-gray-50 dark:disabled:bg-gray-800 disabled:text-gray-500 dark:bg-gray-800/50 dark:text-gray-200 dark:placeholder:text-gray-500"
            />
          )}
          <SpeechButton
            size="sm"
            disabled={disabled}
            className="absolute bottom-3 left-3"
            onTranscription={(text) => {
              const cur = valueRef.current ?? '';
              onChange(cur + (cur ? ' ' : '') + text);
            }}
          />
          <span className="absolute bottom-3 right-3 text-xs text-gray-300 dark:text-gray-600">
            {(value ?? '').length} {t('quiz.charCount')}
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-300">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">{t('quiz.yourAnswer')}</p>
            {value ? (
              <QuizMathText text={value} />
            ) : (
              <span className="text-gray-400 dark:text-gray-500 italic">
                {t('quiz.notAnswered')}
              </span>
            )}
          </div>
          {result.aiComment && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-violet-50 dark:bg-violet-900/30 border border-violet-100 dark:border-violet-800">
              <div>
                <p className="text-xs font-medium text-violet-600 dark:text-violet-400 mb-0.5">
                  {t('quiz.aiComment')}
                </p>
                <p className="text-xs text-violet-600/80 dark:text-violet-400/80">
                  <QuizMathText text={result.aiComment} />
                </p>
              </div>
              <span className="ml-auto text-xs font-bold text-violet-600 dark:text-violet-400 shrink-0">
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
        'bg-white dark:bg-gray-800 rounded-2xl border p-5 relative overflow-hidden',
        !isReview && 'border-gray-150 dark:border-gray-700 shadow-sm',
        isReview &&
          result.status === 'correct' &&
          'border-emerald-200 dark:border-emerald-800 shadow-sm shadow-emerald-50 dark:shadow-emerald-900/20',
        isReview &&
          result.status === 'incorrect' &&
          'border-red-200 dark:border-red-800 shadow-sm shadow-red-50 dark:shadow-red-900/20',
      )}
    >
      {/* Left accent */}
      <div
        className={cn(
          'absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl',
          !isReview && 'bg-violet-400',
          isReview && result.status === 'correct' && 'bg-emerald-400',
          isReview && result.status === 'incorrect' && 'bg-red-400',
        )}
      />

      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0',
              !isReview &&
                'bg-violet-100 dark:bg-violet-900/50 text-violet-600 dark:text-violet-400',
              isReview &&
                result.status === 'correct' &&
                'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400',
              isReview &&
                result.status === 'incorrect' &&
                'bg-red-100 dark:bg-red-900/50 text-red-600 dark:text-red-400',
            )}
          >
            {index + 1}
          </span>
          <div>
            <div className="text-sm font-medium text-gray-800 dark:text-gray-100 leading-relaxed">
              <QuizMathText text={question.question} allowDisplayMode />
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
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
          <div className="shrink-0 ml-2">
            {result.status === 'correct' && <CheckCircle2 className="w-6 h-6 text-emerald-500" />}
            {result.status === 'incorrect' && <XCircle className="w-6 h-6 text-red-400" />}
          </div>
        )}
      </div>

      {/* Body */}
      {children}

      {/* Analysis (review only) */}
      {isReview && (question.analysis || onExplain) && (
        <div className="mt-3 rounded-xl border border-cyan-100 bg-cyan-50/70 p-3 text-xs leading-relaxed text-cyan-950 dark:border-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-200">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {question.analysis ? (
                <><span className="font-bold">{t('quiz.analysis')}</span><QuizMathText text={question.analysis} allowDisplayMode /></>
              ) : (
                <span className="text-stone-500">需要进一步梳理这道题？</span>
              )}
            </div>
            {onExplain ? (
              <button className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-cyan-950 px-3 font-bold text-white transition hover:bg-cyan-900" onClick={onExplain} type="button">
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

  const color = pct >= 80 ? 'emerald' : pct >= 60 ? 'amber' : 'red';
  const colorMap = {
    emerald: {
      bg: 'from-emerald-500 to-teal-500',
      shadow: 'shadow-emerald-200/50 dark:shadow-emerald-900/50',
      ring: 'bg-emerald-400/30',
      text: t('quiz.excellent'),
    },
    amber: {
      bg: 'from-amber-500 to-yellow-500',
      shadow: 'shadow-amber-200/50 dark:shadow-amber-900/50',
      ring: 'bg-amber-400/30',
      text: t('quiz.keepGoing'),
    },
    red: {
      bg: 'from-red-500 to-rose-500',
      shadow: 'shadow-red-200/50 dark:shadow-red-900/50',
      ring: 'bg-red-400/30',
      text: t('quiz.needsReview'),
    },
  };
  const c = colorMap[color];

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className={cn('rounded-2xl p-6 bg-gradient-to-r text-white shadow-lg', c.bg, c.shadow)}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-white/80 text-sm font-medium">{c.text}</p>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-4xl font-bold">{score}</span>
            <span className="text-white/60 text-lg">/ {total}</span>
          </div>
          <div className="flex gap-3 mt-3 text-xs">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> {correctCount} {t('quiz.correct')}
            </span>
            <span className="flex items-center gap-1">
              <XCircle className="w-3.5 h-3.5" /> {incorrectCount} {t('quiz.incorrect')}
            </span>
          </div>
        </div>

        {/* Percentage ring */}
        <div className="relative w-20 h-20">
          <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
            <circle
              cx="40"
              cy="40"
              r="34"
              fill="none"
              stroke="rgba(255,255,255,0.2)"
              strokeWidth="6"
            />
            <motion.circle
              cx="40"
              cy="40"
              r="34"
              fill="none"
              stroke="white"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 34}`}
              initial={{ strokeDashoffset: 2 * Math.PI * 34 }}
              animate={{ strokeDashoffset: 2 * Math.PI * 34 * (1 - pct / 100) }}
              transition={{ duration: 1, ease: 'easeOut', delay: 0.3 }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-lg font-bold">{pct}%</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function QuizView({ questions, sceneId, quizOutlineId }: QuizViewProps) {
  const { t, locale } = useI18n();
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

  const allAnswered = useMemo(() => {
    return questions.every((q) => {
      const a = answers[q.id];
      if (!a) return false;
      if (Array.isArray(a)) {
        if (q.format === 'matching') {
          const expectedLeftIds = new Set((q.matchingPairs ?? []).map((pair) => pair.leftId));
          const answeredLeftIds = new Set(a.map((relation) => relation.split(':', 1)[0]).filter(Boolean));
          return expectedLeftIds.size >= 2
            && expectedLeftIds.size === answeredLeftIds.size
            && [...expectedLeftIds].every((id) => answeredLeftIds.has(id));
        }
        return a.length > 0;
      }
      return (a as string).trim().length > 0;
    });
  }, [questions, answers]);

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
    <div className="w-full h-full bg-gradient-to-b from-gray-50 to-white dark:from-gray-900 dark:to-gray-900 overflow-hidden flex flex-col">
      <AnimatePresence mode="wait">
        {phase === 'not_started' && (
          <motion.div
            key="cover"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1"
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
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1 flex flex-col min-h-0"
          >
            {/* Header bar */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 dark:border-gray-700 bg-white/80 dark:bg-gray-900/80 backdrop-blur shrink-0">
              <div className="flex items-center gap-2">
                <PieChart className="w-4 h-4 text-violet-500" />
                <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                  {t('quiz.answering')}
                </span>
                <span className="text-xs text-gray-400 ml-1">
                  {
                    questions.filter((question) => {
                      const answer = answers[question.id];
                      if (Array.isArray(answer) && question.format === 'matching') {
                        return answer.length === (question.matchingPairs?.length ?? 0) && answer.length >= 2;
                      }
                      if (Array.isArray(answer)) return answer.length > 0;
                      return typeof answer === 'string' && answer.trim().length > 0;
                    }).length
                  }{' '}
                  / {questions.length}
                </span>
              </div>
              <button
                onClick={handleSubmit}
                disabled={!allAnswered}
                className={cn(
                  'px-4 py-1.5 rounded-lg text-xs font-medium transition-all',
                  allAnswered
                    ? 'bg-gradient-to-r from-violet-500 to-purple-500 text-white shadow-sm hover:shadow-md hover:shadow-violet-200/50 dark:hover:shadow-violet-900/50 active:scale-[0.97]'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed',
                )}
              >
                {t('quiz.submitAnswers')}
              </button>
            </div>

            {/* Questions */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
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
          </motion.div>
        )}

        {phase === 'grading' && (
          <motion.div
            key="grading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 flex flex-col items-center justify-center gap-5"
          >
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }}
            >
              <Loader2 className="w-10 h-10 text-violet-500" />
            </motion.div>
            <div className="text-center">
              <p className="text-base font-semibold text-gray-700 dark:text-gray-200">
                正在批阅
              </p>
              <p className="text-sm text-gray-400 mt-1">{t('quiz.aiGradingWait')}</p>
            </div>
            <div className="flex gap-1 mt-2">
              {[0, 1, 2].map((i) => (
                <motion.div
                  key={i}
                  className="w-2 h-2 rounded-full bg-violet-400"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{
                    repeat: Infinity,
                    duration: 1.2,
                    delay: i * 0.2,
                  }}
                />
              ))}
            </div>
          </motion.div>
        )}

        {phase === 'reviewing' && (
          <motion.div
            key="reviewing"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex-1 flex flex-col min-h-0"
          >
            {/* Header bar */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 dark:border-gray-700 bg-white/80 dark:bg-gray-900/80 backdrop-blur shrink-0">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                  {t('quiz.quizReport')}
                </span>
              </div>
              <span className="flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
                <LockKeyhole className="w-3.5 h-3.5" />
                本小节测验仅可作答一次
              </span>
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
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

              <div className="sticky bottom-4 z-10 ml-auto max-w-xl rounded-2xl border border-cyan-200 bg-white/95 p-4 shadow-[0_14px_36px_rgba(8,51,68,.16)] backdrop-blur dark:border-cyan-800 dark:bg-gray-900/95">
                  <div className="flex items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-cyan-950 text-white">
                      <MessageCircleQuestion className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-stone-900 dark:text-stone-100">完成查看后，再继续课程</p>
                      <p className="mt-1 text-xs leading-5 text-stone-500">
                        {hasIncorrectAnswer
                          ? '请先查看错题解析，需要时打开助教讲解。只有点击下方按钮后，课程才会继续。'
                          : '请确认本次小测结果。只有点击下方按钮后，课程才会继续。'}
                      </p>
                      <button
                        className="mt-3 inline-flex h-10 items-center gap-2 rounded-[10px] bg-cyan-950 px-4 text-sm font-bold text-white transition hover:bg-cyan-900 disabled:cursor-default disabled:bg-emerald-600"
                        disabled={reviewReleased}
                        onClick={handleContinueAfterReview}
                        type="button"
                      >
                        {reviewReleased ? <CheckCircle2 className="size-4" /> : null}
                        {reviewReleased ? '已确认理解' : '我已经理解，可以继续'}
                        {!reviewReleased ? <ArrowRight className="size-4" /> : null}
                      </button>
                    </div>
                  </div>
                </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
