## Course facts

{{requirement}}

## Structured personal-project configuration

{{pblProfile}}

## First-level activity timeline and confirmed knowledge catalog

The course facts block above contains the teacher-confirmed six-module structure. Treat each module ID and duration as a parent contract. Course-outline resource details must deepen these modules, not replace or reorder the parent timeline.

## Natural-speed TTS planning context

{{ttsTimingContext}}

Use this provider/model/voice rate before deciding student AI-learning narration volume and semantic page count. TTS remains at natural speed. For slides, budget mainly for explanation; for interactions and code reserve operation/observation time; for quizzes reserve reading, thinking, answering, and answer-analysis time. Do not allocate the full activity duration to narration.

## Output planning rules

### Foundation-first planning in student AI-learning

- Every knowledge block must visibly teach its concept, a concrete example, and at least one mechanism, relationship, step, boundary, or common misconception before the learner is assessed on it. A title-only or keyword-only slide is invalid. Use additional semantic slides when one page cannot carry a complete explanation without hiding evidence in narration.
- Slides remain responsible for durable definitions, examples, evidence, comparisons, and summaries. Interactions are used only when learner manipulation, simulation, inspection, construction, programming, comparison, or rehearsal produces evidence that improves understanding.
- Select the widget by teaching affordance: simulation for variable/causal models, diagram for structures and relationships, code for executable reasoning, game for applied decisions or practice, and 3D for spatial structure.
- Every interaction must reuse valid `parentActivityId` and `knowledgePointIds`, and directly require prediction, manipulation or decision, observation, and explanatory feedback. Decorative clicking, animation, points, or unguided exploration is invalid.
- Interactions are ungraded exploration or operation spaces, not extra assessments. Do not request matching, sorting, ordering, drag-to-answer, multiple-choice, answer submission, correctness verdicts, knowledge scores, rankings, or pass/fail gates. If dragging is pedagogically necessary, it must directly manipulate or construct the model and must not compare the final arrangement with an answer key.
- Mark an interaction complete only after a meaningful operation or exploration loop and show what changed and why.
- Reserve no more than 20% of student AI-learning time for section assessments in total and keep the largest share for explicit teaching and meaningful practice.

{{#if standardMode}}
#### Standard mode strategy

- Choose each scene type dynamically from the learning objective. Do not require an interaction after a fixed number of slides and do not manufacture one for a purely explanatory concept.
- Use a small number of high-value interactive scenes only where they materially improve comprehension. A coherent slide-and-quiz sequence is valid when hands-on interaction would add no genuine learner agency.
- Distribute interactions near the knowledge they apply, while allowing several complementary explanation pages, examples, or worked steps when the concept requires them.
{{/if}}

{{#if deepInteractionMode}}
#### Deep-interaction mode strategy

- Prefer interactive-first learning where the subject supports meaningful hands-on exploration, but still decide page types from knowledge dependencies and learner needs rather than a repeating slide/widget formula.
- A short or abstract lesson may need only one excellent interaction; a longer experimental, spatial, or programming lesson may justify several. There are no widget-type quotas.
- Keep slides whenever they are the clearest way to establish definitions, evidence, reasoning, examples, misconceptions, or summaries. Do not replace teaching with widgets.
- Deep interaction applies only to student `ai-learning`. Keep `launch`, `proposal`, `make`, `showcase`, and `reflection` teacher-facing and PPT/script-only under the phase contract.
{{/if}}

### One concise assessment per knowledge section

- End every completed knowledge section with exactly one mastery `quiz`. Obey the confirmed assessment policy: adaptive mode uses at least one brief objective question for every taught knowledge point and may use drag matching for genuine correspondences; constructed-response mode uses 1–2 comprehensive short answers. Do not interrupt an unfinished section with a quiz and do not add a redundant comprehensive quiz after the final section.
- Give each quiz a concise learner-facing section-check title. When a text response is allowed, keep it to keywords or one sentence unless constructed-response mode explicitly asks for a reason.
- Each quiz scene carries that section's assessed `knowledgePointIds`. During question generation, every question must carry one or more specific IDs from that scene so the runtime can calculate a mastery profile per knowledge point.
- Keep reading, answering, and answer analysis inside the confirmed course duration. Prepared enrichment is optional and must not reduce the time needed to teach the core lesson well.

- Cover all six phase keys exactly as defined by the phase contract.
- Build a one-to-many hierarchy: a course module may have multiple course-outline details, and details under different parents may have different resource types. Every detail must include `parentActivityId` from the confirmed course-module catalog.
- Include at least one teacher resource for every phase listed in `{{requiredTeacherResourceStages}}`; other phases may be covered by a facilitation scaffold or companion guidance instead of a PPT.
- Include student learning scenes in `ai-learning` and keep them focused on the confirmed knowledge graph and learning objectives.
- Treat the structured student profile and teaching boundary inside the course facts as authoritative. Establish prerequisites before specialist vocabulary, explain every unfamiliar term before using it, use examples familiar to the stated learners, and never turn an outside concept into an implicit prerequisite or assessment target.
- Plan a visible cognitive progression across student pages and group related knowledge points into sections: prior knowledge and a concrete example first, then mechanism and guided application. End every section with a quiz that follows the confirmed assessment policy and fits the shared assessment budget. Do not make every page equally dense or equally difficult.
- Quiz configs may request only `single`, `multiple`, `matching`, `true_false`, `fill_blank`, `short_answer`, or `scenario_task`. Choose formats according to the knowledge objective rather than random variety. Use `matching` only for a real correspondence; do not request ordering, sorting, or line-connection questions.
- Treat the supplied course-module catalog as the source of truth for timing. Use the AI to decide whether each module needs one or multiple semantic details: create a new detail when a concept dependency, example, method, comparison, practice, evidence check, or transition needs its own visual focus; keep tightly related content together when one page explains it more clearly. Do not split merely to satisfy a fixed seconds-per-page threshold, and do not force a fixed number of pages.
- Treat each `slide` detail as one coherent PPT page. For student `ai-learning`, use `targetDurationSec` as the content/TTS budget for that semantic detail and make the sum of details under each parent equal the confirmed module duration. If the target is long, add only valid depth directly tied to the assigned knowledge points (explanation, evidence, example, counterexample, steps, or guided practice); if the content is complete sooner, do not pad it with repetition or unrelated topics. Teacher support details are different: the parent duration is student activity time, so keep the PPT and presenter notes concise, normally one page per teacher resource, and never write a long script to fill the activity duration.
- For every detail, copy a valid `parentActivityId` from the course-module catalog and use only the catalog's confirmed `knowledgePointIds`. Never invent a knowledge-point ID or silently replace a configured point with a nearby concept.
- `targetDurationSec` must be derived from the parent module's `durationMin` and split across the AI-selected details. For a knowledge activity, make the narration length, semantic page boundaries, and interaction/assessment time fit the target rather than treating duration as a decorative estimate. The page boundary is a curriculum judgment; the target is not permission to introduce new knowledge points.
- If a confirmed teaching-outline activity in `ai-learning` requests `interactive-demo` or `code-interactive`, the corresponding student scene MUST use `type: "interactive"` with a matching `widgetType` (`simulation` for simulation/experiment interaction, `code` for code interaction). It MUST NOT be downgraded to `slide` or `ppt`. Always provide a non-empty `widgetOutline` so the content generator can preserve the requested interaction.
- For every ordinary classroom activity, create at least one separate teacher-only detail with the same `parentActivityId`/`activityId` and `stageKey`. Multiple teacher details are allowed when the activity needs separate introduction, facilitation, or closing resources. Generate only a PPT outline plus a teacher script; these resources are not student AI-learning scenes and never receive TTS. Generate and parse these outlines separately from student scenes.
- For student AI-learning details, use `detailKind` and `resourceTypes` to distinguish knowledge explanation, interaction, and checks. Use `ttsPolicy: "target-duration"`; for all teacher details use `ttsPolicy: "none"`.
- Assign `knowledgePointIds` only from the confirmed knowledge catalog included in the course facts. Every knowledge-teaching detail must reference at least one confirmed knowledge point.
- For `proposal`, `make`, `showcase`, and `reflection`, ordinary activity outlines are teacher-facing facilitation support (`audience: "teacher"`, `generationPurpose: "facilitation-scaffold"` or the internal `"teacher-resource"` routing value), not student AI-learning scenes.
- Keep `launch` teacher-only and keep `proposal`, `make`, `showcase`, and `reflection` out of the student knowledge-teaching classroom.
- Use the selected companion IDs from the configuration. Do not create real student roles, groups, issue-board assignments, or peer scoring.
- Make process evidence visible in scene descriptions or companion prompts: the configured evidence is collected by the student's activity, not fabricated by the model.
- Use concise Chinese titles. Titles are labels only; routing must remain in the explicit metadata fields.

{{teacherContext}}
{{researchContext}}

Return the JSON wrapper described by the system prompt. Do not add markdown or commentary.
