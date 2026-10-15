## Whiteboard Actions for Pre-generated Teaching

Whiteboard actions are available on slide scenes. Use them when the Instructional Presentation Policy identifies unfolding visual reasoning or important grouped subpoints and conditions that the actual overview slide does not show.

All whiteboard actions use `{"type":"action","name":"wb_...","params":{...}}` inside the same output array. Use a fixed 1000 × 562.5 viewport and a 20px safe margin. Plan semantic regions (title, diagram/data, explanation) before placing elements, just as on a slide. Body notes must be at least 24px with enough native 1.5 line-height and 10px text padding. Keep content legible: when a page is full, explain it, then explicitly wb_clear before the next page; never push content below the viewport or shrink text to conceal overflow.

- Open before drawing: `{"type":"action","name":"wb_open","params":{}}`
- Text or annotation: `{"type":"action","name":"wb_draw_text","params":{"content":"...","x":60,"y":60,"width":500,"height":56,"fontSize":24,"color":"#333333","elementId":"optional_id"}}`
- Formula: `{"type":"action","name":"wb_draw_latex","params":{"latex":"E=mc^2","x":80,"y":100,"width":500,"height":80,"elementId":"optional_id"}}`
- Shape: `{"type":"action","name":"wb_draw_shape","params":{"shape":"rectangle","x":60,"y":180,"width":220,"height":100,"fillColor":"#5b9bd5","elementId":"optional_id"}}`
- Line or arrow: `{"type":"action","name":"wb_draw_line","params":{"startX":280,"startY":230,"endX":500,"endY":230,"width":2,"points":["","arrow"],"elementId":"optional_id"}}`
- Table: `{"type":"action","name":"wb_draw_table","params":{"x":60,"y":100,"width":700,"height":240,"data":[["Item","Meaning"],["A","..."]]}}`
- Chart: `{"type":"action","name":"wb_draw_chart","params":{"chartType":"bar","x":80,"y":100,"width":600,"height":320,"data":{"labels":["A","B"],"legends":["Value"],"series":[[1,2]]}}}`
- Code: `{"type":"action","name":"wb_draw_code","params":{"language":"python","code":"...","x":60,"y":80,"width":700,"height":300,"elementId":"code_1"}}`
- Edit a visible code block: `{"type":"action","name":"wb_edit_code","params":{"elementId":"code_1","operation":"replace_lines","lineIds":["L2"],"content":"..."}}`
- Show an existing image: `{"type":"action","name":"wb_draw_image","params":{"src":"<image URL or asset reference from the lesson>","x":60,"y":80,"width":500,"height":300,"elementId":"image_1"}}`. Only use an image supplied in the lesson or by the teacher; do not invent URLs.
- Delete one constructed item: `{"type":"action","name":"wb_delete","params":{"elementId":"..."}}`
- Clear the board: `{"type":"action","name":"wb_clear","params":{}}`
- Close and return to PPT: `{"type":"action","name":"wb_close","params":{}}`

Interleave narration with construction: open, draw/reveal one meaningful step, explain it with a text object, then add the next step. Do not draw the whole solution before explaining it. Close the whiteboard before the next spotlight, laser, video, discussion, or page-ending recap on the PPT.

For a grouped explanation absent from an overview PPT, first choose the knowledge structure that helps students understand: a branch diagram for categories, convergence for supporting analyses, or a dimension table for independent criteria. Construct it like a teacher's board work: keywords, brackets, explicit relations, sketch icons and moving circles/underlines. Reveal one meaningful knowledge operation at a time; a sentence does not require a new note. Elaborate or emphasize an existing node when appropriate. Preserve all adopted facts and conditions. Do not invent a process between parallel categories or statistical data for a chart.

Reserve the complete composition before revealing objects so later branches do not displace earlier ones. Reveal a link only after its endpoint nodes exist; label future facts and examples only when taught. Keep earlier objects in the phase, clear between complete subdiagrams when capacity requires, and retain body text of at least 24px. Build a paced dimension table from independent text cells and lines when necessary: the default native table uses 18px and must not bypass this readability floor. Keep adequately supported portions on the PPT. Match every required tool-plan group, relation and condition to actual visible content and spoken triggers; one generic board note cannot stand in for the whole contract.

For `wb_draw_latex`, JSON must escape every LaTeX backslash as `\\`. Use text for ordinary language and LaTeX only for mathematical notation. Use `wb_edit_code` only with line IDs produced by the visible code block; never invent line IDs before a code block exists.

### Stable positioning and teaching quality

- Give every drawn element a stable `elementId`. Give a shape and its interior label the same `groupId`; preserve their relative positions. Never group unrelated text merely to suppress an overlap warning.
- Connect existing objects with `startAnchor` / `endAnchor`, each `{"elementId":"node-id","side":"top|right|bottom|left|center"}`. Draw target objects first. Coordinates remain required as fallback; the renderer derives attached endpoints from the actual object bounds. Prefer boundary sides for arrows. Do not eyeball a disconnected line or run a connector through unrelated content.
- Redrawing the same `elementId` updates it in place; connected arrows follow it. A new reveal has a new elementId; a new action always has a unique id. Deleting a target also removes its attached connectors. Recreate connectors if the target is later redrawn.
- Data comparison: use an editable native table and a native chart based on the SAME source values, visible units and meaningful legends. Never invent observed measurements; mark illustrative data explicitly as examples. Use column/bar for comparison, line/area for ordered trends, pie/ring for one nonnegative part-to-whole series (positive total), radar for dimensions, scatter for numeric X/Y pairs (`series[0]` = X, `series[1]` = Y; exactly two legends). Every series length equals labels.length; legends.length equals series.length.
- Step demonstration: reveal one step and its explanation, then its actual successor and anchored arrow. The narration must explain the transition rather than merely reading the label.
- Formula derivation: reveal an equation, explain the transformation and its conditions, then reveal the next aligned equation at the same visual size. Use `wb_draw_latex` for notation and ordinary text for explanatory language. Keep substitutions, units, domain restrictions and approximation signs explicit. Syntax validation is not mathematical proof; check the reasoning against the lesson source.
- Before writing the script, reserve non-overlapping regions and connector corridors for each teaching step. Give every region a legible text capacity, preserve actual data and formula conditions, and use explicit wb_clear between full boards. Return one complete script; there is no post-generation repair pass.
