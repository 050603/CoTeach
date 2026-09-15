import type { SlideComposition } from './slide-visual-plan';

/** Original CoTeach rules: separate content, composition and course theme. Sources: docs/slide-spatial-sources.md. */
export const TEACHING_COMPOSITION_RULES: Record<SlideComposition, string> = {
  'concept-focus': 'Create one large central concept/model at x=180–820, y=170–390, with a short concrete example or implication beneath it. Use typography and a meaningful diagram, not two generic text containers.',
  comparison: 'Align the same 2–4 comparison dimensions across alternatives. Prefer open horizontal rows with shared labels, or paired concrete examples with exact differences annotated. Use the body height from y=150 to 450; avoid unrelated bullet lists inside matching boxes.',
  process: 'Show 3–5 meaningful states connected by labeled transitions. Place the main sequence through the middle of the canvas, with inputs/outputs and one concise consequence below. Arrows must represent real order or causality.',
  relationship: 'Place the focal entity near the canvas center, connect 3–5 related entities with labeled links, and distinguish causality, dependency, and association. Arrange the model across both width and height.',
  'worked-example': 'Give a concrete starting case, 2–3 aligned reasoning steps, and a visible result. Use a vertical worked path or asymmetric example/annotation composition. Keep the example itself visible and distribute steps through the body height.',
  evidence: 'Use one dominant native chart, exact small table, formula, or evidence artifact plus a concise interpretation. Label units, assumptions and source limitations. Never invent numerical data to fill a chart.',
  hierarchy: 'Make levels or part–whole structure visible using aligned branches or nested spatial regions, with explicit relation labels. Give the root, branches and example adequate vertical separation; do not turn each level into a paragraph card.',
  'annotated-example': 'Use a large concrete example as the focal area (roughly 55–65% of the body), with 2–3 directly anchored annotations and a concise takeaway. A supplied image is optional; native editable text, shapes or code can be the example.',
};


export const TEACHING_NATIVE_EXAMPLES: Record<SlideComposition, string> = {
  'concept-focus': 'Native DSL: one text conclusion at (180,170,640,90), editable shape model below; annotations refer to model anchors.',
  comparison: 'Native DSL: one shared dimension column, then paired text cells aligned on the same y coordinates. Keep pairs as one unit.',
  process: 'Native DSL: shape nodes with stable IDs, text state labels, line elements using adjacent node ports; label real transitions.',
  relationship: 'Native DSL: focal shape at center, related shapes around it, line elements with source and target anchors; distinguish causes from associations.',
  'worked-example': 'Native DSL: exact given case, aligned editable formula/text reasoning steps and result. One indivisible unit owns all steps.',
  evidence: 'Native DSL: chart with exact data labels, native table cells or latex formula, plus one interpretation text. Never infer missing numeric values.',
  hierarchy: 'Native DSL: root and children as editable shapes and labels, branch lines routed through open channels. Parent IDs describe intentional containment.',
  'annotated-example': 'Native DSL: image or editable code as focal object, separate text annotations joined by lines to exact anchors; labels never baked into generated images.',
};
