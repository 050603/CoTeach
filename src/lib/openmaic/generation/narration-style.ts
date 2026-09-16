import type { Action } from '@openmaic/lib/types/action';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { AICallFn } from './pipeline-types';
import { parseJsonResponse } from './json-repair';
import { enforceNarrationContinuity } from './narration-continuity';
import type { SceneGenerationContext } from './pipeline-types';

type NarrationSegment = { id: string; text: string };

export const NATURAL_NARRATION_VERSION = 'natural-teacher-speech-v2';
const NARRATION_REWRITE_ATTEMPTS = 2;

const META_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: '页面制作视角', pattern: /(?:这一页|这页|本页|上一页|下一页|当前页|页面|幻灯片|课件|PPT)/i },
  { label: '讲稿提纲标签', pattern: /(?:核心观点|核心命题|本页主张|这页的主张|本页给出|这一页给出|本页承担)/ },
  { label: '资料编号', pattern: /(?:资料|材料)\s*[一二三四五六七八九十\d]+\s*(?:指出|要求|强调|认为|提出|说明)?/ },
  { label: '书面排版符号', pattern: /(?:^|\s)[#*]{1,3}\s|```|\|/m },
];

export function narrationStyleIssues(segments: readonly NarrationSegment[]): string[] {
  return segments.flatMap((segment) => {
    const text = segment.text.trim();
    if (!text) return [`${segment.id} 没有讲稿文本`];
    const issues = META_PATTERNS.flatMap((rule) => {
      const match = text.match(rule.pattern);
      return match ? [`${segment.id} 含${rule.label}“${match[0]}”`] : [];
    });
    const sentences = text.split(/[。！？!?；;]/).map((item) => item.trim()).filter(Boolean);
    if (sentences.some((sentence) => sentence.length > 105)) {
      issues.push(`${segment.id} 含超过 105 字的长句`);
    }
    return issues;
  });
}

export function normalizeNarrationRewrite(
  value: unknown,
  expected: readonly NarrationSegment[],
): NarrationSegment[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('口语化讲稿不是 JSON 对象');
  }
  const rawSegments = (value as { segments?: unknown }).segments;
  if (!Array.isArray(rawSegments) || rawSegments.length !== expected.length) {
    throw new Error(`口语化讲稿必须返回 ${expected.length} 个原位段落`);
  }
  const segments = rawSegments.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`口语化讲稿第 ${index + 1} 段格式无效`);
    }
    const record = item as Record<string, unknown>;
    if (record.id !== expected[index]?.id || typeof record.text !== 'string' || !record.text.trim()) {
      throw new Error(`口语化讲稿第 ${index + 1} 段必须保留 id ${expected[index]?.id}`);
    }
    return { id: expected[index]!.id, text: record.text.trim() };
  });
  const issues = narrationStyleIssues(segments);
  if (issues.length) throw new Error(`口语化讲稿仍有问题：${issues.join('；')}`);
  return segments;
}

export function buildNarrationRewritePrompt(
  outline: SceneOutline,
  segments: readonly NarrationSegment[],
): { system: string; user: string } {
  const plan = outline.timingPlan;
  const timing = plan
    ? `全部段落原计划约 ${plan.targetUnits} ${plan.unit}；这个数字只用于减少重复套话，口语自然度和教学完整性优先，不能为控制时长删掉必要解释。`
    : '保持原讲稿总体篇幅和教学深度。';
  return {
    system: '你是经验丰富的中文课堂讲稿编辑。把已有讲稿改成教师面对学生时会自然说出口的话。只返回合法 JSON，不使用 Markdown。必须保持每个段落的 id、数量、顺序、事实、教学逻辑和与画面动作的对应关系；不得补充教学设计和资料没有支持的新事实。',
    user: `课程页面：${outline.title}
教学目标：${outline.teachingObjective ?? outline.description}
共享教学设计：${JSON.stringify(outline.teachingBrief)}

原讲稿段落：
${segments.map((segment) => `[${segment.id}] ${segment.text}`).join('\n')}

编辑要求：
1. 直接讲概念、证据、例子和推理，不说“这一页、本页、上一页、下一页、PPT、课件、页面、核心观点、核心命题”等制作视角用语。
2. 不宣读“资料1、材料2”等编号；需要交代依据时，自然说出资料名称或“相关指导文件”。
3. 使用自然课堂引导和短句，每句话只承担一个主要意思，单句不超过 105 个汉字；不反复欢迎、报幕、宣读提纲或使用 Markdown、项目符号和舞台说明。
4. 保留具体例子、每一步理由、适用条件、误区辨析以及人的责任；口头表达中优先说“人工智能”，不要无解释地连续朗读英文缩写。
5. ${timing}

返回结构：{"segments":[{"id":"原段落 id","text":"口语化后的完整讲稿"}]}`,
  };
}

export async function naturalizeKnowledgeNarration(input: {
  outline: SceneOutline;
  actions: readonly Action[];
  aiCall: AICallFn;
  context?: SceneGenerationContext;
}): Promise<Action[]> {
  const segments = input.actions.flatMap((action) => action.type === 'speech'
    ? [{ id: action.id, text: action.text }]
    : []);
  if (!segments.length) return input.actions.map((action) => ({ ...action }));
  const prompt = buildNarrationRewritePrompt(input.outline, segments);
  let lastError: unknown;
  for (let attempt = 1; attempt <= NARRATION_REWRITE_ATTEMPTS; attempt += 1) {
    const correction = attempt === 1
      ? ''
      : `\n\n上一次结果未通过验收：${lastError instanceof Error ? lastError.message : String(lastError)}\n请重新返回全部段落，严格满足原段落 ID、顺序和自然课堂口语要求。`;
    try {
      const response = await input.aiCall(prompt.system, `${prompt.user}${correction}`);
      const rewritten = normalizeNarrationRewrite(
        parseJsonResponse<unknown>(response),
        segments,
      );
      const textById = new Map(rewritten.map((segment) => [segment.id, segment.text]));
      return enforceNarrationContinuity(input.actions.map((action) => action.type === 'speech'
        ? { ...action, text: textById.get(action.id) ?? action.text }
        : { ...action }), input.context);
    } catch (error) {
      lastError = error;
    }
  }
  const error = new Error(
    `口语化讲稿连续 ${NARRATION_REWRITE_ATTEMPTS} 次未通过验收，已停止课程生成：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
  Object.assign(error, { isRetryable: true });
  throw error;
}
