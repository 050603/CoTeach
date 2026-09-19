import type { TeachingDesign } from "../types";
import type {
  ActionSupport,
  SemanticTeachingPage,
  SemanticTeachingPlan,
  SemanticTeachingUnit,
  SemanticUnitKind,
} from "./types";

type TeachingPage = NonNullable<TeachingDesign["pagePlan"]>[number];

export interface TeachingPlanAdapterOptions {
  courseId: string;
  /** Relationships can be promoted to essential for subjects where pointing is required. */
  visibleRelationshipActionSupport?: ActionSupport;
  resolveActionSupport?: (input: {
    page: number;
    kind: SemanticUnitKind;
    text: string;
    index: number;
  }) => ActionSupport | undefined;
}

function pagePrefix(page: number): string {
  return `page-${String(page).padStart(3, "0")}`;
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function units(
  page: number,
  kind: SemanticUnitKind,
  values: readonly string[],
  defaultActionSupport: ActionSupport,
  options: TeachingPlanAdapterOptions,
): SemanticTeachingUnit[] {
  return values.flatMap((value, index) => {
    const text = normalizedText(value);
    if (!text) return [];
    const actionSupport = options.resolveActionSupport?.({ page, kind, text, index })
      ?? defaultActionSupport;
    return [{
      // IDs are position based rather than text hashes. A wording repair keeps
      // the same semantic identity, so narration, actions, and review records
      // continue to point at the intended teaching unit.
      id: `${pagePrefix(page)}-${kind}-${String(index + 1).padStart(3, "0")}`,
      kind,
      text,
      actionSupport,
    }];
  });
}

function adaptPage(pagePlan: TeachingPage, options: TeachingPlanAdapterOptions): SemanticTeachingPage {
  const page = pagePlan.page;
  const knowledge = [pagePlan.newContent, ...pagePlan.explanation];
  const targetDurationSec = pagePlan.narrationBudget?.targetDurationSec;
  return {
    id: pagePrefix(page),
    page,
    purpose: normalizedText(pagePlan.purpose),
    priorKnowledge: normalizedText(pagePlan.priorKnowledge),
    units: [
      ...units(page, "knowledge", knowledge, "none", options),
      ...units(page, "case", pagePlan.examples, "none", options),
      ...units(
        page,
        "visible-relationship",
        pagePlan.requiredVisibleContent,
        options.visibleRelationshipActionSupport ?? "helpful",
        options,
      ),
      ...units(page, "narration-step", pagePlan.narrationFocus, "none", options),
      ...units(page, "assessment", pagePlan.assessmentFocus, "none", options),
      ...units(page, "evidence", pagePlan.evidenceQuotes, "none", options),
    ],
    ...(targetDurationSec === undefined ? {} : { targetDurationSec }),
  };
}

/** Converts the V4 teaching contract into the stable semantic V5 contract. */
export function adaptTeachingDesign(
  design: TeachingDesign,
  options: TeachingPlanAdapterOptions,
): SemanticTeachingPlan {
  const pagePlan = design.pagePlan ?? [];
  if (pagePlan.length === 0) throw new Error("Teaching design has no page plan");
  const pageNumbers = pagePlan.map((page) => page.page);
  if (new Set(pageNumbers).size !== pageNumbers.length) {
    throw new Error("Teaching design contains duplicate page numbers");
  }
  const sorted = [...pagePlan].sort((left, right) => left.page - right.page);
  sorted.forEach((page, index) => {
    if (page.page !== index + 1) throw new Error("Teaching design pages must be contiguous from 1");
  });
  return {
    version: 1,
    courseId: options.courseId,
    pages: sorted.map((page) => adaptPage(page, options)),
  };
}

export function semanticUnitMap(plan: SemanticTeachingPlan): ReadonlyMap<string, SemanticTeachingUnit> {
  const result = new Map<string, SemanticTeachingUnit>();
  for (const page of plan.pages) {
    for (const unit of page.units) {
      if (result.has(unit.id)) throw new Error(`Duplicate semantic unit id ${unit.id}`);
      result.set(unit.id, unit);
    }
  }
  return result;
}

