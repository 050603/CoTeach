import type { SceneOutline } from './outline-types.js';

/** Additional first-draft contract. Components are compiled before native DSL normalization. */
export function componentAuthoringContract(outline: SceneOutline): { system: string; user: string } {
  const diagram = outline.visualIntent?.diagram;
  return {
    system: `## First-draft component authoring (overrides the legacy TextElement examples and height lookup above)
Return JSON with both "elements":[] and "components":[]. Put EVERY visible text item in components; elements may contain only images, videos, tables, charts, formulae and truly independent native shapes. Never emit a raw text element, text baked into an image, or a connector for a relationship already owned by a diagram component. Each component's left/top/width/height is its exclusive canvas allocation; keep components and media separate and inside the 50px page margin. Program code measures and compiles the components into native editable PPT elements before this first draft is accepted. Do not estimate final text-element heights yourself.

Text component: {"kind":"textBox","left":60,"top":50,"width":880,"height":90,"role":"title|body|label","text":"exact visible text","fontSize":34,"bold":true,"color":"#1E3A8A","align":"left"}. Use "paragraphs":["first complete statement","second complete statement"] instead of text for multiple paragraphs. Explicit newline in text is allowed only at a meaningful boundary. Put the supplied title verbatim in a title textBox. Typical font sizes: title 32–36px, body 22–28px, short labels 18–22px. Preserve definitions, conditions and conclusions; move expanded oral explanation into narration.

Aligned label component: {"kind":"labelGrid","left":60,"top":245,"width":880,"height":190,"rows":[{"header":"显性线索","cells":["创设情境提出任务","分析讨论规划设计"]},{"header":"隐性脉络","cells":["明确任务与目标","理解原理"]}],"fontSize":18,"gapX":12,"gapY":18,"cellFill":"#EFF6FF","headerFill":"#FFFFFF"}. Every row must have the same number of cells. The compiler allocates columns from actual text width and balances necessary wraps, including row heights. Allocate enough total width and height; do not manually insert one-character second lines or invent small text boxes. Use a labelGrid only when the items genuinely share aligned comparison dimensions or stages.

Diagram component: {"type":"diagram","id":"teaching-diagram","left":100,"top":180,"width":800,"height":290,"topology":"sequence|cycle","nodes":[{"id":"step-1","label":"actual step"}],"edges":[{"from":"step-1","to":"step-2","label":"actual relation"}],"annotation":"optional separate explanation"}. Use the visual intent's structured diagram when supplied, preserving exact nodes, order, edges and meaning. A cycle needs a full closed ring with directed edges; its annotation is outside the node sequence. A sequence stays an open path. Do not turn a feedback note into a new process step.

The compiler rejects invalid geometry or content that cannot fit; the model must allocate viable component rectangles within the first draft. Ensure every required media ID still appears in elements.`,
    user: diagram
      ? `Structured diagram already chosen during teaching design; include exactly one matching diagram component with a suitable non-overlapping body rectangle. Preserve this plan's topology, ordered nodes, edges, and independent annotation: ${JSON.stringify(diagram)}`
      : 'Use diagram components only when the page genuinely teaches an ordered sequence or a closed cycle. Otherwise use the representation that best communicates this page.',
  };
}
