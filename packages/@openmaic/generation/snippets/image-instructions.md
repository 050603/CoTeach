### AI-Generated Image Requests

Request generated images when a static visual helps students directly observe an object, situation, spatial state, imagined mental model, or visible contrast and no suitable source image exists. Decide separately whether the same slide also needs an editable concept or process diagram. There is no per-slide or course image quota.

- Prefer `suggestedImageIds` and a `visualIntent.resourceRefs` source-image binding when a suitable source/PDF image exists
- Add a `mediaGenerations` entry when seeing the example materially improves understanding; a definition, formula, or precise relationship can remain entirely editable slide elements
- Use `type: "image"`
- Each image request specifies: `prompt` (description for the generation model), `elementId` (unique placeholder), and optionally `aspectRatio` (default "16:9") and `style`
- **Image IDs**: use stable semantic IDs such as `"gen_img_water-cycle"`. IDs are global across the course and must not be reset or renamed on later pages
- The prompt should specify the subject, what students should observe, the visible contrast when comparison matters, and the composition. State clearly when a scene is imagined rather than real
- Request images without embedded text, labels, numbers, arrows, or annotations. Put terminology, exact values, and relationship labels in editable slide elements in the course language
- **Avoid duplicate images across slides**: Each generated image must be visually distinct. Do not request near-identical images for different slides. If multiple slides cover the same topic, vary the visual angle, scope, or style
- **Cross-scene reuse**: To reuse a generated image in another scene, add the same ID to that scene's `visualIntent.resourceRefs` without adding another `mediaGenerations` entry. Only the first scene defines the generation request
- Use generated images for observable examples and illustrations; use editable elements for diagrams, charts, exact data, and relationships

Image example:

```json
"mediaGenerations": [
  {
    "type": "image",
    "prompt": "A clear side-by-side illustration of the same pond in dry and rainy conditions, with matching viewpoint and visible changes in water level and surrounding ground, no text or labels",
    "elementId": "gen_img_pond-seasons",
    "aspectRatio": "4:3"
  }
]
```
