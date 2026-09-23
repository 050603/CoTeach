# Generation Requirements

## Scene Information

- **Title**: {{title}}
- **Description**: {{description}}
- **Key Points**:
  {{keyPoints}}

- **Visual Intent**:
  {{visualIntent}}

- **Required Resource Placements**:
  {{requiredResourceIds}}

{{teacherContext}}

## Available Resources

{{#if mediaElementEnabled}}
- **Available Media**: {{assignedImages}}
{{/if}}
- **Canvas Size**: {{canvas_width}} × {{canvas_height}} px

## Output Requirements

Based on the scene information above, generate a complete Canvas/PPT component for one page.

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
5. All TextElement `height` values must be selected from the quick reference table in the system prompt
6. Unless a current explicit edit instruction asks to change it, render `{{title}}` verbatim as the visible primary heading; only line wrapping is allowed

Choose the page's native element types from the teaching need. Do not copy a fixed title-plus-bullets composition. Return one object with `background` and `elements`, using only the element contracts enabled in the system prompt.

Follow the visual intent on the first layout pass. Every ID under Required Resource Placements MUST appear in the matching image `src` or video `mediaRef`; these are teaching evidence, not optional decoration. When the list is `None`, do not add media unless the visual intent and available resources justify it.
