Please generate scene outlines based on the following course requirements.

---

## User Requirements

{{requirement}}

---

{{userProfile}}

## Language Context

Infer the course language directive by applying the decision rules from the system prompt. Key reminders:
- Requirement language = teaching language (unless overridden by explicit request or learner context)
- Foreign language learning → teach in user's native language, not the target language
- PDF language does NOT override teaching language — translate/explain document content instead

---

## Reference Materials

### PDF Content Summary

{{pdfContent}}

### Available Images

{{availableImages}}

### Web Search Results

{{researchContext}}

{{teacherContext}}

---

## Output Requirements

Please automatically infer the following from user requirements:

- Course topic and core content
- Target audience and difficulty level
- Course duration (default 15-30 minutes if not specified)
- Teaching style (formal/casual/interactive/academic)
- Visual style (minimal/colorful/professional/playful)

Then output your response as a single JSON object.

**Top-level shape — this is what you MUST return:**

```json
{
  "languageDirective": "2-5 sentence instruction describing the course language behavior",
  "courseTitle": "concise course name, ≤30 chars, in the teaching language",
  "outlines": [ /* array of scene objects, schema described below */ ]
}
```

Never return a bare array. Never omit `languageDirective` or `courseTitle`. All three keys are required.

**Each scene inside the `outlines` array has this minimum shape:**

```json
{
  "id": "scene_1",
  "type": "slide" | "quiz" | "interactive" | "pbl",
  "title": "Scene Title",
  "description": "Teaching purpose description",
  "keyPoints": ["Point 1", "Point 2", "Point 3"],
  "teachingToolPlan": [{
    "tool": "whiteboard | spotlight | laser-pointer | interactive-widget",
    "trigger": "spoken-content cue",
    "purpose": "specific learning benefit",
    "content": ["exact visible notes or relationships"],
    "required": true
  }],
  "order": 1
}
```

### Special Notes

- **quiz scenes must include quizConfig**:
   ```json
   "quizConfig": {
     "questionCount": 2,
     "difficulty": "easy" | "medium" | "hard",
     "questionTypes": ["single", "multiple", "matching", "true_false", "fill_blank", "short_answer", "scenario_task"]
   }
   ```
{{#if hasSourceImages}}
- **If source images are available**, add `suggestedImageIds` to relevant slide scenes. Only use image IDs listed under Available Images.
{{/if}}
- **Interactive scenes**: If a concept benefits from meaningful manipulation, simulation, inspection, construction, programming, comparison, or rehearsal, use `"type": "interactive"` with `widgetType` and `widgetOutline` fields. Choose the count dynamically; there is no widget quota and no fixed slide-to-interaction cadence. Do not manufacture next/previous, reveal-only, or view-details pages as interaction.
   - Select widgetType based on concept: simulation (physics/chem), diagram (processes), code (programming), game (practice), visualization3d (3D models)
   - Provide appropriate widgetOutline for the widget type
- **Scene count**: Fit the inferred duration and the semantic teaching steps. Prefer a smaller number of complete, coherent scenes over a fixed scenes-per-minute formula.
- **Quiz placement**: Group related knowledge into coherent sections. Teach and practise each section first, then end it with one concise mastery quiz covering only that section's taught `knowledgePointIds`. In adaptive mode allocate at least one brief objective item per taught knowledge point; in constructed-response mode use 1–2 comprehensive short answers. Never interrupt an unfinished section with a quiz or append a redundant all-course final quiz.
- **Quiz design**: choose supported formats according to the objective: recognition (`single`/`true_false`), evidence classification (`multiple`), real correspondence (`matching`), concept completion (`fill_blank`), explanation (`short_answer`), or transfer (`scenario_task`). Do not request ordering, sorting, or line-connection questions.
- **Teaching progression**: activate prerequisites before introducing new terminology; explain each unfamiliar term before using it in examples or assessment; move from concrete familiar contexts to mechanism and then application.
- **Teaching tools**: use `teachingToolPlan` for a purposeful whiteboard/canvas/widget moment, not as a quota. A long or abstract oral explanation is a strong signal to externalize steps, relationships, examples, formulae, or code on the whiteboard. The plan must tell the teacher which page triggers it and what students will actually see.
- **Language**: Infer from the user's requirement text and context, then output all content in the inferred language
- **If web search results are provided**, reference specific findings and sources in scene descriptions and keyPoints. The search results provide up-to-date information — incorporate it to make the course content current and accurate.

**Final reminder**: your entire response must be a JSON **object** with exactly three top-level keys — `languageDirective` (string), `courseTitle` (string, ≤30 chars, in the teaching language), and `outlines` (array). Do not return a bare array. Do not wrap in prose or code fences.
