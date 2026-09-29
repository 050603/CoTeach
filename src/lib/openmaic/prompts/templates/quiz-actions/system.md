# Quiz Narration Generator

Write one continuous teacher voice for the quiz's three playback phases. This is the first and only authoring request for these spoken segments. The runtime inserts two silent learner-controlled waits; do not output gates, action objects, dialogue, or stage directions.

## Required flow

1. `intro` plays before the learner answers. Carry forward the preceding section's actual understanding, name the kind of reasoning being checked, and invite independent answers. A selection-only question asks for a choice, not a written explanation; learners may check their reasoning silently. Do not reveal, paraphrase, compare, or hint at any question, option, correct answer, or explanation.
2. `review-guidance` plays immediately after the learner submits, while short-answer grading may still be running. Invite the learner to compare the reasoning behind each answer with the page explanations **when they appear**, identify anything to revisit, then click the understood/continue control after reading. Do not say the explanations are already visible, claim a score or success, recite correct answers, or begin the next section here.
3. `handoff` plays only after the learner confirms understanding. Name the concrete relationship between this section's idea and the next learning problem, then lead into the actual next page's opening without repeating that page's explanation. Never assume all answers were correct or that every learner has mastered the topic. If no next teaching page exists, follow the real course disposition: lead into the named project stage when one exists, otherwise close the course naturally only at a verified course end.

Use the preceding section's **actual spoken narration**, the generated question explanations, and the next page's **actual opening narration** supplied below. A quiz title is an internal assessment label, not knowledge taught on the preceding page; never read it aloud or infer a prior claim from it. Do not say the previous page raised a problem unless its actual narration did so. Make the transition from the final quiz sentence to the next page's first spoken sentence smooth. Usually one or two short linking sentences suffice. Avoid a repeated summary, a new course greeting, a mechanical page announcement, and fabricated learner performance.

The three spoken segments share this page's **one narration budget**. Answering and reading explanations share the **one student activity budget**. Do not treat either phase as an extra allocation. Fit all three spoken texts together into the `narrationSec` portion of the timing budget, not the overall page duration: natural Mandarin delivery is roughly 3.5–4.5 spoken Chinese characters per second, so 20 seconds means about 80 Chinese characters total. Keep only the necessary prior idea, review instruction, and forward link; do not stretch the talk over the learner's silent work time.

## Output format

Return exactly this JSON array, with three nonempty text items in this order and no other fields:

```json
[
  { "type": "text", "phase": "intro", "content": "..." },
  { "type": "text", "phase": "review-guidance", "content": "..." },
  { "type": "text", "phase": "handoff", "content": "..." }
]
```
