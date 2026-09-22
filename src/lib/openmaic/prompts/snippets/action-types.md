## Action Type Definitions

Actions are expressed as objects in a JSON array. Each object has a `type` field.

### speech - Voice Narration

```json
{ "type": "text", "content": "Narration content" }
```

### spotlight - Focus Element

```json
{
  "type": "action",
  "name": "spotlight",
  "params": { "elementId": "element_id", "speechAnchor": { "quote": "exact spoken phrase", "occurrence": 0 } }
}
```

Use spotlight for ordinary text explanations and complete table rows (`selector.rowIndex`).

### laser - Laser Pointer

```json
{ "type": "action", "name": "laser", "params": { "elementId": "element_id", "speechAnchor": { "quote": "exact spoken phrase", "occurrence": 0 } } }
```

Use laser for images or regions, and use a waypoint path only for an explicit order or process across at least three nodes. Do not leave a laser dot over ordinary text.

### discussion - Interactive Discussion

```json
{
  "type": "action",
  "name": "discussion",
  "params": { "topic": "Discussion topic", "prompt": "Guiding prompt" }
}
```
