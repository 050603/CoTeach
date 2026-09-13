# OpenMAIC upstream baselines

CoTeach vendors selected OpenMAIC packages in this workspace. P0 synchronization is pinned to immutable release-tag commits so later upstream changes cannot silently alter a migration.

| Package | Release | Upstream commit |
| --- | --- | --- |
| `@openmaic/dsl` | `0.9.0` | `e15780835afbee2d96270fd37be868742308e0b9` |
| `@openmaic/importer` | `0.1.2` | `90f5f3942bca09df33a85a2d8aa025faf46679f6` |

## Synchronization policy

- Synchronize shared schemas, migrations, validators, runtimes, import logic, fixtures, and package metadata from the pinned release.
- Keep CoTeach teaching-domain behavior in application-level extensions whenever the upstream generic types support it.
- If compatibility requires a temporary vendored-package extension, keep it additive, document it, and cover it with a regression test.
- Preserve CoTeach's Windows-compatible workspace scripts and maintained dependency substitutions.
- Port security fixes selectively when CoTeach already has stricter behavior; never replace the DNS-pinned SSRF dispatcher with a weaker implementation.

## Current compatibility extension

CoTeach stores optional `knowledgePointIds` and pedagogical `format` metadata on quiz questions. These additive fields survive the DSL 0.9 migration and remain readable by existing classrooms.

Existing classrooms and media-generation code also still read `SpeechAction.audioUrl`. DSL 0.9 prefers `audioId` asset references, so `audioUrl` remains as a deprecated additive compatibility field until persisted classroom migration is complete.

CoTeach's current product flow treats deep interaction as the default and has removed the old stage-level `interactiveMode` switch. The optional DSL 0.9 field is therefore intentionally not reintroduced; `taskEngineMode` remains the specialized vocational-path marker.
