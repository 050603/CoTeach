# Quiz Narration Generator

Write one continuous teacher voice for the quiz's three playback phases. This is the first and only authoring request for these spoken segments. The runtime inserts two silent learner-controlled waits; do not output gates, action objects, dialogue, or stage directions.

## Required flow

1. `intro` plays on entering the quiz, before the learner answers. In two concise, connected spoken sentences, recall the specific understanding established by the preceding section, explain what kind of judgment the quiz checks, then invite independent answers. A selection-only question asks for a choice, not a written explanation; learners may check their reasoning silently. Do not reveal, paraphrase, compare, or hint at any question, option, correct answer, or explanation.
2. `review-guidance` plays as soon as the learner submits, including while short-answer grading is still running. Give two distinct spoken sentences: first say that explanations can be checked **once they appear**; then guide the learner to compare each answer with its reasoning, find the point needing another look, listen to or read the available explanation, and confirm understanding only after reviewing it. Do not say explanations or scores are already visible, claim success, recite correct answers, or begin the next section here.
3. `handoff` plays only after the learner confirms understanding. This is the substantive bridge between sections, not a page announcement. Make the reasoning chain audible in three distinct moves: what concrete understanding the previous teaching established; what decision it still cannot support alone or what new application it makes possible; why the particular next idea or method is needed. Stop there. The handoff explains **why that next idea is needed**; the next slide explains **how it works**. `nextPage.actualOpening` is the **next audio that will play verbatim**, so do not restate, summarize, or paraphrase its mechanism, steps, or conclusion in `handoff`. If naming the next idea already uses a term from that opening, name it without defining or teaching it. Do not restate the same limitation or need in different words, or end with a question that the opening immediately asks again. Usually this takes several connected spoken sentences. Do not say “上一段说到”“下一页”“下一部分” or merely announce a topic; speak to the learner about the knowledge itself. Never assume all answers were correct or every learner has mastered the topic. If no next teaching page exists, follow the real course disposition: connect the established knowledge to the named project stage when one exists, otherwise close the course naturally only at a verified course end.

Use the preceding section's **actual spoken narration**, its intended understanding and assessment focus, the generated question explanations, the next section's learning purpose and entry point, and the next page's **actual opening narration** supplied below. These are evidence for a specific teaching progression, not lines to copy. A quiz title is an internal assessment label, not knowledge taught on the preceding page; never read it aloud or infer a prior claim from it. Do not say the previous page raised a problem unless its actual narration did so. You may explain a new need that follows logically from the taught idea, but do not pretend it was already spoken. Make the final `handoff` thought and the next page's first spoken thought consecutive steps in one explanation. Avoid a repeated summary, a new course greeting, a mechanical page announcement, and fabricated learner performance.

Write natural spoken sentences. Do not use a colon or semicolon as a shortcut for the missing reasoning link; say the link in ordinary speech.

The three spoken segments share this page's **one narration budget**. Answering and reading explanations share the **one student activity budget**. Do not treat either phase as an extra allocation. Fit all three spoken texts together into the `narrationSec` portion of the timing budget, not the overall page duration. Treat the phase allocation in the request as a practical upper target for each phase, not a minimum to fill: keep the first two phases efficient, and give `handoff` the largest share when it must explain a cross-section dependency. Concision means removing filler and repetition, **not** reducing the learning progression to a disconnected single sentence. If the budget is tight, preserve the actual established idea, the reason the next step is needed, and what the next idea contributes; do not spend speech time while the learner is silently answering or reading.

## Output format

Return exactly this JSON array, with three nonempty text items in this order and no other fields:

```json
[
  { "type": "text", "phase": "intro", "content": "..." },
  { "type": "text", "phase": "review-guidance", "content": "..." },
  { "type": "text", "phase": "handoff", "content": "..." }
]
```
