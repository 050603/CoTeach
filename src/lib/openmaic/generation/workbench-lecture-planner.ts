import { nanoid } from 'nanoid';
import { loadSnippet } from '@openmaic/lib/prompts';
import { MAX_PDF_CONTENT_CHARS } from '@openmaic/lib/constants/generation';
import type { CourseVisualTheme, SceneOutline } from '@openmaic/lib/types/generation';
import type { AICallFn, GenerationResult } from './pipeline-types';
import { parseJsonResponse } from './json-repair';
import {
  OPENMAIC_BLUE_COURSE_THEME,
  summarizeCourseVisualTheme,
} from './course-visual-theme';

type RawWorkbenchPage = {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  brief?: unknown;
  description?: unknown;
  materialFacts?: unknown;
  keyPoints?: unknown;
  widgetType?: SceneOutline['widgetType'];
  widgetOutline?: SceneOutline['widgetOutline'];
};

type RawWorkbenchPlan = {
  languageDirective?: unknown;
  courseTitle?: unknown;
  pages?: unknown;
  outlines?: unknown;
};

export type WorkbenchLecturePlanInput = {
  requirement: string;
  teachingSourceContext?: string;
  imageGenerationEnabled?: boolean;
  videoGenerationEnabled?: boolean;
};

const DEFAULT_LANGUAGE_DIRECTIVE =
  '全程使用自然、准确的简体中文讲授；仅保留必要的专有名词、标准缩写和代码。';

function clean(value: unknown, maxLength = Number.POSITIVE_INFINITY): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function cleanFacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const fact = clean(item, 240);
    const key = fact.toLocaleLowerCase();
    if (!fact || seen.has(key)) return [];
    seen.add(key);
    return [fact];
  });
}

/** Remove legacy planning labels from a semantic page brief.
 *
 * Older CoTeach prompts asked the model to repeat a visual direction inside
 * every description, then a normalizer appended a second fallback direction.
 * Both bracket forms occurred in production data. Keep the semantic brief and
 * move the one real direction into its dedicated field instead.
 */
export function stripLegacyVisualDirections(value: string): string {
  return value
    .replace(/【\s*全课视觉方向\s*[:：][^】]*】/gu, ' ')
    .replace(/【\s*全课视觉方向\s*】\s*[^。！？\n]*(?:[。！？]|$)/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildOpenMaicWorkbenchLecturePlanPrompt(
  input: WorkbenchLecturePlanInput,
): { system: string; user: string } {
  const system = `You are the page-planning agent immediately before OpenMAIC's generate_scene tool.

Plan one coherent lecture in the user's language. Follow the current Agent Workbench contract rather than the classic one-click outline cadence:
- Return one explicit page call at a time in plan order. Each page has title, type, brief, and materialFacts, matching generate_scene's public inputs.
- Choose the opening from learners’ prior knowledge and the entry point the subject needs. Close the learning thread with a useful conclusion or application; a further question is optional. Do not impose the same opening and closing sequence on every lesson.
- The body advances coherently across as many related pages as the confirmed scope, available time, and understanding require. Give each page a clear contribution; adjacent pages may share a reasoning chain without each repeating a full explanation cycle. Reuse a relevant case when it advances understanding, without forcing a case onto every page.
- Choose the number of materialFacts from the page’s learning purpose and complexity. Preserve the facts and conditions needed to understand the argument; do not pad to a minimum or omit essential evidence to meet a quota. They must be complete, source-grounded propositions rather than labels or layout headings. Do not invent citations, figures, or facts absent from the supplied material.
- The brief is self-contained and explains the teaching intent, the relationship among the facts, and the most meaningful semantic visual form (for example a causal chain, comparison, timeline, evidence view, or worked example). Do not prescribe coordinates, font sizes, character quotas, element counts, or a card grid.
- Plan no quiz pages. CoTeach adds one short-answer check only after each confirmed section, preserving its teaching contract.
- Use interactive only when manipulating a mechanism materially improves understanding, and include widgetType plus widgetOutline. Otherwise use slide.

Do not plan a palette, background, font, or page-level art direction. The current OpenMAIC slide generator owns its standard blue visual system. Keep briefs semantic so independent pages cannot invent competing themes. You may name the semantic visual form a claim needs, but never describe a second decorative style.

${loadSnippet('adaptive-narration-policy')}

Return JSON only with this shape:
{"languageDirective":"...","courseTitle":"...","pages":[{"id":"page-1","type":"slide|interactive","title":"...","brief":"...","materialFacts":["..."],"widgetType":"optional","widgetOutline":{}}]}`;
  const source = input.teachingSourceContext?.trim().slice(0, MAX_PDF_CONTENT_CHARS) || '无额外材料；只能依据课程要求中已经确认的内容。';
  const user = `课程要求：
${input.requirement}

已确认的教学材料：
${source}

可用媒体能力：图片生成=${input.imageGenerationEnabled === true}；视频生成=${input.videoGenerationEnabled === true}。媒体能力不改变页面数量，也不意味着每页都需要图片。`;
  return { system, user };
}

function normalizePage(
  raw: RawWorkbenchPage,
  index: number,
  visualDirection: string,
  visualTheme: CourseVisualTheme,
): SceneOutline | null {
  const title = clean(raw.title, 120);
  const description = stripLegacyVisualDirections(
    clean(raw.brief || raw.description, 1_200),
  );
  const keyPoints = cleanFacts(
    Array.isArray(raw.materialFacts) ? raw.materialFacts : raw.keyPoints,
  );
  if (!title || !description || keyPoints.length === 0) return null;
  const requestedType = raw.type === 'interactive' ? 'interactive' : 'slide';
  const hasWidget = requestedType === 'interactive' && raw.widgetType && raw.widgetOutline;
  return {
    id: clean(raw.id, 120) || nanoid(),
    type: hasWidget ? 'interactive' : 'slide',
    title,
    description,
    keyPoints,
    order: index,
    ...(visualDirection ? { courseVisualDirection: visualDirection } : {}),
    courseVisualTheme: { ...visualTheme },
    ...(hasWidget
      ? { widgetType: raw.widgetType, widgetOutline: { ...raw.widgetOutline } }
      : {}),
  };
}

/**
 * Thin batch adaptation of the current OpenMAIC Agent Workbench page-planning
 * boundary. It intentionally does not invoke the classic one-click outline
 * prompt, whose built-in scene/minute and quiz rules conflict with CoTeach's
 * confirmed section and timing contract.
 */
export async function generateOpenMaicWorkbenchLecturePlan(
  input: WorkbenchLecturePlanInput,
  aiCall: AICallFn,
): Promise<GenerationResult<{
  languageDirective: string;
  courseTitle?: string;
  outlines: SceneOutline[];
}>> {
  const prompts = buildOpenMaicWorkbenchLecturePlanPrompt(input);
  try {
    const response = await aiCall(prompts.system, prompts.user);
    const parsed = parseJsonResponse<RawWorkbenchPlan | RawWorkbenchPage[]>(response);
    const envelope: RawWorkbenchPlan = Array.isArray(parsed)
      ? { pages: parsed }
      : parsed && typeof parsed === 'object'
        ? parsed
        : {};
    const rawPages = Array.isArray(envelope.pages)
      ? envelope.pages
      : Array.isArray(envelope.outlines)
        ? envelope.outlines
        : [];
    const visualTheme = { ...OPENMAIC_BLUE_COURSE_THEME };
    const visualDirection = summarizeCourseVisualTheme(visualTheme);
    const outlines = rawPages.flatMap((page, index) => {
      if (!page || typeof page !== 'object' || Array.isArray(page)) return [];
      const normalized = normalizePage(
        page as RawWorkbenchPage,
        index,
        visualDirection,
        visualTheme,
      );
      return normalized ? [normalized] : [];
    }).map((outline, index) => ({ ...outline, order: index }));
    if (outlines.length === 0) {
      return { success: false, error: 'Workbench 页面规划未返回可用的讲授页面' };
    }
    return {
      success: true,
      data: {
        languageDirective:
          clean(envelope.languageDirective, 500) || DEFAULT_LANGUAGE_DIRECTIVE,
        ...(clean(envelope.courseTitle, 120)
          ? { courseTitle: clean(envelope.courseTitle, 120) }
          : {}),
        outlines,
      },
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
