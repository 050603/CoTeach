import type { SceneOutline } from './outline-types.js';
import type { DiagramAllocation } from './diagram-compiler.js';

/** The model owns meaning and grouping; the first-pass compiler owns geometry. */
export function flowAuthoringContract(outline: SceneOutline): { system: string; user: string } {
  return {
    system: `# First-draft component authoring
You design an educational slide. Return pure JSON: {"background":{"type":"solid","color":"#ffffff"},"layout":{"groups":[]}}. The compiler supplies the exact page title, measures text with the playback font, lays out every group and media placeholder, and creates continuation pages between groups when needed. Do not output elements, coordinates, widths, heights, or a title block. There is no later AI layout review.

Each top-level group is one small, coherent teaching unit that must stay together on a page. Keep related comparison columns together, but put separate explanations or observations in separate groups. Never put the entire lesson in one giant group. Preserve complete core definitions, conditions and conclusions; put spoken reasoning in narration. Do not split a definition across groups or discard content to fit.

Allowed blocks:
- Editable text: {"kind":"textBox","role":"body|label","text":"complete statement","fontSize":24,"bold":false,"color":"#263445"}. Use paragraphs:["first statement","second statement"] instead of text for distinct paragraphs. Body 22–28px, short label 18–22px. Hard newlines only at meaningful semantic boundaries; never manually break a short label into characters.
- Aligned comparison: {"kind":"labelGrid","rows":[{"header":"Dimension","cells":["First object","Second object"]}],"fontSize":20}. Equal cell counts per row. Use for genuine common comparison dimensions. The compiler balances wrapping and column widths.
- Visual relationship: {"kind":"diagram","topology":"sequence|cycle","nodes":[{"id":"step-1","label":"step name"},{"id":"step-2","label":"step name"}],"edges":[],"annotation":"independent explanation"}. When a planned diagram is supplied, include exactly one diagram block; the compiler preserves that plan's exact nodes, order, edges and annotation. A cycle has a complete directed ring; annotation is never an extra step. Node names must be concise; explain their meaning in separate text groups.
- Media: {"kind":"media","resourceId":"exact provided ID","mediaType":"image|video","aspectRatio":"16:9|4:3|1:1|9:16","observation":"what students should observe"}. Every required media resource must appear where it supports observation. Use the supplied aspect ratio. The compiler reserves its space before laying out text. Never invent resource IDs, URLs or decorative images.
- Precise chart or formula: {"kind":"native","element":{"type":"chart","chartType":"bar","data":{"labels":["A","B"],"legends":["Value"],"series":[[1,2]]}}}, or {"kind":"native","element":{"type":"latex","latex":"x^2"}}. Use actual supplied numeric data only. Native chart/formula geometry is reserved by the compiler; all accompanying explanation uses text blocks.
- Group: {"kind":"row|column","id":"stable-semantic-name","children":[blocks],"weights":[1,1]}. Rows arrange related items side by side; columns stack them. Optional positive weights control relative row widths. Prefer a row for a picture and its short observation prompt, and independent groups for longer explanation. The compiler can stack an infeasibly narrow row. Groups are atomic page-break units, so keep them small enough for one page.

Choose representations from the teaching purpose, without a required number of pictures or template quota. Images show observable objects and situations; labels and exact relationships stay editable. Avoid duplicate text that merely repeats every diagram node. Return a viable semantic design in this single response.`,
    user: outline.visualIntent?.diagram
      ? `Return the flow-layout JSON. Include exactly one diagram block for this authoritative relationship: ${JSON.stringify(outline.visualIntent.diagram)}`
      : 'Return the flow-layout JSON. Include diagrams only for genuine ordered sequences or closed cycles; select other representations by teaching purpose.',
  };
}

/** Keep the native slide authoring vocabulary; compile only local components. */
export function componentAuthoringContract(outline: SceneOutline, diagramAllocations: DiagramAllocation[] = []): { system: string; user: string } {
  return {
    system: `## Optional first-draft measured components
Keep the complete native slide design: editable elements, shapes, tables, charts, rich text emphasis, borders, accent bars, pictures and the authored page hierarchy. Return {"background":...,"elements":[...],"components":[...]}. Components are optional local helpers; do not replace the page with a flow layout or split it into continuation pages. Preserve a coherent teaching page, with concise visible evidence and deeper spoken reasoning in narration.
Use the original typography and content-specific composition from the slide design instructions. All visible text is measured with the playback font. Preserve semantic paragraph breaks; a short label must not leave a single Chinese character, including its punctuation, alone on a wrapped line. Allocate enough width and height at the chosen readable font size; do not omit meaning to fit.
Optional text component: {"kind":"textBox","id":"stable-id","left":60,"top":140,"width":360,"height":90,"text":"a concise statement","fontSize":18,"bold":false,"color":"#334155","role":"body|label|title"}. Height is an estimate; the compiler uses the measured height and checks it against nearby foreground content and the slide boundary. Do not assign a guessed hard maxHeight to fit text. Use native text elements for mixed emphasis, colors, or font sizes.
Optional aligned label component: {"kind":"labelGrid","id":"stable-id","left":60,"top":140,"width":880,"height":200,"rows":[{"header":"dimension","cells":["first","second"]}],"fontSize":16}. Native tables remain available and preferred for genuine tables.
Planned relationship component: {"type":"diagram","id":"stable-id","left":60,"top":140,"width":880,"height":330,"topology":"sequence|cycle","nodes":[{"id":"a","label":"step"},{"id":"b","label":"next"}]}. Its rectangle and optional accentColor/nodeFill/textColor belong to your page design; the compiler supplies the exact planned nodes and edges. Reserve room for its annotation outside the ring. Do not draw duplicate diagram nodes/connectors in native elements.
Arrows, connecting lines, aligned pairs and visual correspondence assert a real teaching relationship. Do not force introductory examples into a one-to-one mapping with concepts, or invent a correspondence, hierarchy or causal link not established by the supplied teaching design. If examples are only an introduction, present them as shared context without misleading connectors.
Components compile inside their allocated rectangles in this same first response. Background surfaces may deliberately contain foreground elements. Keep unrelated foreground content outside each component allocation. Include each required media resource as a native image/video in the page where it supports observation.`,
    user: outline.visualIntent?.diagram
      ? `Return native editable elements with exactly one local diagram component for this authoritative relationship: ${JSON.stringify(outline.visualIntent.diagram)}\nMeasured feasible diagram rectangles (including node labels and the outside annotation): ${JSON.stringify(diagramAllocations)}. Choose one complete width/height pair or a rectangle at least as wide AND as high as one pair. A smaller arbitrary rectangle will not fit. You choose its left/top and the rest of the native page layout. Keep left >= 50, top >= 50, left+width <= 950 and top+height <= 512.5; reserve the page title and keep unrelated foreground content outside the chosen rectangle. The diagram is one local region, not the whole-page layout.`
      : 'Return native editable elements, with optional local text or label components only where helpful. Preserve the page composition and rich text styles.',
  };
}
