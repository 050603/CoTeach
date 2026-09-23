# Generation Requirements

## Scene Information

- **Title**: {{title}}
- **Description**: {{description}}
- **Key Points**:
  {{keyPoints}}

{{teacherContext}}
{{pblContext}}
{{timingBudget}}

## Course Visual System

{{visualDirection}}

## Available Resources

{{#if mediaElementEnabled}}
- **Available Media**: {{assignedImages}}
{{/if}}
- **Canvas Size**: {{canvas_width}} × {{canvas_height}} px

## Output Requirements

Based on the scene information above, generate a complete Canvas/PPT component for this one semantic page.

The generated component must represent only this page's assigned subtopic. Follow the semantic page and narration budget in `{{timingBudget}}`: use enough concrete structure, examples, evidence, or visual relationships to make the assigned knowledge point understandable, but do not pack an entire multi-page module into one page or rely on a long script to compensate for sparse visuals. Treat the time target as a content/TTS budget, not as a reason to add unrelated or graph-outside knowledge.

## Language Directive
{{languageDirective}}

**Must Follow**:

1. Output pure JSON directly, without any explanation or description
2. Do not wrap with ```json code blocks
3. Do not add any text before or after the JSON
4. Ensure the JSON format is correct and can be parsed directly
{{#if imageElementEnabled}}
- Use only the provided image IDs (for example, `img_1`) for source image `src` fields
{{/if}}
{{#if generatedVideoEnabled}}
- Use only the provided generated video media refs for video `mediaRef` fields
{{/if}}
5. Fit TextElement heights to the actual wrapped lines using the system prompt’s metrics; preserve readable text and separate non-overlapping boxes.
6. Unless a current explicit edit instruction asks to change it, render `{{title}}` verbatim as the visible primary heading; only line wrapping is allowed.

**Output structure**: {"background":{"type":"solid","color":"course background"},"elements":[/* native elements following the selected semantic composition */],"remark":"Expanded explanation grounded in the visible evidence; do not introduce unsupported claims."}

Return valid JSON with actual values, no comments or placeholders. The visual plan determines this page's composition. Do not copy a title-plus-bullets example across the deck. For a sparse page, enlarge and place the focal content deliberately near the center of the body, retaining generous balanced whitespace.
