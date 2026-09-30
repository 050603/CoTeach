import { hasExplicitFillBlankSlot } from './quality';

/** Authoring data is checked before conversion to the student-facing QuizQuestion. */
export type QuizQuestionDraft = Record<string, unknown> & {
  assessmentEvidence?: Array<{ knowledgePointId: string; observableResponse: string }>;
  optionReasoning?: Array<{ value: string; correct: boolean; reason: string }>;
  referenceAnswer?: string;
};

const value = (input: unknown): string => typeof input === 'string' ? input.trim() : '';
const record = (input: unknown): Record<string, unknown> => input && typeof input === 'object'
  ? input as Record<string, unknown> : {};
const strings = (input: unknown): string[] => Array.isArray(input) ? input.map(value).filter(Boolean) : [];

export function validateQuizQuestionDrafts(
  drafts: readonly unknown[],
  allowedKnowledgePointIds: readonly string[],
): string[] {
  const issues: string[] = [];
  const allowed = new Set(allowedKnowledgePointIds);
  const covered = new Set<string>();

  drafts.forEach((raw, index) => {
    const item = record(raw) as QuizQuestionDraft;
    const label = `question ${index + 1}`;
    const question = value(item.question);
    const type = value(item.format) || value(item.type);
    const ids = strings(item.knowledgePointIds);
    const evidence = Array.isArray(item.assessmentEvidence) ? item.assessmentEvidence.map(record) : [];
    if (!question) issues.push(`${label}: missing stem`);
    if (value(item.analysis).length < 12) issues.push(`${label}: missing substantive analysis`);
    if (ids.length === 0 || ids.some((id) => !allowed.has(id))) issues.push(`${label}: invalid knowledgePointIds`);
    const evidenceIds = evidence.map((entry) => value(entry.knowledgePointId));
    if (evidence.length !== ids.length || new Set(evidenceIds).size !== ids.length
      || evidence.some((entry) => !ids.includes(value(entry.knowledgePointId)) || !value(entry.observableResponse))) {
      issues.push(`${label}: assessmentEvidence must explain observable response for every attributed knowledge point`);
    } else ids.forEach((id) => covered.add(id));

    const isTrueFalse = /true_false/.test(type);
    const isMultiple = /multiple/.test(type);
    const isChoice = isTrueFalse || isMultiple || /^(single|single_choice)$/.test(type);
    const isMatching = /matching/.test(type);
    const isText = /^(fill_blank|short_answer|scenario_task)$/.test(type);
    if (!isChoice && !isMatching && !isText) issues.push(`${label}: unsupported question format`);

    if (isChoice) {
      const options = isTrueFalse
        ? [{ value: 'true', label: '正确' }, { value: 'false', label: '错误' }]
        : Array.isArray(item.options) ? item.options.map((option, optionIndex) => {
          const entry = record(option);
          return typeof option === 'string'
            ? { value: String.fromCharCode(65 + optionIndex), label: option.trim() }
            : { value: value(entry.value), label: value(entry.label) || value(entry.text) };
        }) : [];
      const values = options.map((option) => option.value);
      const labels = options.map((option) => option.label);
      if (options.length < 2 || values.some((entry) => !entry) || labels.some((entry) => !entry)
        || new Set(values).size !== values.length || new Set(labels).size !== labels.length) {
        issues.push(`${label}: choice options must be distinct and nonempty`);
      }
      const answer = item.answer ?? item.correctAnswer ?? item.correct_answer;
      const rawAnswers = (Array.isArray(answer) ? answer : [answer]).map((entry) => String(entry ?? '').trim());
      const answers = isTrueFalse
        ? rawAnswers.map((entry) => /^(true|correct|正确|对|是|1)$/iu.test(entry) ? 'true'
          : /^(false|incorrect|错误|错|否|0)$/iu.test(entry) ? 'false' : '')
        : rawAnswers.map((entry) => options.find((option) => option.value === entry || option.label === entry)?.value ?? '');
      const correct = new Set(answers.filter(Boolean));
      if (answers.some((entry) => !entry) || correct.size !== answers.length
        || (isMultiple ? correct.size < 2 || correct.size >= options.length
          : correct.size !== 1)) issues.push(`${label}: invalid choice answer`);
      const reasoning = Array.isArray(item.optionReasoning) ? item.optionReasoning.map(record) : [];
      const reasonValues = reasoning.map((entry) => value(entry.value));
      if (reasoning.length !== options.length || new Set(reasonValues).size !== options.length
        || reasoning.some((entry) => !values.includes(value(entry.value)) || !value(entry.reason)
          || typeof entry.correct !== 'boolean' || entry.correct !== correct.has(value(entry.value)))) {
        issues.push(`${label}: optionReasoning must justify each correct option and misconception`);
      }
    }
    if (isMatching) {
      const rawPairs = item.matchingPairs ?? item.pairs;
      const pairs = Array.isArray(rawPairs) ? rawPairs.map(record) : [];
      const left = pairs.map((pair) => value(pair.left) || value(pair.term) || value(pair.source));
      const right = pairs.map((pair) => value(pair.right) || value(pair.definition) || value(pair.target));
      if (pairs.length < 2 || left.some((entry) => !entry) || right.some((entry) => !entry)
        || new Set(left).size !== pairs.length || new Set(right).size !== pairs.length) {
        issues.push(`${label}: matching pairs must be complete and distinct`);
      }
    }
    if (isText) {
      if (!value(item.referenceAnswer) || !value(item.commentPrompt)) {
        issues.push(`${label}: text response requires referenceAnswer and specific grading rubric`);
      }
      if (type === 'fill_blank' && !hasExplicitFillBlankSlot(question)) {
        issues.push(`${label}: fill_blank stem has no explicit blank slot`);
      }
      if (item.options !== undefined) issues.push(`${label}: text response cannot include options`);
    }
  });
  const missing = allowedKnowledgePointIds.filter((id) => !covered.has(id));
  if (missing.length) issues.push(`missing substantive knowledge-point evidence: ${missing.join(', ')}`);
  return issues;
}
