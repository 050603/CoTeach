Elements: {{elements}}
Title: {{title}}
Key Points: {{keyPoints}}
Description: {{description}}
{{courseContext}}
{{agents}}
{{userProfile}}
{{pblContext}}
{{timingBudget}}

{{teachingToolPlan}}

Generate speech and actions for this semantic page only. Use this page's target duration as a TTS/content budget, explain the visible content and assigned subtopic clearly, and do not write a long script that belongs to sibling pages or the whole module. Add depth only through valid explanations, examples, evidence, counterexamples, or steps directly tied to the assigned knowledge points and grade; never pad with repetition or unrelated knowledge.

**Language Directive**: {{languageDirective}}

Output as a JSON array directly (no explanation or code fences; choose segment count from the explanation and meaningful visual changes):
[{"type":"action","name":"spotlight","params":{"elementId":"text_xxx"}},{"type":"text","content":"Opening speech content"}]
