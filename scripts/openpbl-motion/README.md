# CoTeach C-plan motion material run

These scripts are thin project adapters around the installed
`openpbl-sprite-maker` skill. They only point its catalog loader at
`config/openpbl-agent-actions.json`; extraction, normalization, despill,
preview generation, and QA continue to use the installed skill and the
official `hatch-pet` helpers.

Use the bundled workspace Python executable:

```powershell
$python = 'C:\Users\21140\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
& $python scripts/openpbl-motion/prepare-run.py `
  --reference docs/research/character-redesign/banxue-xiaoling-user-standard.png `
  --run-dir output/openpbl-sprite-maker/banxue-xiaoling-motion-c `
  --chroma-key '#FF00FF'
```

Generate the canonical base and one complete action strip at a time with
built-in imagegen. Then process an action with:

```powershell
& $python scripts/openpbl-motion/process-action.py `
  --run-dir output/openpbl-sprite-maker/banxue-xiaoling-motion-c `
  --action walking_down `
  --source C:\absolute\path\to\selected-strip.png
```

For an asymmetric gesture whose extended arm would pull full-bounds
normalization sideways, re-register the normalized frames around the stable
upper scarf/torso junction before independent visual review:

```powershell
& $python scripts/openpbl-motion/register-body-core.py `
  --run-dir output/openpbl-sprite-maker/banxue-xiaoling-motion-c `
  --action screen_pointing
```

Do not pass a strip to the runtime packager until deterministic QA and
independent visual QA both pass.

After every action is complete, aggregate the final run QA and overview:

```powershell
& $python scripts/openpbl-motion/qa-run.py `
  --run-dir output/openpbl-sprite-maker/banxue-xiaoling-motion-c
```
