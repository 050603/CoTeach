Title: {{title}}
Description: {{description}}
Test Points: {{keyPoints}}
Allowed Knowledge Point IDs: {{knowledgePointIds}}
Question Count: {{questionCount}}, Difficulty: {{difficulty}}, Question Types: {{questionTypes}}
Ordered Assessment Targets: {{assessmentTargets}}
{{pblContext}}

## Language Directive
{{languageDirective}}

Treat requested question types as a strict allowlist of supported semantic formats. Select only from that list because the assessment mode and answer burden have already been confirmed. Keep an intentional progression from a basic check to application when the allowed formats permit it. Use drag-and-drop `matching` only for real correspondence targets. Never generate ordering, sorting, or line-connection structures.

When Ordered Assessment Targets is a non-empty JSON array and the caller requests one question per target, return questions in that target order. Copy each target's `unitId` to `teachingUnitIds` and its `knowledgePointId` to `knowledgePointIds`; do not merge or omit targets.

Output JSON array directly (no explanation, no code blocks, no LaTeX). Every question must use one or more IDs from the allowed list:
[{"id":"q1","teachingUnitIds":["unit-1"],"knowledgePointIds":["kp-1"],"type":"single","format":"single_choice","question":"Question text","options":[{"label":"Option A","value":"A"},{"label":"Option B","value":"B"}],"answer":["A"],"analysis":"Explain the correct reasoning and the misconception behind the distractor.","points":10}]
