import type { WidgetType } from '@openmaic/lib/types/widgets';

export interface InteractiveQualityAudit {
  passed: boolean;
  reasons: string[];
}

const COMPLETION_PATTERN = /window\s*\.\s*__maicActivity\s*\.\s*complete\s*\(/i;
const RESET_PATTERN = /window\s*\.\s*__maicActivity\s*\.\s*reset\s*\(/i;
const DIRECT_MANIPULATION_PATTERN = /(?:<input\b|<select\b|<textarea\b|contenteditable\s*=|draggable\s*=|\b(?:pointerdown|pointermove|mousedown|mousemove|touchstart|touchmove|keydown)\b)/i;
const EXPLORATION_STATE_PATTERN = /\b(?:visited|inspected|explored|attempts?|history|observations?|comparisons?|completedStates|selectedStates|revealedPaths?)\b|new\s+Set\s*\(/i;
const PSEUDO_INTERACTION_LABEL = /^(?:下一步|上一步|继续|查看详情|查看详细信息|显示详情|展开|收起|了解更多|next|previous|prev|continue|view details?|show details?|learn more)$/i;

function visibleButtonLabels(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)]
    .map((match) => match[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').trim())
    .filter(Boolean);
}

/**
 * Reject only high-confidence low-agency widgets. The outline planner decides
 * whether an interaction belongs in the lesson; this audit checks that a
 * generated interaction actually records meaningful exploration instead of
 * degrading into a clickable information page.
 */
export function auditInteractiveHtml(
  html: string,
  widgetType: WidgetType,
): InteractiveQualityAudit {
  const reasons: string[] = [];
  if (!COMPLETION_PATTERN.test(html)) {
    reasons.push('missing meaningful activity completion signal');
  }
  if (!RESET_PATTERN.test(html)) {
    reasons.push('missing full activity reset signal');
  }

  const buttons = visibleButtonLabels(html);
  const onlyPseudoNavigation = buttons.length > 0
    && buttons.every((label) => PSEUDO_INTERACTION_LABEL.test(label));
  if (
    widgetType !== 'procedural-skill'
    && onlyPseudoNavigation
    && !DIRECT_MANIPULATION_PATTERN.test(html)
    && !EXPLORATION_STATE_PATTERN.test(html)
  ) {
    reasons.push('only next/detail-style controls without learner manipulation or exploration state');
  }

  return { passed: reasons.length === 0, reasons };
}
