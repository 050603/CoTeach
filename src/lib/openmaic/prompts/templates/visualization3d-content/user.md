Create a 3D visualization widget for: {{title}}

## Visualization Type

{{visualizationType}}

## Description

{{description}}

## Key Points

{{keyPoints}}

## Objects to Visualize

{{objects}}

## Interactions

{{interactions}}

## Language

{{pblContext}}

{{languageDirective}}

---

Generate a complete, interactive 3D visualization using Three.js with these MANDATORY features:

### Knowledge Teaching (CRITICAL — students must LEARN, not just look)
1. **Objective Alignment**: Map every supplied Key Point to a specific object, spatial relation, viewpoint, comparison, or explanation task. Use accurate scale/shape conventions and disclose purposeful distortions; do not add impressive but irrelevant objects.
2. **No Decorative Interaction**: Orbiting, zooming, and animation count only when they help the learner predict, inspect, compare, explain, or revise a target spatial idea. Free camera movement alone is not a learning activity.
3. **Teaching Loop**: Begin from an orientation view; invite the learner to anticipate a relation or appearance; move to a purposeful viewpoint or let the learner manipulate one parameter; highlight the evidence; then explain the observed contrast.
4. **Explanatory Feedback**: Every instructional object needs a readable label and explanation of its role. Use the selected object, camera view, and learner choice to explain what is visible and why without judging an answer.
5. **Guided Attention**: A guided tour must stop only at instructionally necessary viewpoints, state what to inspect and why it matters, and visually isolate the current evidence. Keep labels legible and prevent occlusion on desktop and mobile.
6. **Exploration Evidence**: Preserve the learner's inspected objects or viewpoints and finish with a visual comparison summary. Let the learner freely revisit the model; do not require a correct selection or explanation submission.
7. **Assessment Boundary**: This is not a quiz: use no score, answer key, matching, correctness verdict, ranking, or pass/fail gate.

### Activity Completion Protocol (MANDATORY)
1. Call `window.__maicActivity.complete()` after meaningful exploration: the learner has inspected the required objects or viewpoints and the comparison summary is visible. Also add `data-activity-complete` to the final continue control when one exists.
2. Call `window.__maicActivity.reset()` when a full reset clears the inspection history; add `data-activity-reset` to the reset control.
3. Do not signal completion for orbiting, zooming once, selecting one object, or decorative interaction. Completion is a playback milestone, not a grade or mastery claim.

### Scene Setup
1. **Self-hosted Three.js 0.160.0** using importmap for ES modules: map `three` to `/api/openmaic/interactive-runtime/three/0.160.0/build/three.module.js` and `three/addons/` to `/api/openmaic/interactive-runtime/three/0.160.0/examples/jsm/`. Do not use external CDN URLs.
2. **Proper lighting** (ambient + directional/point lights)
3. **OrbitControls** for camera manipulation
4. **Responsive canvas** that fills the container

### Objects
1. Create 3D objects based on the visualization type
2. Use appropriate materials (Phong, Standard, Emissive)
3. Add meaningful colors and textures
4. Store objects in an `objects` dictionary for widget actions
5. **Each object must have an associated explanation** stored in its data

### Interactions
1. **Sliders** for controlling parameters (speed, scale, etc.)
2. **Buttons** for presets, guided tour, and reset
3. **Info panel** showing current state and knowledge points
4. **Touch-friendly** controls (44px minimum)

### Animation
1. Use `requestAnimationFrame` for smooth animations
2. Support pause/play controls
3. Respect `animationSpeed` variable

### Teacher Actions Support
1. Include the postMessage listener
2. Support SET_WIDGET_STATE for camera and object control
3. Support HIGHLIGHT_ELEMENT for 3D objects
4. Support ANNOTATE_ELEMENT for 3D objects

### Widget Config
Embed a complete widget configuration in the HTML:
```json
{
  "type": "visualization3d",
  "visualizationType": "{{visualizationType}}",
  "description": "...",
  "objects": [...],
  "interactions": [...],
  "presets": [...]
}
```

### Mobile Considerations
1. Touch-enabled OrbitControls
2. Lower polygon count for mobile
3. Control panel at bottom for thumb access
4. Readable text sizes

Return ONLY the HTML document.
