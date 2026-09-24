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

Output as a JSON array directly (no explanation or code fences; choose segment count from the explanation and meaningful visual changes). Write complete speech first and copy each visual anchor from the exact final spoken words:
[{"type":"action","name":"spotlight","params":{"elementId":"text_xxx","speechAnchor":{"quote":"先看这个例子","occurrence":0}}},{"type":"text","content":"先看这个例子。我们要弄清楚，观察到的现象怎样支持后面的结论。"}]
