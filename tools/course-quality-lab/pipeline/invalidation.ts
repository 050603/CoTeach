export interface InvalidationModuleDefinition {
  moduleId: string;
  consumes: readonly string[];
  produces: readonly string[];
}

export interface InvalidationResult {
  changedAspects: ReadonlySet<string>;
  invalidatedModules: ReadonlySet<string>;
}

/**
 * Propagates changed artifact aspects through declared module inputs. Modules
 * are invalidated only when an input aspect they actually consume is dirty.
 */
export class InvalidationGraph {
  private readonly modules: InvalidationModuleDefinition[] = [];

  register(definition: InvalidationModuleDefinition): this {
    if (this.modules.some((candidate) => candidate.moduleId === definition.moduleId)) {
      throw new Error(`Duplicate invalidation module ${definition.moduleId}`);
    }
    this.modules.push({
      moduleId: definition.moduleId,
      consumes: [...new Set(definition.consumes)],
      produces: [...new Set(definition.produces)],
    });
    return this;
  }

  affectedBy(changes: readonly string[]): InvalidationResult {
    const changedAspects = new Set(changes);
    const invalidatedModules = new Set<string>();
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const definition of this.modules) {
        if (invalidatedModules.has(definition.moduleId)) continue;
        if (!definition.consumes.some((aspect) => changedAspects.has(aspect))) continue;
        invalidatedModules.add(definition.moduleId);
        for (const output of definition.produces) changedAspects.add(output);
        progressed = true;
      }
    }
    return { changedAspects, invalidatedModules };
  }
}

export const V5_ARTIFACT_ASPECTS = {
  plan: "plan.semantic",
  slideSemantic: "slide.semantic",
  slideLayout: "slide.layout",
  narrationText: "narration.text",
  narrationTiming: "narration.timing",
  actions: "actions.binding",
  semanticReview: "review.semantic",
  layoutReview: "review.layout",
  actionReview: "review.actions",
  quiz: "quiz.content",
  audio: "audio.segment",
  export: "export.bundle",
} as const;

/** Reference graph used by the V5 lab adapter and regression tests. */
export function createV5InvalidationGraph(): InvalidationGraph {
  const aspect = V5_ARTIFACT_ASPECTS;
  return new InvalidationGraph()
    .register({
      moduleId: "slides",
      consumes: [aspect.plan],
      produces: [aspect.slideSemantic, aspect.slideLayout],
    })
    .register({
      moduleId: "narration",
      consumes: [aspect.plan],
      produces: [aspect.narrationText, aspect.narrationTiming],
    })
    .register({
      moduleId: "actions",
      consumes: [aspect.slideSemantic, aspect.slideLayout, aspect.narrationText],
      produces: [aspect.actions],
    })
    .register({
      moduleId: "semantic-review",
      consumes: [aspect.plan, aspect.slideSemantic, aspect.narrationText],
      produces: [aspect.semanticReview],
    })
    .register({
      moduleId: "layout-review",
      consumes: [aspect.slideLayout],
      produces: [aspect.layoutReview],
    })
    .register({
      moduleId: "action-review",
      consumes: [aspect.actions],
      produces: [aspect.actionReview],
    })
    .register({
      moduleId: "quiz",
      consumes: [aspect.narrationText],
      produces: [aspect.quiz],
    })
    .register({
      moduleId: "audio",
      consumes: [aspect.narrationText, aspect.narrationTiming],
      produces: [aspect.audio],
    })
    .register({
      moduleId: "export",
      consumes: [aspect.slideSemantic, aspect.slideLayout, aspect.actions, aspect.quiz],
      produces: [aspect.export],
    });
}
