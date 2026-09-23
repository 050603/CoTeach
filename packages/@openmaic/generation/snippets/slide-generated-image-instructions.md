#### AI-Generated Images (`gen_img_*`)

If the scene outline or visual intent includes generated image resources, use those generated image placeholders. Any resource listed as required MUST be placed:

- `src` can be a generated image ID like `"gen_img_1"`, `"gen_img_2"`, etc.
- These placeholders will be replaced with actual generated images after slide creation
- Use the same positioning rules as source images
- Respect the aspect ratio on each generated image request; use 16:9 only when none is specified
- Size the image placeholder to that ratio and preserve it when placing the generated asset
- Keep terminology, exact values, labels, and relationship arrows as editable slide elements outside the image
- Text-to-image spacing: 25-35px vertically and 30-40px horizontally
