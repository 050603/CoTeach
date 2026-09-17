import type { QuizMatchingPair, QuizOption, QuizQuestion } from '@openmaic/lib/types/stage';

export const SUPPORTED_QUIZ_FORMATS = [
  'single_choice',
  'multiple_choice',
  'true_false',
  'matching',
  'fill_blank',
  'short_answer',
  'scenario_task',
] as const;

export type SupportedQuizFormat = (typeof SUPPORTED_QUIZ_FORMATS)[number];

export interface QuizNormalizationResult {
  questions: QuizQuestion[];
  issues: string[];
}

const GENERATABLE_FORMATS = new Set(['single', 'multiple', 'matching', 'short_answer', 'true_false', 'fill_blank', 'scenario_task']);

export function selectQuizFormats(input: {
  objectiveText: string;
  difficulty: 'easy' | 'medium' | 'hard';
  questionCount: number;
  requested?: string[];
}): string[] {
  const selected = (input.requested ?? []).filter((item) => GENERATABLE_FORMATS.has(item));
  const textValue = input.objectiveText.toLowerCase();
  const candidates: string[] = [];
  if (/判断|辨认|识别|概念|定义|recogn|identify|define/.test(textValue)) candidates.push('true_false', 'single');
  if (/对应|配对|匹配|关系|术语.*含义|概念.*例子|match|pair|correspond|relation/.test(textValue)) candidates.push('matching');
  if (/比较|分类|证据|多种|compare|classif|evidence/.test(textValue)) candidates.push('multiple');
  if (/解释|原因|机制|说明|explain|why|mechanism/.test(textValue)) candidates.push('short_answer');
  if (/应用|解决|设计|情境|案例|迁移|apply|solve|design|scenario|case/.test(textValue)) candidates.push('scenario_task');
  if (/术语|关键词|关系|填|term|keyword|relation/.test(textValue)) candidates.push('fill_blank');
  if (candidates.length === 0) candidates.push('single', input.difficulty === 'easy' ? 'true_false' : 'short_answer');
  if (input.difficulty === 'hard') candidates.push('scenario_task');

  const merged = selected.length > 0
    ? Array.from(new Set([
        ...candidates.filter((candidate) => selected.includes(candidate)),
        ...selected,
      ]))
    : Array.from(new Set(candidates));
  const maxFormats = Math.max(1, Math.min(input.questionCount, 3));
  return merged.slice(0, maxFormats);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function rawAnswer(record: Record<string, unknown>): unknown {
  return record.answer ?? record.correctAnswer ?? record.correct_answer;
}

function answerArray(record: Record<string, unknown>): string[] {
  const value = rawAnswer(record);
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return [String(value).trim()];
}

function normalizeOptions(value: unknown): QuizOption[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const fallback = String.fromCharCode(65 + index);
    if (typeof item === 'string') return { value: fallback, label: item.trim() || fallback };
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      value: text(record.value) || fallback,
      label: text(record.label) || text(record.text) || text(record.value) || fallback,
    };
  });
}

function semanticFormat(rawType: string, rawFormat: string): SupportedQuizFormat {
  const value = `${rawFormat || rawType}`.toLowerCase().replace(/[\s-]+/g, '_');
  if (/match|matching|drag|配对|匹配|拖拽/.test(value)) return 'matching';
  if (/true_false|judg|判断|boolean/.test(value)) return 'true_false';
  if (/fill|blank|填空/.test(value)) return 'fill_blank';
  if (/scenario|situation|情境|case_task/.test(value)) return 'scenario_task';
  if (/multiple|multi_choice|多选/.test(value)) return 'multiple_choice';
  if (/short|text|essay|简答/.test(value)) return 'short_answer';
  return 'single_choice';
}

function unsupportedStructuredType(rawType: string): boolean {
  return /connect|line|order|sort|排序|连线/.test(rawType.toLowerCase());
}

function normalizeMatchingPairs(value: unknown): QuizMatchingPair[] {
  if (!Array.isArray(value)) return [];
  const pairs = value.slice(0, 8).flatMap((item, index): QuizMatchingPair[] => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const left = text(record.left) || text(record.term) || text(record.source) || text(record.prompt);
    const right = text(record.right) || text(record.definition) || text(record.target) || text(record.match);
    if (!left || !right) return [];
    const leftId = text(record.leftId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    const rightId = text(record.rightId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    return [{
      leftId: leftId || `L${index + 1}`,
      left,
      rightId: rightId || `R${index + 1}`,
      right,
    }];
  });
  const leftIds = new Set<string>();
  const rightIds = new Set<string>();
  const leftLabels = new Set<string>();
  const rightLabels = new Set<string>();
  return pairs.filter((pair) => {
    if (leftIds.has(pair.leftId) || rightIds.has(pair.rightId)
      || leftLabels.has(pair.left) || rightLabels.has(pair.right)) return false;
    leftIds.add(pair.leftId);
    rightIds.add(pair.rightId);
    leftLabels.add(pair.left);
    rightLabels.add(pair.right);
    return true;
  });
}

function explainUnsupported(record: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(record.options)) {
    parts.push((record.options as unknown[]).map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('；'));
  }
  if (Array.isArray(record.pairs)) {
    parts.push((record.pairs as unknown[]).map((item) => JSON.stringify(item)).join('；'));
  }
  return parts.filter(Boolean).join('；').slice(0, 500);
}

function choiceAnalysis(options: QuizOption[], answers: string[], original: string): string {
  if (original.length >= 12) return original;
  const labels = answers.map((answer) => options.find((option) => option.value === answer)?.label ?? answer);
  return `正确答案为${labels.join('、')}。判断时应回到题目对应的核心概念，说明这些选项为什么符合条件，并辨析其他选项所反映的常见误解。`;
}

export function normalizeQuizQuestions(
  input: unknown,
  config: {
    allowedKnowledgePointIds?: readonly string[];
    fallbackKnowledgePointIds?: readonly string[];
  } = {},
): QuizNormalizationResult {
  const issues: string[] = [];
  const allowedKnowledgePointIds = config.allowedKnowledgePointIds
    ? new Set(config.allowedKnowledgePointIds)
    : undefined;
  const rawQuestions = Array.isArray(input) ? input : [];
  const questions = rawQuestions.flatMap((value, index): QuizQuestion[] => {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const question = text(record.question) || text(record.prompt) || text(record.title);
    if (!question) {
      issues.push(`question ${index + 1}: missing stem and removed`);
      return [];
    }
    const rawType = text(record.type) || 'single';
    const id = text(record.id) || `q_${index + 1}`;
    const requestedKnowledgePointIds = Array.isArray(record.knowledgePointIds)
      ? record.knowledgePointIds.map(text).filter(Boolean)
      : [];
    const validKnowledgePointIds = Array.from(new Set(requestedKnowledgePointIds.filter((knowledgePointId) =>
      !allowedKnowledgePointIds || allowedKnowledgePointIds.has(knowledgePointId),
    )));
    const knowledgePointIds = validKnowledgePointIds.length > 0
      ? validKnowledgePointIds
      : Array.from(new Set(config.fallbackKnowledgePointIds ?? [])).filter((knowledgePointId) =>
          !allowedKnowledgePointIds || allowedKnowledgePointIds.has(knowledgePointId),
        );
    const teachingUnitIds = Array.isArray(record.teachingUnitIds)
      ? Array.from(new Set(record.teachingUnitIds.map(text).filter(Boolean)))
      : [];
    const pointsValue = Number(record.points);
    const points = Number.isFinite(pointsValue) && pointsValue > 0 ? Math.min(100, Math.round(pointsValue)) : 10;
    const originalAnalysis = text(record.analysis) || text(record.explanation);

    const format = semanticFormat(rawType, text(record.format));
    if (format === 'matching') {
      const matchingPairs = normalizeMatchingPairs(record.matchingPairs ?? record.pairs);
      if (matchingPairs.length >= 2) {
        return [{
          id,
          knowledgePointIds,
          teachingUnitIds,
          type: 'matching',
          format: 'matching',
          question,
          matchingPairs,
          answer: matchingPairs.map((pair) => `${pair.leftId}:${pair.rightId}`),
          analysis: originalAnalysis || '正确配对应体现每个概念、对象或步骤与其对应特征之间的准确关系。',
          hasAnswer: true,
          points,
        }];
      }
      issues.push(`question ${index + 1}: invalid matching structure repaired as fill_blank`);
      return [{
        id,
        knowledgePointIds,
        teachingUnitIds,
        type: 'short_answer',
        format: 'fill_blank',
        question: `${question}\n请填写最关键的一组对应关系。`,
        analysis: originalAnalysis || '参考答案应准确写出题干要求的核心对应关系。',
        commentPrompt: '评分规则：对应对象准确占80%；语义等价占20%。不要求展开论述。',
        hasAnswer: false,
        points,
      }];
    }

    if (unsupportedStructuredType(rawType)) {
      issues.push(`question ${index + 1}: unsupported ${rawType} downgraded to scenario_task`);
      const structure = explainUnsupported(record);
      return [{
        id,
        knowledgePointIds,
        teachingUnitIds,
        type: 'short_answer',
        format: 'scenario_task',
        question: structure ? `${question}\n请用“对象—对应关系/顺序—理由”的方式作答。可参考待处理项目：${structure}` : `${question}\n请写出完整关系或顺序，并说明理由。`,
        analysis: originalAnalysis || '参考答案应给出完整关系或顺序，并根据当前知识点解释每一项判断的依据。',
        commentPrompt: text(record.commentPrompt) || '评分规则：关系或顺序完整且正确占60%；理由符合当前知识点占30%；表达清楚占10%。',
        hasAnswer: false,
        points,
      }];
    }

    if (format === 'fill_blank' || format === 'short_answer' || format === 'scenario_task') {
      return [{
        id,
        knowledgePointIds,
        teachingUnitIds,
        type: 'short_answer',
        format,
        question,
        analysis: originalAnalysis || '参考答案必须围绕当前知识点给出关键概念、判断依据和必要步骤，而不只是结论。',
        commentPrompt: text(record.commentPrompt) || (format === 'fill_blank'
          ? '评分规则：关键概念准确占70%；语义符合题干占20%；表达清楚占10%。允许语义等价表述。'
          : '评分规则：核心概念和结论占40%；推理或证据占40%；表达清楚占20%。'),
        hasAnswer: false,
        points,
      }];
    }

    let options = normalizeOptions(record.options);
    let answers = answerArray(record);
    if (format === 'true_false') {
      options = [{ value: 'true', label: '正确' }, { value: 'false', label: '错误' }];
      answers = answers.map((answer) => /^(true|正确|对|是|1)$/i.test(answer) ? 'true' : 'false').slice(0, 1);
    } else {
      answers = answers.map((answer) => {
        const byValue = options.find((option) => option.value === answer);
        if (byValue) return byValue.value;
        return options.find((option) => option.label === answer)?.value ?? answer;
      });
    }
    answers = Array.from(new Set(answers.filter((answer) => options.some((option) => option.value === answer))));

    if (options.length < 2 || answers.length === 0) {
      issues.push(`question ${index + 1}: invalid choice structure repaired as fill_blank`);
      return [{
        id,
        knowledgePointIds,
        teachingUnitIds,
        type: 'short_answer',
        format: 'fill_blank',
        question: `${question}\n请只填写关键概念或正确结论。`,
        analysis: originalAnalysis || '参考答案应给出题干要求的关键概念或正确结论。',
        commentPrompt: text(record.commentPrompt) || '评分规则：关键概念或结论准确占80%；语义等价占20%。不要求展开论述。',
        hasAnswer: false,
        points,
      }];
    }

    const type = format === 'multiple_choice' && answers.length > 1 ? 'multiple' : 'single';
    if (format === 'multiple_choice' && type === 'single') {
      issues.push(`question ${index + 1}: multiple choice had fewer than two answers and was repaired as single choice`);
    }
    return [{
      id,
      knowledgePointIds,
      teachingUnitIds,
      type,
      format: type === 'multiple' ? 'multiple_choice' : format,
      question,
      options,
      answer: type === 'single' ? answers.slice(0, 1) : answers,
      analysis: choiceAnalysis(options, type === 'single' ? answers.slice(0, 1) : answers, originalAnalysis),
      hasAnswer: true,
      points,
    }];
  });

  return { questions, issues };
}
