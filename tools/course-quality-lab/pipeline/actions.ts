import type {
  Action,
  VisualTargetSelector,
} from "@openmaic/lib/types/action";
import type {
  ActionSupport,
  NarrationModuleOutput,
  NarrationSegment,
  SlideModuleOutput,
} from "./types";

export interface VisualActionCue {
  id: string;
  type: "spotlight" | "laser";
  semanticId: string;
  narrationSegmentId: string;
  anchorId?: string;
  selector?: VisualTargetSelector;
  necessity: Exclude<ActionSupport, "none">;
  omissionRisk?: string;
  elementId?: string;
  durationMs?: number;
}

export interface ActionBindingIssue {
  id: string;
  cueId?: string;
  actionId?: string;
  severity: "warning" | "blocking";
  code:
    | "duplicate-action-id"
    | "missing-element-binding"
    | "unknown-element"
    | "unknown-segment"
    | "unknown-anchor"
    | "anchor-quote-missing"
    | "selector-quote-missing"
    | "missing-required-cue"
    | "speech-text-mismatch";
  message: string;
}

export interface ActionCompilationResult {
  actions: Action[];
  issues: ActionBindingIssue[];
}

function quoteOccurrenceExists(text: string, quote: string, occurrence = 0): boolean {
  if (!quote || occurrence < 0 || !Number.isInteger(occurrence)) return false;
  let offset = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const found = text.indexOf(quote, offset);
    if (found < 0) return false;
    offset = found + quote.length;
  }
  return true;
}

function issue(
  code: ActionBindingIssue["code"],
  message: string,
  fields: Pick<ActionBindingIssue, "severity" | "cueId" | "actionId">,
): ActionBindingIssue {
  const owner = fields.cueId ?? fields.actionId ?? "page";
  return {
    id: `action-binding:${owner}:${code}`,
    code,
    message,
    ...fields,
  };
}

function resolveCue(
  cue: VisualActionCue,
  slide: SlideModuleOutput,
  narrationById: ReadonlyMap<string, NarrationSegment>,
): { action?: Action; issues: ActionBindingIssue[] } {
  const severity = cue.necessity === "essential" ? "blocking" : "warning";
  const issues: ActionBindingIssue[] = [];
  const elementIds = new Set(slide.content.elements.map((element) => element.id));
  const binding = slide.bindings.find((candidate) => candidate.semanticId === cue.semanticId);
  const elementId = cue.elementId ?? binding?.elementIds[0];
  if (!elementId) {
    issues.push(issue(
      "missing-element-binding",
      `Cue ${cue.id} has no element binding for semantic unit ${cue.semanticId}`,
      { cueId: cue.id, severity },
    ));
  } else if (!elementIds.has(elementId)) {
    issues.push(issue(
      "unknown-element",
      `Cue ${cue.id} references missing slide element ${elementId}`,
      { cueId: cue.id, severity: "blocking" },
    ));
  }

  const segment = narrationById.get(cue.narrationSegmentId);
  if (!segment) {
    issues.push(issue(
      "unknown-segment",
      `Cue ${cue.id} references missing narration segment ${cue.narrationSegmentId}`,
      { cueId: cue.id, severity: "blocking" },
    ));
  }

  const anchor = cue.anchorId
    ? segment?.anchors?.find((candidate) => candidate.id === cue.anchorId)
    : undefined;
  if (cue.anchorId && !anchor) {
    issues.push(issue(
      "unknown-anchor",
      `Cue ${cue.id} references missing narration anchor ${cue.anchorId}`,
      { cueId: cue.id, severity: "blocking" },
    ));
  } else if (anchor && segment
    && !quoteOccurrenceExists(segment.text, anchor.quote, anchor.occurrence)) {
    issues.push(issue(
      "anchor-quote-missing",
      `Anchor ${anchor.id} no longer matches narration segment ${segment.id}`,
      { cueId: cue.id, severity: "blocking" },
    ));
  }

  if (issues.some((candidate) => candidate.severity === "blocking") || !elementId || !segment) {
    return { issues };
  }
  const base = {
    id: cue.id,
    elementId,
    speechId: segment.id,
    ...(cue.selector ? { selector: cue.selector } : {}),
    ...(anchor ? {
      speechAnchor: { quote: anchor.quote, occurrence: anchor.occurrence },
    } : {}),
    necessity: cue.necessity,
    ...(cue.omissionRisk ? { omissionRisk: cue.omissionRisk } : {}),
  };
  const action: Action = cue.type === "laser"
    ? { ...base, type: "laser", ...(cue.durationMs ? { duration: cue.durationMs } : {}) }
    : { ...base, type: "spotlight" };
  return { action, issues };
}

/** Deterministically compiles semantic bindings into the existing Action contract. */
export function compileActionBindings(input: {
  slide: SlideModuleOutput;
  narration: NarrationModuleOutput;
  cues: readonly VisualActionCue[];
}): ActionCompilationResult {
  if (input.slide.pageId !== input.narration.pageId) {
    throw new Error("Slide and narration page ids do not match");
  }
  const narrationById = new Map(input.narration.segments.map((segment) => [segment.id, segment]));
  const resolved = input.cues.map((cue) => ({ cue, ...resolveCue(cue, input.slide, narrationById) }));
  const issues = resolved.flatMap((candidate) => candidate.issues);
  const cuesBySegment = new Map<string, Action[]>();
  for (const candidate of resolved) {
    if (!candidate.action) continue;
    const actions = cuesBySegment.get(candidate.cue.narrationSegmentId) ?? [];
    actions.push(candidate.action);
    cuesBySegment.set(candidate.cue.narrationSegmentId, actions);
  }
  const actions = input.narration.segments.flatMap((segment): Action[] => [
    ...(cuesBySegment.get(segment.id) ?? []).sort((left, right) => left.id.localeCompare(right.id)),
    { id: segment.id, type: "speech", text: segment.text },
  ]);
  return {
    actions,
    issues: [
      ...issues,
      ...validateActionReferences({
        actions,
        slide: input.slide,
        narration: input.narration,
        requiredCues: input.cues,
      }),
    ].filter((candidate, index, all) =>
      all.findIndex((other) => other.id === candidate.id) === index,
    ),
  };
}

function selectorMatchesElement(
  selector: VisualTargetSelector | undefined,
  elementText: string,
): boolean {
  return !selector?.quote
    || quoteOccurrenceExists(elementText, selector.quote, selector.occurrence);
}

export function validateActionReferences(input: {
  actions: readonly Action[];
  slide: SlideModuleOutput;
  narration: NarrationModuleOutput;
  requiredCues?: readonly VisualActionCue[];
}): ActionBindingIssue[] {
  const issues: ActionBindingIssue[] = [];
  const elementById = new Map(
    input.slide.content.elements.map((element) => [element.id, JSON.stringify(element)]),
  );
  const segmentById = new Map(input.narration.segments.map((segment) => [segment.id, segment]));
  const seenIds = new Set<string>();
  for (const action of input.actions) {
    if (seenIds.has(action.id)) {
      issues.push(issue(
        "duplicate-action-id",
        `Action id ${action.id} is duplicated`,
        { actionId: action.id, severity: "blocking" },
      ));
    }
    seenIds.add(action.id);
    if (action.type === "speech") {
      const segment = segmentById.get(action.id);
      if (segment && segment.text !== action.text) {
        issues.push(issue(
          "speech-text-mismatch",
          `Speech action ${action.id} no longer matches its narration segment`,
          { actionId: action.id, severity: "blocking" },
        ));
      }
      continue;
    }
    if (action.type !== "spotlight" && action.type !== "laser") continue;
    const elementText = elementById.get(action.elementId);
    if (!elementText) {
      issues.push(issue(
        "unknown-element",
        `Action ${action.id} references missing slide element ${action.elementId}`,
        { actionId: action.id, severity: "blocking" },
      ));
    } else if (!selectorMatchesElement(action.selector, elementText)) {
      issues.push(issue(
        "selector-quote-missing",
        `Action ${action.id} selector no longer matches element ${action.elementId}`,
        { actionId: action.id, severity: "blocking" },
      ));
    }
    for (const waypoint of action.type === "laser" ? action.waypoints ?? [] : []) {
      const waypointText = elementById.get(waypoint.elementId);
      if (!waypointText) {
        issues.push(issue(
          "unknown-element",
          `Action ${action.id} waypoint references missing element ${waypoint.elementId}`,
          { actionId: action.id, severity: "blocking" },
        ));
      } else if (!selectorMatchesElement(waypoint.selector, waypointText)) {
        issues.push(issue(
          "selector-quote-missing",
          `Action ${action.id} waypoint selector no longer matches ${waypoint.elementId}`,
          { actionId: action.id, severity: "blocking" },
        ));
      }
    }
    const referencedSpeechIds = action.type === "spotlight"
      ? [action.speechId, action.endSpeechId]
      : [action.speechId];
    for (const speechId of referencedSpeechIds) {
      if (speechId && !segmentById.has(speechId)) {
        issues.push(issue(
          "unknown-segment",
          `Action ${action.id} references missing narration segment ${speechId}`,
          { actionId: action.id, severity: "blocking" },
        ));
      }
    }
    if (action.speechAnchor && action.speechId) {
      const segment = segmentById.get(action.speechId);
      if (segment && !quoteOccurrenceExists(
        segment.text,
        action.speechAnchor.quote,
        action.speechAnchor.occurrence,
      )) {
        issues.push(issue(
          "anchor-quote-missing",
          `Action ${action.id} speech anchor no longer matches ${action.speechId}`,
          { actionId: action.id, severity: "blocking" },
        ));
      }
    }
  }

  for (const cue of input.requiredCues ?? []) {
    if (input.actions.some((action) => action.id === cue.id)) continue;
    issues.push(issue(
      "missing-required-cue",
      `Declared ${cue.necessity} cue ${cue.id} was not compiled`,
      {
        cueId: cue.id,
        severity: cue.necessity === "essential" ? "blocking" : "warning",
      },
    ));
  }
  return issues;
}

export function assertActionBindings(result: ActionCompilationResult): Action[] {
  const blocking = result.issues.filter((candidate) => candidate.severity === "blocking");
  if (blocking.length > 0) {
    throw new Error(blocking.map((candidate) => candidate.message).join("; "));
  }
  return result.actions;
}
