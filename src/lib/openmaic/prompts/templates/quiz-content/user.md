Title: {{title}}
Description: {{description}}
Test Points: {{keyPoints}}
Allowed Knowledge Point IDs: {{knowledgePointIds}}
Question Count: {{questionCount}}, Difficulty: {{difficulty}}, Question Types: {{questionTypes}}
Internal authoring evidence contract: {{authoringEvidence}}
Learner answer time budget: {{learnerAnswerTime}}
Ordered Assessment Targets: {{assessmentTargets}}
Confirmed assessment design (ability goals, bound premises, and original evidence): {{assessmentDesign}}
{{pblContext}}

## Language Directive
{{languageDirective}}

Treat requested question types as a strict allowlist of supported semantic formats. Select only from that list.
{{#if ordinarySectionQuiz}}
This ordinary section quiz uses single, multiple, true_false, matching, and fill_blank only. Dynamically select 2–4 questions and their combination from the understanding decisions and learner answer time. There is no type quota. Fill_blank uses a short text input (`type="short_answer"`) internally, but its semantic `format` must be `fill_blank` and its answer must be a concise missing term or relation, not a written explanation.
{{/if}}
{{#if deepResponse}}
This deep-response section quiz is exactly one comprehensive `short_answer` with `format="short_answer"`; require a reasoned written answer that covers every allowed knowledge point. Do not add a second item or use another format.
{{/if}}
{{#if legacyQuiz}}
If an exact ordered plan is supplied, follow it; otherwise choose the final count and formats from the requested allowlist, the response evidence needed, and available answer time.
{{/if}}
Basic checks may directly test taught knowledge. Use a fresh situation only when application or transfer requires it, and do not connect every question to the final project. Never generate ordering, sorting, or line-connection structures.
{{#if objectiveQuiz}}
For an unplanned multiple-choice item, provide at least two credible incorrect alternatives; with four options, use two correct and two incorrect answers. If the target does not support two genuine distractors, choose another allowed format. Any allowed format may be repeated; no single or multiple-choice quota applies.
{{/if}}

Test Points are the section's assessment responsibilities, not a question-by-question list unless an exact ordered plan is supplied. Group only responsibilities that share a meaningful concept, mechanism, or task; a question must elicit every essential decision it claims to assess. If an application responsibility asks for judging a situation, supply one brief new situation and test the decision in it. Shortening the wording must not remove part of the assessment; a knowledge-point ID alone does not prove it was tested.
For a question-count range, decide the final count from distinct decisions the learner must demonstrate and the actual answer-time budget. Two questions are sufficient only when they can genuinely cover every distinct responsibility; otherwise use three or four within the supplied range. Do not add questions just for variety.
For a situation-based item, put every fact needed to establish a correct judgment in the shared stem. If the situation does not establish a required criterion, test that criterion directly instead of assuming it from the topic.
Every distinction needed to reject an option must have been explained in the actual completed teaching or established prerequisite teaching. A term merely mentioned in the source or narration is not proof that its definition or boundary was taught; do not borrow the explanation from a later section.

This request has one model-generation pass. For each item, first establish the target distinction, its source-supported boundary, and observable learner response. Give the stem a clear subject, referents, necessary premises, and one coherent task. The analysis cannot supply a premise needed to answer the stem. Put shared facts and criteria in the stem once, without stating the answer rule or echoing the correct choice's distinctive words. The difficulty should come from distinguishing taught concepts or conditions, not obscure knowledge, excessive reading, or verbal traps.
{{#if objectiveQuiz}}
For each choice or true/false item, derive every distractor from a plausible partial understanding of the taught content: concept confusion, condition misuse, stage confusion, insufficient evidence, or reversed causality or correspondence. If there are not enough plausible misconceptions, redesign the decision or choose another allowed format. Compare the same concrete attributes and retain plausible positive alternatives; do not make the correct choice a collection of every desirable practice while the others fail basic teaching common sense. Keep options parallel in clause count, qualifiers, specificity, and information density; length similarity is an auxiliary check. Do not make an option wrong only by adding an extreme word. In each `optionReasoning` entry, state a concise verifiable justification: the correct option's decisive evidence, or the distractor's plausible confusion and its precise error here. Make learner-visible `analysis` explain the decisive knowledge and answer, without authoring fields or private reasoning. For fill blank, require inference of a concise concept or relation rather than copying a nearby phrase, and accept equivalent wording. For matching, use concrete operations or performances without repeated keywords on both sides. Complete the answer-blind check before output.
For a design choice, fix useful positive learning arrangements in the shared stem, then vary one taught conceptual axis such as mechanism, support role, criterion, feedback source, or stage. Diagnose that distinction instead of asking which complete arrangement generally “fits the theory”. Mere reproduction, teacher withdrawal, or forbidding learners to explain or adjust are not credible alternatives to a complete student-centred plan, even with an authoring justification. For an application fill blank, use observable actions, artifacts, or utterances; do not reveal the cognitive mechanism with labels such as “未改变原有认知结构” or “改变框架”.
{{/if}}
{{#if deepResponse}}
For the one comprehensive written item, make the required conclusion and reasoning explicit in the task. Supply a worked reference answer and specific scoring criteria for each knowledge-point decision; accept equivalent reasoning. Treat the supplied answer time as an effort reference; a complete, clear response may take longer.
{{/if}}
Output the final JSON once.

When Ordered Assessment Targets is a non-empty JSON array and the caller requests one question per target, return questions in that target order. Copy each target's `unitId` to `teachingUnitIds` and its `knowledgePointId` to `knowledgePointIds`; do not merge or omit targets.

Output a JSON array directly (no explanation, code blocks, or LaTeX). Every question must use one or more IDs from the allowed list and include the fields required for its selected format as shown in the system instructions.
