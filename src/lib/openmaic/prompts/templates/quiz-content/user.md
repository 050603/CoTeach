Title: {{title}}
Description: {{description}}
Test Points: {{keyPoints}}
Allowed Knowledge Point IDs: {{knowledgePointIds}}
Question Count: {{questionCount}}, Difficulty: {{difficulty}}, Question Types: {{questionTypes}}
Learner answer time budget: {{learnerAnswerTime}}
Ordered Assessment Targets: {{assessmentTargets}}
{{pblContext}}

## Language Directive
{{languageDirective}}

Treat requested question types as a strict allowlist of supported semantic formats. Select only from that list because the assessment mode and answer burden have already been confirmed. If an exact ordered plan is supplied, follow it; otherwise choose each format by the response evidence needed for its test point. Ordinary quizzes use single choice, multiple choice, and true/false to distinguish mastery with plausible wrong alternatives. For an unplanned multiple-choice item, provide at least two credible incorrect alternatives; with four options, use two correct and two incorrect answers. If the target does not support two genuine distractors, choose single choice or true/false. Basic checks may directly test taught knowledge. Use a fresh situation only when application or transfer requires it, and do not connect every question to the final project. Matching is available only when the exact ordered plan explicitly requires it. Never generate ordering, sorting, or line-connection structures.

Each numbered Test Point may join more than one responsibility. The corresponding question must require a decision for each essential part, including any required relationship, condition, or staged action. If it asks for a concrete task or for judging a situation, supply one brief new task or situation and test the decision in it; matching abstract rules to definitions is insufficient. Shortening the wording must not remove part of the assessment; a knowledge-point ID alone does not prove it was tested.
For a situation-based item, put every fact needed to establish a correct judgment in the shared stem. If the situation does not establish a required criterion, test that criterion directly instead of assuming it from the topic.

This request has one model-generation pass. For each choice or true/false item, privately build the target distinction and misconception map before writing any option. Derive every distractor from the taught content; if there are not enough plausible misconceptions, redesign the decision or choose another allowed format when no exact plan is set. Put shared facts and criteria in the stem once. Keep the options parallel and limit them to the decisive differences; do not repeat a whole scenario or full plan in every option. Keep clause count, qualifiers, visible length, specificity, and information density comparable so the correct answer cannot be guessed from presentation. Do not make an option wrong only by adding an extreme word. Make `analysis` identify the evidence for every correct option and the precise misconception, missing condition, or scope error behind every distractor. Consider reading, thinking, and response actions for all questions against the supplied answer time. Complete the answer-blind check inside this response, then output the final JSON array once.

When Ordered Assessment Targets is a non-empty JSON array and the caller requests one question per target, return questions in that target order. Copy each target's `unitId` to `teachingUnitIds` and its `knowledgePointId` to `knowledgePointIds`; do not merge or omit targets.

Output a JSON array directly (no explanation, code blocks, or LaTeX). Every question must use one or more IDs from the allowed list and include the fields required for its selected format as shown in the system instructions.
