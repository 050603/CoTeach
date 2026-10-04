# Quiz Narration Generator

Write one continuous teacher voice for the quiz's three playback phases. This is the first and only authoring request for these spoken segments. The runtime inserts two silent learner-controlled waits; do not output gates, action objects, dialogue, or stage directions.

## Required flow

1. `intro` plays on entering the quiz, before the learner answers. Briefly invite independent answers for the intended kind of judgment. The preceding teaching already established the knowledge, so it needs no repeated summary here. A selection-only question asks for a choice, not a written explanation; learners may check their reasoning silently. Do not reveal, paraphrase, compare, or hint at any question, option, correct answer, or explanation.
2. `review-guidance` plays as soon as the learner submits, including while short-answer grading is still running. Guide the learner to compare answers with their reasons **once explanations appear**, revisit what needs another look, and confirm understanding after reviewing. These responsibilities can be expressed together in a concise utterance. Do not say explanations or scores are already visible, claim success, recite correct answers, or begin the next section here.
3. `handoff` plays only after the learner confirms understanding. Express the actual relationship that makes the next teaching step useful, such as a parallel route, further explanation or application of an established idea. Use only the prior premise necessary to make that relationship intelligible; do not retell the preceding section. A short connected sentence may complete this responsibility. Do not invent a limitation simply to create a transition. The handoff explains **why that next idea is needed**; the next slide explains **how it works**. `nextPage.actualOpening` is the **next audio that will play verbatim**, so do not restate, summarize, or paraphrase its mechanism, steps, or conclusion in `handoff`. If naming the next idea already uses a term from that opening, name it without defining or teaching it. Do not restate the same limitation or need in different words, or end with a question that the opening immediately asks again. Do not say “上一段说到”“下一页”“下一部分” or merely announce a topic; speak to the learner about the knowledge itself. Never assume all answers were correct or every learner has mastered the topic. If no next teaching page exists, follow the real course disposition: connect the established knowledge to the named project stage when one exists, otherwise close the course naturally only at a verified course end.

Use the preceding section's **actual spoken narration**, its intended understanding and assessment focus, the generated question explanations, the next section's learning purpose and entry point, and the next page's **actual opening narration** supplied below. Actual narration establishes what was taught; the bound source statements and their conditions determine what is true. These inputs support a specific teaching progression, not lines to copy. A quiz title is an internal assessment label, not knowledge taught on the preceding page; never read it aloud or infer a prior claim from it. Do not say the previous page raised a problem unless its actual narration did so. You may explain a new need that follows logically from the taught idea, but do not pretend it was already spoken. Make the final `handoff` thought and the next page's first spoken thought consecutive steps in one explanation. Avoid a repeated summary, a new course greeting, a mechanical page announcement, and fabricated learner performance.

Write natural spoken sentences. Do not use a colon or semicolon as a shortcut for the missing reasoning link; say the link in ordinary speech.

The three spoken segments share this page's **one reference speech allocation** at the supplied voice and natural speed 1.0. Answering and reading explanations have their separate **student activity allocation**. Time and unit ranges guide pacing, not pass/fail: a clear necessary handoff may exceed them. Allocate speech by the three actual responsibilities, without a fixed sentence count or paragraph ratio. Keep the first two phases brief and the handoff sufficient for its true relationship; none needs filler to use up its share. Preserve the reasoning link while removing repeated definitions, answers and decorative setup. Do not spend speech time while the learner is silently answering or reading, accelerate audio or omit a playback phase to fit a reference duration.

## Output format

Return exactly this JSON array, with three nonempty text items in this order and no other fields:

```json
[
  { "type": "text", "phase": "intro", "content": "..." },
  { "type": "text", "phase": "review-guidance", "content": "..." },
  { "type": "text", "phase": "handoff", "content": "..." }
]
```
